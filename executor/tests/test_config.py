import io
import unittest
from contextlib import redirect_stdout, redirect_stderr
from unittest import mock

from executor import __main__ as entry
from executor.config import Config


class LimitDefaultsTest(unittest.TestCase):
    def test_defaults_fit_the_maxima(self):
        cfg = Config.from_env({})
        self.assertLessEqual(cfg.defaults.mem_mib, cfg.maxima.mem_mib)

    def test_a_default_above_its_maximum_refuses_to_start(self):
        cases = {
            "EXECUTOR_MAX_MEM_MIB": ("448", "EXECUTOR_DEFAULT_MEM_MIB (512 MiB) is above EXECUTOR_MAX_MEM_MIB (448 MiB)"),
            "EXECUTOR_MAX_CPU": ("0.5", "EXECUTOR_DEFAULT_CPU"),
            "EXECUTOR_MAX_TIMEOUT_SEC": ("30", "EXECUTOR_DEFAULT_TIMEOUT_SEC"),
        }
        for name, (value, message) in cases.items():
            with self.subTest(name), self.assertRaises(ValueError) as ctx:
                Config.from_env({name: value})
            self.assertIn(message, str(ctx.exception))

    def test_a_lowered_maximum_with_a_matching_default_is_fine(self):
        cfg = Config.from_env({"EXECUTOR_MAX_MEM_MIB": "384", "EXECUTOR_DEFAULT_MEM_MIB": "384"})
        self.assertEqual((cfg.defaults.mem_mib, cfg.maxima.mem_mib), (384, 384))

    def test_main_logs_and_exits_before_listening(self):
        out = io.StringIO()
        with mock.patch.dict("os.environ", {"EXECUTOR_MAX_MEM_MIB": "448"}, clear=False), redirect_stdout(out), redirect_stderr(out):
            with mock.patch.object(entry, "Sandbox") as sandbox:
                code = entry.main()
        self.assertEqual(code, 2)
        sandbox.assert_not_called()
        self.assertIn("config_invalid", out.getvalue())


if __name__ == "__main__":
    unittest.main()
