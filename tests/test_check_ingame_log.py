"""The in-game smoke test reads the game's log; these are logs it has to read correctly.

It is the only acceptance gate that runs against the real game, so a wrong verdict here
is worse than no verdict: it cried wolf on a page that legitimately has nothing to load,
and it compared the number of apps the preset list named against a loaded list that now
includes the apps bundled in the package.
"""
import io
import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tools"))

import check_ingame_log as check  # noqa: E402

PREFIX = "[2026-09-16 02:13:06.949] [gameface] [info] [ACEUIAppLoader] "


def log(*loader_lines, **kwargs):
    """A game log: the lines the game always writes, plus the loader's own."""
    head = [
        "[2026-09-16 02:12:43.000] Build release x, version 0.9.1+release.6, revision 1",
        "[2026-09-16 02:13:06.000] Loading page hud.html",
    ]
    return head + [PREFIX + l for l in loader_lines] + list(kwargs.get("extra", []))


def run(lines):
    """Run the checker over a log, returning (exit code, what it printed)."""
    path = os.path.join(os.environ.get("TEMP", "."), "ace-check-test.log")
    with io.open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(lines) + "\n")
    out = io.StringIO()
    was = sys.stdout
    sys.stdout = out
    try:
        code = check.main(["check_ingame_log.py", path])
    finally:
        sys.stdout = was
        os.remove(path)
    return code, out.getvalue()


HUD = "loader 0.19.0 on /hud.html"
OTHER = "loader 0.19.0 on /driverlabels.html"


