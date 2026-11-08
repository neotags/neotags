"""Per-call execution in a fresh bubblewrap sandbox.

Each call gets new user, mount, PID, network, IPC, UTS, and cgroup
namespaces; a fresh ``/work`` directory; a read-only view of ``/usr``; no
environment from the executor; and rlimits for CPU, memory, file size, and
process count. The only way out is the per-call egress proxy.

If bubblewrap can't create a sandbox at startup (most often because user
namespaces are unavailable), every call is refused. There is no fallback to
running without a sandbox.
"""

from __future__ import annotations

import os
import shutil
import signal
import subprocess
import tempfile
import threading
import time
from dataclasses import dataclass, field
from typing import Callable, Dict, List, Optional, Sequence, Tuple

from .config import Config
from .log import log
from .policy import (
    ExecRequest,
    Limits,
    NetRule,
    RequestError,
    is_blocked_ip,
    make_placeholder,
)
from .proxy import EgressProxy, Injection, Resolver, default_resolver

PKG_DIR = os.path.dirname(os.path.abspath(__file__))
SANDBOX_PKG_DIR = "/opt/executor"
SANDBOX_PROXY_SOCK = "/run/egress.sock"
BRIDGE_PORT = 3128

_ROOT_DIRS = ("/bin", "/sbin", "/lib", "/lib32", "/lib64", "/libx32")
_ETC_FILES = (
    "/etc/ssl",
    "/etc/ca-certificates",
    "/etc/ld.so.cache",
    "/etc/ld.so.conf",
    "/etc/ld.so.conf.d",
    "/etc/nsswitch.conf",
    "/etc/localtime",
    "/etc/alternatives",
    "/etc/mime.types",
)
_FSIZE_BYTES = 256 * 1024 * 1024
_NOFILE = 1024
_NPROC = 1024


@dataclass
class ExecResult:
    exit_code: int
    signal: Optional[str]
    stdout: bytes
    stderr: bytes
    stdout_truncated: bool
    stderr_truncated: bool
    duration_ms: int
    timed_out: bool
    egress: List[Dict[str, object]] = field(default_factory=list)

    def to_json(self, req_id: str) -> Dict[str, object]:
        return {
            "id": req_id,
            "exitCode": self.exit_code,
            "signal": self.signal,
            "timedOut": self.timed_out,
            "durationMs": self.duration_ms,
            "stdout": self.stdout.decode("utf-8", "replace"),
            "stderr": self.stderr.decode("utf-8", "replace"),
            "truncated": {"stdout": self.stdout_truncated, "stderr": self.stderr_truncated},
            "egress": self.egress,
        }


class _Capture(threading.Thread):
    """Read a pipe to EOF, keeping at most ``cap`` bytes."""

    def __init__(self, pipe, cap: int) -> None:
        super().__init__(daemon=True)
        self.pipe = pipe
        self.cap = cap
        self.data = bytearray()
        self.truncated = False

    def run(self) -> None:
        try:
            while True:
                chunk = self.pipe.read1(65536) if hasattr(self.pipe, "read1") else self.pipe.read(65536)
                if not chunk:
                    break
                room = self.cap - len(self.data)
                if room > 0:
                    self.data += chunk[:room]
                if len(chunk) > room:
                    self.truncated = True
        except (OSError, ValueError):
            pass


def _feed(pipe, data: bytes) -> None:
    try:
        if data:
            pipe.write(data)
    except (BrokenPipeError, OSError):
        pass
    finally:
        try:
            pipe.close()
        except OSError:
            pass


