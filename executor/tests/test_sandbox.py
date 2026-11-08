"""End-to-end tests through the server with real bubblewrap.

They need Linux, bubblewrap, and unprivileged user namespaces, so they run
in the image (see README). Elsewhere they skip, unless
EXECUTOR_REQUIRE_SANDBOX=1, which turns the skip into a failure for CI.
EXECUTOR_REQUIRE_PROCFS=1 also requires the strongest mode (private /proc).
"""

import json
import os
import sys
import time
import unittest

from executor.config import Config
from executor.policy import is_blocked_ip
from executor.sandbox import Sandbox
from tests.helpers import RecordingUpstream, RunningServer, request, rmtree, short_tmpdir

SECRET = "s3cr3t-api-token-for-tests"
HOST_SENTINEL = "host-only-sentinel-value"

CLIENT = r"""
import json, os, sys, urllib.error, urllib.request
url = sys.argv[1]
headers = dict(h.split("=", 1) for h in sys.argv[2:])
headers = {k: os.path.expandvars(v) for k, v in headers.items()}
try:
    with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=10) as r:
        out = {"status": r.status, "body": r.read().decode()}
except urllib.error.HTTPError as e:
    out = {"status": e.code, "deny": e.headers.get("X-Executor-Deny")}
except Exception as e:
    out = {"error": type(e).__name__ + ": " + str(e)}
print(json.dumps(out))
"""

PROBES = r"""
import ctypes, errno, json, os, socket
r = {}
try:
    socket.socket(socket.AF_UNIX, socket.SOCK_STREAM); r["af_unix"] = "allowed"
except OSError as e:
    r["af_unix"] = errno.errorcode[e.errno]
libc = ctypes.CDLL(None, use_errno=True)
rc = libc.syscall(425, 1, ctypes.c_void_p(0))  # io_uring_setup
r["io_uring"] = errno.errorcode[ctypes.get_errno()] if rc < 0 else "allowed"
def call(rc):
    return errno.errorcode[ctypes.get_errno()] if rc < 0 else "allowed"
r["userns"] = call(libc.unshare(0x10000000))  # CLONE_NEWUSER
r["mount"] = call(libc.mount(b"none", b"/tmp", b"tmpfs", 0, None))
r["setns"] = call(libc.setns(0, 0))
r["ptrace"] = call(libc.ptrace(16, 1, None, None))  # PTRACE_ATTACH to PID 1
try:
    socket.create_connection(("1.1.1.1", 80), timeout=3); r["direct"] = "connected"
except OSError as e:
    r["direct"] = type(e).__name__
r["uid"] = os.getuid()
r["cwd"] = os.getcwd()
print(json.dumps(r))
"""


def allow_loopback(_addr):
    # Test upstreams listen on 127.0.0.1 outside the sandbox. Production uses
    # executor.policy.is_blocked_ip; LoopbackDeniedTest checks that path.
    return None


