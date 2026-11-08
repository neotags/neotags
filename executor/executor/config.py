"""Executor configuration, read from EXECUTOR_* environment variables."""

from __future__ import annotations

import os
import sys
from dataclasses import dataclass, field
from typing import Mapping, Optional, Tuple

from .policy import Limits


def _int(env: Mapping[str, str], name: str, default: int) -> int:
    raw = env.get(name)
    return default if raw in (None, "") else int(raw)


def _float(env: Mapping[str, str], name: str, default: float) -> float:
    raw = env.get(name)
    return default if raw in (None, "") else float(raw)


def _paths(env: Mapping[str, str], name: str) -> Tuple[str, ...]:
    raw = env.get(name, "")
    return tuple(p for p in raw.split(":") if p)


@dataclass(frozen=True)
class Config:
    socket_path: str = "/run/executor/exec.sock"
    socket_mode: int = 0o660
    work_root: str = "/tmp/executor"
    bwrap: str = "bwrap"
    # Wraps bwrap to apply rlimits; empty disables (tests on non-Linux hosts).
    prlimit: str = "prlimit"
    sandbox_python: str = sys.executable
    credentials_dir: str = "/run/executor/credentials"
    skills_dir: str = ""
    # Extra read-only paths bound into the sandbox at the same location,
    # for example a directory of CLI tools.
    ro_binds: Tuple[str, ...] = ()
    # Prepended to PATH inside the sandbox.
    tool_path: Tuple[str, ...] = ()
    # Accept only the strongest sandbox mode (private /proc and
    # --disable-userns); refuse execution instead of falling back.
    require_procfs: bool = False
    max_concurrency: int = 4
    max_request_bytes: int = 8 * 1024 * 1024
    max_output_bytes: int = 1024 * 1024
    defaults: Limits = field(default_factory=lambda: Limits(cpu=1.0, mem_mib=512, timeout_sec=60.0))
    maxima: Limits = field(default_factory=lambda: Limits(cpu=4.0, mem_mib=4096, timeout_sec=300.0))
    worker_root: str = ""
    workers: int = 0
    worker_max_timeout_sec: float = 30.0

    @classmethod
    def from_env(cls, env: Optional[Mapping[str, str]] = None) -> "Config":
        env = os.environ if env is None else env
        base = cls()
        skills_dir = env.get("EXECUTOR_SKILLS_DIR", base.skills_dir)
        return cls(
            socket_path=env.get("EXECUTOR_SOCKET", base.socket_path),
            socket_mode=int(env.get("EXECUTOR_SOCKET_MODE", "660"), 8),
            work_root=env.get("EXECUTOR_WORK_ROOT", base.work_root),
            bwrap=env.get("EXECUTOR_BWRAP", base.bwrap),
            prlimit=env.get("EXECUTOR_PRLIMIT", base.prlimit),
            sandbox_python=env.get("EXECUTOR_SANDBOX_PYTHON", base.sandbox_python),
            credentials_dir=env.get("EXECUTOR_CREDENTIALS_DIR", base.credentials_dir),
            skills_dir=skills_dir,
            ro_binds=_paths(env, "EXECUTOR_RO_BINDS"),
            tool_path=_paths(env, "EXECUTOR_TOOL_PATH"),
            require_procfs=env.get("EXECUTOR_REQUIRE_PROCFS", "") in ("1", "true", "yes"),
            max_concurrency=_int(env, "EXECUTOR_MAX_CONCURRENCY", base.max_concurrency),
            max_output_bytes=_int(env, "EXECUTOR_MAX_OUTPUT_BYTES", base.max_output_bytes),
            defaults=Limits(
                cpu=_float(env, "EXECUTOR_DEFAULT_CPU", base.defaults.cpu),
                mem_mib=_int(env, "EXECUTOR_DEFAULT_MEM_MIB", base.defaults.mem_mib),
                timeout_sec=_float(env, "EXECUTOR_DEFAULT_TIMEOUT_SEC", base.defaults.timeout_sec),
            ),
            maxima=Limits(
                cpu=_float(env, "EXECUTOR_MAX_CPU", base.maxima.cpu),
                mem_mib=_int(env, "EXECUTOR_MAX_MEM_MIB", base.maxima.mem_mib),
                timeout_sec=_float(env, "EXECUTOR_MAX_TIMEOUT_SEC", base.maxima.timeout_sec),
            ),
            worker_root=env.get("EXECUTOR_WORKER_ROOT", skills_dir),
            workers=_int(env, "EXECUTOR_WORKERS", base.workers),
            worker_max_timeout_sec=_float(env, "EXECUTOR_WORKER_MAX_TIMEOUT_SEC", base.worker_max_timeout_sec),
        )
