"""First process inside the bubblewrap sandbox.

Runs as ``python3 -I sandbox_init.py [--proxy SOCK --port N] -- ARGV...``.
It must stay self-contained (standard library plus the system ``seccomp``
module, no package imports) because isolated mode doesn't put its directory
on ``sys.path``.

1. With ``--proxy``: listen on ``127.0.0.1:N`` inside the empty network
   namespace and fork a bridge that forwards each TCP connection to the
   egress proxy's unix socket. This is the only way out of the sandbox.
2. Install a seccomp filter (libseccomp) that denies the syscalls in
   ``RULES``: io_uring, new AF_UNIX sockets, new user namespaces, mount
   operations, setns, ptrace (so the command can't take over the bridge),
   and a few kernel interfaces a sandboxed tool never needs.
3. ``execvp`` the command. Exit 126 if the sandbox can't be set up, 127 if
   the command doesn't exist.
"""

import ctypes
import errno
import os
import socket
import sys
import threading

# -- seccomp -----------------------------------------------------------------

AF_UNIX = 1
CLONE_NEWUSER = 0x10000000
# Linux errno values, fixed so the rules mean the same whatever host reads them.
LINUX_EPERM = 1
LINUX_ENOSYS = 38

# (syscall, errno, condition). The condition is None (always) or
# ("eq" | "mask", argument index, value): "eq" matches arg == value, "mask"
# matches (arg & value) == value. Everything not listed is allowed.
RULES = (
    # io_uring bypasses seccomp for the operations it submits.
    ("io_uring_setup", LINUX_EPERM, None),
    ("io_uring_enter", LINUX_EPERM, None),
    ("io_uring_register", LINUX_EPERM, None),
    # No new user namespaces: they would hand the command capabilities.
    ("unshare", LINUX_EPERM, ("mask", 0, CLONE_NEWUSER)),
    ("clone", LINUX_EPERM, ("mask", 0, CLONE_NEWUSER)),
    # clone3 passes its flags in a struct seccomp can't read. ENOSYS makes
    # libc fall back to clone(), whose flags the rule above checks.
    ("clone3", LINUX_ENOSYS, None),
    ("setns", LINUX_EPERM, None),
    # Mount operations, old and new API: the command can't change its view
    # of the filesystem. (All capabilities are dropped too; this is a second
    # layer.)
    ("mount", LINUX_EPERM, None),
    ("umount2", LINUX_EPERM, None),
    ("pivot_root", LINUX_EPERM, None),
    ("open_tree", LINUX_EPERM, None),
    ("move_mount", LINUX_EPERM, None),
    ("fsopen", LINUX_EPERM, None),
    ("fsconfig", LINUX_EPERM, None),
    ("fsmount", LINUX_EPERM, None),
    ("fspick", LINUX_EPERM, None),
    ("mount_setattr", LINUX_EPERM, None),
    # Other processes in the sandbox (the bridge) are off limits.
    ("ptrace", LINUX_EPERM, None),
    ("process_vm_readv", LINUX_EPERM, None),
    ("process_vm_writev", LINUX_EPERM, None),
    # Kernel interfaces with a history of exploits and no use here.
    ("bpf", LINUX_EPERM, None),
    ("perf_event_open", LINUX_EPERM, None),
    ("userfaultfd", LINUX_EPERM, None),
    ("keyctl", LINUX_EPERM, None),
    ("add_key", LINUX_EPERM, None),
    ("request_key", LINUX_EPERM, None),
    # The only unix socket in the sandbox is the egress proxy's, used by the
    # bridge; the command may not open any.
    ("socket", LINUX_EPERM, ("eq", 0, AF_UNIX)),
)


def rules_for(block_unix_sockets=True):
    if block_unix_sockets:
        return RULES
    return tuple(r for r in RULES if r[0] != "socket")


def build_filter(rules):
    """Compile ``rules`` with libseccomp for the native architecture.

    libseccomp adds only the native ABI, so syscalls from any other ABI
    (x32, 32-bit compat) hit the bad-arch action and kill the process. The
    loaded filter also sets no_new_privs. Unknown syscall names raise, so a
    rule never silently drops out.
    """
    import seccomp  # Debian python3-seccomp; imported here so tests can skip it

    f = seccomp.SyscallFilter(defaction=seccomp.ALLOW)
    for name, err, cond in rules:
        args = []
        if cond is not None:
            kind, index, value = cond
            if kind == "eq":
                args.append(seccomp.Arg(index, seccomp.EQ, value))
            else:
                args.append(seccomp.Arg(index, seccomp.MASKED_EQ, value, value))
        f.add_rule(seccomp.ERRNO(err), name, *args)
    return f


def install_filter(rules):
    build_filter(rules).load()


PR_SET_PDEATHSIG = 1
PR_SET_DUMPABLE = 4


def _libc():
    return ctypes.CDLL(None, use_errno=True)


# -- bridge ------------------------------------------------------------------


def _pipe(src, dst):
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


def _serve(client, proxy_path):
    try:
        upstream = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        upstream.connect(proxy_path)
    except OSError:
        client.close()
        return
    t = threading.Thread(target=_pipe, args=(upstream, client), daemon=True)
    t.start()
    _pipe(client, upstream)
    t.join()
    client.close()
    upstream.close()


def _run_bridge(listener, proxy_path):
    libc = _libc()
    libc.prctl(PR_SET_PDEATHSIG, 9, 0, 0, 0)
    # Not dumpable: the command can't open /proc/<bridge>/mem either.
    libc.prctl(PR_SET_DUMPABLE, 0, 0, 0, 0)
    devnull = os.open("/dev/null", os.O_RDWR)
    for fd in (0, 1, 2):
        os.dup2(devnull, fd)
    # The bridge needs AF_UNIX to reach the proxy; it gets the rest of the
    # filter so the command can't use it as a stepping stone.
    install_filter(rules_for(block_unix_sockets=False))
    while True:
        client, _ = listener.accept()
        threading.Thread(target=_serve, args=(client, proxy_path), daemon=True).start()


def _fail(code, msg):
    sys.stderr.write("sandbox-init: " + msg + "\n")
    sys.stderr.flush()
    os._exit(code)


def main(args):
    proxy_path, port = None, 0
    while args and args[0] != "--":
        if args[0] == "--proxy" and len(args) > 1:
            proxy_path, args = args[1], args[2:]
        elif args[0] == "--port" and len(args) > 1:
            port, args = int(args[1]), args[2:]
        else:
            _fail(126, "bad arguments")
    argv = args[1:]
    if not argv:
        _fail(126, "no command")

    if proxy_path:
        try:
            listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            listener.bind(("127.0.0.1", port))
            listener.listen(64)
        except OSError as exc:
            _fail(126, "cannot start egress bridge: %s" % exc)
        pid = os.fork()
        if pid == 0:
            try:
                _run_bridge(listener, proxy_path)
            finally:
                os._exit(0)
        listener.close()

    try:
        install_filter(rules_for())
    except Exception as exc:  # noqa: BLE001 - any failure here must stop the exec
        _fail(126, "cannot install seccomp filter: %s" % exc)

    try:
        os.execvp(argv[0], argv)
    except FileNotFoundError:
        _fail(127, "command not found: " + argv[0])
    except OSError as exc:
        _fail(126, "cannot execute %s: %s" % (argv[0], exc))


if __name__ == "__main__":
    main(sys.argv[1:])
