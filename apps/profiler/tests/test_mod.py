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
    # the per-frame code is the graph and the table (drawColumn, fillRow) plus tick;
    # the controls below it run on a click or a setting change, not on every frame
    HOT_PATH = ("// ---- the graph", "// ---- controls")
    # A profiler is the one mod that has to reach past the library: it wraps the page's own
    # requestAnimationFrame (that is how it sees the stock HUD's work, not only ours) and
    # counts getBoundingClientRect calls, which is the closest thing this engine has to an
    # allocation counter. Its wrappers also have to hand each wrapped function the receiver
    # it was called with, which cannot be written without `this`.
    ALLOW_OWN = ("requestAnimationFrame", "cancelAnimationFrame", "getBoundingClientRect")
    ALLOW_THIS = ("sampler.js",)


class PaletteTests(unittest.TestCase):
    """The canvas paints with ink from the script, the legend with ink from the stylesheet.

    That duplication is forced: `getComputedStyle` in this engine reports inline styles and
    initial values rather than the cascade, so a canvas cannot read a colour out of CSS --
    it came back `rgba(0, 0, 0, 0)` for every band and the graph painted nothing. The two
    lists must therefore agree by test rather than by construction.
    """

    def test_the_script_and_the_stylesheet_name_the_same_colours(self):
        import re

        with open(os.path.join(ROOT, "profiler", "profiler.js"), encoding="utf-8") as f:
            js = f.read()

        with open(os.path.join(ROOT, "profiler", "profiler.css"), encoding="utf-8") as f:
            css = f.read()
        bands = re.findall(r'\{ key: "(\w+)", label: "[^"]*", ink: "([^"]+)" \}', js)

        self.assertEqual(len(bands), 6, "six bands in the script")

        for key, ink in bands:
            # the swatch specifically: the share bar behind a table row is drawn through an
            # opacity, so the engine's bar is deliberately a lighter grey than its swatch
            rule = re.search(r'\.pr-swatch\[data-band="%s"\][^{]*\{[^}]*background:\s*([^;]+);' % key, css)
            self.assertIsNotNone(rule, f"{key} has no swatch colour in the stylesheet")
            self.assertEqual(rule.group(1).strip(), ink,
                             f"{key}: the graph paints {ink} but the legend shows {rule.group(1).strip()}")


if __name__ == "__main__":
    unittest.main()
