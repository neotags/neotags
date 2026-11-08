"""Request validation and egress policy.

The executor trusts nothing in a request beyond what it can check here. The
caller (the neotags Tool Guard) has already matched the request against the skill
pack's ``sandbox`` declaration; these checks are defense in depth.
"""

from __future__ import annotations

import ipaddress
import math
import posixpath
import re
import secrets
from dataclasses import dataclass
from typing import Any, Dict, List, Mapping, Optional, Tuple


class RequestError(Exception):
    """A request the executor refuses. Maps to an HTTP error body."""

    def __init__(self, code: str, message: str, status: int = 400) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status


_HOST_LABEL = re.compile(r"^(?!-)[a-z0-9-]{1,63}(?<!-)$")
_ENV_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,127}$")
_CRED_NAME = re.compile(r"^[A-Z][A-Z0-9_]{0,63}$")
_HEADER_NAME = re.compile(r"^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$")
_TOOL_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$")
_ID = re.compile(r"^[A-Za-z0-9._:/-]{1,128}$")

# Headers a credential may never be injected into.
_FORBIDDEN_CRED_HEADERS = frozenset(
    {
        "host",
        "content-length",
        "transfer-encoding",
        "connection",
        "keep-alive",
        "te",
        "trailer",
        "upgrade",
        "proxy-authorization",
        "proxy-connection",
    }
)

# Env names the request may not set: they would bypass the proxy, the tool
# check, or shadow a credential placeholder.
_RESERVED_ENV = frozenset(
    {
        "PATH",
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "NO_PROXY",
        "http_proxy",
        "https_proxy",
        "all_proxy",
        "no_proxy",
    }
)

MAX_ARGV = 256
MAX_ARG_BYTES = 8192
MAX_STDIN_BYTES = 1024 * 1024
MAX_FILES_BYTES = 4 * 1024 * 1024
MAX_NET_RULES = 16
MAX_CREDENTIALS = 8

# Cloud metadata endpoints that are not covered by the link-local check.
_METADATA_ADDRS = frozenset(
    ipaddress.ip_address(a)
    for a in (
        "169.254.169.254",  # AWS, GCP, Azure IMDS (link-local, listed for clarity)
        "169.254.170.2",  # ECS task metadata
        "169.254.170.23",  # EKS Pod Identity agent
        "fd00:ec2::254",  # AWS IMDS over IPv6 (ULA, not link-local)
        "fd00:ec2::23",  # EKS Pod Identity agent over IPv6
        "100.100.100.200",  # Alibaba Cloud metadata
        "192.0.0.192",  # Oracle Cloud metadata
    )
)
_THIS_NETWORK = ipaddress.ip_network("0.0.0.0/8")
_NAT64 = ipaddress.ip_network("64:ff9b::/96")


def is_blocked_ip(addr: str) -> Optional[str]:
    """Return why ``addr`` must not be reached through the proxy, or None."""
    try:
        ip = ipaddress.ip_address(addr.split("%", 1)[0])
    except ValueError:
        return "invalid"
    if ip.version == 6:
        if ip.ipv4_mapped is not None:
            ip = ip.ipv4_mapped
        elif ip in _NAT64:
            ip = ipaddress.ip_address(int(ip) & 0xFFFFFFFF)
    if ip in _METADATA_ADDRS:
        return "metadata"
    if ip.is_loopback:
        return "loopback"
    if ip.is_link_local:
        return "link-local"
    if ip.is_unspecified or (ip.version == 4 and ip in _THIS_NETWORK):
        return "unspecified"
    if ip.is_multicast:
        return "multicast"
    return None


def normalize_host(host: str) -> str:
    host = host.strip().lower().rstrip(".")
    if host.startswith("[") and host.endswith("]"):
        host = host[1:-1]
    return host


def split_host_port(value: str) -> Tuple[str, Optional[int]]:
    """Split ``host``, ``host:port``, or ``[v6]:port``."""
    if value.startswith("["):
        end = value.find("]")
        if end < 0:
            raise ValueError("unterminated IPv6 literal")
        host, rest = value[1:end], value[end + 1 :]
        if not rest:
            return host, None
        if not rest.startswith(":"):
            raise ValueError("junk after IPv6 literal")
        return host, _port(rest[1:])
    if value.count(":") == 1:
        host, port = value.split(":")
        return host, _port(port)
    if value.count(":") > 1:
        # Bare IPv6 literal without a port.
        return value, None
    return value, None


def _port(raw: str) -> int:
    if not raw.isdigit():
        raise ValueError("port must be numeric")
    port = int(raw)
    if not 1 <= port <= 65535:
        raise ValueError("port out of range")
    return port


def _valid_host(host: str) -> bool:
    try:
        ipaddress.ip_address(host)
        return True
    except ValueError:
        pass
    if len(host) > 253 or host == "localhost" or host.endswith(".localhost"):
        return False
    return all(_HOST_LABEL.match(label) for label in host.split("."))


