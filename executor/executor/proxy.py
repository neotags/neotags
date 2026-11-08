"""Per-execution egress proxy on a unix socket.

Each sandboxed execution gets its own proxy instance, so the policy (allowed
hosts, credentials) is bound to the socket the sandbox can reach, not to
anything the sandbox sends.

* ``CONNECT host:port`` opens a TCP tunnel (HTTPS). The proxy can't see the
  headers, so it never injects credentials into a tunnel.
* Absolute-form ``http://`` requests are forwarded one request per connection.
  For declared hosts, the proxy replaces a credential placeholder with the real
  value, and only inside the declared header.

Every destination is checked twice: the host name must match a declared rule,
and every address it resolves to must pass ``blocked_ip`` (loopback,
link-local, metadata). The proxy connects to the address it checked, so DNS
rebinding between check and connect doesn't help.
"""

from __future__ import annotations

import os
import re
import socket
import threading
from dataclasses import dataclass
from typing import Callable, Dict, List, Optional, Sequence, Tuple
from urllib.parse import urlsplit

from .policy import NetRule, is_blocked_ip, normalize_host, split_host_port

MAX_HEAD_BYTES = 64 * 1024
MAX_BODY_BYTES = 16 * 1024 * 1024
MAX_EVENTS = 200

_HOP_BY_HOP = frozenset(
    {
        "connection",
        "keep-alive",
        "proxy-connection",
        "proxy-authorization",
        "te",
        "trailer",
        "transfer-encoding",
        "upgrade",
        "expect",
    }
)

Resolver = Callable[[str, int], List[str]]


def default_resolver(host: str, port: int) -> List[str]:
    infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    seen: List[str] = []
    for info in infos:
        addr = info[4][0]
        if addr not in seen:
            seen.append(addr)
    return seen


@dataclass(frozen=True)
class Injection:
    placeholder: str
    value: str
    hosts: frozenset
    header: str  # lower-cased
    name: str


class _Deny(Exception):
    def __init__(self, status: int, reason: str) -> None:
        super().__init__(reason)
        self.status = status
        self.reason = reason


