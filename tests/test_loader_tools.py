"""Tests for the library sources (style and contracts), install_mod.py and build_loader.py."""
import json
import os
import re
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TOOLS = os.path.join(ROOT, "tools")
sys.path.insert(0, TOOLS)

import install_mod  # noqa: E402
import build_loader  # noqa: E402
import _repos  # noqa: E402

SRC = os.path.join(ROOT, "src")


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


class LibrarySourceTests(unittest.TestCase):
    def setUp(self):
        self.files = {name: read(os.path.join(SRC, name)) for name in build_loader.LIB_ORDER}

    def test_every_source_file_is_in_load_order_and_present(self):
        self.assertEqual(sorted(n for n in os.listdir(SRC) if n.endswith(".js")), sorted(build_loader.LIB_ORDER))
        self.assertEqual(build_loader.LIB_ORDER[0], "acemods.core.js", "core defines the namespace")
        self.assertEqual(build_loader.LIB_ORDER[1], "acemods.console.js", "console hook must run before the stock bundle")
        self.assertEqual(build_loader.LIB_ORDER[-1], "acemods.loader.js", "loader starts mods last")

    def test_version_matches_version_file_and_readme(self):
        v = read(os.path.join(ROOT, "VERSION")).strip()
        self.assertRegex(v, r"^\d+\.\d+\.\d+$")
        self.assertIn(f'const VERSION = "{v}";', self.files["acemods.core.js"])
        self.assertIn(v, read(os.path.join(ROOT, "README.md")))

    def test_style_rules(self):
        for name, js in self.files.items():
            code = strip_js(js)
            self.assertIsNone(re.search(r"\bclass\s+[A-Za-z_$]", code), name)
            self.assertIsNone(re.search(r"\bthis\b", code), name)
            self.assertIsNone(re.search(r"^\s*function\s+[A-Za-z_$][\w$]*\s*\(", code, re.M), f"{name}: function declarations")
            self.assertNotIn("=>", code, f"{name}: arrow functions")
            self.assertIsNone(re.search(r"\bvar\s", code), name)
            self.assertNotIn("\t", js, name)
            for a, b in ("()", "{}", "[]"):
                self.assertEqual(code.count(a), code.count(b), f"{name}: unbalanced {a}{b}")
            for line in js.splitlines():
                if line.lstrip().startswith("*"):
                    continue
                self.assertEqual((len(line) - len(line.lstrip(" "))) % 4, 0, f"{name}: indent {line!r}")
            self.assertEqual(re.findall(r"^[^\"'\n]*'", strip_comments(js), re.M), [], f"{name}: single-quoted literal")

    def test_module_shapes(self):
        self.assertIn("const AceMods = (function () {", self.files["acemods.core.js"])
        self.assertIn("\nwindow.AceMods = AceMods;\n", self.files["acemods.core.js"])
        for name in build_loader.LIB_ORDER[1:]:
            ns = name.split(".")[1]
            self.assertIn(f"AceMods.{ns} = (function () {{", self.files[name], f"{name} must define AceMods.{ns}")
            self.assertNotIn("const AceMods", self.files[name], f"{name} must not redefine the namespace")

    def test_core_exports(self):
        core = self.files["acemods.core.js"]
        for name in ("VERSION", "LOG_PREFIX", "HUD_HIDDEN_CLASS", "page", "log", "logger", "clamp", "el", "close",
                     "toArray", "percentText", "hudHidden", "closestWithAttribute"):
            self.assertRegex(core, rf"\n\s+{name}: [A-Za-z_.()]+,?\n", f"core.{name} not exported")

    def test_console_hook_chains_and_never_echoes(self):
        js = self.files["acemods.console.js"]
        self.assertIn('const LEVELS = ["log", "info", "debug", "warn", "error"];', js)
        self.assertNotIn('"trace"', js, "console.trace is wrapped by the stock bundle; leave it alone")
        self.assertIn("original.apply(console, args);", js)
        self.assertIn("const MAX_ENTRIES = 500;", js)
        self.assertIn('window.addEventListener("error", onError);', js)
        self.assertIn('window.addEventListener("unhandledrejection", onRejection);', js)
        self.assertIn("if (state.notifying) { return; }", js, "listener recursion guard")
        for name in ("MAX_ENTRIES", "LEVELS", "entries", "clear", "capture", "subscribe", "listenerCount", "format"):
            self.assertRegex(js, rf"\n\s+{name}: [A-Za-z_.]+,?\n", f"console.{name} not exported")

    def test_panel_contract(self):
        js = self.files["acemods.panel.js"]
        self.assertIn('const NO_DRAG_ATTR = "data-nodrag";', js)
        self.assertIn('const DRAGGING_CLASS = "dragging";', js)
        self.assertIn("const RESTORE_WAIT_MS = 2000;", js)
        self.assertIn('root.style.visibility = HIDDEN;', js, "hidden until placed, without needing a stylesheet")
        for name in ("RESTORE_WAIT_MS", "DRAGGING_CLASS", "NO_DRAG_ATTR", "isPosition", "moveTo", "currentPosition",
                     "savePosition", "update", "attach", "detach"):
            self.assertRegex(js, rf"\n\s+{name}: [A-Za-z_.]+,?\n", f"panel.{name} not exported")
        self.assertIn('window.removeEventListener("mousemove", panel.handlers.move);', js)

    def test_loader_contract(self):
        js = self.files["acemods.loader.js"]
        self.assertIn('const ROOT = "acemods/";', js)
        self.assertIn('ROOT + "manifest.json"', js)
        self.assertIn('const MOD_FILE = "mod.json";', js)
        self.assertIn('const DEFAULT_PAGES = ["hud.html"];', js)
        for line in ('"loader " + AceMods.VERSION + " on /"', '"manifest: "', '" loaded"', '" FAILED"', '"no manifest at "'):
            self.assertIn(line, js, line)
        self.assertIn("loadScripts(base, files, index + 1, onDone)", js, "scripts load sequentially")
        for alias in ("ROOT", "mods", "ready", "addStylesheet", "addScript"):
            self.assertIn(f"AceMods.{alias} = AceMods.loader.{alias};", js)

    def test_no_per_frame_geometry_or_css_in_library(self):
        for name, js in self.files.items():
            self.assertNotIn("<svg", js.lower(), name)
            self.assertNotIn("innerHTML", js, f"{name}: the library builds no markup")
            self.assertNotIn('createElement("style")', js, name)


class InstallModTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.mods = os.path.join(self.tmp.name, "mods")
        self.src = os.path.join(self.tmp.name, "mymod")
        os.makedirs(self.src)
        with open(os.path.join(self.src, "mod.json"), "w", encoding="utf-8") as f:
            json.dump({"name": "mymod", "version": "1.2.3", "pages": ["hud.html"], "styles": ["a.css"], "scripts": ["a.js", "b.js"]}, f)
        for name in ("a.css", "a.js", "b.js", ".hidden", "x.swp"):
            with open(os.path.join(self.src, name), "w") as f:
                f.write("x")

    def tearDown(self):
        self.tmp.cleanup()

    def test_install_copies_files_and_registers_in_manifest(self):
        dest = install_mod.install(self.src, self.mods)
        self.assertEqual(dest, os.path.join(self.mods, "uiresources", "acemods", "mymod"))
        self.assertEqual(sorted(os.listdir(dest)), ["a.css", "a.js", "b.js", "mod.json"], "junk must not be copied")
        manifest = install_mod.read_manifest(install_mod.acemods_dir(self.mods))
        self.assertEqual(manifest["mods"], ["mymod"])
        install_mod.install(self.src, self.mods)
        self.assertEqual(install_mod.read_manifest(install_mod.acemods_dir(self.mods))["mods"], ["mymod"])

    def test_remove(self):
        install_mod.install(self.src, self.mods)
        install_mod.remove("mymod", self.mods)
        self.assertFalse(os.path.isdir(os.path.join(self.mods, "uiresources", "acemods", "mymod")))
        self.assertEqual(install_mod.read_manifest(install_mod.acemods_dir(self.mods))["mods"], [])

    def test_missing_listed_file_is_an_error(self):
        os.remove(os.path.join(self.src, "b.js"))
        with self.assertRaises(SystemExit):
            install_mod.install(self.src, self.mods)

    def test_manifest_keeps_other_mods(self):
        root = install_mod.acemods_dir(self.mods)
        install_mod.write_manifest(root, {"mods": ["other"]})
        install_mod.install(self.src, self.mods)
        self.assertEqual(install_mod.read_manifest(root)["mods"], ["other", "mymod"])


@unittest.skipUnless(os.path.exists(os.path.join(_repos.game_dir(), "content.kspkg")), "game not installed")
class BuildLoaderTests(unittest.TestCase):
    def test_assemble_is_stock_plus_library_in_order_and_override_wins(self):
        import kspkg
        import pack_kspkg as pk
        import lookup_sim
        with tempfile.TemporaryDirectory() as tmp:
            build = build_loader.assemble(os.path.join(tmp, "build"))
            host = os.path.join(build, "uiresources", "js", "cohtml.js")
            stock = kspkg.extract(os.path.join(_repos.game_dir(), "content.kspkg"), build_loader.HOST_PATH)
            data = open(host, "rb").read()
            self.assertTrue(data.startswith(stock), "host must start with the untouched stock file")
            positions = [data.index(f"/* ---- {name} ".encode()) for name in build_loader.LIB_ORDER]
            self.assertEqual(positions, sorted(positions), "library files must be appended in LIB_ORDER")
            self.assertIn(b"const AceMods = (function () {", data)
            self.assertIn(b"AceMods.loader = (function () {", data)
            out = os.path.join(tmp, "loader.kspkg")
            written = pk.pack(build, out)
            pk.verify(out, written)
            base = lookup_sim.read_base_hashes(os.path.join(_repos.game_dir(), "content.kspkg"))
            entries = kspkg.read_entries(out)
            w = lookup_sim.winners(base, [e.hash for e in entries.values()])
            self.assertEqual(w[pk.path_hash(build_loader.HOST_PATH)], "mod", "cohtml.js override would lose")
            self.assertEqual([p for p in entries if not p.startswith("uiresources\\pad") and "\\" in p and p.endswith(".js")],
                             ["uiresources\\js\\cohtml.js"], "the package must contain exactly one file")


if __name__ == "__main__":
    unittest.main()
