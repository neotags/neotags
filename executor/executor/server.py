"""HTTP/1.1 over a unix socket.

* ``GET /healthz``: sandbox and worker status.
* ``POST /v1/exec``: run a command in a fresh bubblewrap sandbox.
* ``POST /v1/call``: call a function in a resident worker.

Errors use ``{"error": {"code": ..., "message": ...}}``. Every exec and call
writes one audit line with names only, never credential values or output.
"""

from __future__ import annotations

import json
import os
import socket
import socketserver
import stat
import sys
import threading
from http.server import BaseHTTPRequestHandler
from typing import Any, Optional

from . import __version__
from .config import Config
from .log import log
from .policy import RequestError, parse_exec_request
from .sandbox import Sandbox, describe
from .worker import WorkerPool


class _Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server: "ExecutorServer"

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A002 - stdlib signature
        pass

    def address_string(self) -> str:
        return "unix"

    def _send(self, status: int, obj: Any) -> None:
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _error(self, err: RequestError, body_unread: bool = False) -> None:
        if body_unread:
            # Leftover body bytes would be parsed as the next request.
            self.close_connection = True
        self._send(err.status, {"error": {"code": err.code, "message": err.message}})

    def _read_body(self) -> bytes:
        """Read the whole body, so every later error keeps the connection usable."""
        try:
            length = int(self.headers.get("Content-Length", ""))
        except ValueError:
            raise RequestError("length_required", "Content-Length is required", status=411) from None
        if length < 0:
            raise RequestError("invalid_length", "Content-Length must not be negative")
        if length > self.server.cfg.max_request_bytes:
            raise RequestError("too_large", "request body too large", status=413)
        return self.rfile.read(length)

    def do_GET(self) -> None:  # noqa: N802 - stdlib naming
        if self.path != "/healthz":
            return self._error(RequestError("not_found", "no such endpoint", status=404))
        self._send(200, self.server.health())

    def do_POST(self) -> None:  # noqa: N802 - stdlib naming
        try:
            raw = self._read_body()
        except RequestError as err:
            return self._error(err, body_unread=True)
        try:
            route = {"/v1/exec": self.server.exec, "/v1/call": self.server.call}.get(self.path)
            if route is None:
                raise RequestError("not_found", "no such endpoint", status=404)
            try:
                body = json.loads(raw)
            except ValueError:
                raise RequestError("invalid_json", "body must be JSON") from None
            self._send(200, route(body))
        except RequestError as err:
            self._error(err)
        except Exception as exc:  # noqa: BLE001 - always answer, never drop the connection
            log("internal_error", level="error", path=self.path, error=f"{type(exc).__name__}: {exc}")
            self._error(RequestError("internal_error", f"{type(exc).__name__}: {exc}", status=500))


class ExecutorServer(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True

    def __init__(self, cfg: Config, sandbox: Sandbox, workers: Optional[WorkerPool]) -> None:
        self.cfg = cfg
        self.sandbox = sandbox
        self.workers = workers
        self._slots = threading.BoundedSemaphore(cfg.max_concurrency)
        _prepare_socket_path(cfg.socket_path)
        super().__init__(cfg.socket_path, _Handler)
        os.chmod(cfg.socket_path, cfg.socket_mode)

    def handle_error(self, request: Any, client_address: Any) -> None:
        exc = sys.exc_info()[1]
        if isinstance(exc, (BrokenPipeError, ConnectionResetError)):
            return  # the client went away; nothing to answer
        log("handler_error", level="error", error=f"{type(exc).__name__}: {exc}")

    def health(self) -> dict:
        return {
            "version": __version__,
            "exec": {
                "available": self.sandbox.available,
                "reason": self.sandbox.reason,
                "mode": self.sandbox.mode,
            },
            "worker": {
                "enabled": self.workers is not None,
                "workers": self.workers.count if self.workers else 0,
            },
        }

    def exec(self, body: Any) -> dict:
        if not self.sandbox.available:
            log("exec_refused", level="warn", reason=self.sandbox.reason)
            raise RequestError("sandbox_unavailable", self.sandbox.reason or "sandbox unavailable", status=503)
        req = parse_exec_request(body, self.cfg.defaults, self.cfg.maxima)
        if not self._slots.acquire(blocking=False):
            raise RequestError("busy", f"executor is at its concurrency limit ({self.cfg.max_concurrency})", status=429)
        try:
            result = self.sandbox.run(req)
        except RequestError as err:
            log("exec_rejected", level="warn", code=err.code, **describe(req))
            raise
        finally:
            self._slots.release()
        denied = [e for e in result.egress if e.get("decision") != "allow"]
        log(
            "exec",
            exitCode=result.exit_code,
            signal=result.signal,
            timedOut=result.timed_out,
            durationMs=result.duration_ms,
            egressAllowed=len(result.egress) - len(denied),
            egressDenied=[f"{e.get('host')}:{e.get('port')}" for e in denied][:20],
            injected=sorted({n for e in result.egress for n in e.get("injected", [])}),
            **describe(req),
        )
        return result.to_json(req.id)

    def call(self, body: Any) -> dict:
        if self.workers is None:
            raise RequestError("worker_disabled", "resident workers are not enabled (EXECUTOR_WORKERS=0)", status=503)
        resp = self.workers.call(body)
        log(
            "call",
            id=body.get("id") if isinstance(body, dict) else None,
            entry=body.get("entry") if isinstance(body, dict) else None,
            ok=resp.get("ok"),
            timedOut=resp.get("timedOut"),
            durationMs=resp.get("durationMs"),
        )
        if isinstance(body, dict) and isinstance(body.get("id"), str):
            resp["id"] = body["id"]
        return resp


def _prepare_socket_path(path: str) -> None:
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    try:
        st = os.lstat(path)
    except FileNotFoundError:
        return
    if not stat.S_ISSOCK(st.st_mode):
        raise RuntimeError(f"{path} exists and is not a socket")
    # Refuse to steal the socket from a live executor.
    probe = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        probe.connect(path)
    except OSError:
        os.unlink(path)
    else:
        raise RuntimeError(f"another process is listening on {path}")
    finally:
        probe.close()
