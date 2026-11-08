import contextlib
import io
import json
import os
import socket
import stat
import subprocess
import time
import unittest

from executor.config import Config
from executor.sandbox import Sandbox
from executor.worker import WorkerPool
from tests.helpers import RunningServer, UnixHTTPConnection, request, rmtree, short_tmpdir

USERNS_ERROR = "bwrap: No permissions to create a new namespace, likely because the kernel does not allow non-privileged user namespaces."

CHECK = '''
import time

def run(args):
    return {"echo": args, "check": "collection_chain"}

def slow(args):
    time.sleep(10)

def boom(args):
    raise ValueError("bad alert")

def huge(args):
    return "x" * (5 * 1024 * 1024)

def die(args):
    import os
    os._exit(3)

def leave_child(args):
    import subprocess
    subprocess.Popen(["sleep", "47.25"])
    time.sleep(10)
'''


def running_commands():
    if not os.path.isdir("/proc/self"):
        return subprocess.run(["ps", "-A", "-o", "command"], capture_output=True, text=True).stdout
    out = []
    for pid in filter(str.isdigit, os.listdir("/proc")):
        try:
            with open(f"/proc/{pid}/cmdline", "rb") as f:
                out.append(f.read().replace(b"\0", b" ").decode(errors="replace"))
        except OSError:
            pass
    return "\n".join(out)


def write_exe(path, body):
    with open(path, "w") as f:
        f.write(body)
    os.chmod(path, os.stat(path).st_mode | stat.S_IXUSR)


class UserNamespaceUnavailableTest(unittest.TestCase):
    """bubblewrap can't create namespaces: exec is refused, never run unsandboxed."""

    def setUp(self):
        self.tmp = short_tmpdir()
        fake = os.path.join(self.tmp, "bwrap")
        marker = os.path.join(self.tmp, "ran")
        # A fake bwrap that would leave a marker if anything tried to run the
        # command anyway.
        write_exe(fake, f"#!/bin/sh\necho '{USERNS_ERROR}' >&2\nexit 1\n")
        self.marker = marker
        os.makedirs(os.path.join(self.tmp, "checks"))
        with open(os.path.join(self.tmp, "checks", "c.py"), "w") as f:
            f.write(CHECK)
        self.cfg = Config(
            socket_path=os.path.join(self.tmp, "exec.sock"),
            work_root=os.path.join(self.tmp, "work"),
            bwrap=fake,
            prlimit="",
        )
        self.sandbox = Sandbox(self.cfg)
        self.workers = WorkerPool(self.tmp, 1, 5)
        self.log = io.StringIO()
        with contextlib.redirect_stderr(self.log):
            self.assertFalse(self.sandbox.self_check())
        self.server = RunningServer(self.cfg, self.sandbox, self.workers)

    def tearDown(self):
        self.server.close()
        self.workers.close()
        rmtree(self.tmp)

    def test_self_check_reports_reason(self):
        self.assertFalse(self.sandbox.available)
        self.assertIn("No permissions to create a new namespace", self.sandbox.reason)
        self.assertIn("user namespaces unavailable", self.sandbox.reason)
        status, body = request(self.server.socket, "GET", "/healthz")
        self.assertEqual(status, 200)
        self.assertFalse(body["exec"]["available"])
        self.assertIn("No permissions", body["exec"]["reason"])

    def test_exec_is_refused(self):
        with contextlib.redirect_stderr(self.log):
            status, body = request(
                self.server.socket,
                "POST",
                "/v1/exec",
                {"argv": ["touch", self.marker], "constraints": {"tools": ["touch"]}},
            )
        self.assertEqual(status, 503)
        self.assertEqual(body["error"]["code"], "sandbox_unavailable")
        self.assertIn("No permissions", body["error"]["message"])
        self.assertFalse(os.path.exists(self.marker))
        events = [json.loads(line) for line in self.log.getvalue().splitlines() if line.startswith("{")]
        self.assertIn("exec_refused", [e["event"] for e in events])

    def test_resident_worker_still_works(self):
        status, body = request(
            self.server.socket, "POST", "/v1/call", {"id": "a1", "entry": "checks/c.py", "args": {"alert": 1}}
        )
        self.assertEqual(status, 200)
        self.assertTrue(body["ok"])
        self.assertEqual(body["result"], {"echo": {"alert": 1}, "check": "collection_chain"})
        self.assertEqual(body["id"], "a1")


