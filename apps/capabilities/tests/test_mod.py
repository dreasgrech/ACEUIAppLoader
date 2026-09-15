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


if __name__ == "__main__":
    unittest.main()