class EgressProxy:
    def __init__(
        self,
        socket_path: str,
        rules: Sequence[NetRule],
        injections: Sequence[Injection] = (),
        blocked_ip: Callable[[str], Optional[str]] = is_blocked_ip,
        resolver: Resolver = default_resolver,
        connect_timeout: float = 10.0,
    ) -> None:
        self.socket_path = socket_path
        self.rules = tuple(rules)
        self.injections = tuple(injections)
        self.blocked_ip = blocked_ip
        self.resolver = resolver
        self.connect_timeout = connect_timeout
        self.events: List[Dict[str, object]] = []
        self._events_lock = threading.Lock()
        self._conns: List[socket.socket] = []
        self._conns_lock = threading.Lock()
        self._closed = threading.Event()
        self._sock: Optional[socket.socket] = None
        self._thread: Optional[threading.Thread] = None

    # -- lifecycle ---------------------------------------------------------

    def start(self) -> None:
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.bind(self.socket_path)
        os.chmod(self.socket_path, 0o600)
        sock.listen(64)
        sock.settimeout(0.2)
        self._sock = sock
        self._thread = threading.Thread(target=self._accept_loop, name="egress-proxy", daemon=True)
        self._thread.start()

    def close(self) -> None:
        self._closed.set()
        if self._thread is not None:
            self._thread.join(timeout=2)
        if self._sock is not None:
            self._sock.close()
        with self._conns_lock:
            conns, self._conns = self._conns, []
        for c in conns:
            _quiet_close(c)
        try:
            os.unlink(self.socket_path)
        except FileNotFoundError:
            pass

    def __enter__(self) -> "EgressProxy":
        self.start()
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    def _track(self, s: socket.socket) -> None:
        with self._conns_lock:
            self._conns.append(s)

    def _accept_loop(self) -> None:
        assert self._sock is not None
        while not self._closed.is_set():
            try:
                conn, _ = self._sock.accept()
            except socket.timeout:
                continue
            except OSError:
                return
            conn.settimeout(None)
            self._track(conn)
            threading.Thread(target=self._handle, args=(conn,), daemon=True).start()

    # -- policy --------------------------------------------------------------

    def _record(self, **event: object) -> None:
        with self._events_lock:
            if len(self.events) < MAX_EVENTS:
                self.events.append(event)

    def _check(self, host: str, port: int) -> List[str]:
        host = normalize_host(host)
        if not any(r.matches(host, port) for r in self.rules):
            raise _Deny(403, f"{host}:{port} is not declared in net")
        try:
            addrs = self.resolver(host, port)
        except OSError as exc:
            raise _Deny(502, f"cannot resolve {host}: {exc}") from None
        if not addrs:
            raise _Deny(502, f"cannot resolve {host}")
        for addr in addrs:
            why = self.blocked_ip(addr)
            if why:
                raise _Deny(403, f"{host} resolves to a {why} address")
        return addrs

    def _connect(self, addrs: List[str], port: int) -> socket.socket:
        last: Optional[OSError] = None
        for addr in addrs:
            try:
                s = socket.create_connection((addr, port), timeout=self.connect_timeout)
                s.settimeout(None)
                self._track(s)
                return s
            except OSError as exc:
                last = exc
        raise _Deny(502, f"cannot connect: {last}")

    def _inject(self, host: str, header: str, value: str) -> Tuple[str, List[str]]:
        used: List[str] = []
        for inj in self.injections:
            if header == inj.header and host in inj.hosts and inj.placeholder in value:
                value = value.replace(inj.placeholder, inj.value)
                used.append(inj.name)
        return value, used

    # -- protocol ------------------------------------------------------------

    def _handle(self, conn: socket.socket) -> None:
        method, host, port = "?", "?", 0
        try:
            head, rest = _read_head(conn)
            lines = head.decode("iso-8859-1").split("\r\n")
            parts = lines[0].split(" ")
            if len(parts) != 3:
                raise _Deny(400, "malformed request line")
            method, target, version = parts
            _check_line(lines[0])
            if not _TOKEN.match(method) or version not in ("HTTP/1.1", "HTTP/1.0"):
                raise _Deny(400, "malformed request line")
            headers = _parse_headers(lines[1:])
            if method.upper() == "CONNECT":
                try:
                    host, p = split_host_port(target)
                except ValueError:
                    raise _Deny(400, "CONNECT target must be host:port") from None
                if p is None:
                    raise _Deny(400, "CONNECT target must be host:port")
                port = p
                self._tunnel(conn, host, port, rest)
            else:
                url = urlsplit(target)
                if url.scheme != "http" or not url.hostname:
                    raise _Deny(400, "only absolute http:// URLs are proxied; use CONNECT for https")
                host = url.hostname
                port = url.port or 80
                self._forward(conn, method, url, headers, rest)
        except _Deny as d:
            self._record(method=method, host=normalize_host(host), port=port, decision="deny", reason=d.reason)
            _send_error(conn, d.status, d.reason)
        except (OSError, ValueError) as exc:
            self._record(method=method, host=normalize_host(host), port=port, decision="error", reason=str(exc))
            _send_error(conn, 502, f"proxy error: {exc}")
        finally:
            _quiet_close(conn)

    def _tunnel(self, conn: socket.socket, host: str, port: int, rest: bytes) -> None:
        addrs = self._check(host, port)
        upstream = self._connect(addrs, port)
        self._record(method="CONNECT", host=normalize_host(host), port=port, decision="allow")
        conn.sendall(b"HTTP/1.1 200 Connection Established\r\n\r\n")
        if rest:
            upstream.sendall(rest)
        t = threading.Thread(target=_pipe, args=(upstream, conn), daemon=True)
        t.start()
        _pipe(conn, upstream)
        t.join()
        _quiet_close(upstream)

    def _forward(self, conn, method, url, headers, rest) -> None:
        host = normalize_host(url.hostname)
        port = url.port or 80
        addrs = self._check(host, port)

        conn_tokens = set()
        for name, value in headers:
            if name.lower() in ("connection", "proxy-connection"):
                conn_tokens.update(t.strip().lower() for t in value.split(","))
        transfer_encoding = ""
        content_length: Optional[int] = None
        expect_continue = False
        out: List[Tuple[str, str]] = []
        injected: List[str] = []
        for name, value in headers:
            lname = name.lower()
            if lname == "transfer-encoding":
                if transfer_encoding:
                    raise _Deny(400, "duplicate Transfer-Encoding")
                transfer_encoding = value.strip().lower()
                continue
            if lname == "expect":
                expect_continue = value.strip().lower() == "100-continue"
                continue
            if lname in _HOP_BY_HOP or lname in conn_tokens or lname == "host":
                continue
            if lname == "content-length":
                if content_length is not None or not value.strip().isdigit():
                    raise _Deny(400, "invalid Content-Length")
                content_length = int(value.strip())
                continue
            value, used = self._inject(host, lname, value)
            injected.extend(used)
            out.append((name, value))

        if transfer_encoding and content_length is not None:
            # RFC 9112 6.3: a message with both is a smuggling attempt.
            raise _Deny(400, "both Transfer-Encoding and Content-Length")
        if expect_continue:
            conn.sendall(b"HTTP/1.1 100 Continue\r\n\r\n")
        reader = _Reader(conn, rest)
        if transfer_encoding:
            if transfer_encoding != "chunked":
                raise _Deny(501, f"unsupported Transfer-Encoding {transfer_encoding!r}")
            body = reader.read_chunked(MAX_BODY_BYTES)
        elif content_length is not None:
            if content_length > MAX_BODY_BYTES:
                raise _Deny(413, "request body too large")
            body = reader.read_exact(content_length)
        else:
            body = b""

        upstream = self._connect(addrs, port)
        self._record(method=method, host=host, port=port, decision="allow", injected=injected)
        path = url.path or "/"
        if url.query:
            path += "?" + url.query
        authority = url.netloc.rsplit("@", 1)[-1]
        lines = [f"{method} {path} HTTP/1.1", f"Host: {authority}"]
        lines += [f"{n}: {v}" for n, v in out]
        if body or method.upper() in ("POST", "PUT", "PATCH"):
            lines.append(f"Content-Length: {len(body)}")
        lines.append("Connection: close")
        upstream.sendall(("\r\n".join(lines) + "\r\n\r\n").encode("iso-8859-1") + body)
        _pipe(upstream, conn)
        _quiet_close(upstream)


