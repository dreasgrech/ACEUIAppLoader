"""The shared ACEUIModLoader test kit (modkit.py in the loader repo) plus the console's own contract."""
import os
import re
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOADER = os.environ.get("ACE_LOADER_DIR") or os.path.join(os.path.dirname(ROOT), "ACEUIModLoader")
sys.path.insert(0, os.path.join(LOADER, "tools"))

from modkit import ModTests  # noqa: E402

JS = os.path.join(ROOT, "devconsole", "devconsole.js")


class Tests(ModTests):
    ROOT = ROOT
    MIN_CASES = 18
    HOT_PATH = ("// ---- rendering", "// ---- state changes")


class ConsoleContractTests(unittest.TestCase):
    """What the console promises beyond the kit's rules (each line was once a bug)."""

    def setUp(self):
        with open(JS, encoding="utf-8") as f:
            self.js = f.read()

    def test_rows_are_a_fixed_pool(self):
        self.assertEqual(self.js.count("root.innerHTML = markup()"), 1, "markup built once, at attach")
        self.assertIn("if (row.seq === entry.seq) { return; }", self.js, "unchanged rows are skipped")
        self.assertIn("if (!state.open || !state.dirty || ACEUIModLoader.hudHidden()) { return; }", self.js, "render only when dirty")

    def test_keys_are_checked_by_legacy_keycode_too(self):
        # the game's engine reports legacy keyCode only (the stock bundle checks `keyCode == 13`)
        self.assertIn("const KEY_CODES = { Backquote: 192, Enter: 13, ArrowUp: 38, ArrowDown: 40, Escape: 27 };", self.js)
        self.assertIn("e.keyCode === KEY_CODES[name]", self.js)
        self.assertIsNone(re.search(r"e\.key === RUN_KEY", self.js), "use keyIs()")

    def test_cohtml_wheel_sign_and_typing_guards(self):
        self.assertIn("const WHEEL_SIGN = -1;", self.js, "Cohtml: a positive deltaY is up (observed in game)")
        self.assertIn("if (e.target === state.input || e.target === state.search || !isToggleKey(e)) { return; }", self.js)

    def test_prompt_never_echoes_into_the_game_log(self):
        self.assertIn('new Function("return (" + code + "\\n);")', self.js)
        self.assertIn('const ECHO_LEVEL = "input";', self.js)
        self.assertIn('const RESULT_LEVEL = "result";', self.js)

    def test_run_command_only_ever_requests_plain_snippet_files(self):
        # a URL that resolves to a folder crashes the game (ACEGameInternals, game-internals.md section 7)
        self.assertIn("const SNIPPET_NAME_RE = /^[A-Za-z0-9_.-]+$/;", self.js)
        self.assertIn('const SNIPPET_DIR = ACEUIModLoader.ROOT + "snippets/";', self.js)
        self.assertIn("if (!SNIPPET_NAME_RE.test(name)) {", self.js)
        self.assertIn("ACEUIModLoader.addScript(url, function (ok) {", self.js)
        self.assertLess(self.js.find("if (COMMAND_RE.test(trimmed)) {"), self.js.find("lines.format(compile(trimmed)())"),
                        "commands are taken before JavaScript")


if __name__ == "__main__":
    unittest.main()
