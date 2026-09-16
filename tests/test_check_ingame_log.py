"""The in-game smoke test reads the game's log; these are logs it has to read correctly.

It is the only acceptance gate that runs against the real game, so a wrong verdict here
is worse than no verdict: it cried wolf on a page that legitimately has nothing to load,
and it compared the number of mods the preset list named against a loaded list that now
includes the apps bundled in the package.
"""
import io
import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tools"))

import check_ingame_log as check  # noqa: E402

PREFIX = "[2026-09-16 02:13:06.949] [gameface] [info] [ACEUIModLoader] "


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
            "presets: 3 mod(s)",
            "bundled: 3 app(s)",
            "mod capabilities 0.3.0: loading 1 script(s), 1 stylesheet(s)",
            "mod capabilities loaded",
            "mod pedalgraph 0.6.2: loading 1 script(s), 1 stylesheet(s)",
            "mod pedalgraph loaded",
        ))
        self.assertEqual(code, 0, out)
        self.assertIn("3 installed + 3 bundled", out)
        self.assertIn("capabilities, pedalgraph", out)

    def test_a_page_with_nothing_to_load_is_not_a_failure(self):
        """driverlabels.html has no mods and never gets a preset answer; that is normal
        and was reported as a failure on every single run."""
        code, out = run(log(
            OTHER,
            "no preset list answer in 1500 ms; no installed mods",
            "nothing to load",
            HUD,
            "presets: 3 mod(s)",
            "bundled: 3 app(s)",
            "mod doom 0.5.4: loading 4 script(s), 1 stylesheet(s)",
            "mod doom loaded",
        ))
        self.assertEqual(code, 0, out)
        self.assertIn("/driverlabels.html", out)

    def test_nothing_on_the_hud_is_a_failure(self):
        code, out = run(log(HUD, "no preset list answer in 1500 ms; no installed mods", "nothing to load"))
        self.assertEqual(code, 2, out)
        self.assertIn("nothing loaded on the HUD", out)

    def test_a_mod_that_starts_but_never_finishes_is_caught(self):
        """The old count-based check could not see this once bundled apps made the
        loaded list longer than the preset count."""
        code, out = run(log(
            HUD,
            "presets: 2 mod(s)",
            "bundled: 3 app(s)",
            "mod profiler 0.10.0: loading 2 script(s), 1 stylesheet(s)",
            "mod profiler loaded",
            "mod doom 0.5.4: loading 4 script(s), 1 stylesheet(s)",
        ))
        self.assertEqual(code, 2, out)
        self.assertIn("never finished", out)
        self.assertIn("doom", out)

    def test_more_loaded_than_the_preset_list_named_is_normal_now(self):
        """Three installed mods and three bundled apps is six loaded; that used to read
        as 'not every discovered mod reported loaded'."""
        mods = ["capabilities", "devconsole", "profiler", "doom", "pedalgraph", "telemetry"]
        lines = [HUD, "presets: 3 mod(s)", "bundled: 3 app(s)"]
        for name in mods:
            lines.append(f"mod {name} 1.0.0: loading 1 script(s), 1 stylesheet(s)")
            lines.append(f"mod {name} loaded")
        code, out = run(log(*lines))
        self.assertEqual(code, 0, out)

    def test_an_installed_copy_overriding_a_bundled_app_is_reported_not_flagged(self):
        code, out = run(log(
            HUD,
            "presets: 1 mod(s)",
            "bundled: 3 app(s)",
            "profiler: installed copy overrides the bundled 0.10.0",
            "mod profiler 0.10.1: loading 2 script(s), 1 stylesheet(s)",
            "mod profiler loaded",
        ))
        self.assertEqual(code, 0, out)
        self.assertIn("installed copies replaced the bundled: profiler", out)

    def test_a_broken_manifest_still_fails(self):
        code, out = run(log(
            HUD,
            "presets: 1 mod(s)",
            "mod wonky: no mod.json, skipped",
        ))
        self.assertEqual(code, 2, out)
        self.assertIn("skipped", out)

    def test_a_crash_fails_whatever_else_happened(self):
        code, out = run(log(HUD, "presets: 0 mod(s)", "bundled: 3 app(s)",
                            "mod devconsole 0.11.0: loading 1 script(s), 1 stylesheet(s)",
                            "mod devconsole loaded",
                            extra=["[2026-09-16 02:14:00.000] ********** CRASH DETECTED **********"]))
        self.assertEqual(code, 2, out)
        self.assertIn("CRASH", out)

    def test_a_log_without_the_loader_says_the_package_is_not_applied(self):
        code, out = run(["[2026-09-16 02:12:43.000] Build release x, version 0.9.1, revision 1",
                         "[2026-09-16 02:13:06.000] Loading page hud.html"])
        self.assertEqual(code, 1, out)
        self.assertIn("NOT APPLIED", out)

    def test_no_hud_in_the_session_is_its_own_verdict(self):
        code, out = run([PREFIX + "loader 0.19.0 on /menu.html"])
        self.assertEqual(code, 3, out)
        self.assertIn("HUD never loaded", out)


if __name__ == "__main__":
    unittest.main()
