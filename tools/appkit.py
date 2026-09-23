"""
appkit.py - the shared test kit for ACEUIAppLoader apps.

An app repo needs one test file. tools/new_app.py writes it; the part worth knowing is
that it finds this kit by walking up from the app's own root, because the loader is
either beside the app (its own repo) or above it (a bundled app in the loader's apps/):

    import os, sys
    ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    ... walk up for <dir>/tools/appkit.py or <dir>/ACEUIAppLoader/tools/appkit.py ...
    sys.path.insert(0, os.path.join(LOADER, "tools"))
    from appkit import AppTests

    class Tests(AppTests):
        ROOT = ROOT

and gets: app.json validity (the folder is the shipped app), nothing ships that is
not listed, no stock file is overridden, no legacy boilerplate (VERSION file, mod.js,
install wrapper, `const VERSION` in scripts), the project's JavaScript style rules,
the Cohtml rules (no `var(--x, fallback)`, no per-frame SVG/canvas, no CSS in
scripts), class names used by scripts exist in the stylesheet, identity comes from
`ACEUIAppLoader.app(...)`, and every `tests/**/harness.html` passes in a headless
browser (tools/headless.py; skipped without a browser).

Optional class attributes:
    APP_DIR       shipped folder (default: the one directory under ROOT with an app.json)
    MIN_CASES     minimum cases the harnesses must report between them (default 1)
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

APP_FILE = "app.json"
KNOWN_KEYS = {"name", "version", "title", "pages", "scripts", "styles", "files", "root", "developer"}
STOCK_FILES = ("hud.html", "cohtml.js", "components.js")
LEGACY = ("VERSION", os.path.join("tools", "install.py"))
LIBRARY_OWNED = ("requestAnimationFrame", "cancelAnimationFrame", "localStorage", "window.HUD", "getBoundingClientRect", "JSON.stringify")
HOT_FORBIDDEN = ("innerHTML", "appendChild", "createElement", "removeChild", "insertAdjacentHTML")
# per-frame style writes other than transforms (the stock HUD's own technique) thrash layout in Cohtml.
# clip-path is animated by the stock speedo too, but the engine draws it as a hard stencil with no
# antialiasing (PedalGraph's polygon bars, 2026-09-19), so it stays out.
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


def find_app_dir(root):
    """The one directory directly under root that holds an app.json."""
    found = [d for d in sorted(os.listdir(root))
             if os.path.isdir(os.path.join(root, d)) and os.path.isfile(os.path.join(root, d, APP_FILE))]
    if len(found) != 1:
        raise AssertionError(f"expected exactly one folder with {APP_FILE} under {root}, found {found}")
    return os.path.join(root, found[0])


def check_style(testcase, name, js, allow_this=False):
    """The project's JavaScript conventions: IIFE modules, no classes/this/var/arrows, 4 spaces, double quotes.

    `allow_this` exists for one shape of code these rules were not written for: a
    wrapper standing in front of somebody else's function has to hand that function
    the receiver it was called with, and there is no way to say that without `this`.
    An app opts in per file, in its own test class, so the exception is visible next
    to the file it applies to rather than hidden in the kit.
    """
    code = strip_js(js)
    testcase.assertIsNone(re.search(r"\bclass\s+[A-Za-z_$]", code), f"{name}: class")
    # defining one is the hazard: the stock framework owns the ks-* registry and an app
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


class AppTests(unittest.TestCase):
    ROOT = None
    APP_DIR = None
    MIN_CASES = 1
    HOT_PATH = None
    ALLOW_OWN = ()
    ALLOW_THIS = ()      # files where a receiver-preserving wrapper needs `this` (see check_style)

    @classmethod
    def setUpClass(cls):
        if cls.ROOT is None:
            raise unittest.SkipTest("AppTests is a base class; subclass it with ROOT set")
        cls.app_dir = cls.APP_DIR or find_app_dir(cls.ROOT)
        cls.name = os.path.basename(cls.app_dir)
        cls.info = json.loads(read(os.path.join(cls.app_dir, APP_FILE)))
        cls.scripts = {f: read(os.path.join(cls.app_dir, f)) for f in cls.info.get("scripts", [])}
        cls.styles = {f: read(os.path.join(cls.app_dir, f)) for f in cls.info.get("styles", [])}

    # ---- the shipped folder ----------------------------------------------------------

    def test_app_json_is_minimal_and_valid(self):
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
            self.assertTrue(os.path.isfile(os.path.join(self.app_dir, rel)), f"{rel} listed but missing")
        self.assertTrue(info.get("scripts"), "at least one script")

    def test_nothing_ships_that_is_not_listed(self):
        listed = set(self.info.get("scripts", [])) | set(self.info.get("styles", [])) | set(self.info.get("files", [])) | {APP_FILE}
        present = {n for n in os.listdir(self.app_dir) if not n.startswith(".")}
        self.assertEqual(present, listed, "app.json must list exactly the files in the app folder")
        for stock in STOCK_FILES:
            self.assertNotIn(stock, present, f"{stock} must not be overridden")

    def test_no_legacy_boilerplate(self):
        for rel in LEGACY:
            self.assertFalse(os.path.exists(os.path.join(self.ROOT, rel)), f"{rel}: gone since loader 0.4.0 (app.json holds the version)")
        self.assertFalse(os.path.exists(os.path.join(self.app_dir, "mod.js")), "mod.js: the loader creates the root now")
        for name, js in self.scripts.items():
            self.assertIsNone(re.search(r"const VERSION\s*=", js), f"{name}: the version lives in app.json; read ACEUIAppLoader.app().version")

    # ---- the scripts ----------------------------------------------------------------

    def test_style_rules(self):
        for name, js in self.scripts.items():
            check_style(self, name, js, allow_this=name in self.ALLOW_THIS)

    def test_cohtml_rules(self):
        for name, css in self.styles.items():
            rules = re.sub(r"/\*.*?\*/", "", css, flags=re.S)
            self.assertIsNone(re.search(r"var\(--[a-z0-9-]+\s*,", rules), f"{name}: var(--x, fallback) is not supported by the game's Cohtml")
            # ignored by the engine, and it logs a warning for every element that asks, on
            # every frame: 19,672 lines in one 13-minute session came from one legend
            self.assertNotIn("text-transform", rules, f"{name}: text-transform is ignored and floods the game log; upper-case the string in the script")
            self.assertIsNone(re.search(r"align-items\s*:\s*baseline", rules), f"{name}: align-items: baseline is not supported (use center or flex-end)")
            # `Trying to set display property to invalid value!` once per element that asks (log 2026-09-22); the stock CSS never uses it
            self.assertNotIn("inline-flex", rules, f"{name}: display: inline-flex is not supported (use flex; a flex item is laid out the same)")
            self.assertNotIn("inline-block", rules, f"{name}: display: inline-block is not supported either (use block; the stock never uses either)")
        for name, js in self.scripts.items():
            low = js.lower()
            self.assertNotIn("<svg", low, f"{name}: no SVG built by script (per-frame geometry crashed the game)")
            self.assertNotIn("<canvas", low, name)
            self.assertNotIn('createElement("style")', js, f"{name}: no CSS in scripts")
            self.assertNotIn("background:", js, f"{name}: no CSS in scripts")
            self.assertIsNone(re.search(r"var\(--", js), f"{name}: no CSS variables in scripts")
            self.assertNotIn("textTransform", js, f"{name}: text-transform is ignored and floods the game log")
            self.assertNotIn('alignItems: "baseline"', js, f"{name}: align-items: baseline is not supported")
            self.assertNotIn("inline-flex", js, f"{name}: display: inline-flex is not supported (use flex)")
            self.assertNotIn("inline-block", js, f"{name}: display: inline-block is not supported (use block)")

    def test_identity_comes_from_the_loader(self):
        joined = "\n".join(self.scripts.values())
        self.assertIn("ACEUIAppLoader.app(", joined, "read name/version/title/root/log/keys from ACEUIAppLoader.app(...)")
        self.assertIn(".mount(", joined, "attach through ACEUIAppLoader.app(name).mount(attach), not your own boot code")
        for name, js in self.scripts.items():
            code = strip_js(js)
            for own in ("DOMContentLoaded", "readyState"):
                self.assertNotIn(own, code, f"{name}: {own}: the loader's mount() handles page readiness")
            for own in LIBRARY_OWNED:
                if own in self.ALLOW_OWN:
                    continue
                self.assertNotIn(own, code, f"{name}: {own} belongs to the library (ACEUIAppLoader.loop/persist/panel)")

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
        # MIN_CASES guards against a suite silently shrinking; it is held to the cases of all the
        # harnesses together, so an app may keep a second harness (recorded sessions, say) small
        total = 0
        for page in pages:
            with self.subTest(harness=os.path.relpath(page, self.ROOT)):
                total += headless.check_harness(self, page, 1)
        self.assertGreaterEqual(total, self.MIN_CASES, f"expected the full set of cases across {len(pages)} harness(es)")
