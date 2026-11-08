import unittest

from executor.policy import (
    Limits,
    NetRule,
    RequestError,
    is_blocked_ip,
    make_placeholder,
    parse_exec_request,
    parse_net_rule,
)

DEFAULTS = Limits(cpu=1.0, mem_mib=512, timeout_sec=60.0)
MAXIMA = Limits(cpu=4.0, mem_mib=4096, timeout_sec=300.0)


def req(**over):
    body = {
        "id": "run-1/call-1",
        "argv": ["example-cli", "version"],
        "constraints": {"tools": ["example-cli"]},
    }
    body.update(over)
    return body


def parse(body):
    return parse_exec_request(body, DEFAULTS, MAXIMA)


class BlockedIpTest(unittest.TestCase):
    def test_blocks_loopback_link_local_and_metadata(self):
        for addr, why in [
            ("127.0.0.1", "loopback"),
            ("127.8.9.10", "loopback"),
            ("::1", "loopback"),
            ("169.254.169.254", "metadata"),
            ("169.254.170.23", "metadata"),
            ("fd00:ec2::254", "metadata"),
            ("100.100.100.200", "metadata"),
            ("169.254.1.1", "link-local"),
            ("fe80::1", "link-local"),
            ("0.0.0.0", "unspecified"),
            ("0.1.2.3", "unspecified"),
            ("::", "unspecified"),
            ("224.0.0.1", "multicast"),
            ("::ffff:127.0.0.1", "loopback"),
            ("::ffff:169.254.169.254", "metadata"),
            ("64:ff9b::a9fe:a9fe", "metadata"),
        ]:
            with self.subTest(addr=addr):
                self.assertEqual(is_blocked_ip(addr), why)

    def test_allows_cluster_and_public_addresses(self):
        for addr in ("10.100.0.12", "172.20.1.1", "192.168.1.1", "8.8.8.8", "2600:1f18::1"):
            with self.subTest(addr=addr):
                self.assertIsNone(is_blocked_ip(addr))


class NetRuleTest(unittest.TestCase):
    def test_parses_host_and_port(self):
        self.assertEqual(parse_net_rule("Obs.Example.com."), NetRule("obs.example.com", None))
        self.assertEqual(parse_net_rule("api.example.com:5080"), NetRule("api.example.com", 5080))
        self.assertEqual(parse_net_rule("[2600:1f18::1]:443"), NetRule("2600:1f18::1", 443))

    def test_rejects_wildcards_and_junk(self):
        for bad in ("*.example.com", "*", "example.com/path", "user@example.com", "localhost", "a.localhost", "", "ex ample.com", "host:0", "host:99999", "-bad.example.com"):
            with self.subTest(bad=bad):
                with self.assertRaises(RequestError):
                    parse_net_rule(bad)

    def test_port_matching(self):
        r = NetRule("obs.example.com")
        self.assertTrue(r.matches("OBS.example.com", 443))
        self.assertTrue(r.matches("obs.example.com", 80))
        self.assertFalse(r.matches("obs.example.com", 5080))
        self.assertFalse(r.matches("evil.obs.example.com", 443))
        self.assertTrue(NetRule("api", 5080).matches("api", 5080))
        self.assertFalse(NetRule("api", 5080).matches("api", 443))


class ExecRequestTest(unittest.TestCase):
    def test_minimal_request_gets_default_limits(self):
        r = parse(req())
        self.assertEqual(r.argv, ("example-cli", "version"))
        self.assertEqual(r.limits, DEFAULTS)
        self.assertEqual(r.net, ())

    def test_argv0_must_be_a_declared_tool(self):
        with self.assertRaises(RequestError) as ctx:
            parse(req(argv=["sh", "-c", "id"]))
        self.assertEqual(ctx.exception.code, "tool_not_declared")
        with self.assertRaises(RequestError):
            parse(req(argv=["/usr/bin/example-cli"]))

    def test_limits(self):
        r = parse(req(constraints={"tools": ["example-cli"], "limits": {"cpu": 1, "mem": "1Gi", "timeoutSec": 5}}))
        self.assertEqual(r.limits, Limits(cpu=1.0, mem_mib=1024, timeout_sec=5.0))
        self.assertEqual(r.limits.cpu_seconds, 5)
        for bad in ({"timeoutSec": 0}, {"timeoutSec": 301}, {"cpu": 8}, {"mem": "64Ti"}, {"mem": True}):
            with self.subTest(bad=bad):
                with self.assertRaises(RequestError):
                    parse(req(constraints={"tools": ["example-cli"], "limits": bad}))

    def test_credentials_must_target_declared_hosts(self):
        c = {
            "tools": ["example-cli"],
            "net": ["obs.example.com"],
            "credentials": [{"name": "API_TOKEN", "hosts": ["obs.example.com"], "header": "Authorization"}],
        }
        r = parse(req(constraints=c))
        self.assertEqual(r.credentials[0].header, "authorization")
        c["credentials"][0]["hosts"] = ["other.example.com"]
        with self.assertRaises(RequestError):
            parse(req(constraints=c))

    def test_credentials_cannot_use_framing_headers(self):
        for header in ("Host", "Content-Length", "Proxy-Authorization", "Transfer-Encoding", "bad header"):
            c = {
                "tools": ["example-cli"],
                "net": ["obs.example.com"],
                "credentials": [{"name": "T", "hosts": ["obs.example.com"], "header": header}],
            }
            with self.subTest(header=header):
                with self.assertRaises(RequestError):
                    parse(req(constraints=c))

    def test_env_cannot_override_path_proxy_or_credentials(self):
        c = {
            "tools": ["example-cli"],
            "net": ["obs.example.com"],
            "credentials": [{"name": "API_TOKEN", "hosts": ["obs.example.com"], "header": "Authorization"}],
        }
        for name in ("PATH", "HTTP_PROXY", "no_proxy", "LD_PRELOAD", "API_TOKEN", "1BAD"):
            with self.subTest(name=name):
                with self.assertRaises(RequestError):
                    parse(req(constraints=c, env={name: "x"}))
        self.assertEqual(parse(req(env={"API_ORG": "default"})).env, {"API_ORG": "default"})

    def test_files_stay_in_workdir(self):
        self.assertIn("in/query.sql", parse(req(files={"in/query.sql": "SELECT 1"})).files)
        for bad in ("/etc/passwd", "../x", "a/../../x", ".", ""):
            with self.subTest(bad=bad):
                with self.assertRaises(RequestError):
                    parse(req(files={bad: "x"}))

    def test_rejects_nul_and_bad_types(self):
        with self.assertRaises(RequestError):
            parse(req(argv=["example-cli", "a\x00b"]))
        with self.assertRaises(RequestError):
            parse(req(argv="example-cli"))
        with self.assertRaises(RequestError):
            parse(["not", "an", "object"])

    def test_placeholders_are_unique(self):
        a, b = make_placeholder("API_TOKEN"), make_placeholder("API_TOKEN")
        self.assertNotEqual(a, b)
        self.assertTrue(a.startswith("neotags-placeholder-api_token-"))


if __name__ == "__main__":
    unittest.main()
