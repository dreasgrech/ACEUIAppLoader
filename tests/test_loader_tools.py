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
        self.assertEqual(build_loader.LIB_ORDER[0], "ACEUIModLoader.core.js", "core defines the namespace")
        self.assertEqual(build_loader.LIB_ORDER[1], "ACEUIModLoader.console.js", "console hook must run before the stock bundle")
        self.assertEqual(build_loader.LIB_ORDER[-2], "ACEUIModLoader.loader.js", "loader starts mods")
        # the drawer registers an ACEUIModLoader.ready callback, so it must load after the loader
        self.assertEqual(build_loader.LIB_ORDER[-1], "ACEUIModLoader.drawer.js", "drawer needs ready()")

    def test_version_matches_version_file_and_readme(self):
        v = read(os.path.join(ROOT, "VERSION")).strip()
        self.assertRegex(v, r"^\d+\.\d+\.\d+$")
        self.assertIn(f'const VERSION = "{v}";', self.files["ACEUIModLoader.core.js"])
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
        self.assertIn("const ACEUIModLoader = (function () {", self.files["ACEUIModLoader.core.js"])
        self.assertIn("\nwindow.ACEUIModLoader = ACEUIModLoader;\n", self.files["ACEUIModLoader.core.js"])
        for name in build_loader.LIB_ORDER[1:]:
            ns = name.split(".")[1]
            self.assertIn(f"ACEUIModLoader.{ns} = (function () {{", self.files[name], f"{name} must define ACEUIModLoader.{ns}")
            self.assertNotIn("const ACEUIModLoader", self.files[name], f"{name} must not redefine the namespace")

    def test_core_exports(self):
        core = self.files["ACEUIModLoader.core.js"]
        for name in ("VERSION", "LOG_PREFIX", "HUD_HIDDEN_CLASS", "page", "log", "logger", "clamp", "el", "close",
                     "toArray", "percentText", "hudHidden", "closestWithAttribute"):
            self.assertRegex(core, rf"\n\s+{name}: [A-Za-z_.()]+,?\n", f"core.{name} not exported")

    def test_console_hook_chains_and_never_echoes(self):
        js = self.files["ACEUIModLoader.console.js"]
        # trace/dir/table are wrapped too: this file runs BEFORE the stock bundle, so when
        # the bundle wraps console.trace itself its wrapper calls ours, which calls the
        # original -- the line is captured once and the bundle's behaviour is unchanged.
        self.assertIn('const LEVELS = ["log", "info", "debug", "warn", "error", "trace", "dir", "table"];', js)
        # console.assert must only record when the condition is false, so it is wrapped apart
        self.assertIn("if (!condition) { push(ASSERT_LEVEL, ASSERT_PREFIX + formatArgs(args)); }", js)
        self.assertIn("wrapAssert();", js, "the assert wrapper is installed by hook()")
        self.assertIn("original.apply(console, args);", js)
        self.assertIn("const MAX_ENTRIES = 500;", js)
        self.assertIn('window.addEventListener("error", onError);', js)
        self.assertIn('window.addEventListener("unhandledrejection", onRejection);', js)
        self.assertIn("if (state.notifying) { return; }", js, "listener recursion guard")
        for name in ("MAX_ENTRIES", "LEVELS", "entries", "clear", "capture", "subscribe", "listenerCount", "format"):
            self.assertRegex(js, rf"\n\s+{name}: [A-Za-z_.]+,?\n", f"console.{name} not exported")

    def test_mod_roots_are_hidden_at_creation_when_switched_off(self):
        # the drawer builds on ready(), which fires only after every mod has loaded, so a
        # switched-off app stayed visible for that whole window and appeared to flash on
        # and off again after a pause-menu reload
        js = self.files["ACEUIModLoader.loader.js"]
        self.assertIn("if (ACEUIModLoader.drawer) { ACEUIModLoader.drawer.applyStored(name); }", js,
                      "mountRoot must apply the saved switch as soon as it creates the root")
        self.assertLess(js.find("ACEUIModLoader.drawer.applyStored(name)"), js.find("return root;"),
                        "applied before the root is handed back and the mod's scripts run")
        drawer = self.files["ACEUIModLoader.drawer.js"]
        self.assertIn("loadStored();", drawer, "the saved switches are read as the library loads")
        self.assertIn("applyStored: applyStored,", drawer, "and exported for the loader to call")

    def test_panel_contract(self):
        js = self.files["ACEUIModLoader.panel.js"]
        self.assertIn('const NO_DRAG_ATTR = "data-nodrag";', js)
        self.assertIn('const DRAGGING_CLASS = "dragging";', js)
        self.assertIn("const RESTORE_WAIT_MS = 2000;", js)
        self.assertIn('root.style.visibility = HIDDEN;', js, "hidden until placed, without needing a stylesheet")
        for name in ("RESTORE_WAIT_MS", "DRAGGING_CLASS", "NO_DRAG_ATTR", "isPosition", "moveTo", "currentPosition",
                     "savePosition", "update", "attach", "detach"):
            self.assertRegex(js, rf"\n\s+{name}: [A-Za-z_.]+,?\n", f"panel.{name} not exported")
        self.assertIn('window.removeEventListener("mousemove", panel.handlers.move);', js)

    def test_loader_contract(self):
        js = self.files["ACEUIModLoader.loader.js"]
        self.assertIn('const ROOT = "ACEUIModLoaderMods/";', js)
        self.assertNotIn("manifest", js.lower(), "the game's preset list is the only source of mod names")
        self.assertIn('const MOD_FILE = "mod.json";', js)
        self.assertIn('const DEFAULT_PAGES = ["hud.html"];', js)
        self.assertIn('const PRESET_REQUEST = "SettingsRequestVideoPresetList";', js)
        self.assertIn('const PRESET_RESPONSE = "SettingsResponseVideoPresetList";', js)
        self.assertIn('const MARKER_PREFIX = "ACEUIModLoaderMods-";', js)
        self.assertIn('const MARKER_EXT = ".settingspreset";', js)
        self.assertIn('engine.trigger("OnUICommand", PRESET_REQUEST, { __Type: PRESET_REQUEST, version: 0 });', js)
        for line in ('"loader " + ACEUIModLoader.VERSION + " on /"', 'source + ": " + names.length + " mod(s)"', '" loaded"',
                     '" FAILED"', '"; nothing to load"', '"no engine on this page"', '"could not wrap engine.on'):
            self.assertIn(line, js, line)
        self.assertIn("loadScripts(base, files, index + 1, onDone)", js, "scripts load sequentially")
        self.assertIn("styles.concat(scripts).every(isFileName)", js, "never request anything that could be a folder")
        for name in ("PRESET_REQUEST", "PRESET_RESPONSE", "MARKER_PREFIX", "MARKER_EXT", "PRESET_TIMEOUT_MS", "source",
                     "filtering", "isMarker", "markerNames", "withoutMarkers", "isFileName", "CONTAINER_SELECTOR",
                     "MOD_ATTR", "DEV_VERSION", "mod"):
            self.assertRegex(js, rf"\n\s+{name}: [A-Za-z_.]+,?\n", f"loader.{name} not exported")
        for alias in ("ROOT", "mods", "mod", "ready", "addStylesheet", "addScript"):
            self.assertIn(f"ACEUIModLoader.{alias} = ACEUIModLoader.loader.{alias};", js)
        self.assertIn('const CONTAINER_SELECTOR = ".absolutecenter";', js)
        self.assertIn("mountRoot(name, info);\n            state.current = entry;\n            loadScripts(", js,
                      "root exists and mod() knows the current mod before its scripts run")
        self.assertIn('const KEY_PREFIX = "ace";', js)
        self.assertIn('const HUD_ID_PREFIX = "hud_";', js)

    def test_browser_pages_share_doubles_and_the_library_load_order(self):
        lib_js = read(os.path.join(ROOT, "tests", "lib", "lib.js"))
        names = re.search(r"const FILES = \[([^\]]*)\];", lib_js).group(1)
        files = [f"ACEUIModLoader.{n.strip().strip(chr(34))}.js" for n in names.split(",")]
        self.assertEqual(files, build_loader.LIB_ORDER, "tests/lib/lib.js must load the library in LIB_ORDER")
        self.assertTrue(os.path.exists(os.path.join(ROOT, "tests", "lib", "doubles.js")))
        harness = read(os.path.join(ROOT, "tests", "lib", "harness.html"))
        self.assertIn('<script src="doubles.js"></script>', harness)
        self.assertIn('<script src="lib.js"></script>', harness)
        self.assertNotIn("ACEUIModLoader.core.js", harness, "the harness must not list library files itself")

    def test_marker_naming_matches_between_loader_and_install_tool(self):
        js = self.files["ACEUIModLoader.loader.js"]
        self.assertIn(f'const MARKER_PREFIX = "{install_mod.MARKER_PREFIX}";', js)
        self.assertIn(f'const MARKER_EXT = "{install_mod.MARKER_EXT}";', js)
        self.assertEqual(install_mod.MARKER_DIR, "Video", "the game lists Saved Games/ACE/Video for SettingsRequestVideoPresetList")
        self.assertEqual(install_mod.MODS_SUBDIR.replace(os.sep, "/") + "/", "uiresources/" + "ACEUIModLoaderMods/")

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

    def test_install_copies_files_and_writes_an_empty_marker(self):
        dest = install_mod.install(self.src, self.mods)
        self.assertEqual(dest, os.path.join(self.mods, "uiresources", "ACEUIModLoaderMods", "mymod"))
        self.assertEqual(sorted(os.listdir(dest)), ["a.css", "a.js", "b.js", "mod.json"], "junk must not be copied")
        marker = install_mod.marker_path("mymod", self.mods)
        self.assertEqual(marker, os.path.join(self.tmp.name, "Video", "ACEUIModLoaderMods-mymod.settingspreset"),
                         "marker lives next to the mods folder, where the game lists video presets")
        self.assertTrue(os.path.isfile(marker))
        self.assertEqual(os.path.getsize(marker), 0, "the game deserialises every listed file; only an empty one is safe")
        install_mod.install(self.src, self.mods)
        self.assertEqual(install_mod.marker_names(self.mods), ["mymod"])
        self.assertFalse(os.path.exists(os.path.join(install_mod.mods_root_dir(self.mods), "manifest.json")), "no manifest any more")

    def test_remove_deletes_folder_and_marker(self):
        install_mod.install(self.src, self.mods)
        install_mod.remove("mymod", self.mods)
        self.assertFalse(os.path.isdir(os.path.join(self.mods, "uiresources", "ACEUIModLoaderMods", "mymod")))
        self.assertFalse(os.path.exists(install_mod.marker_path("mymod", self.mods)))
        self.assertEqual(install_mod.marker_names(self.mods), [])

    def test_missing_listed_file_is_an_error(self):
        os.remove(os.path.join(self.src, "b.js"))
        with self.assertRaises(SystemExit):
            install_mod.install(self.src, self.mods)

    def test_name_comes_from_the_folder_when_mod_json_has_none(self):
        folder = os.path.join(self.tmp.name, "othermod")
        os.makedirs(folder)
        with open(os.path.join(folder, "mod.json"), "w", encoding="utf-8") as f:
            json.dump({"version": "0.1.0", "scripts": ["othermod.js"]}, f)
        with open(os.path.join(folder, "othermod.js"), "w") as f:
            f.write("x")
        dest = install_mod.install(folder, self.mods)
        self.assertTrue(dest.endswith("othermod"))
        self.assertEqual(install_mod.marker_names(self.mods), ["othermod"])
        with open(os.path.join(folder, "mod.json"), "w", encoding="utf-8") as f:
            json.dump({"name": "different", "version": "0.1.0", "scripts": ["othermod.js"]}, f)
        with self.assertRaises(SystemExit):
            install_mod.install(folder, self.mods)
        with open(os.path.join(folder, "mod.json"), "w", encoding="utf-8") as f:
            json.dump({"version": "0.1.0", "scripts": ["othermod.js"], "bogus": 1}, f)
        with self.assertRaises(SystemExit):
            install_mod.install(folder, self.mods)

    def test_names_and_paths_that_could_escape_the_folder_are_errors(self):
        with self.assertRaises(SystemExit):
            install_mod.check_name("../evil")
        with open(os.path.join(self.src, "mod.json"), "w", encoding="utf-8") as f:
            json.dump({"name": "mymod", "version": "1.0.0", "scripts": ["sub/a.js"]}, f)
        with self.assertRaises(SystemExit):
            install_mod.install(self.src, self.mods)

    def test_marker_names_ignore_the_players_own_presets(self):
        folder = install_mod.marker_dir(self.mods)
        os.makedirs(folder)
        for name in ("MyLowSettings.settingspreset", "ACEUIModLoaderMods-other.settingspreset", "ACEUIModLoaderMods-x.txt"):
            with open(os.path.join(folder, name), "wb"):
                pass
        self.assertEqual(install_mod.marker_names(self.mods), ["other"])


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
            self.assertIn(b"const ACEUIModLoader = (function () {", data)
            self.assertIn(b"ACEUIModLoader.loader = (function () {", data)
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
