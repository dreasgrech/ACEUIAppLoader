"""Runs tests/lib/harness.html (the shared library) in a headless Chromium.

The harness fakes requestAnimationFrame, localStorage and the stock HUD store, and
exercises AceMods.core/console/persist/panel/loop/loader deterministically. See
tools/headless.py for the runner and its process hygiene.
"""
import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tools"))

import headless  # noqa: E402

HARNESS = os.path.join(ROOT, "tests", "lib", "harness.html")
MIN_CASES = 15


class LibraryBrowserTests(unittest.TestCase):
    def test_library_harness_all_pass(self):
        headless.check_harness(self, HARNESS, MIN_CASES)


if __name__ == "__main__":
    unittest.main()