class _SandboxCase(unittest.TestCase):
    blocked_ip = staticmethod(allow_loopback)

    @classmethod
    def setUpClass(cls):
        os.environ["EXECUTOR_HOST_SENTINEL"] = HOST_SENTINEL
        cls.tmp = short_tmpdir()
        cls.creds = os.path.join(cls.tmp, "credentials")
        os.makedirs(cls.creds)
        with open(os.path.join(cls.creds, "API_TOKEN"), "w") as f:
            f.write(SECRET + "\n")
        cls.cfg = Config(
            socket_path=os.path.join(cls.tmp, "exec.sock"),
            work_root=os.path.join(cls.tmp, "work"),
            credentials_dir=cls.creds,
            # Set where the runtime allows a private /proc (Kubernetes with
            # hostUsers: false and procMount: Unmasked).
            require_procfs=os.environ.get("EXECUTOR_REQUIRE_PROCFS") == "1",
        )
        cls.sandbox = Sandbox(cls.cfg, blocked_ip=cls.blocked_ip)
        if not cls.sandbox.self_check():
            msg = f"bubblewrap sandbox unavailable: {cls.sandbox.reason}"
            rmtree(cls.tmp)
            if os.environ.get("EXECUTOR_REQUIRE_SANDBOX") == "1":
                raise AssertionError(msg)
            raise unittest.SkipTest(msg)
        sys.stderr.write(f"\n[{cls.__name__}] sandbox mode: {cls.sandbox.mode} ({cls.sandbox.reason})\n")
        cls.server = RunningServer(cls.cfg, cls.sandbox)
        cls.up = RecordingUpstream()

    @classmethod
    def tearDownClass(cls):
        cls.up.close()
        cls.server.close()
        rmtree(cls.tmp)

    def exec(self, argv, tools=None, net=(), credentials=(), files=None, timeout=20, env=None):
        body = {
            "id": "test/" + self.id().rsplit(".", 1)[-1],
            "argv": list(argv),
            "files": files or {},
            "env": env or {},
            "constraints": {
                "tools": tools or [argv[0]],
                "net": list(net),
                "credentials": list(credentials),
                "limits": {"cpu": 1, "mem": "512Mi", "timeoutSec": timeout},
            },
        }
        status, resp = request(self.server.socket, "POST", "/v1/exec", body, timeout=timeout + 30)
        self.assertEqual(status, 200, resp)
        return resp

    def client(self, url, headers=(), net=(), credentials=()):
        resp = self.exec(
            ["python3", "client.py", url, *headers],
            net=net,
            credentials=credentials,
            files={"client.py": CLIENT},
        )
        self.assertEqual(resp["exitCode"], 0, resp)
        return json.loads(resp["stdout"]), resp