class Sandbox:
    def __init__(
        self,
        cfg: Config,
        blocked_ip: Callable[[str], Optional[str]] = is_blocked_ip,
        resolver: Resolver = default_resolver,
    ) -> None:
        self.cfg = cfg
        self.blocked_ip = blocked_ip
        self.resolver = resolver
        self.available = False
        self.reason: Optional[str] = "self-check has not run"
        self.mount_proc = True
        self.disable_userns = True
        self.mode: Optional[str] = None

    # -- self-check ----------------------------------------------------------

    def self_check(self) -> bool:
        """Probe the full sandbox once. Sets ``available`` and ``reason``."""
        if not shutil.which(self.cfg.bwrap):
            return self._unavailable(f"bubblewrap not found ({self.cfg.bwrap})")
        if self.cfg.prlimit and not shutil.which(self.cfg.prlimit):
            return self._unavailable(f"prlimit not found ({self.cfg.prlimit})")
        try:
            os.makedirs(self.cfg.work_root, mode=0o700, exist_ok=True)
        except OSError as exc:
            return self._unavailable(f"cannot create work root {self.cfg.work_root}: {exc}")
        errors = []
        # Container runtimes (Docker, and Kubernetes without procMount:
        # Unmasked) mask /proc, so a new procfs can't be mounted. Then the
        # sandbox runs without /proc rather than with the host's view of it.
        # bwrap's --disable-userns needs /proc inside the sandbox; without it,
        # the seccomp filter alone stops new user namespaces.
        modes = [(True, True), (False, True), (False, False)]
        if self.cfg.require_procfs:
            # Production: only the strongest mode, never a silent fallback.
            modes = modes[:1]
        for mount_proc, disable_userns in modes:
            probe = self._execute(
                argv=("true",),
                env={},
                files={},
                stdin=b"",
                rules=(),
                injections=(),
                limits=Limits(cpu=1.0, mem_mib=256, timeout_sec=15.0),
                mount_proc=mount_proc,
                disable_userns=disable_userns,
            )
            mode = f"procfs={'on' if mount_proc else 'off'}, disable-userns={'on' if disable_userns else 'off'}"
            if probe.exit_code == 0 and not probe.timed_out:
                self.available = True
                self.mount_proc = mount_proc
                self.disable_userns = disable_userns
                self.mode = mode
                notes = []
                if not mount_proc:
                    notes.append("procfs can't be mounted; sandboxes run without /proc")
                if not disable_userns:
                    notes.append("--disable-userns unavailable; seccomp alone blocks new user namespaces")
                self.reason = "; ".join(notes) or None
                return True
            err = probe.stderr.decode("utf-8", "replace").strip() or f"exit {probe.exit_code}"
            errors.append(f"[{mode}] {err}")
        hint = " (user namespaces unavailable, or blocked by seccomp or AppArmor in the container runtime)"
        if self.cfg.require_procfs:
            hint = (
                " (EXECUTOR_REQUIRE_PROCFS=1 accepts only a private /proc with --disable-userns; in"
                " Kubernetes this needs hostUsers: false and procMount: Unmasked)"
            )
        return self._unavailable("bubblewrap probe failed: " + " | ".join(errors) + hint)

    def _unavailable(self, reason: str) -> bool:
        self.available = False
        self.reason = reason
        return False

    # -- execution -----------------------------------------------------------

    def run(self, req: ExecRequest) -> ExecResult:
        if not self.available:
            raise RequestError("sandbox_unavailable", self.reason or "sandbox unavailable", status=503)
        injections = [self._injection(c.name, c.hosts, c.header) for c in req.credentials]
        return self._execute(
            argv=req.argv,
            env=req.env,
            files=req.files,
            stdin=req.stdin,
            rules=req.net,
            injections=injections,
            limits=req.limits,
            mount_proc=self.mount_proc,
            disable_userns=self.disable_userns,
        )

    def _injection(self, name: str, hosts: Sequence[str], header: str) -> Injection:
        path = os.path.join(self.cfg.credentials_dir, name)
        try:
            with open(path, encoding="utf-8") as f:
                value = f.read().strip()
        except OSError:
            raise RequestError(
                "credential_unavailable", f"credential {name} is not configured in the executor", status=422
            ) from None
        if not value or any(c in value for c in "\r\n\x00"):
            raise RequestError("credential_unavailable", f"credential {name} has an invalid value", status=422)
        return Injection(
            placeholder=make_placeholder(name),
            value=value,
            hosts=frozenset(hosts),
            header=header,
            name=name,
        )

    def _execute(
        self,
        argv: Sequence[str],
        env: Dict[str, str],
        files: Dict[str, bytes],
        stdin: bytes,
        rules: Sequence[NetRule],
        injections: Sequence[Injection],
        limits: Limits,
        mount_proc: bool,
        disable_userns: bool = True,
    ) -> ExecResult:
        execdir = tempfile.mkdtemp(prefix="x-", dir=self.cfg.work_root)
        proxy: Optional[EgressProxy] = None
        try:
            workdir = os.path.join(execdir, "work")
            os.mkdir(workdir, 0o700)
            for rel, data in files.items():
                dest = os.path.join(workdir, rel)
                os.makedirs(os.path.dirname(dest), exist_ok=True)
                with open(dest, "wb") as f:
                    f.write(data)
            uid, gid = os.getuid(), os.getgid()
            with open(os.path.join(execdir, "passwd"), "w") as f:
                f.write(f"sandbox:x:{uid}:{gid}:sandbox:/work:/usr/sbin/nologin\n")
            with open(os.path.join(execdir, "group"), "w") as f:
                f.write(f"sandbox:x:{gid}:\n")

            sandbox_env = {
                "PATH": ":".join(list(self.cfg.tool_path) + ["/usr/local/bin", "/usr/bin", "/bin"]),
                "HOME": "/work",
                "TMPDIR": "/tmp",
                "LANG": "C.UTF-8",
                "PYTHONDONTWRITEBYTECODE": "1",
            }
            sandbox_env.update(env)
            for inj in injections:
                sandbox_env[inj.name] = inj.placeholder

            proxy_sock = None
            if rules:
                proxy_sock = os.path.join(execdir, "egress.sock")
                proxy = EgressProxy(
                    proxy_sock,
                    rules,
                    injections,
                    blocked_ip=self.blocked_ip,
                    resolver=self.resolver,
                )
                proxy.start()
                url = f"http://127.0.0.1:{BRIDGE_PORT}"
                for k in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"):
                    sandbox_env[k] = url
                sandbox_env["NO_PROXY"] = sandbox_env["no_proxy"] = ""

            cmd = self._command(execdir, sandbox_env, argv, proxy_sock, limits, mount_proc, disable_userns)
            result = self._spawn(cmd, stdin, limits.timeout_sec)
            if proxy is not None:
                result.egress = list(proxy.events)
            return result
        finally:
            if proxy is not None:
                proxy.close()
            shutil.rmtree(execdir, ignore_errors=True)

    def _command(
        self,
        execdir: str,
        env: Dict[str, str],
        argv: Sequence[str],
        proxy_sock: Optional[str],
        limits: Limits,
        mount_proc: bool,
        disable_userns: bool = True,
    ) -> List[str]:
        cmd: List[str] = []
        if self.cfg.prlimit:
            cmd += [
                self.cfg.prlimit,
                f"--cpu={limits.cpu_seconds}",
                f"--as={limits.mem_mib * 1024 * 1024}",
                f"--fsize={_FSIZE_BYTES}",
                f"--nofile={_NOFILE}",
                f"--nproc={_NPROC}",
                "--core=0",
            ]
        cmd += [
            self.cfg.bwrap,
            "--unshare-all",
            "--unshare-user",
            "--die-with-parent",
            "--new-session",
            "--cap-drop",
            "ALL",
            "--hostname",
            "sandbox",
            "--clearenv",
        ]
        if disable_userns:
            cmd.append("--disable-userns")
        for k, v in env.items():
            cmd += ["--setenv", k, v]
        cmd += ["--ro-bind", "/usr", "/usr"]
        for d in _ROOT_DIRS:
            if os.path.islink(d):
                cmd += ["--symlink", os.readlink(d), d]
            elif os.path.isdir(d):
                cmd += ["--ro-bind", d, d]
        for p in _ETC_FILES:
            cmd += ["--ro-bind-try", p, p]
        cmd += [
            "--ro-bind", os.path.join(execdir, "passwd"), "/etc/passwd",
            "--ro-bind", os.path.join(execdir, "group"), "/etc/group",
            "--ro-bind", PKG_DIR, SANDBOX_PKG_DIR,
        ]
        if self.cfg.skills_dir:
            cmd += ["--ro-bind-try", self.cfg.skills_dir, "/skills"]
        for p in self.cfg.ro_binds:
            cmd += ["--ro-bind-try", p, p]
        cmd += ["--dev", "/dev"]
        if mount_proc:
            cmd += ["--proc", "/proc"]
        cmd += [
            "--tmpfs", "/tmp",
            "--bind", os.path.join(execdir, "work"), "/work",
            "--chdir", "/work",
        ]
        if proxy_sock:
            cmd += ["--bind", proxy_sock, SANDBOX_PROXY_SOCK]
        cmd += [
            "--",
            self.cfg.sandbox_python,
            # Isolated mode, but with site: the system seccomp module lives
            # in dist-packages.
            "-I",
            os.path.join(SANDBOX_PKG_DIR, "sandbox_init.py"),
        ]
        if proxy_sock:
            cmd += ["--proxy", SANDBOX_PROXY_SOCK, "--port", str(BRIDGE_PORT)]
        cmd += ["--"] + list(argv)
        return cmd

    def _spawn(self, cmd: List[str], stdin: bytes, timeout: float) -> ExecResult:
        cap = self.cfg.max_output_bytes
        started = time.monotonic()
        try:
            proc = subprocess.Popen(
                cmd,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                env={"PATH": "/usr/local/bin:/usr/bin:/bin", "LANG": "C.UTF-8"},
                close_fds=True,
                start_new_session=True,
            )
        except OSError as exc:
            return ExecResult(126, None, b"", f"cannot start sandbox: {exc}".encode(), False, False, 0, False)
        out = _Capture(proc.stdout, cap)
        err = _Capture(proc.stderr, cap)
        out.start()
        err.start()
        threading.Thread(target=_feed, args=(proc.stdin, stdin), daemon=True).start()
        timed_out = False
        try:
            proc.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            timed_out = True
            # bwrap runs with --die-with-parent, so killing it tears down the
            # whole PID namespace, including anything the command forked.
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            proc.wait()
        out.join(timeout=5)
        err.join(timeout=5)
        for pipe in (proc.stdout, proc.stderr):
            try:
                pipe.close()
            except OSError:
                pass
        duration = int((time.monotonic() - started) * 1000)
        code = proc.returncode
        if code < 0:
            # bwrap itself was killed (our timeout kill).
            code = 128 - code
        # bwrap reports a command killed by signal N as exit status 128+N,
        # like a shell, so a command that exits 128+N itself reads the same.
        sig = _signal_name(code - 128) if code > 128 else None
        return ExecResult(
            exit_code=code,
            signal=sig,
            stdout=bytes(out.data),
            stderr=bytes(err.data),
            stdout_truncated=out.truncated,
            stderr_truncated=err.truncated,
            duration_ms=duration,
            timed_out=timed_out,
        )


def _signal_name(num: int) -> Optional[str]:
    if not 0 < num < 65:
        return None
    try:
        return signal.Signals(num).name
    except ValueError:
        return f"SIG{num}"  # real-time signals have no name


def describe(req: ExecRequest) -> Dict[str, object]:
    """Audit fields for a request. Never includes values."""
    return {
        "id": req.id,
        "tool": req.argv[0],
        "argc": len(req.argv),
        "net": [str(r) for r in req.net],
        "credentials": [c.name for c in req.credentials],
        "limits": {"cpu": req.limits.cpu, "memMiB": req.limits.mem_mib, "timeoutSec": req.limits.timeout_sec},
    }
