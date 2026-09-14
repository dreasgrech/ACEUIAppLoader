"""Static regression checks on the shipped mod files.

Same guard rails as PedalGraph, adapted to a text panel:
  - no per-frame markup rebuilds (rows are a fixed pool; frames only rewrite text)
  - CSS var() fallback syntax is not supported by the game's Cohtml build
  - mod.json must describe exactly the files that exist, in the right order
  - style: IIFE modules, function expressions, let/const, no classes, no `this`
  - the version is declared once per artefact and they all agree
  - infrastructure comes from the AceMods library, not from this mod
"""
import json
import os
import re
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "src")
JS = os.path.join(SRC, "devconsole.js")
ENTRY = os.path.join(SRC, "mod.js")
CSS = os.path.join(SRC, "devconsole.css")
MOD_JSON = os.path.join(SRC, "mod.json")
VERSION_FILE = os.path.join(ROOT, "VERSION")
PREVIEW = os.path.join(ROOT, "dev", "preview.html")
HARNESS = os.path.join(ROOT, "tests", "console", "harness.html")
LIB_FILES = ["acemods.core.js", "acemods.console.js", "acemods.persist.js", "acemods.panel.js", "acemods.loop.js", "acemods.loader.js"]


def read(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


def strip_js(src):
    src = re.sub(r"/\*.*?\*/", "", src, flags=re.S)
    src = re.sub(r"//[^\n]*", "", src)
    return re.sub(r"'(?:\\.|[^'\\\n])*'|\"(?:\\.|[^\"\\\n])*\"|`(?:\\.|[^`\\])*`", "''", src)


def strip_comments(src):
    src = re.sub(r"/\*.*?\*/", "", src, flags=re.S)
    return re.sub(r"//[^\n]*", "", src)


def hot_path(js):
    """The per-frame code: the rendering section."""
    return js[js.find("// ---- rendering"):js.find("// ---- state changes")]


class ModManifestTests(unittest.TestCase):
    def setUp(self):
        self.info = json.loads(read(MOD_JSON))

    def test_required_fields(self):
        self.assertEqual(self.info["name"], "devconsole")
        self.assertRegex(self.info["version"], r"^\d+\.\d+\.\d+$")
        self.assertEqual(self.info["pages"], ["hud.html"])

    def test_listed_files_exist_and_nothing_else_ships(self):
        listed = set(self.info["scripts"]) | set(self.info["styles"]) | {"mod.json"}
        self.assertEqual(listed, set(os.listdir(SRC)), "mod.json must list exactly the files in src/")

    def test_console_loads_before_entry(self):
        scripts = self.info["scripts"]
        self.assertLess(scripts.index("devconsole.js"), scripts.index("mod.js"))

    def test_no_stock_file_is_overridden(self):
        for name in os.listdir(SRC):
            self.assertNotIn(name, ("hud.html", "cohtml.js", "components.js"))


class EntryTests(unittest.TestCase):
    def test_entry_attaches_into_the_hud_container(self):
        js = read(ENTRY)
        self.assertIn('".absolutecenter"', js)
        self.assertIn("DevConsole.ROOT_ID", js)
        self.assertIn("DevConsole.attach(root)", js)
        self.assertIn("not attaching twice", js)
        self.assertIn('AceMods.logger("[DevConsole]")', js)


class ConsoleSourceTests(unittest.TestCase):
    def setUp(self):
        self.js = read(JS)
        self.code = strip_js(self.js)

    def test_brackets_balanced(self):
        for a, b in ("()", "{}", "[]"):
            self.assertEqual(self.code.count(a), self.code.count(b), f"unbalanced {a}{b}")

    def test_rows_are_a_fixed_pool_and_frames_only_rewrite_text(self):
        hot = hot_path(self.js)
        self.assertGreater(len(hot), 800, "hot path slice found")
        for forbidden in ("innerHTML", "appendChild", "createElement", "removeChild", "style.", "insertAdjacentHTML"):
            self.assertNotIn(forbidden, hot, f"{forbidden} in the per-frame code")
        self.assertIn("textContent", hot)
        self.assertIn("if (row.seq === entry.seq) { return; }", self.js, "unchanged rows are skipped")
        self.assertIn("if (!state.open || !state.dirty || AceMods.hudHidden()) { return; }", self.js, "render only when dirty")
        self.assertEqual(self.js.count("root.innerHTML = markup()"), 1, "markup built once, at attach")

    def test_no_per_frame_geometry_or_css_in_script(self):
        self.assertNotIn("<svg", self.js.lower())
        self.assertNotIn("<canvas", self.js.lower())
        self.assertNotIn('createElement("style")', self.js)
        self.assertNotIn("background:", self.js)
        self.assertIsNone(re.search(r"var\(--", self.js))

    def test_no_css_var_fallback_syntax(self):
        self.assertIsNone(re.search(r"var\(--[a-z0-9-]+\s*,", read(CSS)), "var(--x, fallback) is not supported by the game's Cohtml")

    def test_no_magic_literals_in_hot_path(self):
        hot = strip_comments(hot_path(self.js))
        numbers = set(re.findall(r"(?<![\w.])(\d+(?:\.\d+)?)(?![\w.])", hot))
        self.assertTrue(numbers <= {"0", "1"}, f"magic numbers in hot path: {sorted(numbers)}")

    def test_uses_the_library_instead_of_its_own_infrastructure(self):
        for call in ("AceMods.panel.attach(root, { hudId: HUD_ELEMENT_ID, storageKey: STORAGE_KEY, log: log })",
                     "AceMods.panel.update(state.panel, now)", "AceMods.panel.detach(state.panel)",
                     "AceMods.loop.start(", "AceMods.loop.stop(state.loop)", "AceMods.hudHidden()",
                     "AceMods.logger(LOG_PREFIX)", "lines.subscribe(", "lines.capture(", "lines.format(", "lines.entries()",
                     "persist.readLocal(", "persist.writeLocal(", "AceMods.closestWithAttribute(", "AceMods.panel.NO_DRAG_ATTR"):
            self.assertIn(call, self.js, call)
        for own in ("requestAnimationFrame", "cancelAnimationFrame", "localStorage", "window.HUD", "getBoundingClientRect",
                    "addEventListener(\"mouse", "console.log(", "JSON.stringify"):
            self.assertNotIn(own, self.code, f"{own} belongs to the library now")

    def test_prompt_evaluates_expressions_then_statements_and_never_echoes_to_the_game_log(self):
        self.assertIn('new Function("return (" + code + "\\n);")', self.js)
        self.assertIn("return new Function(code);", self.js)
        self.assertIn('const ECHO_LEVEL = "input";', self.js)
        self.assertIn('const RESULT_LEVEL = "result";', self.js)
        self.assertIn("if (e.target === state.input || !isToggleKey(e)) { return; }", self.js, "typing in the prompt must not toggle")
        # the game's engine reports legacy keyCode only (the stock bundle checks `keyCode == 13`), so every key check must accept it
        self.assertIn("const KEY_CODES = { Backquote: 192, Enter: 13, ArrowUp: 38, ArrowDown: 40, Escape: 27 };", self.js)
        self.assertIn("e.keyCode === KEY_CODES[name]", self.js)
        self.assertNotIn("e.key === RUN_KEY", self.js, "use keyIs()")

    def test_module_shape_and_exports(self):
        self.assertIn("const DevConsole = (function () {", self.js)
        self.assertIn("}());", self.js)
        self.assertIn('const ROOT_ID = "devconsole"', self.js)
        self.assertIn("script loaded, version=", self.js)
        for name in ("VERSION", "ROOT_ID", "HUD_ELEMENT_ID", "STORAGE_KEY", "OPEN_KEY", "FILTER_KEY", "TOGGLE_CODE", "MAX_ROWS",
                     "CLASS", "FILTERS", "create", "render", "evaluate", "setOpen", "setFilter", "tick", "attach", "detach"):
            self.assertRegex(self.js, rf"\n\s+{name}: {name},?\n", f"{name} not exported")

    def test_class_names_and_levels_match_stylesheet(self):
        css = read(CSS)
        block = self.js[self.js.find("const CLASS = {"):self.js.find("};", self.js.find("const CLASS = {"))]
        names = re.findall(r':\s*"([a-z-]+)"', block)
        self.assertGreaterEqual(len(names), 12)
        for name in names:
            self.assertIn("." + name, css, f"class {name} used by the script is not styled")
        self.assertIn("body.hide-hud .ace-devconsole", css)
        for level in ("warn", "error", "input", "result"):
            self.assertIn(f'[data-level="{level}"] .dc-text', css, f"no colour for level {level}")


class VersionTests(unittest.TestCase):
    def test_versions_agree_everywhere(self):
        v = read(VERSION_FILE).strip()
        self.assertRegex(v, r"^\d+\.\d+\.\d+$")
        self.assertEqual(re.search(r'const VERSION = "([^"]+)"', read(JS)).group(1), v)
        self.assertEqual(json.loads(read(MOD_JSON))["version"], v)
        self.assertIn(v, read(os.path.join(ROOT, "README.md")))


class PreviewAndHarnessTests(unittest.TestCase):
    def test_pages_load_the_library_then_the_real_sources(self):
        for path, up in ((PREVIEW, "../"), (HARNESS, "../../")):
            html = read(path)
            positions = [html.find(f'src="{up}../ACEUIModLoader/src/{name}"') for name in LIB_FILES]
            self.assertTrue(all(p >= 0 for p in positions), f"{path}: library files missing")
            self.assertEqual(positions, sorted(positions), f"{path}: library load order")
            self.assertLess(positions[-1], html.find(f'src="{up}src/devconsole.js"'), f"{path}: library before the console")
            self.assertIn(f'href="{up}src/devconsole.css"', html)
        self.assertIn('id="devconsole"', read(PREVIEW))
        self.assertIn("--font-family-main", read(PREVIEW))


class StyleTests(unittest.TestCase):
    """The project's JavaScript conventions (see the uplinkjs scripts)."""

    FILES = {"console": JS, "entry": ENTRY, "preview": PREVIEW}

    def code_of(self, path):
        src = read(path)
        if path.endswith(".html"):
            src = "\n".join(re.findall(r"<script>(.*?)</script>", src, re.S))
        return src, strip_js(src)

    def test_no_classes_no_this_no_var_no_arrows_no_declarations(self):
        for name, path in self.FILES.items():
            _, code = self.code_of(path)
            self.assertIsNone(re.search(r"\bclass\s+[A-Za-z_$]", code), name)
            self.assertNotIn("customElements", code, name)
            self.assertIsNone(re.search(r"\bthis\b", code), name)
            self.assertIsNone(re.search(r"\bvar\s", code), name)
            self.assertIsNone(re.search(r"^\s*function\s+[A-Za-z_$][\w$]*\s*\(", code, re.M), f"{name}: function declarations")
            self.assertNotIn("=>", code, f"{name}: arrow functions")
        self.assertGreaterEqual(len(re.findall(r"= function \(", strip_js(read(JS)))), 20)

    def test_iife_shapes(self):
        self.assertIsNotNone(re.search(r"const DevConsole = \(function \(\) \{", strip_js(read(JS))))
        self.assertIsNotNone(re.search(r"\n\}\(\)\);", strip_js(read(JS))))
        self.assertIsNotNone(re.search(r"^\(function \(\) \{", strip_js(read(ENTRY)), re.M))

    def test_formatting_conventions(self):
        for path in (JS, ENTRY):
            js = read(path)
            self.assertNotIn("\t", js)
            for line in js.splitlines():
                if line.lstrip().startswith("*"):
                    continue
                self.assertEqual((len(line) - len(line.lstrip(" "))) % 4, 0, f"indent not a multiple of 4: {line!r}")
            self.assertEqual(re.findall(r"^[^\"'\n]*'", strip_comments(js), re.M), [], f"single-quoted literal in {path}")
            self.assertIsNone(re.search(r"\bif \([^\n]*\)\s*[a-z][^{\n]*;\s*$", strip_js(js), re.M), "if without braces")


if __name__ == "__main__":
    unittest.main()
