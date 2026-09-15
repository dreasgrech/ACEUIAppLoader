"""Runs the shared ACEUIModLoader test kit against this mod (see modkit.py in the loader repo)."""
import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOADER = os.environ.get("ACE_LOADER_DIR") or os.path.join(os.path.dirname(ROOT), "ACEUIModLoader")
sys.path.insert(0, os.path.join(LOADER, "tools"))

from modkit import ModTests  # noqa: E402


class Tests(ModTests):
    ROOT = ROOT
    MIN_CASES = 3
    HOT_PATH = ("// ---- rendering", "// ---- lifecycle")
    # A profiler is the one mod that has to reach past the library: it wraps the page's own
    # requestAnimationFrame (that is how it sees the stock HUD's work, not only ours) and
    # counts getBoundingClientRect calls, which is the closest thing this engine has to an
    # allocation counter. Its wrappers also have to hand each wrapped function the receiver
    # it was called with, which cannot be written without `this`.
    ALLOW_OWN = ("requestAnimationFrame", "cancelAnimationFrame", "getBoundingClientRect")
    ALLOW_THIS = ("sampler.js",)


if __name__ == "__main__":
    unittest.main()
