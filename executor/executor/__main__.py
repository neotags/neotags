"""Entrypoint: ``python3 -m executor``."""

from __future__ import annotations

import os
import signal
import sys
import threading

from . import __version__
from .config import Config
from .log import log
from .sandbox import Sandbox
from .server import ExecutorServer
from .worker import WorkerPool


def main() -> int:
    try:
        cfg = Config.from_env()
    except ValueError as exc:
        log("config_invalid", level="error", reason=str(exc))
        return 2
    sandbox = Sandbox(cfg)
    if sandbox.self_check():
        log("sandbox_ready", mode=sandbox.mode, note=sandbox.reason)
    else:
        # Refuse, don't degrade: /v1/exec answers 503 sandbox_unavailable.
        log(
            "sandbox_unavailable",
            level="error",
            reason=sandbox.reason,
            msg="per-call execution is disabled; every /v1/exec request will be refused",
        )

    workers = None
    if cfg.workers > 0:
        if cfg.worker_root and os.path.isdir(cfg.worker_root):
            workers = WorkerPool(cfg.worker_root, cfg.workers, cfg.worker_max_timeout_sec)
        else:
            log("worker_disabled", level="warn", reason=f"worker root {cfg.worker_root!r} is not a directory")

    server = ExecutorServer(cfg, sandbox, workers)

    def stop(signum: int, _frame: object) -> None:
        log("shutdown", signal=signal.Signals(signum).name)
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    log(
        "listening",
        version=__version__,
        socket=cfg.socket_path,
        exec=sandbox.available,
        workers=workers.count if workers else 0,
    )
    try:
        server.serve_forever(poll_interval=0.5)
    finally:
        server.server_close()
        if workers:
            workers.close()
        try:
            os.unlink(cfg.socket_path)
        except OSError:
            pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
