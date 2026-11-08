"""Checks on the seccomp rules. The kernel-level behavior is covered by
test_sandbox.py, which needs a Linux host with bubblewrap."""

import tempfile
import unittest

from executor import sandbox_init as si

try:
    import seccomp  # noqa: F401 - Debian python3-seccomp, present in the image
except ImportError:
    seccomp = None

REQUIRED = {
    "io_uring_setup",
    "io_uring_enter",
    "io_uring_register",
    "unshare",
    "clone",
    "clone3",
    "setns",
    "mount",
    "umount2",
    "pivot_root",
    "open_tree",
    "move_mount",
    "fsopen",
    "fsmount",
    "ptrace",
    "process_vm_readv",
    "process_vm_writev",
    "socket",
}


class RulesTest(unittest.TestCase):
    def test_required_syscalls_are_denied(self):
        names = {r[0] for r in si.RULES}
        self.assertEqual(REQUIRED - names, set())
        self.assertEqual(len(names), len(si.RULES), "a syscall is listed twice")

    def test_conditions(self):
        rules = {r[0]: r for r in si.RULES}
        self.assertEqual(rules["socket"][2], ("eq", 0, si.AF_UNIX))
        self.assertEqual(rules["clone"][2], ("mask", 0, si.CLONE_NEWUSER))
        self.assertEqual(rules["unshare"][2], ("mask", 0, si.CLONE_NEWUSER))
        self.assertEqual(rules["clone3"][1], si.LINUX_ENOSYS)
        for name, err, _cond in si.RULES:
            if name != "clone3":
                self.assertEqual(err, si.LINUX_EPERM, name)

    def test_bridge_keeps_unix_sockets_only(self):
        bridge = {r[0] for r in si.rules_for(block_unix_sockets=False)}
        self.assertEqual({r[0] for r in si.RULES} - bridge, {"socket"})


@unittest.skipIf(seccomp is None, "libseccomp Python bindings not installed (they are in the image)")
class LibseccompTest(unittest.TestCase):
    def test_every_rule_compiles_for_the_native_arch(self):
        f = si.build_filter(si.rules_for())
        with tempfile.TemporaryFile("w+") as out:
            f.export_pfc(out)
            out.seek(0)
            pfc = out.read()
        for name in REQUIRED:
            self.assertIn(name, pfc)
        # libseccomp adds only the native ABI; others hit the bad-arch action.
        self.assertNotIn("x32", pfc)

    def test_unknown_syscall_fails_closed(self):
        with self.assertRaises(Exception):
            si.build_filter((("no_such_syscall", si.LINUX_EPERM, None),))


if __name__ == "__main__":
    unittest.main()