class MaskedProcTest(unittest.TestCase):
    """A runtime that masks /proc: fallback by default, refusal when required."""

    def setUp(self):
        self.tmp = short_tmpdir()
        self.fake = os.path.join(self.tmp, "bwrap")
        # Fails like bwrap does when a new procfs can't be mounted; otherwise
        # "runs" the probe (true) successfully without executing anything.
        write_exe(
            self.fake,
            '#!/bin/sh\nfor a in "$@"; do\n'
            '  if [ "$a" = "--proc" ]; then echo "bwrap: Can\'t mount proc on /newroot/proc: Operation not permitted" >&2; exit 1; fi\n'
            "done\nexit 0\n",
        )

    def tearDown(self):
        rmtree(self.tmp)

    def sandbox(self, require):
        cfg = Config(work_root=os.path.join(self.tmp, "work"), bwrap=self.fake, prlimit="", require_procfs=require)
        sb = Sandbox(cfg)
        sb.self_check()
        return sb

    def test_falls_back_without_procfs_by_default(self):
        sb = self.sandbox(require=False)
        self.assertTrue(sb.available)
        self.assertEqual(sb.mode, "procfs=off, disable-userns=on")
        self.assertIn("without /proc", sb.reason)

    def test_refuses_when_procfs_is_required(self):
        sb = self.sandbox(require=True)
        self.assertFalse(sb.available)
        self.assertIn("Can't mount proc", sb.reason)
        self.assertIn("procMount: Unmasked", sb.reason)

    def test_require_procfs_from_env(self):
        self.assertTrue(Config.from_env({"EXECUTOR_REQUIRE_PROCFS": "1"}).require_procfs)
        self.assertFalse(Config.from_env({}).require_procfs)


class ServerValidationTest(unittest.TestCase):
    def setUp(self):
        self.tmp = short_tmpdir()
        self.cfg = Config(socket_path=os.path.join(self.tmp, "exec.sock"), work_root=self.tmp, prlimit="")
        self.sandbox = Sandbox(self.cfg)
        # Pretend the probe passed; these tests never reach bubblewrap.
        self.sandbox.available, self.sandbox.reason = True, None
        self.server = RunningServer(self.cfg, self.sandbox, None)

    def tearDown(self):
        self.server.close()
        rmtree(self.tmp)

    def test_bad_requests(self):
        cases = [
            ({"argv": ["sh"], "constraints": {"tools": ["python3"]}}, "tool_not_declared"),
            ({"argv": ["sh"]}, "invalid_request"),
            ({"argv": ["sh"], "constraints": {"tools": ["sh"], "net": ["*.example.com"]}}, "invalid_net"),
        ]
        for body, code in cases:
            with self.subTest(code=code):
                status, resp = request(self.server.socket, "POST", "/v1/exec", body)
                self.assertEqual(status, 400)
                self.assertEqual(resp["error"]["code"], code)

    def test_missing_credential_is_rejected(self):
        status, resp = request(
            self.server.socket,
            "POST",
            "/v1/exec",
            {
                "argv": ["sh"],
                "constraints": {
                    "tools": ["sh"],
                    "net": ["obs.example.com"],
                    "credentials": [{"name": "API_TOKEN", "hosts": ["obs.example.com"], "header": "Authorization"}],
                },
            },
        )
        self.assertEqual(status, 422)
        self.assertEqual(resp["error"]["code"], "credential_unavailable")

    def test_unknown_endpoint_and_disabled_worker(self):
        self.assertEqual(request(self.server.socket, "GET", "/nope")[0], 404)
        status, resp = request(self.server.socket, "POST", "/v1/call", {"entry": "x.py"})
        self.assertEqual(status, 503)
        self.assertEqual(resp["error"]["code"], "worker_disabled")

    def test_bad_input_gets_400_not_a_dropped_connection(self):
        for body in (
            {"argv": ["sh", "\ud800"], "constraints": {"tools": ["sh"]}},
            {"argv": ["sh"], "files": {"a": "x", "a/b": "y"}, "constraints": {"tools": ["sh"]}},
        ):
            conn = UnixHTTPConnection(self.server.socket)
            raw = json.dumps(body).encode()  # keeps the lone surrogate as \\ud800
            conn.request("POST", "/v1/exec", body=raw)
            resp = conn.getresponse()
            self.assertEqual(resp.status, 400, resp.read())
            conn.close()

    def test_negative_content_length_is_rejected(self):
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.settimeout(5)
        s.connect(self.server.socket)
        s.sendall(b"POST /v1/exec HTTP/1.1\r\nHost: x\r\nContent-Length: -1\r\n\r\n")
        self.assertIn(b" 400 ", s.recv(4096).split(b"\r\n")[0])
        s.close()

    def test_errors_keep_keep_alive_connection_usable(self):
        conn = UnixHTTPConnection(self.server.socket)
        for path in ("/v1/nope", "/v1/exec"):
            conn.request("POST", path, body=b'{"argv": ["GET /healthz HTTP/1.1"]}')
            resp = conn.getresponse()
            resp.read()
            self.assertIn(resp.status, (400, 404))
        conn.request("GET", "/healthz")
        resp = conn.getresponse()
        self.assertEqual(resp.status, 200)
        self.assertIn(b'"exec"', resp.read())
        conn.close()

    def test_socket_is_not_world_accessible(self):
        mode = stat.S_IMODE(os.stat(self.server.socket).st_mode)
        self.assertEqual(mode & 0o007, 0)