# -- helpers -----------------------------------------------------------------


def _read_head(conn: socket.socket) -> Tuple[bytes, bytes]:
    buf = b""
    while b"\r\n\r\n" not in buf:
        chunk = conn.recv(8192)
        if not chunk:
            raise _Deny(400, "connection closed before end of headers")
        buf += chunk
        if len(buf) > MAX_HEAD_BYTES:
            raise _Deny(431, "request headers too large")
    head, rest = buf.split(b"\r\n\r\n", 1)
    return head, rest


_TOKEN = re.compile(r"^[!#$%&'*+.^_`|~0-9A-Za-z-]+$")
_CHUNK_SIZE = re.compile(rb"^[0-9A-Fa-f]{1,16}$")


def _check_line(line: str) -> None:
    # The head was split on CRLF, so any CR, LF, or NUL left is a bare one.
    # Upstreams disagree on bare LF, which is how requests get smuggled.
    if any(c in line for c in "\r\n\x00"):
        raise _Deny(400, "bare CR, LF, or NUL in request head")


def _parse_headers(lines: List[str]) -> List[Tuple[str, str]]:
    out = []
    for line in lines:
        if not line:
            continue
        _check_line(line)
        if line[0] in " \t" or ":" not in line:
            raise _Deny(400, "malformed header (obsolete line folding is not accepted)")
        name, value = line.split(":", 1)
        if not _TOKEN.match(name):
            raise _Deny(400, "malformed header name")
        out.append((name, value.strip(" \t")))
    return out


class _Reader:
    def __init__(self, conn: socket.socket, buf: bytes) -> None:
        self.conn = conn
        self.buf = bytearray(buf)

    def _fill(self) -> None:
        chunk = self.conn.recv(65536)
        if not chunk:
            raise _Deny(400, "connection closed in request body")
        self.buf += chunk

    def read_exact(self, n: int) -> bytes:
        while len(self.buf) < n:
            self._fill()
        data = bytes(self.buf[:n])
        del self.buf[:n]
        return data

    def read_line(self) -> bytes:
        while True:
            i = self.buf.find(b"\r\n")
            if i >= 0:
                line = bytes(self.buf[:i])
                del self.buf[: i + 2]
                return line
            if len(self.buf) > MAX_HEAD_BYTES:
                raise _Deny(400, "chunk header too long")
            self._fill()

    def read_chunked(self, limit: int) -> bytes:
        body = bytearray()
        while True:
            size_line = self.read_line().split(b";", 1)[0].strip()
            if not _CHUNK_SIZE.match(size_line):
                raise _Deny(400, "invalid chunk size")
            size = int(size_line, 16)
            if size == 0:
                while self.read_line():  # trailers
                    pass
                return bytes(body)
            if len(body) + size > limit:
                raise _Deny(413, "request body too large")
            body += self.read_exact(size)
            if self.read_exact(2) != b"\r\n":
                raise _Deny(400, "invalid chunk terminator")


def _pipe(src: socket.socket, dst: socket.socket) -> None:
    try:
        while True:
            data = src.recv(65536)
            if not data:
                break
            dst.sendall(data)
    except OSError:
        pass
    try:
        dst.shutdown(socket.SHUT_WR)
    except OSError:
        pass


def _send_error(conn: socket.socket, status: int, reason: str) -> None:
    body = f"egress denied by neotags executor: {reason}\n".encode()
    phrase = {400: "Bad Request", 403: "Forbidden", 413: "Payload Too Large", 431: "Request Header Fields Too Large", 501: "Not Implemented", 502: "Bad Gateway"}.get(status, "Error")
    head = (
        f"HTTP/1.1 {status} {phrase}\r\n"
        "Content-Type: text/plain; charset=utf-8\r\n"
        f"Content-Length: {len(body)}\r\n"
        f"X-Executor-Deny: {reason.encode('ascii', 'replace').decode()}\r\n"
        "Connection: close\r\n\r\n"
    )
    try:
        conn.sendall(head.encode() + body)
    except OSError:
        pass


def _quiet_close(s: socket.socket) -> None:
    # shutdown() first: on Linux, close() alone doesn't wake a recv() blocked
    # in another thread, which would leak tunnel threads and connections.
    try:
        s.shutdown(socket.SHUT_RDWR)
    except OSError:
        pass
    try:
        s.close()
    except OSError:
        pass
