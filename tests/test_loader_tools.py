"""Tests for the library sources (style and contracts), install_mod.py and build_loader.py."""
import json
import os
import re
import shutil
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


def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)


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

    def test_the_library_follows_the_project_style_too(self):
        """The same conventions the kit enforces on mods: IIFE modules, no classes, no
        `this`, no var, no arrows, 4-space indent, double quotes. This was only ever
        checked on mods, so the loader's own source -- the most-edited code here -- was
        the one place the rule lived on memory rather than on a test."""
        from modkit import check_style

        for name, js in self.files.items():
            with self.subTest(source=name):
                check_style(self, name, js)

    def test_every_source_file_is_in_load_order_and_present(self):
        self.assertEqual(sorted(n for n in os.listdir(SRC) if n.endswith(".js")), sorted(build_loader.LIB_ORDER))
        self.assertEqual(build_loader.LIB_ORDER[0], "ACEUIModLoader.core.js", "core defines the namespace")
        self.assertEqual(build_loader.LIB_ORDER[1], "ACEUIModLoader.console.js", "console hook must run before the stock bundle")
        self.assertEqual(build_loader.LIB_ORDER[-4], "ACEUIModLoader.loader.js", "loader starts mods")
        # the drawer registers an ACEUIModLoader.ready callback, so it must load after the loader
        self.assertEqual(build_loader.LIB_ORDER[-3], "ACEUIModLoader.drawer.js", "drawer needs ready()")
        # settings registers its pane with the drawer, so it loads after it
        # settings opens its pane as an ACEUIModLoader.window, so windows load before it
        self.assertEqual(build_loader.LIB_ORDER[-2], "ACEUIModLoader.window.js", "settings builds on window")
        self.assertEqual(build_loader.LIB_ORDER[-1], "ACEUIModLoader.settings.js", "settings needs the drawer")

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
        # the two roots must differ: loose files never beat packed files, so a bundled app
        # sitting at the installed path could never be overridden to work on it
        self.assertIn('const APPS_ROOT = "ACEUIModLoaderApps/";', js)
        self.assertIn('const APPS_FILE = "apps.json";', js)
        self.assertNotEqual('ACEUIModLoaderApps/', 'ACEUIModLoaderMods/')
        self.assertNotIn("manifest", js.lower(), "the game's preset list is the only source of mod names")
        self.assertIn('const MOD_FILE = "mod.json";', js)
        self.assertIn('const DEFAULT_PAGES = ["hud.html"];', js)
        self.assertIn('const PRESET_REQUEST = "SettingsRequestVideoPresetList";', js)
        self.assertIn('const PRESET_RESPONSE = "SettingsResponseVideoPresetList";', js)
        self.assertIn('const MARKER_PREFIX = "ACEUIModLoaderMods-";', js)
        self.assertIn('const MARKER_EXT = ".settingspreset";', js)
        self.assertIn('engine.trigger("OnUICommand", PRESET_REQUEST, { __Type: PRESET_REQUEST, version: 0 });', js)
        for line in ('"loader " + ACEUIModLoader.VERSION + " on /"', 'source + ": " + names.length + " mod(s)"', '" loaded"',
                     '" FAILED"', '"; no installed mods"', '"nothing to load"', '"no engine on this page"', '"could not wrap engine.on'):
            self.assertIn(line, js, line)
        self.assertIn("loadScripts(base, files, index + 1, onDone)", js, "scripts load sequentially")
        self.assertIn("styles.concat(scripts).every(isFileName)", js, "never request anything that could be a folder")
        for name in ("PRESET_REQUEST", "PRESET_RESPONSE", "MARKER_PREFIX", "MARKER_EXT", "PRESET_TIMEOUT_MS", "source",
                     "filtering", "isMarker", "markerNames", "withoutMarkers", "isFileName", "CONTAINER_SELECTOR",
                     "MOD_ATTR", "DEV_VERSION", "mod", "APPS_ROOT", "APPS_FILE", "merge", "isDeveloper"):
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

    def test_manifest_keys_match_between_the_install_tool_and_the_test_kit(self):
        """Both read a mod.json, and a key one accepts and the other rejects is a mod that
        installs but fails its own tests (or the reverse)."""
        sys.path.insert(0, os.path.join(ROOT, "tools"))
        import modkit  # noqa: E402

        self.assertEqual(sorted(install_mod.KNOWN_KEYS), sorted(modkit.KNOWN_KEYS))
        self.assertIn("developer", install_mod.KNOWN_KEYS, "the app drawer's developer switch reads it")

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
class BundledAppsTests(unittest.TestCase):
    """The apps that ship inside the package: manifest-listed files only, plus the index."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.apps = os.path.join(self.tmp, "apps")
        mod = os.path.join(self.apps, "gizmo", "gizmo")
        os.makedirs(mod)
        write(os.path.join(mod, "mod.json"),
              json.dumps({"version": "1.2.3", "title": "Gizmo", "developer": True,
                          "scripts": ["gizmo.js"], "styles": ["gizmo.css"]}))
        for name in ("gizmo.js", "gizmo.css"):
            write(os.path.join(mod, name), "/* x */")
        # things a repo has and a package must not: tests, dev pages, a README
        os.makedirs(os.path.join(self.apps, "gizmo", "tests"))
        write(os.path.join(self.apps, "gizmo", "tests", "harness.html"), "<html></html>")
        write(os.path.join(self.apps, "gizmo", "README.md"), "# gizmo")
        write(os.path.join(mod, "notes.txt"), "not listed")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_only_the_listed_files_are_bundled_and_the_index_describes_them(self):
        build = os.path.join(self.tmp, "build")
        index = build_loader.copy_apps(build, self.apps)
        root = os.path.join(build, *build_loader.APPS_PATH.split("/"))

        self.assertEqual(sorted(os.listdir(os.path.join(root, "gizmo"))),
                         ["gizmo.css", "gizmo.js", "mod.json"], "the repo's tests, README and strays stay out")
        self.assertEqual(index, [{"name": "gizmo", "version": "1.2.3", "title": "Gizmo", "developer": True}])
        with open(os.path.join(root, build_loader.APPS_INDEX), encoding="utf-8") as f:
            self.assertEqual(json.load(f)["apps"], index, "what the loader reads is what was copied")

    def test_a_bundled_app_is_held_to_the_same_manifest_rules_as_an_installed_one(self):
        write(os.path.join(self.apps, "gizmo", "gizmo", "mod.json"),
              json.dumps({"version": "1.2.3", "scripts": ["missing.js"]}))
        with self.assertRaises(SystemExit):
            build_loader.copy_apps(os.path.join(self.tmp, "build"), self.apps)

    def test_no_apps_folder_is_not_an_error(self):
        build = os.path.join(self.tmp, "build")
        self.assertEqual(build_loader.copy_apps(build, os.path.join(self.tmp, "nothing")), [])


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
            # Pack for a stock install. The padding is planned against whatever packages the
            # mods folder holds, and `winners` below models base + ours and nothing else --
            # so without this the assertion depends on what the developer happens to have
            # installed, and plans for one world while checking another.
            stock_mods = os.path.join(tmp, "empty-mods")
            os.makedirs(stock_mods)
            written = pk.pack(build, out, mods_dir=stock_mods)
            pk.verify(out, written)
            base = lookup_sim.read_base_hashes(os.path.join(_repos.game_dir(), "content.kspkg"))
            entries = kspkg.read_entries(out)
            w = lookup_sim.winners(base, [e.hash for e in entries.values()])
            for target in build_loader.TARGETS:
                self.assertEqual(w[pk.path_hash(target)], "mod", f"{target} override would lose")
            # Two overrides and nothing else: cohtml.js and our copy of the HUD page, which
            # are the two independent ways the library can reach the page. Everything else
            # the package adds is a bundled app, at a path no stock file can collide with.
            shipped = sorted(p for p in entries
                             if not p.startswith("uiresources\\pad") and not entries[p].flags & kspkg.FLAG_DIR)
            # the table stores lower-case paths (kspkg.normalize)
            apps_prefix = (build_loader.APPS_PATH.replace("/", "\\") + "\\").lower()
            overrides = [pk.normalize(t) for t in build_loader.TARGETS]
            for path in overrides:
                self.assertIn(path, shipped)
            self.assertEqual([p for p in shipped if p not in overrides and not p.startswith(apps_prefix)],
                             [], "the only overrides are the entry points; the rest are bundled apps")

            # the bootstrap the HUD page loads lives beside the apps, at a new path of its own
            expected = {(apps_prefix + build_loader.APPS_INDEX).lower(), pk.normalize(build_loader.BOOT_PATH)}
            for _, info in build_loader.bundled_apps():
                for rel in ["mod.json"] + info.get("scripts", []) + info.get("styles", []) + info.get("files", []):
                    expected.add((apps_prefix + info["name"] + "\\" + rel).lower())
            self.assertEqual({p for p in shipped if p.startswith(apps_prefix)}, expected,
                             "the package carries every listed file of every bundled app, and nothing else")


class BuildOptionTests(unittest.TestCase):
    """
    The build's command line. A typo must fail loudly: `--instal` once built the package
    and quietly did not install it, which reads exactly like a build that worked.
    """

    def setUp(self):
        # build_loader writes dist/ whether or not --install is given, so a bad-option case
        # that got as far as building would quietly replace the release artefact. Every case
        # here asserts it did not.
        self.dist = build_loader.OUT
        self.before = os.path.getmtime(self.dist) if os.path.exists(self.dist) else None

    def tearDown(self):
        after = os.path.getmtime(self.dist) if os.path.exists(self.dist) else None
        self.assertEqual(self.before, after, "a test rebuilt dist/: tests must not touch the release artefact")

    def run_build(self, *args):
        import subprocess
        return subprocess.run([sys.executable, os.path.join(TOOLS, "build_loader.py")] + list(args),
                              capture_output=True, text=True, cwd=ROOT)

    def test_an_unknown_option_is_refused_before_anything_is_built(self):
        done = self.run_build("--instal", "--dups=1")
        self.assertNotEqual(done.returncode, 0)
        self.assertIn("unknown option(s): --instal", done.stdout + done.stderr)
        self.assertNotIn("wrote ", done.stdout, "nothing may be written when the options are wrong")

    def test_dups_must_be_a_number_or_auto(self):
        done = self.run_build("--dups=abc")
        self.assertNotEqual(done.returncode, 0)
        self.assertIn("--dups takes a whole number or 'auto'", done.stdout + done.stderr)
        self.assertNotIn("assembled ", done.stdout, "the option is checked before any work is done")

    def test_the_documented_options_and_the_accepted_ones_are_the_same_set(self):
        # Both directions: a documented option the build refuses is a lie, and an accepted
        # one nobody wrote down is a feature only its author knows about.
        documented = set(re.findall(r"^\s+(--[a-z-]+)", build_loader.__doc__, re.M))
        known = build_loader.KNOWN_FLAGS | {f.rstrip("=") for f in build_loader.VALUED_FLAGS}
        self.assertTrue(documented, "no options found in the docstring: the pattern stopped matching")
        self.assertEqual(documented - known, set(), "documented but not accepted")
        self.assertEqual(known - documented, set(), "accepted but not documented")


@unittest.skipUnless(os.path.exists(os.path.join(_repos.game_dir(), "content.kspkg")), "game not installed")
class SecondEntryPointTests(unittest.TestCase):
    """
    Our copy of the HUD page, and the library it loads from a path of its own.

    The page is a second, independent tie for the same library: the loader runs if either
    it or the cohtml.js override wins. The script it adds is at a new path, which always
    resolves, so winning the page is enough on its own.
    """

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.build = build_loader.assemble(os.path.join(self.tmp, "build"))
        # read as bytes: the stock page's line endings must survive untouched, and
        # universal-newline reading would hide a change to them
        with open(os.path.join(self.build, *build_loader.PAGE_PATH.split("/")), "rb") as f:
            self.page = f.read().decode("utf-8")
        self.boot = read(os.path.join(self.build, *build_loader.BOOT_PATH.split("/")))

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_the_page_is_the_stock_one_with_a_single_tag_added(self):
        import kspkg
        stock = kspkg.extract(os.path.join(_repos.game_dir(), "content.kspkg"),
                              build_loader.PAGE_PATH).decode("utf-8")
        eol = "\r\n" if "\r\n" in stock else "\n"
        self.assertEqual(self.page.replace(eol + "    " + build_loader.PAGE_TAG, "", 1), stock,
                         "nothing but our script tag may differ from Kunos' page")
        self.assertEqual(self.page.count(build_loader.PAGE_TAG), 1)

    def test_the_added_line_uses_the_page_s_own_line_ending(self):
        # The stock page is entirely CRLF; a lone LF would be the one byte in it that is
        # not Kunos', and it would not show up in a comparison that normalises newlines.
        crlf, lf = self.page.count("\r\n"), self.page.count("\n")
        self.assertEqual(crlf, lf, "the page mixes line endings: %d CRLF of %d LF" % (crlf, lf))

    def test_our_script_runs_after_cohtml_and_before_the_stock_bundle(self):
        # The console hook has to be in place before Kunos' bundle runs, which is why the
        # tag goes here and not at the end of the head.
        self.assertLess(self.page.index(build_loader.PAGE_ANCHOR), self.page.index(build_loader.PAGE_TAG))
        self.assertLess(self.page.index(build_loader.PAGE_TAG), self.page.index("js/components.js"))

    def test_a_stock_page_we_no_longer_recognise_fails_the_build(self):
        import kspkg
        real = kspkg.extract
        kspkg.extract = lambda pkg, path, entries=None: (b"<html><head></head></html>"
                                                         if path == build_loader.PAGE_PATH else real(pkg, path, entries))
        try:
            with self.assertRaises(SystemExit):
                build_loader.assemble_page(os.path.join(self.tmp, "b2"),
                                           os.path.join(_repos.game_dir(), "content.kspkg"),
                                           build_loader.library_sources())
        finally:
            kspkg.extract = real

    def test_both_artefacts_record_the_game_build_they_were_made_for(self):
        # A game update can leave the package loading nothing, and the symptom is silence.
        # The stamp is what lets the loader say "stale" instead of saying nothing.
        version = build_loader.game_version()
        self.assertRegex(version, r"^\d+\.\d+\.\d+\+release\.\d+$", "no game version read from the exe")
        host = read(os.path.join(self.build, *build_loader.HOST_PATH.split("/")))
        for where, text in (("the appended host", host), ("the bootstrap", self.boot)):
            self.assertIn('ACEUIModLoader.builtFor = "%s";' % version, text, where)
        self.assertLess(self.boot.index("builtFor"), self.boot.rindex("}());"),
                        "the stamp must be inside the guard, or a second load would reset it")

    def test_the_loader_compares_the_stamp_with_the_running_game(self):
        js = read(os.path.join(SRC, "ACEUIModLoader.loader.js"))
        self.assertIn("ACEUIModLoader.builtFor", js)
        self.assertIn("ModelUIState", js, "the running version comes from the model the game publishes")
        self.assertIn("warnIfGameMoved();", js, "and the check has to actually be called")

    def test_the_bootstrap_carries_the_library_behind_a_guard(self):
        self.assertIn("if (window.ACEUIModLoader) { return; }", self.boot)
        self.assertIn("const ACEUIModLoader = (function () {", self.boot)
        self.assertLess(self.boot.index("if (window.ACEUIModLoader) { return; }"),
                        self.boot.index("const ACEUIModLoader = (function () {"),
                        "the guard must come before anything it is meant to skip")
        for name in build_loader.LIB_ORDER:
            self.assertIn(f"/* ---- {name} ", self.boot, "the bootstrap is the whole library")

    def test_the_bootstrap_runs_in_a_browser_and_loading_it_twice_is_a_no_op(self):
        import headless
        harness = os.path.join(self.tmp, "bootstrap.html")
        shutil.copyfile(os.path.join(ROOT, "tests", "lib", "bootstrap.html"), harness)
        shutil.copyfile(os.path.join(self.build, *build_loader.BOOT_PATH.split("/")),
                        os.path.join(self.tmp, "loader.js"))
        headless.check_harness(self, harness, 6)


if __name__ == "__main__":
    unittest.main()
