"""Pool of resident Python workers for function calls (alert-gate checks).

Workers are isolated at the container level only (no secrets, read-only
root, egress limited by NetworkPolicy); they don't use bubblewrap, so they
keep working when user namespaces are unavailable. A call that times out
kills its worker and starts a replacement.
"""

from __future__ import annotations

import json
import os
import queue
import re
import selectors
import signal
import subprocess
import sys
import tempfile
import time
from typing import Any, Dict, Optional

from .policy import RequestError

CHILD = os.path.join(os.path.dirname(os.path.abspath(__file__)), "worker_child.py")
_FUNC = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,63}$")
MAX_RESPONSE_BYTES = 4 * 1024 * 1024


class _WorkerFailure(Exception):
    """The worker can't be reused; ``kind`` says why."""

    def __init__(self, kind: str, message: str) -> None:
        super().__init__(message)
        self.kind = kind
        self.message = message


class _Worker:
    def __init__(self, python: str, root: str, cwd: str) -> None:
        self.proc = subprocess.Popen(
            [python, "-I", "-S", CHILD, root],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            env={"PATH": "/usr/local/bin:/usr/bin:/bin", "HOME": cwd, "LANG": "C.UTF-8", "PYTHONDONTWRITEBYTECODE": "1"},
            cwd=cwd,
            close_fds=True,
            start_new_session=True,
        )

    def alive(self) -> bool:
        return self.proc.poll() is None

    def kill(self) -> None:
        # The worker leads its own session: kill the whole group so processes
        # a check started don't outlive it.
        try:
            os.killpg(self.proc.pid, signal.SIGKILL)
        except OSError:
            pass
        self.proc.wait()
        for pipe in (self.proc.stdin, self.proc.stdout):
            try:
                if pipe:
                    pipe.close()
            except OSError:
                pass

    def call(self, payload: Dict[str, Any], timeout: float) -> Dict[str, Any]:
        """Return the response, or raise _WorkerFailure (the worker is then unusable)."""
        assert self.proc.stdin and self.proc.stdout
        try:
            self.proc.stdin.write((json.dumps(payload) + "\n").encode())
            self.proc.stdin.flush()
        except OSError as exc:
            raise _WorkerFailure("WorkerDied", f"cannot send to worker: {exc}") from None
        fd = self.proc.stdout.fileno()
        deadline = time.monotonic() + timeout
        buf = bytearray()
        with selectors.DefaultSelector() as sel:
            sel.register(fd, selectors.EVENT_READ)
            while b"\n" not in buf:
                left = deadline - time.monotonic()
                if left <= 0 or not sel.select(left):
                    raise _WorkerFailure("Timeout", f"call exceeded {timeout}s")
                chunk = os.read(fd, 65536)
                if not chunk:
                    code = self.proc.wait()
                    raise _WorkerFailure("WorkerDied", f"worker exited with status {code} during the call")
                buf += chunk
                if len(buf) > MAX_RESPONSE_BYTES:
                    raise _WorkerFailure("ResponseTooLarge", f"response larger than {MAX_RESPONSE_BYTES} bytes")
        line, _, rest = bytes(buf).partition(b"\n")
        if rest:
            raise _WorkerFailure("ProtocolError", "worker wrote more than one response")
        try:
            return json.loads(line)
        except ValueError:
            raise _WorkerFailure("ProtocolError", "worker response is not JSON") from None


class WorkerPool:
    def __init__(self, root: str, count: int, max_timeout: float, python: str = sys.executable) -> None:
        self.root = os.path.realpath(root)
        self.count = count
        self.max_timeout = max_timeout
        self.python = python
        self._cwd = tempfile.mkdtemp(prefix="worker-")
        self._idle: "queue.Queue[_Worker]" = queue.Queue()
        for _ in range(count):
            self._idle.put(self._spawn())

    def _spawn(self) -> _Worker:
        return _Worker(self.python, self.root, self._cwd)

    def _replace(self, worker: _Worker) -> _Worker:
        """Kill ``worker`` and start a new one. On failure keep the dead one
        in the pool, so the slot isn't lost; the next call retries."""
        worker.kill()
        try:
            return self._spawn()
        except OSError:
            return worker

    def close(self) -> None:
        while True:
            try:
                self._idle.get_nowait().kill()
            except queue.Empty:
                return

    def _resolve(self, entry: Any) -> str:
        if not isinstance(entry, str) or not entry.endswith(".py") or entry.startswith("/") or ".." in entry.split("/"):
            raise RequestError("invalid_entry", "entry must be a relative path to a .py file under the worker root")
        path = os.path.realpath(os.path.join(self.root, entry))
        if not path.startswith(self.root + os.sep) or not os.path.isfile(path):
            raise RequestError("entry_not_found", f"entry {entry!r} not found", status=404)
        return entry

    def call(self, obj: Any) -> Dict[str, Any]:
        if not isinstance(obj, dict):
            raise RequestError("invalid_request", "body must be a JSON object")
        entry = self._resolve(obj.get("entry"))
        function = obj.get("function", "run")
        if not isinstance(function, str) or not _FUNC.match(function):
            raise RequestError("invalid_request", "function must be an identifier")
        try:
            timeout = float(obj.get("timeoutSec", 3))
        except (TypeError, ValueError):
            raise RequestError("invalid_request", "timeoutSec must be a number") from None
        if not 0 < timeout <= self.max_timeout:
            raise RequestError("invalid_request", f"timeoutSec must be in (0, {self.max_timeout}]")
        try:
            worker = self._idle.get(timeout=1)
        except queue.Empty:
            raise RequestError("busy", "all workers are busy", status=429) from None

        if not worker.alive():
            worker = self._replace(worker)
            if not worker.alive():
                self._idle.put(worker)
                raise RequestError("worker_unavailable", "cannot start a worker process", status=503)

        started = time.monotonic()
        failure: Optional[_WorkerFailure] = None
        resp: Dict[str, Any] = {}
        try:
            resp = worker.call({"entry": entry, "function": function, "args": obj.get("args")}, timeout)
        except _WorkerFailure as exc:
            failure = exc
            worker = self._replace(worker)
        finally:
            self._idle.put(worker)
        duration = int((time.monotonic() - started) * 1000)
        if failure is not None:
            return {
                "ok": False,
                "timedOut": failure.kind == "Timeout",
                "durationMs": duration,
                "error": {"type": failure.kind, "message": failure.message + "; worker restarted"},
            }
        resp.update({"timedOut": False, "durationMs": duration})
        return resp
