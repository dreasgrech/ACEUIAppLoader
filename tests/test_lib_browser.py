"""Runs tests/lib/harness.html (the shared library) in a headless Chromium.

The harness fakes requestAnimationFrame, localStorage and the stock HUD store, and
exercises ACEUIAppLoader.core/console/persist/panel/loop/loader deterministically. See
tools/headless.py for the runner and its process hygiene.
"""
import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tools"))

import headless  # noqa: E402

HARNESS = os.path.join(ROOT, "tests", "lib", "harness.html")
MIN_CASES = 127
# the library loading on a fresh page, twice over: after Escape and resume (localStorage full,
# no HUD store yet) and after a game restart (localStorage empty, the HUD store arriving later);
# module state is per page, so these cannot be played inside the one big harness
RELOAD_SESSION = os.path.join(ROOT, "tests", "lib", "reload-session.html")
RELOAD_DISK = os.path.join(ROOT, "tests", "lib", "reload-disk.html")
# and after a game restart reached through a menu page, with a window opened before the HUD store arrives
RELOAD_OPS = os.path.join(ROOT, "tests", "lib", "reload-ops.html")
# and a reload that came before the HUD store was adopted, with changes made on the load before it
RELOAD_PENDING = os.path.join(ROOT, "tests", "lib", "reload-pending.html")


class LibraryBrowserTests(unittest.TestCase):
    def test_library_harness_all_pass(self):
        headless.check_harness(self, HARNESS, MIN_CASES)

    def test_windows_come_back_after_the_hud_reload(self):
        headless.check_harness(self, RELOAD_SESSION, 2)

    def test_windows_come_back_after_a_game_restart(self):
        headless.check_harness(self, RELOAD_DISK, 2)

    def test_each_page_keeps_its_windows_across_a_restart(self):
        headless.check_harness(self, RELOAD_OPS, 2)

    def test_changes_made_before_the_store_survive_a_reload(self):
        headless.check_harness(self, RELOAD_PENDING, 2)


if __name__ == "__main__":
    unittest.main()
