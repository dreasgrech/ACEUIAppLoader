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
        self.assertIn("if (!state.dirty || ACEUIModLoader.hudHidden()) { return; }", self.js, "render only when dirty")

    def test_keys_go_through_the_library_rather_than_a_private_table(self):
        """The engine reports legacy keyCode only (the stock bundle checks `keyCode == 13`)
        and sends the backquote as a character under `key`. Both facts, and the table that
        encodes them, now live in ACEUIModLoader.keys, so the console must use it and must
        not grow another copy."""
        self.assertIn("const keys = ACEUIModLoader.keys;", self.js)
        self.assertIn("keys.is(e, ", self.js, "key checks go through the library")
        self.assertNotIn("const KEY_CODES = {", self.js, "no private keyCode table")
        self.assertIsNone(re.search(r"e\.key === RUN_KEY", self.js), "use keys.is()")
        self.assertIn("KEY_CODES: keys.CODES", self.js, "what it exports is the library's table")

    def test_scrolling_and_the_toggle_key_come_from_the_library(self):
        """Cohtml does not scroll an overflowing box and reports the wheel with the
        opposite sign to a browser; the capabilities probe needed the same behaviour, so
        it is ACEUIModLoader.scroll's now. The toggle key binds through the loader,
        which is what keeps it from firing while the player is typing."""
        self.assertIn("const scrolling = ACEUIModLoader.scroll;", self.js)
        self.assertIn("scrolling.attach({", self.js, "the scrollbar is the library's")
        self.assertNotIn("const WHEEL_SIGN", self.js, "no private wheel handling")
        self.assertNotIn("const syncScrollbar", self.js, "no private thumb geometry")
        self.assertIn('ACEUIModLoader.mod("devconsole").toggle(DevConsole.toggleKey);', self.js,
                      "the hotkey is the loader's, so it still works once the app is switched off")
        self.assertNotIn("state.unbindToggle", self.js, "and the panel no longer holds one of its own")
        self.assertNotIn("isToggleKey", self.js, "no private hotkey matching")

    def test_every_listener_it_adds_goes_into_one_bag(self):
        """Fourteen addEventListener calls once had fourteen removeEventListener calls
        mirroring them by hand in detach; one missed pair leaks into a HUD that reloads on
        every Escape."""
        self.assertIn("state.bag = dom.listeners();", self.js)
        self.assertIn("state.bag.off();", self.js)
        self.assertEqual(self.js.count("removeEventListener"), 0, "detach empties the bag instead")

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
