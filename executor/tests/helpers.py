from __future__ import annotations

import http.client
import json
import os
import shutil
import socket
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any, Dict, List, Optional, Tuple

from executor.config import Config
from executor.sandbox import Sandbox
from executor.server import ExecutorServer
from executor.worker import WorkerPool


class UnixHTTPConnection(http.client.HTTPConnection):
    def __init__(self, path: str, timeout: float = 60) -> None:
        super().__init__("localhost", timeout=timeout)
        self._path = path

    def connect(self) -> None:
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.settimeout(self.timeout)
        s.connect(self._path)
        self.sock = s


def request(sock: str, method: str, path: str, body: Any = None, timeout: float = 60) -> Tuple[int, Any]:
    conn = UnixHTTPConnection(sock, timeout=timeout)
    try:
        data = None if body is None else json.dumps(body).encode()
        headers = {} if data is None else {"Content-Type": "application/json"}
        conn.request(method, path, body=data, headers=headers)
        resp = conn.getresponse()
        return resp.status, json.loads(resp.read() or b"null")
    finally:
        conn.close()


def short_tmpdir() -> str:
    # macOS limits unix socket paths to 104 bytes; keep them short.
    base = "/tmp" if os.path.isdir("/tmp") else None
    return tempfile.mkdtemp(prefix="exe-", dir=base)


class RunningServer:
    """An ExecutorServer on a temporary socket, served from a thread."""

    def __init__(self, cfg: Config, sandbox: Sandbox, workers: Optional[WorkerPool] = None) -> None:
        self.server = ExecutorServer(cfg, sandbox, workers)
        self.socket = cfg.socket_path
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.1}, daemon=True)
        self.thread.start()

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()


class RecordingUpstream:
    """A plain HTTP server that records request headers and answers ``ok``."""

    def __init__(self, host: str = "127.0.0.1") -> None:
        self.requests: List[Dict[str, Any]] = []
        outer = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a: Any) -> None:
                pass

            def _answer(self) -> None:
                length = int(self.headers.get("Content-Length") or 0)
                body = self.rfile.read(length) if length else b""
                outer.requests.append(
                    {"method": self.command, "path": self.path, "headers": dict(self.headers.items()), "body": body}
                )
                payload = b"ok"
                self.send_response(200)
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            do_GET = do_POST = _answer

        self.httpd = HTTPServer((host, 0), H)
        self.port = self.httpd.server_address[1]
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def close(self) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()


def rmtree(path: str) -> None:
    shutil.rmtree(path, ignore_errors=True)
