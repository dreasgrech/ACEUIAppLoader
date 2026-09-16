"""
modkit.py - the shared test kit for ACEUIModLoader mods.

A mod repo needs one test file. tools/new_mod.py writes it; the part worth knowing is
that it finds this kit by walking up from the mod's own root, because the loader is
either beside the mod (its own repo) or above it (a bundled app in the loader's apps/):

    import os, sys
    ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    ... walk up for <dir>/tools/modkit.py or <dir>/ACEUIModLoader/tools/modkit.py ...
    sys.path.insert(0, os.path.join(LOADER, "tools"))
    from modkit import ModTests

    class Tests(ModTests):
        ROOT = ROOT

and gets: mod.json validity (the folder is the shipped mod), nothing ships that is
not listed, no stock file is overridden, no legacy boilerplate (VERSION file, mod.js,
install wrapper, `const VERSION` in scripts), the project's JavaScript style rules,
the Cohtml rules (no `var(--x, fallback)`, no per-frame SVG/canvas, no CSS in
scripts), class names used by scripts exist in the stylesheet, identity comes from
`ACEUIModLoader.mod(...)`, and every `tests/**/harness.html` passes in a headless
browser (tools/headless.py; skipped without a browser).

Optional class attributes:
    MOD_DIR       shipped folder (default: the one directory under ROOT with a mod.json)
    MIN_CASES     minimum cases a harness must report (default 1)
    HOT_PATH      (start marker, end marker) in the main script: that slice must not
                  build markup or touch style, and must not hold magic numbers
    ALLOW_OWN     substrings the "belongs to the library" rule should tolerate
    ALLOW_THIS    script file names allowed `this` (receiver-preserving wrappers)
"""
import glob
import json
import os
import re
import unittest

import headless

MOD_FILE = "mod.json"
KNOWN_KEYS = {"name", "version", "title", "pages", "scripts", "styles", "files", "root", "developer"}
STOCK_FILES = ("hud.html", "cohtml.js", "components.js")
LEGACY = ("VERSION", os.path.join("tools", "install.py"))
LIBRARY_OWNED = ("requestAnimationFrame", "cancelAnimationFrame", "localStorage", "window.HUD", "getBoundingClientRect", "JSON.stringify")
HOT_FORBIDDEN = ("innerHTML", "appendChild", "createElement", "removeChild", "insertAdjacentHTML")
# per-frame style writes other than transforms (the stock HUD's own technique) thrash layout in Cohtml
HOT_STYLE_RE = re.compile(r"\.style\.(?!transform\b)[A-Za-z]")