class WorkerPoolTest(unittest.TestCase):
    def setUp(self):
        self.tmp = short_tmpdir()
        with open(os.path.join(self.tmp, "c.py"), "w") as f:
            f.write(CHECK)
        self.pool = WorkerPool(self.tmp, 1, 5)

    def tearDown(self):
        self.pool.close()
        rmtree(self.tmp)

    def test_timeout_restarts_worker(self):
        resp = self.pool.call({"entry": "c.py", "function": "slow", "timeoutSec": 0.5})
        self.assertFalse(resp["ok"])
        self.assertTrue(resp["timedOut"])
        self.assertLess(resp["durationMs"], 3000)
        self.assertTrue(self.pool.call({"entry": "c.py", "args": 2})["ok"])

    def test_errors_are_reported(self):
        resp = self.pool.call({"entry": "c.py", "function": "boom"})
        self.assertFalse(resp["ok"])
        self.assertEqual(resp["error"]["type"], "ValueError")
        resp = self.pool.call({"entry": "c.py", "function": "missing"})
        self.assertEqual(resp["error"]["type"], "AttributeError")

    def test_oversized_response_does_not_poison_next_call(self):
        resp = self.pool.call({"entry": "c.py", "function": "huge"})
        self.assertEqual(resp["error"]["type"], "ResponseTooLarge")
        self.assertFalse(resp["timedOut"])
        self.assertEqual(self.pool.call({"entry": "c.py", "args": 7})["result"]["echo"], 7)

    def test_worker_death_is_not_reported_as_timeout(self):
        resp = self.pool.call({"entry": "c.py", "function": "die"})
        self.assertEqual(resp["error"]["type"], "WorkerDied")
        self.assertFalse(resp["timedOut"])
        self.assertTrue(self.pool.call({"entry": "c.py"})["ok"])

    def test_timeout_kills_processes_the_check_started(self):
        resp = self.pool.call({"entry": "c.py", "function": "leave_child", "timeoutSec": 1})
        self.assertTrue(resp["timedOut"])
        time.sleep(0.3)
        self.assertNotIn("sleep 47.25", running_commands())

    def test_entry_must_stay_under_root(self):
        from executor.policy import RequestError

        for entry in ("../c.py", "/etc/passwd", "c.txt", "nope.py"):
            with self.subTest(entry=entry):
                with self.assertRaises(RequestError):
                    self.pool.call({"entry": entry})


if __name__ == "__main__":
    unittest.main()
