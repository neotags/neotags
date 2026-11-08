"""JSON-lines logging to stderr. Never pass credential values here."""

from __future__ import annotations

import json
import sys
import threading
import time
from typing import Any

_lock = threading.Lock()


def log(event: str, level: str = "info", **fields: Any) -> None:
    record = {"ts": round(time.time(), 3), "level": level, "event": event}
    record.update(fields)
    line = json.dumps(record, default=str, ensure_ascii=False)
    with _lock:
        sys.stderr.write(line + "\n")
        sys.stderr.flush()
