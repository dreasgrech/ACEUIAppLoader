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
    MIN_CASES = 21
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
        self.assertIn("const KEY_CODES = { Backquote: 192, Enter: 13, ArrowUp: 38, ArrowDown: 40, Escape: 27, Tab: 9 };", self.js)
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
        self.assertLess(self.js.find("if (COMMAND_RE.test(trimmed)) {"), self.js.find("showValue(compile(trimmed)())"),
                        "commands are taken before JavaScript")


    def test_results_are_expanded_over_lines_not_squashed_onto_one(self):
        # a game model is a wall of fields; console.format's single line is unreadable for those
        self.assertIn("showValue(compile(trimmed)())", self.js, "prompt results go through the tree printer")
        self.assertIn("const TREE_MAX_DEPTH", self.js)
        self.assertIn("const TREE_MAX_LINES", self.js, "a careless `window` must not flood the buffer")
        self.assertIn("if (seen.indexOf(value) >= 0)", self.js, "cycles are marked, not followed")

    def test_completion_only_reads_properties_and_never_runs_the_expression(self):
        # completing a path must not call a getter chain's functions or eval anything
        self.assertIn("const resolvePath = function (parts) {", self.js)
        self.assertIn("current = safeGet(current, parts[i]);", self.js, "walk by name, never call")
        self.assertIn("const PATH_TAIL_RE", self.js)
        completion = self.js[self.js.find("// ---- tab completion"):self.js.find("// ---- prompt ---")]
        self.assertGreater(len(completion), 0, "completion section present")
        for forbidden in ("new Function", "compile(", "eval("):
            self.assertNotIn(forbidden, completion, f"the completer must not {forbidden} anything")


if __name__ == "__main__":
    unittest.main()
