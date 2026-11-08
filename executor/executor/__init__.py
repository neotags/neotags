"""neotags executor sidecar: sandboxed execution over a unix socket.

Two execution modes share one server:

* ``POST /v1/exec``: run a command in a fresh bubblewrap sandbox per call
  (no network except a per-call egress proxy, seccomp, fresh workdir).
* ``POST /v1/call``: call a Python function in a resident worker process.

Everything is standard library only so the image stays small and works with a
read-only root filesystem.
"""

__version__ = "0.1.0"