class CheckIngameLogTests(unittest.TestCase):
    def test_a_good_session_passes_and_names_what_ran_on_the_hud(self):
        code, out = run(log(
            HUD,
            "presets: 3 app(s)",
            "bundled: 3 app(s)",
            "app capabilities 0.3.0: loading 1 script(s), 1 stylesheet(s)",
            "app capabilities loaded",
            "app pedalgraph 0.6.2: loading 1 script(s), 1 stylesheet(s)",
            "app pedalgraph loaded",
        ))
        self.assertEqual(code, 0, out)
        self.assertIn("3 installed + 3 bundled", out)
        self.assertIn("capabilities, pedalgraph", out)

    def test_a_page_with_nothing_to_load_is_not_a_failure(self):
        """driverlabels.html has no apps and never gets a preset answer; that is normal
        and was reported as a failure on every single run."""
        code, out = run(log(
            OTHER,
            "no preset list answer in 1500 ms; no installed apps",
            "nothing to load",
            HUD,
            "presets: 3 app(s)",
            "bundled: 3 app(s)",
            "app doom 0.5.4: loading 4 script(s), 1 stylesheet(s)",
            "app doom loaded",
        ))
        self.assertEqual(code, 0, out)
        self.assertIn("/driverlabels.html", out)

    def test_nothing_on_the_hud_is_a_failure(self):
        code, out = run(log(HUD, "no preset list answer in 1500 ms; no installed apps", "nothing to load"))
        self.assertEqual(code, 2, out)
        self.assertIn("nothing loaded on the HUD", out)

    def test_a_mod_that_starts_but_never_finishes_is_caught(self):
        """The old count-based check could not see this once bundled apps made the
        loaded list longer than the preset count."""
        code, out = run(log(
            HUD,
            "presets: 2 app(s)",
            "bundled: 3 app(s)",
            "app profiler 0.10.0: loading 2 script(s), 1 stylesheet(s)",
            "app profiler loaded",
            "app doom 0.5.4: loading 4 script(s), 1 stylesheet(s)",
        ))
        self.assertEqual(code, 2, out)
        self.assertIn("never finished", out)
        self.assertIn("doom", out)

    def test_more_loaded_than_the_preset_list_named_is_normal_now(self):
        """Three installed apps and three bundled apps is six loaded; that used to read
        as 'not every discovered app reported loaded'."""
        apps = ["capabilities", "devconsole", "profiler", "doom", "pedalgraph", "telemetry"]
        lines = [HUD, "presets: 3 app(s)", "bundled: 3 app(s)"]
        for name in apps:
            lines.append(f"app {name} 1.0.0: loading 1 script(s), 1 stylesheet(s)")
            lines.append(f"app {name} loaded")
        code, out = run(log(*lines))
        self.assertEqual(code, 0, out)

    def test_an_installed_copy_overriding_a_bundled_app_is_reported_not_flagged(self):
        code, out = run(log(
            HUD,
            "presets: 1 app(s)",
            "bundled: 3 app(s)",
            "profiler: installed copy overrides the bundled 0.10.0",
            "app profiler 0.10.1: loading 2 script(s), 1 stylesheet(s)",
            "app profiler loaded",
        ))
        self.assertEqual(code, 0, out)
        self.assertIn("installed copies replaced the bundled: profiler", out)

    def test_a_broken_manifest_still_fails(self):
        code, out = run(log(
            HUD,
            "presets: 1 app(s)",
            "app wonky: no app.json, skipped",
        ))
        self.assertEqual(code, 2, out)
        self.assertIn("skipped", out)

    def test_a_crash_fails_whatever_else_happened(self):
        """The wording is the game's, copied from a real log. This case asserted
        "********** CRASH DETECTED **********" for months -- a string this game has never
        written -- so the check passed every run without ever finding anything."""
        code, out = run(log(HUD, "presets: 0 app(s)", "bundled: 3 app(s)",
                            "app devconsole 0.11.0: loading 1 script(s), 1 stylesheet(s)",
                            "app devconsole loaded",
                            extra=["[2026-09-16 02:14:00.000] [crash] [error] Exception Detected: 0xC0000005 (Access Violation)",
                                   "[2026-09-16 02:14:00.000] [crash] [error]     AssettoCorsaEVO!Something+0x10"]))
        self.assertEqual(code, 2, out)
        self.assertIn("CRASH", out)

    def test_the_display_driver_exceptions_do_not_fail_the_run(self):
        """Every launch throws dozens of these, with or without anything installed. Failing
        on them would make the gate useless; hiding them would lose a real signal."""
        code, out = run(log(HUD, "presets: 0 app(s)", "bundled: 3 app(s)",
                            "app devconsole 0.11.0: loading 1 script(s), 1 stylesheet(s)",
                            "app devconsole loaded",
                            extra=["[2026-09-16 02:14:00.000] [crash] [error] Exception Detected: 0xE06D7363 (C++)",
                                   "[2026-09-16 02:14:00.000] [crash] [error]     nvwgf2umx!NVAPI_DirectMethods+0x1"]))
        self.assertEqual(code, 0, out)
        self.assertIn("display-driver exceptions: 1", out)

    def test_a_log_without_the_loader_says_the_package_is_not_applied(self):
        code, out = run(["[2026-09-16 02:12:43.000] Build release x, version 0.9.1, revision 1",
                         "[2026-09-16 02:13:06.000] Loading page hud.html"])
        self.assertEqual(code, 1, out)
        self.assertIn("NOT APPLIED", out)

    def test_no_hud_in_the_session_is_its_own_verdict(self):
        code, out = run([PREFIX + "loader 0.19.0 on /menu.html"])
        self.assertEqual(code, 3, out)
        self.assertIn("HUD never loaded", out)



class CrashDetectionTests(unittest.TestCase):
    """The two strings this used to look for appear in no log the game has ever written, so
    every run said "no crashes" without having looked. These pin the real wording down."""

    DRIVER = ["[crash] [error] Exception Detected: 0xE06D7363 (C++)",
              "[crash] [error]     D3D12Core! ?? +0x0",
              "[crash] [error]     nvwgf2umx!NVAPI_DirectMethods+0x1"]
    OURS = ["[crash] [error] Exception Detected: 0xC0000005 (Access Violation)",
            "[crash] [error]     AssettoCorsaEVO!Something+0x10"]

    def test_the_display_driver_exceptions_are_counted_not_failed(self):
        real, driver = check.classify_crashes(self.DRIVER * 3)
        self.assertEqual(len(driver), 3, "every launch throws these; they are noise")
        self.assertEqual(real, [], "and they must not fail the run")

    def test_anything_else_is_a_real_crash(self):
        real, driver = check.classify_crashes(self.OURS)
        self.assertEqual(len(real), 1)
        self.assertEqual(driver, [])

    def test_a_driver_block_does_not_shield_a_later_real_one(self):
        real, driver = check.classify_crashes(self.DRIVER + ["x"] * 40 + self.OURS)
        self.assertEqual((len(real), len(driver)), (1, 1),
                         "the stack window must not reach past its own block")

if __name__ == "__main__":
    unittest.main()
