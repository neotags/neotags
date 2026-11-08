"""Resident worker process: call Python functions from files under a root.

Runs as ``python3 -I -S worker_child.py ROOT`` and must stay self-contained.
Protocol: one JSON request per line on stdin, one JSON response per line on
the original stdout. The functions' own prints go to stderr so they can't
corrupt the protocol.

Request:  {"entry": "checks/x.py", "function": "run", "args": {...}}
Response: {"ok": true, "result": ...} or {"ok": false, "error": {...}}
"""

import importlib.util
import json
import os
import sys
import traceback


def main(root):
    proto = os.fdopen(os.dup(1), "w", buffering=1, encoding="utf-8")
    os.dup2(2, 1)
    root = os.path.realpath(root)
    if root not in sys.path:
        sys.path.insert(0, root)
    cache = {}

    def load(entry):
        path = os.path.realpath(os.path.join(root, entry))
        if not path.startswith(root + os.sep):
            raise PermissionError("entry escapes the worker root")
        mtime = os.stat(path).st_mtime_ns
        hit = cache.get(path)
        if hit and hit[0] == mtime:
            return hit[1]
        name = "neotags_entry_" + str(abs(hash(path)))
        spec = importlib.util.spec_from_file_location(name, path)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        cache[path] = (mtime, mod)
        return mod

    for line in sys.stdin:
        try:
            req = json.loads(line)
            fn = getattr(load(req["entry"]), req["function"])
            resp = {"ok": True, "result": fn(req.get("args"))}
            out = json.dumps(resp, default=str)
        except BaseException as exc:  # noqa: BLE001 - sys.exit() in a check is a failure, not a shutdown
            out = json.dumps(
                {
                    "ok": False,
                    "error": {
                        "type": type(exc).__name__,
                        "message": str(exc)[:2000],
                        "traceback": traceback.format_exc(limit=5)[-4000:],
                    },
                }
            )
        proto.write(out + "\n")


if __name__ == "__main__":
    main(sys.argv[1])