@dataclass(frozen=True)
class NetRule:
    """One allowed destination. Without a port, only 80 and 443 match."""

    host: str
    port: Optional[int] = None

    def matches(self, host: str, port: int) -> bool:
        if normalize_host(host) != self.host:
            return False
        if self.port is None:
            return port in (80, 443)
        return port == self.port

    def __str__(self) -> str:
        host = f"[{self.host}]" if ":" in self.host else self.host
        return host if self.port is None else f"{host}:{self.port}"


def parse_net_rule(value: Any) -> NetRule:
    if not isinstance(value, str) or not value or len(value) > 300:
        raise RequestError("invalid_net", "net entries must be non-empty strings")
    if any(c in value for c in "*/@ \t?#"):
        raise RequestError(
            "invalid_net",
            f"net entry {value!r} must be a single host name (no wildcards, paths, or userinfo)",
        )
    try:
        host, port = split_host_port(value)
    except ValueError as exc:
        raise RequestError("invalid_net", f"net entry {value!r}: {exc}") from None
    host = normalize_host(host)
    if not _valid_host(host):
        raise RequestError("invalid_net", f"net entry {value!r} is not a valid host name")
    return NetRule(host=host, port=port)


@dataclass(frozen=True)
class CredentialSpec:
    """A credential the proxy injects. The sandbox only sees a placeholder."""

    name: str
    hosts: Tuple[str, ...]
    header: str  # lower-cased


def parse_credential(value: Any, rules: List[NetRule]) -> CredentialSpec:
    if not isinstance(value, Mapping):
        raise RequestError("invalid_credentials", "each credential must be an object")
    name = value.get("name")
    if not isinstance(name, str) or not _CRED_NAME.match(name):
        raise RequestError("invalid_credentials", "credential name must match [A-Z][A-Z0-9_]*")
    header = value.get("header")
    if not isinstance(header, str) or not _HEADER_NAME.match(header):
        raise RequestError("invalid_credentials", f"credential {name}: header must be a header name")
    if header.lower() in _FORBIDDEN_CRED_HEADERS:
        raise RequestError("invalid_credentials", f"credential {name}: header {header!r} is not allowed")
    hosts = value.get("hosts")
    if not isinstance(hosts, list) or not hosts:
        raise RequestError("invalid_credentials", f"credential {name}: hosts must be a non-empty list")
    declared = {r.host for r in rules}
    out = []
    for h in hosts:
        if not isinstance(h, str):
            raise RequestError("invalid_credentials", f"credential {name}: hosts must be strings")
        h = normalize_host(h)
        if h not in declared:
            raise RequestError(
                "invalid_credentials",
                f"credential {name}: host {h!r} is not in net",
            )
        out.append(h)
    return CredentialSpec(name=name, hosts=tuple(sorted(set(out))), header=header.lower())


@dataclass(frozen=True)
class Limits:
    cpu: float
    mem_mib: int
    timeout_sec: float

    @property
    def cpu_seconds(self) -> int:
        """RLIMIT_CPU budget: average cores times wall-clock timeout."""
        return max(1, math.ceil(self.cpu * self.timeout_sec))


def parse_mem_mib(value: Any) -> int:
    if isinstance(value, bool):
        raise ValueError("mem must be a number of MiB or a string like 512Mi")
    if isinstance(value, int):
        return value
    if isinstance(value, str):
        m = re.fullmatch(r"(\d+)(Mi|Gi)", value.strip())
        if m:
            n = int(m.group(1))
            return n if m.group(2) == "Mi" else n * 1024
    raise ValueError("mem must be a number of MiB or a string like 512Mi")


def parse_limits(value: Any, defaults: Limits, maxima: Limits) -> Limits:
    if value is None:
        value = {}
    if not isinstance(value, Mapping):
        raise RequestError("invalid_limits", "limits must be an object")
    try:
        cpu = float(value.get("cpu", defaults.cpu))
        mem = parse_mem_mib(value.get("mem", value.get("memMiB", defaults.mem_mib)))
        timeout = float(value.get("timeoutSec", defaults.timeout_sec))
    except (TypeError, ValueError) as exc:
        raise RequestError("invalid_limits", str(exc)) from None
    if not 0 < cpu <= maxima.cpu:
        raise RequestError("invalid_limits", f"cpu must be in (0, {maxima.cpu}]")
    if not 16 <= mem <= maxima.mem_mib:
        raise RequestError("invalid_limits", f"mem must be in [16, {maxima.mem_mib}] MiB")
    if not 0 < timeout <= maxima.timeout_sec:
        raise RequestError("invalid_limits", f"timeoutSec must be in (0, {maxima.timeout_sec}]")
    return Limits(cpu=cpu, mem_mib=mem, timeout_sec=timeout)


@dataclass(frozen=True)
class ExecRequest:
    id: str
    argv: Tuple[str, ...]
    stdin: bytes
    env: Dict[str, str]
    files: Dict[str, bytes]
    tools: Tuple[str, ...]
    net: Tuple[NetRule, ...]
    credentials: Tuple[CredentialSpec, ...]
    limits: Limits


