import os
import socket
import unittest

from executor.policy import NetRule
from executor.proxy import EgressProxy, Injection
from tests.helpers import RecordingUpstream, rmtree, short_tmpdir

SECRET = "real-token-value-123"
PLACEHOLDER = "neotags-placeholder-api_token-abc"


def allow_all(_addr):
    return None


def raw(sock_path, data: bytes) -> bytes:
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.settimeout(10)
    s.connect(sock_path)
    s.sendall(data)
    out = b""
    while True:
        chunk = s.recv(65536)
        if not chunk:
            break
        out += chunk
    s.close()
    return out


class ProxyTest(unittest.TestCase):
    def setUp(self):
        self.tmp = short_tmpdir()
        self.sock = os.path.join(self.tmp, "p.sock")
        self.up = RecordingUpstream()

    def tearDown(self):
        self.up.close()
        rmtree(self.tmp)

    def proxy(self, rules, injections=(), blocked_ip=allow_all, resolver=None):
        kwargs = {"blocked_ip": blocked_ip}
        if resolver:
            kwargs["resolver"] = resolver
        return EgressProxy(self.sock, rules, injections, **kwargs)

    def test_undeclared_host_is_denied(self):
        with self.proxy([NetRule("127.0.0.1", self.up.port)]) as p:
            out = raw(self.sock, f"GET http://127.0.0.2:{self.up.port}/ HTTP/1.1\r\nHost: x\r\n\r\n".encode())
            self.assertIn(b" 403 ", out.split(b"\r\n")[0])
            self.assertIn(b"not declared", out)
            out = raw(self.sock, b"CONNECT evil.example.com:443 HTTP/1.1\r\n\r\n")
            self.assertIn(b" 403 ", out.split(b"\r\n")[0])
        self.assertEqual(self.up.requests, [])
        self.assertEqual([e["decision"] for e in p.events], ["deny", "deny"])

    def test_undeclared_port_is_denied(self):
        with self.proxy([NetRule("127.0.0.1")]):
            out = raw(self.sock, f"GET http://127.0.0.1:{self.up.port}/ HTTP/1.1\r\n\r\n".encode())
        self.assertIn(b" 403 ", out.split(b"\r\n")[0])

    def test_loopback_and_metadata_denied_by_default_policy(self):
        def resolver(host, port):
            return {"meta.example.com": ["169.254.169.254"], "mixed.example.com": ["10.0.0.5", "127.0.0.1"]}[host]

        rules = [NetRule("127.0.0.1", self.up.port), NetRule("meta.example.com"), NetRule("mixed.example.com")]
        from executor.policy import is_blocked_ip

        with self.proxy(rules, blocked_ip=is_blocked_ip, resolver=None):
            out = raw(self.sock, f"GET http://127.0.0.1:{self.up.port}/ HTTP/1.1\r\n\r\n".encode())
            self.assertIn(b"loopback", out)
        with self.proxy(rules, blocked_ip=is_blocked_ip, resolver=resolver):
            out = raw(self.sock, b"GET http://meta.example.com/latest/meta-data/ HTTP/1.1\r\n\r\n")
            self.assertIn(b"metadata", out)
            out = raw(self.sock, b"CONNECT mixed.example.com:443 HTTP/1.1\r\n\r\n")
            self.assertIn(b"loopback", out)
        self.assertEqual(self.up.requests, [])

    def test_credential_injected_only_in_declared_header_and_host(self):
        inj = Injection(PLACEHOLDER, SECRET, frozenset({"127.0.0.1"}), "authorization", "API_TOKEN")
        with self.proxy([NetRule("127.0.0.1", self.up.port)], [inj]) as p:
            out = raw(
                self.sock,
                (
                    f"POST http://127.0.0.1:{self.up.port}/api/x?q=1 HTTP/1.1\r\n"
                    f"Host: wrong\r\nAuthorization: Bearer {PLACEHOLDER}\r\n"
                    f"X-Other: {PLACEHOLDER}\r\nProxy-Authorization: nope\r\n"
                    f"Content-Length: 4\r\n\r\n{PLACEHOLDER[:4]}"
                ).encode(),
            )
        self.assertIn(b"200", out.split(b"\r\n")[0])
        self.assertNotIn(SECRET.encode(), out)
        [got] = self.up.requests
        self.assertEqual(got["path"], "/api/x?q=1")
        self.assertEqual(got["headers"]["Authorization"], f"Bearer {SECRET}")
        self.assertEqual(got["headers"]["X-Other"], PLACEHOLDER)
        self.assertEqual(got["headers"]["Host"], f"127.0.0.1:{self.up.port}")
        self.assertNotIn("Proxy-Authorization", got["headers"])
        self.assertEqual(got["body"], PLACEHOLDER[:4].encode())
        self.assertEqual(p.events[0]["injected"], ["API_TOKEN"])

    def test_credential_not_injected_for_other_hosts(self):
        other = RecordingUpstream()
        try:
            inj = Injection(PLACEHOLDER, SECRET, frozenset({"obs.example.com"}), "authorization", "API_TOKEN")
            with self.proxy([NetRule("127.0.0.1", other.port)], [inj]):
                raw(
                    self.sock,
                    f"GET http://127.0.0.1:{other.port}/ HTTP/1.1\r\nAuthorization: Bearer {PLACEHOLDER}\r\n\r\n".encode(),
                )
            self.assertEqual(other.requests[0]["headers"]["Authorization"], f"Bearer {PLACEHOLDER}")
        finally:
            other.close()

    def test_chunked_body_is_forwarded_with_length(self):
        with self.proxy([NetRule("127.0.0.1", self.up.port)]):
            raw(
                self.sock,
                (
                    f"POST http://127.0.0.1:{self.up.port}/ HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n"
                    "5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n"
                ).encode(),
            )
        self.assertEqual(self.up.requests[0]["body"], b"hello world")

    def test_smuggling_shapes_are_rejected(self):
        port = self.up.port
        base = f"POST http://127.0.0.1:{port}/ HTTP/1.1\r\n"
        cases = {
            "CL and TE": base + "Content-Length: 4\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n",
            "two CL": base + "Content-Length: 1\r\nContent-Length: 2\r\n\r\nab",
            "two TE": base + "Transfer-Encoding: chunked\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n",
            "TE not chunked": base + "Transfer-Encoding: gzip, chunked\r\n\r\n0\r\n\r\n",
            "bare LF in header": base + "X-A: 1\nX-B: 2\r\n\r\n",
            "bare CR in header": base + "X-A: 1\rX-B: 2\r\n\r\n",
            "NUL in header": base + "X-A: 1\x002\r\n\r\n",
            "obs-fold": base + "X-A: 1\r\n  continued\r\n\r\n",
            "space before colon": base + "Content-Length : 4\r\n\r\nabcd",
            "negative chunk": base + "Transfer-Encoding: chunked\r\n\r\n-1\r\nx\r\n0\r\n\r\n",
            "chunk size junk": base + "Transfer-Encoding: chunked\r\n\r\n0x5\r\nhello\r\n0\r\n\r\n",
            "signed CL": base + "Content-Length: +4\r\n\r\nabcd",
            "bad version": f"GET http://127.0.0.1:{port}/ HTTP/2.0\r\n\r\n",
            "bad method": f"G@T http://127.0.0.1:{port}/ HTTP/1.1\r\n\r\n",
        }
        with self.proxy([NetRule("127.0.0.1", port)]):
            for name, req in cases.items():
                with self.subTest(name=name):
                    out = raw(self.sock, req.encode("latin-1"))
                    self.assertRegex(out.split(b"\r\n")[0], rb" (400|501) ")
        self.assertEqual(self.up.requests, [])

    def test_https_absolute_form_is_rejected(self):
        with self.proxy([NetRule("127.0.0.1", self.up.port)]):
            out = raw(self.sock, f"GET https://127.0.0.1:{self.up.port}/ HTTP/1.1\r\n\r\n".encode())
        self.assertIn(b" 400 ", out.split(b"\r\n")[0])

    def test_connect_tunnels_to_declared_host(self):
        with self.proxy([NetRule("127.0.0.1", self.up.port)]):
            out = raw(
                self.sock,
                f"CONNECT 127.0.0.1:{self.up.port} HTTP/1.1\r\n\r\nGET /tunnel HTTP/1.0\r\n\r\n".encode(),
            )
        self.assertTrue(out.startswith(b"HTTP/1.1 200 Connection Established"))
        self.assertIn(b"ok", out)
        self.assertEqual(self.up.requests[0]["path"], "/tunnel")


if __name__ == "__main__":
    unittest.main()