class SandboxTest(_SandboxCase):
    def test_exit_code_and_output(self):
        resp = self.exec(["sh", "-c", "echo out; echo err >&2; exit 7"])
        self.assertEqual((resp["exitCode"], resp["stdout"], resp["stderr"]), (7, "out\n", "err\n"))
        self.assertFalse(resp["timedOut"])

    def test_undeclared_host_fails(self):
        before = len(self.up.requests)
        net = [f"127.0.0.1:{self.up.port}"]
        out, resp = self.client(f"http://127.0.0.2:{self.up.port}/", net=net)
        self.assertEqual(out["status"], 403)
        self.assertIn("not declared", out["deny"])
        out, _ = self.client("https://example.com/", net=net)
        self.assertIn("403", out["error"])
        self.assertEqual([e["decision"] for e in resp["egress"]], ["deny"])
        self.assertEqual(self.up.requests[before:], [])

    def test_declared_host_works_through_proxy(self):
        out, resp = self.client(f"http://127.0.0.1:{self.up.port}/ping", net=[f"127.0.0.1:{self.up.port}"])
        self.assertEqual(out, {"status": 200, "body": "ok"})
        self.assertEqual(resp["egress"][0]["decision"], "allow")

    def test_no_network_without_proxy(self):
        resp = self.exec(["python3", "probes.py"], files={"probes.py": PROBES})
        r = json.loads(resp["stdout"])
        self.assertNotEqual(r["direct"], "connected")
        resp = self.exec(["env"])
        self.assertNotIn("PROXY", resp["stdout"].upper())

    def test_direct_connections_bypassing_proxy_fail(self):
        resp = self.exec(["python3", "probes.py"], files={"probes.py": PROBES}, net=[f"127.0.0.1:{self.up.port}"])
        self.assertNotEqual(json.loads(resp["stdout"])["direct"], "connected")

    def test_timeout_kills_process_tree(self):
        started = time.monotonic()
        resp = self.exec(["sh", "-c", "sleep 61.5 & sleep 62.5; echo finished"], timeout=1)
        self.assertTrue(resp["timedOut"])
        self.assertEqual(resp["signal"], "SIGKILL")
        self.assertNotIn("finished", resp["stdout"])
        self.assertLess(time.monotonic() - started, 10)
        time.sleep(0.5)
        leftovers = []
        for pid in filter(str.isdigit, os.listdir("/proc")):
            try:
                with open(f"/proc/{pid}/cmdline", "rb") as f:
                    cmd = f.read()
            except OSError:
                continue
            if b"61.5" in cmd or b"62.5" in cmd:
                leftovers.append(cmd)
        self.assertEqual(leftovers, [])

    def test_host_environment_is_invisible(self):
        self.assertEqual(os.environ.get("EXECUTOR_HOST_SENTINEL"), HOST_SENTINEL)
        resp = self.exec(["env"])
        self.assertNotIn(HOST_SENTINEL, resp["stdout"])
        self.assertNotIn("EXECUTOR_", resp["stdout"])
        self.assertIn("HOME=/work", resp["stdout"])
        resp = self.exec(["sh", "-c", "cat /proc/1/environ /proc/*/environ 2>/dev/null | tr '\\0' '\\n'"])
        self.assertNotIn(HOST_SENTINEL, resp["stdout"])

    def test_credential_only_in_proxied_request(self):
        net = [f"127.0.0.1:{self.up.port}"]
        cred = {"name": "API_TOKEN", "hosts": ["127.0.0.1"], "header": "Authorization"}
        before = len(self.up.requests)
        out, resp = self.client(
            f"http://127.0.0.1:{self.up.port}/api/default/_search",
            headers=["Authorization=Bearer $API_TOKEN", "X-Echo=$API_TOKEN"],
            net=net,
            credentials=[cred],
        )
        self.assertEqual(out["status"], 200)
        got = self.up.requests[before]
        self.assertEqual(got["headers"]["Authorization"], f"Bearer {SECRET}")
        # The placeholder is replaced only in the declared header.
        self.assertTrue(got["headers"]["X-Echo"].startswith("neotags-placeholder-api_token-"))
        self.assertEqual(resp["egress"][0]["injected"], ["API_TOKEN"])

        # Inside the sandbox: only the placeholder, and no credential files.
        resp = self.exec(
            ["sh", "-c", f"env; ls -la {self.creds} 2>&1; cat {self.creds}/API_TOKEN 2>&1"],
            net=net,
            credentials=[cred],
        )
        for text in (resp["stdout"], resp["stderr"], json.dumps(resp)):
            self.assertNotIn(SECRET, text)
        self.assertIn("API_TOKEN=neotags-placeholder-api_token-", resp["stdout"])

    def test_workdir_is_fresh_each_time(self):
        first = self.exec(["sh", "-c", "echo hi > marker; pwd; ls"])
        self.assertEqual(first["stdout"], "/work\nmarker\n")
        second = self.exec(["ls", "-A"])
        self.assertEqual(second["stdout"], "")
        self.assertEqual(os.listdir(self.cfg.work_root), [])

    def test_seccomp_and_namespace_restrictions(self):
        resp = self.exec(["python3", "probes.py"], files={"probes.py": PROBES}, net=[f"127.0.0.1:{self.up.port}"])
        r = json.loads(resp["stdout"])
        self.assertEqual(r["af_unix"], "EPERM")
        self.assertEqual(r["io_uring"], "EPERM")
        self.assertEqual(r["userns"], "EPERM")
        self.assertEqual(r["mount"], "EPERM")
        self.assertEqual(r["setns"], "EPERM")
        self.assertEqual(r["ptrace"], "EPERM")
        self.assertEqual(r["cwd"], "/work")

    def test_root_filesystem_is_read_only(self):
        resp = self.exec(["sh", "-c", "touch /usr/x 2>&1; touch /etc/x 2>&1; touch /tmp/ok && echo tmp-ok"])
        self.assertIn("Read-only file system", resp["stdout"])
        self.assertIn("tmp-ok", resp["stdout"])


class LoopbackDeniedTest(_SandboxCase):
    """With the production IP policy, loopback is refused even when declared."""

    blocked_ip = staticmethod(is_blocked_ip)

    def test_declared_loopback_is_denied(self):
        out, _ = self.client(f"http://127.0.0.1:{self.up.port}/", net=[f"127.0.0.1:{self.up.port}"])
        self.assertEqual(out["status"], 403)
        self.assertIn("loopback", out["deny"])
        self.assertEqual(self.up.requests, [])

if __name__ == "__main__":
    unittest.main()