def _check_text(value: Any, what: str, max_bytes: int) -> str:
    if not isinstance(value, str):
        raise RequestError("invalid_request", f"{what} must be a string")
    if "\x00" in value:
        raise RequestError("invalid_request", f"{what} must not contain NUL")
    try:
        size = len(value.encode())
    except UnicodeEncodeError:
        raise RequestError("invalid_request", f"{what} is not valid UTF-8 text") from None
    if size > max_bytes:
        raise RequestError("invalid_request", f"{what} is larger than {max_bytes} bytes")
    return value


def _safe_relpath(path: str) -> str:
    norm = posixpath.normpath(path)
    if (
        not path
        or path.startswith("/")
        or norm.startswith("..")
        or norm in (".", "")
        or "\\" in path
    ):
        raise RequestError("invalid_files", f"file path {path!r} must be relative and stay in the workdir")
    return norm


def parse_exec_request(obj: Any, defaults: Limits, maxima: Limits) -> ExecRequest:
    if not isinstance(obj, Mapping):
        raise RequestError("invalid_request", "body must be a JSON object")

    req_id = obj.get("id") or "anonymous"
    if not isinstance(req_id, str) or not _ID.match(req_id):
        raise RequestError("invalid_request", "id must match [A-Za-z0-9._:/-]{1,128}")

    argv = obj.get("argv")
    if not isinstance(argv, list) or not argv or len(argv) > MAX_ARGV:
        raise RequestError("invalid_request", f"argv must be a list of 1..{MAX_ARGV} strings")
    argv = [_check_text(a, "argv item", MAX_ARG_BYTES) for a in argv]

    constraints = obj.get("constraints")
    if not isinstance(constraints, Mapping):
        raise RequestError("invalid_request", "constraints is required")

    tools = constraints.get("tools")
    if not isinstance(tools, list) or not tools or not all(
        isinstance(t, str) and _TOOL_NAME.match(t) for t in tools
    ):
        raise RequestError("invalid_tools", "constraints.tools must be a non-empty list of command names")
    if argv[0] not in tools:
        raise RequestError(
            "tool_not_declared",
            f"argv[0] {argv[0]!r} must be a bare command name listed in constraints.tools",
        )

    net_raw = constraints.get("net") or []
    if not isinstance(net_raw, list) or len(net_raw) > MAX_NET_RULES:
        raise RequestError("invalid_net", f"constraints.net must be a list of at most {MAX_NET_RULES} hosts")
    net = [parse_net_rule(n) for n in net_raw]

    creds_raw = constraints.get("credentials") or []
    if not isinstance(creds_raw, list) or len(creds_raw) > MAX_CREDENTIALS:
        raise RequestError("invalid_credentials", f"constraints.credentials must be a list of at most {MAX_CREDENTIALS}")
    creds = [parse_credential(c, net) for c in creds_raw]
    if len({c.name for c in creds}) != len(creds):
        raise RequestError("invalid_credentials", "credential names must be unique")

    limits = parse_limits(constraints.get("limits"), defaults, maxima)

    env_raw = obj.get("env") or {}
    if not isinstance(env_raw, Mapping):
        raise RequestError("invalid_env", "env must be an object")
    env: Dict[str, str] = {}
    cred_names = {c.name for c in creds}
    for k, v in env_raw.items():
        if not isinstance(k, str) or not _ENV_NAME.match(k):
            raise RequestError("invalid_env", f"env name {k!r} is invalid")
        if k in _RESERVED_ENV or k.startswith("LD_") or k in cred_names:
            raise RequestError("invalid_env", f"env name {k!r} is reserved")
        env[k] = _check_text(v, f"env {k}", MAX_ARG_BYTES)

    stdin_raw = obj.get("stdin")
    stdin = b"" if stdin_raw is None else _check_text(stdin_raw, "stdin", MAX_STDIN_BYTES).encode()

    files_raw = obj.get("files") or {}
    if not isinstance(files_raw, Mapping):
        raise RequestError("invalid_files", "files must be an object of path to content")
    files: Dict[str, bytes] = {}
    total = 0
    for path, content in files_raw.items():
        if not isinstance(path, str):
            raise RequestError("invalid_files", "file paths must be strings")
        data = _check_text(content, f"file {path}", MAX_FILES_BYTES).encode()
        total += len(data)
        if total > MAX_FILES_BYTES:
            raise RequestError("invalid_files", f"files are larger than {MAX_FILES_BYTES} bytes in total")
        rel = _safe_relpath(path)
        if rel in files:
            raise RequestError("invalid_files", f"file path {path!r} is given twice")
        files[rel] = data
    for rel in files:
        parent = posixpath.dirname(rel)
        while parent:
            if parent in files:
                raise RequestError("invalid_files", f"file {parent!r} is also used as a directory")
            parent = posixpath.dirname(parent)

    return ExecRequest(
        id=req_id,
        argv=tuple(argv),
        stdin=stdin,
        env=env,
        files=files,
        tools=tuple(tools),
        net=tuple(net),
        credentials=tuple(creds),
        limits=limits,
    )


def make_placeholder(name: str) -> str:
    """A per-execution stand-in for a credential value."""
    return f"neotags-placeholder-{name.lower()}-{secrets.token_hex(16)}"