def read(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


def strip_js(src):
    """Source without comments and with string literals blanked, for structural checks."""
    src = re.sub(r"/\*.*?\*/", "", src, flags=re.S)
    src = re.sub(r"//[^\n]*", "", src)
    return re.sub(r"'(?:\\.|[^'\\\n])*'|\"(?:\\.|[^\"\\\n])*\"|`(?:\\.|[^`\\])*`", "''", src)


def strip_comments(src):
    src = re.sub(r"/\*.*?\*/", "", src, flags=re.S)
    return re.sub(r"//[^\n]*", "", src)


def find_mod_dir(root):
    """The one directory directly under root that holds a mod.json."""
    found = [d for d in sorted(os.listdir(root))
             if os.path.isdir(os.path.join(root, d)) and os.path.isfile(os.path.join(root, d, MOD_FILE))]
    if len(found) != 1:
        raise AssertionError(f"expected exactly one folder with {MOD_FILE} under {root}, found {found}")
    return os.path.join(root, found[0])


def check_style(testcase, name, js, allow_this=False):
    """The project's JavaScript conventions: IIFE modules, no classes/this/var/arrows, 4 spaces, double quotes.

    `allow_this` exists for one shape of code these rules were not written for: a
    wrapper standing in front of somebody else's function has to hand that function
    the receiver it was called with, and there is no way to say that without `this`.
    A mod opts in per file, in its own test class, so the exception is visible next
    to the file it applies to rather than hidden in the kit.
    """
    code = strip_js(js)
    testcase.assertIsNone(re.search(r"\bclass\s+[A-Za-z_$]", code), f"{name}: class")
    # defining one is the hazard: the stock framework owns the ks-* registry and a mod
    # that registers a tag can collide with it. Reading the registry is not a hazard --
    # ACEUIProfiler does it to wrap the stock widgets' methods and profile them by name.
    testcase.assertNotIn("customElements.define", code, f"{name}: defines a custom element")
    if not allow_this:
        testcase.assertIsNone(re.search(r"\bthis\b", code), f"{name}: this")
    testcase.assertIsNone(re.search(r"\bvar\s", code), f"{name}: var")
    testcase.assertIsNone(re.search(r"^\s*function\s+[A-Za-z_$][\w$]*\s*\(", code, re.M), f"{name}: function declaration")
    testcase.assertNotIn("=>", code, f"{name}: arrow function")
    testcase.assertNotIn("\t", js, f"{name}: tab")
    for a, b in ("()", "{}", "[]"):
        testcase.assertEqual(code.count(a), code.count(b), f"{name}: unbalanced {a}{b}")
    for line in js.splitlines():
        if line.lstrip().startswith("*"):
            continue
        testcase.assertEqual((len(line) - len(line.lstrip(" "))) % 4, 0, f"{name}: indent not a multiple of 4: {line!r}")
    testcase.assertEqual(re.findall(r"^[^\"'\n]*'", strip_comments(js), re.M), [], f"{name}: single-quoted literal")
    testcase.assertIsNone(re.search(r"\bif \([^\n]*\)\s*[a-z][^{\n]*;\s*$", code, re.M), f"{name}: if without braces")
    testcase.assertIsNotNone(re.search(r"\(function \(\) \{", code), f"{name}: no IIFE")


class ModTests(unittest.TestCase):
    ROOT = None
    MOD_DIR = None
    MIN_CASES = 1
    HOT_PATH = None
    ALLOW_OWN = ()
    ALLOW_THIS = ()      # files where a receiver-preserving wrapper needs `this` (see check_style)

    @classmethod
    def setUpClass(cls):
        if cls.ROOT is None:
            raise unittest.SkipTest("ModTests is a base class; subclass it with ROOT set")
        cls.mod_dir = cls.MOD_DIR or find_mod_dir(cls.ROOT)
        cls.name = os.path.basename(cls.mod_dir)
        cls.info = json.loads(read(os.path.join(cls.mod_dir, MOD_FILE)))
        cls.scripts = {f: read(os.path.join(cls.mod_dir, f)) for f in cls.info.get("scripts", [])}
        cls.styles = {f: read(os.path.join(cls.mod_dir, f)) for f in cls.info.get("styles", [])}

    # ---- the shipped folder ----------------------------------------------------------

    def test_mod_json_is_minimal_and_valid(self):
        info = self.info
        self.assertRegex(info.get("version", ""), r"^\d+\.\d+\.\d+$", "version x.y.z")
        self.assertEqual(sorted(set(info) - KNOWN_KEYS), [], f"unknown keys; known: {sorted(KNOWN_KEYS)}")
        if "name" in info:
            self.assertEqual(info["name"], self.name, "a name key must match the folder name (or be left out)")
        self.assertRegex(self.name, r"^[a-z0-9][a-z0-9_.-]*$", "folder name: lower-case letters, digits, _ . -")
        for key in ("scripts", "styles", "files", "pages"):
            self.assertIsInstance(info.get(key, []), list, key)
        for rel in info.get("scripts", []) + info.get("styles", []) + info.get("files", []):
            self.assertEqual(os.path.basename(rel), rel, f"{rel}: plain file names only (folders crash the game)")
            self.assertTrue(os.path.isfile(os.path.join(self.mod_dir, rel)), f"{rel} listed but missing")
        self.assertTrue(info.get("scripts"), "at least one script")

    def test_nothing_ships_that_is_not_listed(self):
        listed = set(self.info.get("scripts", [])) | set(self.info.get("styles", [])) | set(self.info.get("files", [])) | {MOD_FILE}
        present = {n for n in os.listdir(self.mod_dir) if not n.startswith(".")}
        self.assertEqual(present, listed, "mod.json must list exactly the files in the mod folder")
        for stock in STOCK_FILES:
            self.assertNotIn(stock, present, f"{stock} must not be overridden")

    def test_no_legacy_boilerplate(self):
        for rel in LEGACY:
            self.assertFalse(os.path.exists(os.path.join(self.ROOT, rel)), f"{rel}: gone since loader 0.4.0 (mod.json holds the version)")
        self.assertFalse(os.path.exists(os.path.join(self.mod_dir, "mod.js")), "mod.js: the loader creates the root now")
        for name, js in self.scripts.items():
            self.assertIsNone(re.search(r"const VERSION\s*=", js), f"{name}: the version lives in mod.json; read ACEUIModLoader.mod().version")

    # ---- the scripts ----------------------------------------------------------------

    def test_style_rules(self):
        for name, js in self.scripts.items():
            check_style(self, name, js, allow_this=name in self.ALLOW_THIS)

    def test_cohtml_rules(self):
        for name, css in self.styles.items():
            self.assertIsNone(re.search(r"var\(--[a-z0-9-]+\s*,", css), f"{name}: var(--x, fallback) is not supported by the game's Cohtml")
        for name, js in self.scripts.items():
            low = js.lower()
            self.assertNotIn("<svg", low, f"{name}: no SVG built by script (per-frame geometry crashed the game)")
            self.assertNotIn("<canvas", low, name)
            self.assertNotIn('createElement("style")', js, f"{name}: no CSS in scripts")
            self.assertNotIn("background:", js, f"{name}: no CSS in scripts")
            self.assertIsNone(re.search(r"var\(--", js), f"{name}: no CSS variables in scripts")

    def test_identity_comes_from_the_loader(self):
        joined = "\n".join(self.scripts.values())
        self.assertIn("ACEUIModLoader.mod(", joined, "read name/version/title/root/log/keys from ACEUIModLoader.mod(...)")
        self.assertIn(".mount(", joined, "attach through ACEUIModLoader.mod(name).mount(attach), not your own boot code")
        for name, js in self.scripts.items():
            code = strip_js(js)
            for own in ("DOMContentLoaded", "readyState"):
                self.assertNotIn(own, code, f"{name}: {own}: the loader's mount() handles page readiness")
            for own in LIBRARY_OWNED:
                if own in self.ALLOW_OWN:
                    continue
                self.assertNotIn(own, code, f"{name}: {own} belongs to the library (ACEUIModLoader.loop/persist/panel)")

    def test_class_names_used_by_scripts_exist_in_the_stylesheet(self):
        css = "\n".join(self.styles.values())
        for name, js in self.scripts.items():
            start = js.find("const CLASS = {")
            if start < 0:
                continue
            block = js[start:js.find("};", start)]
            names = re.findall(r':\s*"([a-z][a-z0-9-]*)"', block)
            self.assertTrue(names, f"{name}: CLASS block found but empty")
            for cls in names:
                self.assertIn("." + cls, css, f"{name}: class {cls} is not styled")

    def test_hot_path_only_rewrites_text(self):
        if not self.HOT_PATH:
            self.skipTest("no HOT_PATH markers declared")
        start, end = self.HOT_PATH
        for name, js in self.scripts.items():
            if start not in js:
                continue
            hot = js[js.find(start):js.find(end)]
            self.assertGreater(len(hot), 0, f"{name}: hot path slice empty")
            for forbidden in HOT_FORBIDDEN:
                self.assertNotIn(forbidden, hot, f"{name}: {forbidden} in the per-frame code")
            self.assertIsNone(HOT_STYLE_RE.search(hot), f"{name}: per-frame style write other than transform")
            numbers = set(re.findall(r"(?<![\w.])(\d+(?:\.\d+)?)(?![\w.])", strip_comments(hot)))
            self.assertTrue(numbers <= {"0", "1"}, f"{name}: magic numbers in hot path: {sorted(numbers)}")

    # ---- the browser harnesses ------------------------------------------------------

    def test_browser_harnesses_pass(self):
        pages = sorted(glob.glob(os.path.join(self.ROOT, "tests", "**", "harness.html"), recursive=True))
        if not pages:
            self.skipTest("no tests/**/harness.html")
        if not headless.find_browser():
            self.skipTest("no Chromium-based browser found (set ACE_BROWSER)")
        for page in pages:
            with self.subTest(harness=os.path.relpath(page, self.ROOT)):
                headless.check_harness(self, page, self.MIN_CASES)
