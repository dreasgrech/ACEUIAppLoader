"""Tests for the library sources (style and contracts), install_app.py and build_loader.py."""
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

import install_app  # noqa: E402
import build_loader  # noqa: E402
import post_update  # noqa: E402
import repad  # noqa: E402
import tune_dups  # noqa: E402
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
        """The same conventions the kit enforces on apps: IIFE modules, no classes, no
        `this`, no var, no arrows, 4-space indent, double quotes. This was only ever
        checked on apps, so the loader's own source -- the most-edited code here -- was
        the one place the rule lived on memory rather than on a test."""
        from appkit import check_style

        for name, js in self.files.items():
            with self.subTest(source=name):
                check_style(self, name, js)

    def test_every_source_file_is_in_load_order_and_present(self):
        self.assertEqual(sorted(n for n in os.listdir(SRC) if n.endswith(".js")), sorted(build_loader.LIB_ORDER))
        self.assertEqual(build_loader.LIB_ORDER[0], "ACEUIAppLoader.core.js", "core defines the namespace")
        self.assertEqual(build_loader.LIB_ORDER[1], "ACEUIAppLoader.console.js", "console hook must run before the stock bundle")
        self.assertEqual(build_loader.LIB_ORDER[-4], "ACEUIAppLoader.loader.js", "loader starts apps")
        # the drawer registers an ACEUIAppLoader.ready callback, so it must load after the loader
        self.assertEqual(build_loader.LIB_ORDER[-3], "ACEUIAppLoader.drawer.js", "drawer needs ready()")
        # settings registers its pane with the drawer, so it loads after it
        # settings opens its pane as an ACEUIAppLoader.window, so windows load before it
        self.assertEqual(build_loader.LIB_ORDER[-2], "ACEUIAppLoader.window.js", "settings builds on window")
        self.assertEqual(build_loader.LIB_ORDER[-1], "ACEUIAppLoader.settings.js", "settings needs the drawer")

    def test_version_matches_version_file_and_readme(self):
        v = read(os.path.join(ROOT, "VERSION")).strip()
        self.assertRegex(v, r"^\d+\.\d+\.\d+$")
        self.assertIn(f'const VERSION = "{v}";', self.files["ACEUIAppLoader.core.js"])
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
        self.assertIn("const ACEUIAppLoader = (function () {", self.files["ACEUIAppLoader.core.js"])
        self.assertIn("\nwindow.ACEUIAppLoader = ACEUIAppLoader;\n", self.files["ACEUIAppLoader.core.js"])
        for name in build_loader.LIB_ORDER[1:]:
            ns = name.split(".")[1]
            self.assertIn(f"ACEUIAppLoader.{ns} = (function () {{", self.files[name], f"{name} must define ACEUIAppLoader.{ns}")
            self.assertNotIn("const ACEUIAppLoader", self.files[name], f"{name} must not redefine the namespace")

    def test_core_exports(self):
        core = self.files["ACEUIAppLoader.core.js"]
        for name in ("VERSION", "LOG_PREFIX", "HUD_HIDDEN_CLASS", "page", "log", "logger", "clamp", "el", "close",
                     "toArray", "percentText", "hudHidden", "closestWithAttribute"):
            self.assertRegex(core, rf"\n\s+{name}: [A-Za-z_.()]+,?\n", f"core.{name} not exported")

    def test_console_hook_chains_and_never_echoes(self):
        js = self.files["ACEUIAppLoader.console.js"]
        # trace/dir/table are wrapped too: this file runs BEFORE the stock bundle, so when
        # the bundle wraps console.trace itself its wrapper calls ours, which calls the
        # original -- the line is captured once and the bundle's behaviour is unchanged.
        self.assertIn('const LEVELS = ["log", "info", "debug", "warn", "error", "trace", "dir", "table"];', js)
        # console.assert must only record when the condition is false, so it is wrapped apart
        self.assertIn("if (!condition) { record(ASSERT_LEVEL, args, ASSERT_PREFIX); }", js)
        self.assertIn("wrapAssert();", js, "the assert wrapper is installed by hook()")
        # formatting reads the logged values, and a value that throws must not abort the
        # caller -- the stock bundle, in the middle of its own work
        self.assertIn("const record = function (level, args, prefix) {\n        try {\n            push(level, (prefix || \"\") + formatArgs(args));\n        } catch (ignore) {", js,
                      "capture is guarded so the hook never throws back into whoever logged")
        self.assertIn("            record(level, args);\n            original.apply(console, args);", js)
        self.assertNotIn("push(level, formatArgs(args));", js, "no unguarded capture on the console path")
        self.assertIn("const MAX_ENTRIES = 500;", js)
        self.assertIn('window.addEventListener("error", onError);', js)
        self.assertIn('window.addEventListener("unhandledrejection", onRejection);', js)
        self.assertIn("if (state.notifying) { return; }", js, "listener recursion guard")
        for name in ("MAX_ENTRIES", "LEVELS", "entries", "clear", "capture", "subscribe", "listenerCount", "format"):
            self.assertRegex(js, rf"\n\s+{name}: [A-Za-z_.]+,?\n", f"console.{name} not exported")

    def test_app_roots_are_hidden_at_creation_when_switched_off(self):
        # the drawer builds on ready(), which fires only after every app has loaded, so a
        # switched-off app stayed visible for that whole window and appeared to flash on
        # and off again after a pause-menu reload
        js = self.files["ACEUIAppLoader.loader.js"]
        self.assertIn("if (ACEUIAppLoader.drawer) { ACEUIAppLoader.drawer.applyStored(name); }", js,
                      "mountRoot must apply the saved switch as soon as it creates the root")
        self.assertLess(js.find("ACEUIAppLoader.drawer.applyStored(name)"), js.find("return root;"),
                        "applied before the root is handed back and the app's scripts run")
        drawer = self.files["ACEUIAppLoader.drawer.js"]
        self.assertIn("loadStored();", drawer, "the saved switches are read as the library loads")
        self.assertIn("applyStored: applyStored,", drawer, "and exported for the loader to call")

    def test_panel_contract(self):
        js = self.files["ACEUIAppLoader.panel.js"]
        self.assertIn('const NO_DRAG_ATTR = "data-nodrag";', js)
        self.assertIn('const DRAGGING_CLASS = "dragging";', js)
        self.assertIn("const RESTORE_WAIT_MS = 2000;", js)
        self.assertIn('root.style.visibility = HIDDEN;', js, "hidden until placed, without needing a stylesheet")
        for name in ("RESTORE_WAIT_MS", "DRAGGING_CLASS", "NO_DRAG_ATTR", "isPosition", "moveTo", "currentPosition",
                     "savePosition", "update", "attach", "detach"):
            self.assertRegex(js, rf"\n\s+{name}: [A-Za-z_.]+,?\n", f"panel.{name} not exported")
        self.assertIn('window.removeEventListener("mousemove", panel.handlers.move);', js)

    def test_loader_contract(self):
        js = self.files["ACEUIAppLoader.loader.js"]
        self.assertIn('const ROOT = "ACEUIAppLoader/";', js)
        # the two roots must differ: loose files never beat packed files, so a bundled app
        # sitting at the installed path could never be overridden to work on it
        self.assertIn('const BUILTIN_ROOT = "ACEUIAppLoaderBuiltIn/";', js)
        self.assertIn('const BUILTIN_INDEX = "apps.json";', js)
        self.assertNotEqual('ACEUIAppLoaderBuiltIn/', 'ACEUIAppLoader/')
        self.assertNotIn("manifest", js.lower(), "the game's preset list is the only source of app names")
        self.assertIn('const APP_FILE = "app.json";', js)
        self.assertIn('const DEFAULT_PAGES = ["hud.html"];', js)
        self.assertIn('const PRESET_REQUEST = "SettingsRequestVideoPresetList";', js)
        self.assertIn('const PRESET_RESPONSE = "SettingsResponseVideoPresetList";', js)
        self.assertIn('const MARKER_PREFIX = "ACEUIAppLoader-";', js)
        self.assertIn('const MARKER_EXT = ".settingspreset";', js)
        self.assertIn('engine.trigger("OnUICommand", PRESET_REQUEST, { __Type: PRESET_REQUEST, version: 0 });', js)
        for line in ('"loader " + ACEUIAppLoader.VERSION + " on /"', 'source + ": " + names.length + " app(s)"', '" loaded"',
                     '" FAILED"', '"; no installed apps"', '"nothing to load"', '"no engine on this page"', '"could not wrap engine.on'):
            self.assertIn(line, js, line)
        self.assertIn("loadScripts(base, files, index + 1, onDone)", js, "scripts load sequentially")
        self.assertIn("styles.concat(scripts).every(isFileName)", js, "never request anything that could be a folder")
        for name in ("PRESET_REQUEST", "PRESET_RESPONSE", "MARKER_PREFIX", "MARKER_EXT", "PRESET_TIMEOUT_MS", "source",
                     "filtering", "isMarker", "markerNames", "withoutMarkers", "isFileName", "CONTAINER_SELECTOR",
                     "APP_ATTR", "DEV_VERSION", "app", "BUILTIN_ROOT", "BUILTIN_INDEX", "merge", "isDeveloper",
                     "PRESET_RETRY_MS", "HUD_PAGE", "isAppName", "discover", "idTaken", "warnIfGameMoved"):
            self.assertRegex(js, rf"\n\s+{name}: [A-Za-z_.]+,?\n", f"loader.{name} not exported")
        for alias in ("ROOT", "apps", "app", "ready", "addStylesheet", "addScript"):
            self.assertIn(f"ACEUIAppLoader.{alias} = ACEUIAppLoader.loader.{alias};", js)
        self.assertIn('const CONTAINER_SELECTOR = ".absolutecenter";', js)
        self.assertIn("mountRoot(name, info);\n            state.current = entry;\n            loadScripts(", js,
                      "root exists and app() knows the current app before its scripts run")
        self.assertIn('const KEY_PREFIX = "ace";', js)
        self.assertIn('const HUD_ID_PREFIX = "hud_";', js)

    def test_browser_pages_share_doubles_and_the_library_load_order(self):
        lib_js = read(os.path.join(ROOT, "tests", "lib", "lib.js"))
        names = re.search(r"const FILES = \[([^\]]*)\];", lib_js).group(1)
        files = [f"ACEUIAppLoader.{n.strip().strip(chr(34))}.js" for n in names.split(",")]
        self.assertEqual(files, build_loader.LIB_ORDER, "tests/lib/lib.js must load the library in LIB_ORDER")
        self.assertTrue(os.path.exists(os.path.join(ROOT, "tests", "lib", "doubles.js")))
        harness = read(os.path.join(ROOT, "tests", "lib", "harness.html"))
        self.assertIn('<script src="doubles.js"></script>', harness)
        self.assertIn('<script src="lib.js"></script>', harness)
        self.assertNotIn("ACEUIAppLoader.core.js", harness, "the harness must not list library files itself")

    def test_manifest_keys_match_between_the_install_tool_and_the_test_kit(self):
        """Both read an app.json, and a key one accepts and the other rejects is an app that
        installs but fails its own tests (or the reverse)."""
        sys.path.insert(0, os.path.join(ROOT, "tools"))
        import appkit  # noqa: E402

        self.assertEqual(sorted(install_app.KNOWN_KEYS), sorted(appkit.KNOWN_KEYS))
        self.assertIn("developer", install_app.KNOWN_KEYS, "the app drawer's developer switch reads it")

    def test_marker_naming_matches_between_loader_and_install_tool(self):
        js = self.files["ACEUIAppLoader.loader.js"]
        self.assertIn(f'const MARKER_PREFIX = "{install_app.MARKER_PREFIX}";', js)
        self.assertIn(f'const MARKER_EXT = "{install_app.MARKER_EXT}";', js)
        # the name becomes a URL, and a `#` in it would turn the request into one for the
        # folder above -- the request that kills the game -- so the loader applies the
        # installer's rule to what the game lists, not only what the installer wrote
        self.assertIn(f"const NAME_RE = /{install_app.NAME_RE.pattern}/;", js, "the loader and the installer agree on what a name is")
        self.assertIn(".filter(function (name) {\n            if (isAppName(name)) { return true; }", js, "and the loader applies it to the markers")
        self.assertEqual(install_app.MARKER_DIR, "Video", "the game lists Saved Games/ACE/Video for SettingsRequestVideoPresetList")
        self.assertEqual(install_app.APPS_SUBDIR.replace(os.sep, "/") + "/", "uiresources/" + "ACEUIAppLoader/")

    def test_no_per_frame_geometry_or_css_in_library(self):
        for name, js in self.files.items():
            self.assertNotIn("<svg", js.lower(), name)
            self.assertNotIn("innerHTML", js, f"{name}: the library builds no markup")
            self.assertNotIn('createElement("style")', js, name)

    def test_no_css_the_engine_warns_about_in_library(self):
        """Measured in the game log: `text-transform` is ignored AND warned about for every
        element that asks, every frame (19,672 lines in a 13-minute session); `align-items:
        baseline` is refused with a warning per write. The library draws with inline styles,
        so the check is on the scripts."""
        for name, js in self.files.items():
            self.assertNotIn("textTransform", js, f"{name}: upper-case the string instead")
            self.assertNotIn('"baseline"', js, f"{name}: align-items: baseline is not supported")

    def test_an_app_cannot_be_handed_a_stock_element_as_its_root(self):
        js = self.files["ACEUIAppLoader.loader.js"]
        self.assertIn("existing.getAttribute(APP_ATTR) !== name", js, "an element with the app's id that is not an app root is not ours to give away")
        self.assertIn("if (info.root !== false && idTaken(name)) {", js, "checked before the root is mounted")

    def test_discovery_asks_twice_before_giving_up(self):
        js = self.files["ACEUIAppLoader.loader.js"]
        self.assertIn("const PRESET_RETRY_MS = 3000;", js)
        self.assertIn("const PRESET_ATTEMPTS = 2;", js)
        self.assertIn('" ms; asking again"', js)
        self.assertIn("NO_ANSWER_HINT", js, "the give-up line says what a silent folder usually means")

    def test_the_drawer_is_built_only_where_an_app_runs(self):
        js = self.files["ACEUIAppLoader.drawer.js"]
        self.assertIn("if (!belongsOn(apps)) {", js, "no hot zone over the stock menus' scrollbars on pages nothing loads on")
        self.assertIn('const HUD_PAGE = "hud.html";', js)

    def test_the_input_reset_on_load_is_conditional(self):
        js = self.files["ACEUIAppLoader.input.js"]
        self.assertIn('const HELD_KEY = "aceinput.held";', js)
        self.assertIn("if (!readHeld()) { return; }", js, "the stock menus own those flags on their pages; only undo what a page of ours left")
        self.assertIn("writeHeld(want);", js)


class InstallAppTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.mods = os.path.join(self.tmp.name, "mods")
        self.src = os.path.join(self.tmp.name, "myapp")
        os.makedirs(self.src)
        with open(os.path.join(self.src, "app.json"), "w", encoding="utf-8") as f:
            json.dump({"name": "myapp", "version": "1.2.3", "pages": ["hud.html"], "styles": ["a.css"], "scripts": ["a.js", "b.js"]}, f)
        for name in ("a.css", "a.js", "b.js", ".hidden", "x.swp"):
            with open(os.path.join(self.src, name), "w") as f:
                f.write("x")

    def tearDown(self):
        self.tmp.cleanup()

    def test_install_copies_files_and_writes_an_empty_marker(self):
        dest = install_app.install(self.src, self.mods)
        self.assertEqual(dest, os.path.join(self.mods, "uiresources", "ACEUIAppLoader", "myapp"))
        self.assertEqual(sorted(os.listdir(dest)), ["a.css", "a.js", "app.json", "b.js"], "junk must not be copied")
        marker = install_app.marker_path("myapp", self.mods)
        self.assertEqual(marker, os.path.join(self.tmp.name, "Video", "ACEUIAppLoader-myapp.settingspreset"),
                         "marker lives next to the mods folder, where the game lists video presets")
        self.assertTrue(os.path.isfile(marker))
        self.assertEqual(os.path.getsize(marker), 0, "the game deserialises every listed file; only an empty one is safe")
        install_app.install(self.src, self.mods)
        self.assertEqual(install_app.marker_names(self.mods), ["myapp"])
        self.assertFalse(os.path.exists(os.path.join(install_app.apps_root_dir(self.mods), "manifest.json")), "no manifest any more")

    def plant_legacy(self, name="myapp"):
        """One folder and one marker at every path apps have ever been installed to."""
        planted = []
        for sub, prefix in install_app.LEGACY_LAYOUTS:
            folder = os.path.join(self.mods, sub, name)
            os.makedirs(folder, exist_ok=True)
            write(os.path.join(folder, "mod.json"), "{}")
            marker = os.path.join(self.tmp.name, "Video", prefix + name + ".settingspreset")
            os.makedirs(os.path.dirname(marker), exist_ok=True)
            write(marker, "")
            planted += [folder, marker]
        return planted

    def test_installing_clears_every_copy_left_at_an_older_path(self):
        """Apps were renamed twice (mod -> app, then the loader itself). A copy at either old
        path sits somewhere the loader no longer reads, so it is invisible rather than broken
        -- which is worse, because nothing says why the app is missing."""
        planted = self.plant_legacy()
        self.assertTrue(len(planted) >= 4, "more than one old layout to clear")

        install_app.install(self.src, self.mods)

        for path in planted:
            self.assertFalse(os.path.exists(path), f"still there: {path}")
        self.assertTrue(os.path.isdir(os.path.join(install_app.apps_root_dir(self.mods), "myapp")))

    def test_remove_clears_every_path_so_nothing_lingers(self):
        install_app.install(self.src, self.mods)
        planted = self.plant_legacy()

        install_app.remove("myapp", self.mods)

        for path in planted:
            self.assertFalse(os.path.exists(path), f"still there: {path}")
        self.assertEqual(install_app.marker_names(self.mods), [])

    def test_remove_deletes_folder_and_marker(self):
        install_app.install(self.src, self.mods)
        install_app.remove("myapp", self.mods)
        self.assertFalse(os.path.isdir(os.path.join(self.mods, "uiresources", "ACEUIAppLoader", "myapp")))
        self.assertFalse(os.path.exists(install_app.marker_path("myapp", self.mods)))
        self.assertEqual(install_app.marker_names(self.mods), [])

    def test_missing_listed_file_is_an_error(self):
        os.remove(os.path.join(self.src, "b.js"))
        with self.assertRaises(SystemExit):
            install_app.install(self.src, self.mods)

    def test_name_comes_from_the_folder_when_mod_json_has_none(self):
        folder = os.path.join(self.tmp.name, "otherapp")
        os.makedirs(folder)
        with open(os.path.join(folder, "app.json"), "w", encoding="utf-8") as f:
            json.dump({"version": "0.1.0", "scripts": ["otherapp.js"]}, f)
        with open(os.path.join(folder, "otherapp.js"), "w") as f:
            f.write("x")
        dest = install_app.install(folder, self.mods)
        self.assertTrue(dest.endswith("otherapp"))
        self.assertEqual(install_app.marker_names(self.mods), ["otherapp"])
        with open(os.path.join(folder, "app.json"), "w", encoding="utf-8") as f:
            json.dump({"name": "different", "version": "0.1.0", "scripts": ["otherapp.js"]}, f)
        with self.assertRaises(SystemExit):
            install_app.install(folder, self.mods)
        with open(os.path.join(folder, "app.json"), "w", encoding="utf-8") as f:
            json.dump({"version": "0.1.0", "scripts": ["otherapp.js"], "bogus": 1}, f)
        with self.assertRaises(SystemExit):
            install_app.install(folder, self.mods)

    def test_names_and_paths_that_could_escape_the_folder_are_errors(self):
        with self.assertRaises(SystemExit):
            install_app.check_name("../evil")
        with open(os.path.join(self.src, "app.json"), "w", encoding="utf-8") as f:
            json.dump({"name": "myapp", "version": "1.0.0", "scripts": ["sub/a.js"]}, f)
        with self.assertRaises(SystemExit):
            install_app.install(self.src, self.mods)

    def test_marker_names_ignore_the_players_own_presets(self):
        folder = install_app.marker_dir(self.mods)
        os.makedirs(folder)
        for name in ("MyLowSettings.settingspreset", "ACEUIAppLoader-other.settingspreset", "ACEUIAppLoader-x.txt"):
            with open(os.path.join(folder, name), "wb"):
                pass
        self.assertEqual(install_app.marker_names(self.mods), ["other"])


@unittest.skipUnless(os.path.exists(os.path.join(_repos.game_dir(), "content.kspkg")), "game not installed")
class BundledAppsTests(unittest.TestCase):
    """The apps that ship inside the package: manifest-listed files only, plus the index."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.apps = os.path.join(self.tmp, "apps")
        app = os.path.join(self.apps, "gizmo", "gizmo")
        os.makedirs(app)
        write(os.path.join(app, "app.json"),
              json.dumps({"version": "1.2.3", "title": "Gizmo", "developer": True,
                          "scripts": ["gizmo.js"], "styles": ["gizmo.css"]}))
        for name in ("gizmo.js", "gizmo.css"):
            write(os.path.join(app, name), "/* x */")
        # things a repo has and a package must not: tests, dev pages, a README
        os.makedirs(os.path.join(self.apps, "gizmo", "tests"))
        write(os.path.join(self.apps, "gizmo", "tests", "harness.html"), "<html></html>")
        write(os.path.join(self.apps, "gizmo", "README.md"), "# gizmo")
        write(os.path.join(app, "notes.txt"), "not listed")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_only_the_listed_files_are_bundled_and_the_index_describes_them(self):
        build = os.path.join(self.tmp, "build")
        index = build_loader.copy_apps(build, self.apps)
        root = os.path.join(build, *build_loader.BUILTIN_PATH.split("/"))

        self.assertEqual(sorted(os.listdir(os.path.join(root, "gizmo"))),
                         ["app.json", "gizmo.css", "gizmo.js"], "the repo's tests, README and strays stay out")
        self.assertEqual(index, [{"name": "gizmo", "version": "1.2.3", "title": "Gizmo", "developer": True}])
        with open(os.path.join(root, build_loader.BUILTIN_INDEX), encoding="utf-8") as f:
            self.assertEqual(json.load(f)["apps"], index, "what the loader reads is what was copied")

    def test_a_bundled_app_is_held_to_the_same_manifest_rules_as_an_installed_one(self):
        write(os.path.join(self.apps, "gizmo", "gizmo", "app.json"),
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
            self.assertIn(b"const ACEUIAppLoader = (function () {", data)
            self.assertIn(b"ACEUIAppLoader.loader = (function () {", data)
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
            builtin_prefix = (build_loader.BUILTIN_PATH.replace("/", "\\") + "\\").lower()
            overrides = [pk.normalize(t) for t in build_loader.TARGETS]
            for path in overrides:
                self.assertIn(path, shipped)
            self.assertEqual([p for p in shipped if p not in overrides and not p.startswith(builtin_prefix)],
                             [], "the only overrides are the entry points; the rest are bundled apps")

            # the bootstrap the HUD page loads lives beside the apps, at a new path of its own
            expected = {(builtin_prefix + build_loader.BUILTIN_INDEX).lower(), pk.normalize(build_loader.BOOT_PATH)}
            for _, info in build_loader.bundled_apps():
                for rel in ["app.json"] + info.get("scripts", []) + info.get("styles", []) + info.get("files", []):
                    expected.add((builtin_prefix + info["name"] + "\\" + rel).lower())
            self.assertEqual({p for p in shipped if p.startswith(builtin_prefix)}, expected,
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
            self.assertIn('ACEUIAppLoader.builtFor = "%s";' % version, text, where)
        self.assertLess(self.boot.index("builtFor"), self.boot.rindex("}());"),
                        "the stamp must be inside the guard, or a second load would reset it")

    def test_the_record_count_is_stamped_into_both_artefacts_and_the_boot_line_says_it(self):
        build_loader.stamp_records(self.build, 32)
        host = read(os.path.join(self.build, *build_loader.HOST_PATH.split("/")))
        boot = read(os.path.join(self.build, *build_loader.BOOT_PATH.split("/")))
        self.assertTrue(host.rstrip().endswith("ACEUIAppLoader.records = 32;"), "appended to the host")
        self.assertIn("ACEUIAppLoader.records = 32;\n}());\n", boot, "inside the bootstrap's guard")
        js = read(os.path.join(SRC, "ACEUIAppLoader.loader.js"))
        self.assertIn('(ACEUIAppLoader.records ? " (" + ACEUIAppLoader.records + " records)" : "")', js,
                      "the boot line names it, so a log says which release a player has")

    def test_the_loader_compares_the_stamp_with_the_running_game(self):
        js = read(os.path.join(SRC, "ACEUIAppLoader.loader.js"))
        self.assertIn("ACEUIAppLoader.builtFor", js)
        self.assertIn("ModelUIState", js, "the running version comes from the model the game publishes")
        self.assertIn("warnIfGameMoved();", js, "and the check has to actually be called")
        # the models are filled in per frame by the stock bundle, so at DOMContentLoaded the
        # version can still be missing: a check made once there would say nothing
        self.assertIn("watchGameVersion(Date.now() + GAME_VERSION_WAIT_MS);", js, "start() waits for the version rather than reading it once")
        # the game publishes "0.9.1", the stamp is "0.9.1+release.6": the first launch of the
        # notice fired on a matching build because the two were compared whole
        self.assertIn("releaseOf(running) !== releaseOf(built)", js, "compared on the release, which is all the game publishes")
        self.assertIn('const VERSION_BUILD_SEPARATOR = "+";', js)
        # a stale package's stock files can leave the HUD blank; a log line nobody reads
        # is not a warning, a strip across the HUD is
        self.assertIn("if (ACEUIAppLoader.page === HUD_PAGE && document.body) { showMoved(built, running); }", js)
        self.assertIn("delete ACEUIAppLoader.kspkg from Saved Games", js, "and it says what to do")

    def test_the_bootstrap_carries_the_library_behind_a_guard(self):
        self.assertIn("if (window.ACEUIAppLoader) { return; }", self.boot)
        self.assertIn("const ACEUIAppLoader = (function () {", self.boot)
        self.assertLess(self.boot.index("if (window.ACEUIAppLoader) { return; }"),
                        self.boot.index("const ACEUIAppLoader = (function () {"),
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

    def test_the_shipped_host_survives_a_game_like_timeline(self):
        """The assembled cohtml.js -- stock file plus library -- on a page called hud.html,
        with Coherent's own engine implementation (mock mode) and a scripted game: bindings
        ready after DOMContentLoaded, the stock UI wiping every handler for the preset answer
        while ours is pending, the game version filled in late and different from the
        build's, a stock pause menu taking the input flags, the HUD store arriving late.
        tests/lib/timeline/hud.html says what must hold at the end; above all that no error
        escaped."""
        import headless
        stage = os.path.join(self.tmp, "timeline")
        os.makedirs(stage)
        shutil.copyfile(os.path.join(self.build, *build_loader.HOST_PATH.split("/")), os.path.join(stage, "cohtml.js"))
        shutil.copyfile(os.path.join(ROOT, "tests", "lib", "timeline", "hud.html"), os.path.join(stage, "hud.html"))
        shutil.copyfile(os.path.join(ROOT, "tests", "lib", "doubles.js"), os.path.join(stage, "doubles.js"))
        for fixture in ("ACEUIAppLoader", "ACEUIAppLoaderBuiltIn"):
            shutil.copytree(os.path.join(ROOT, "tests", "lib", fixture), os.path.join(stage, fixture))
        headless.check_harness(self, os.path.join(stage, "hud.html"), 9)

    def test_the_console_buffer_survives_the_page_reload(self):
        """Escape and resume reload the HUD page, which throws away the JS context -- and
        with it the lines you reloaded to go and read. The buffer is mirrored to
        localStorage, which outlives the page but not the game. Seeded before the library
        loads, because the restore happens as the module defines itself."""
        import headless
        harness = os.path.join(self.tmp, "consolecarry.html")
        shutil.copyfile(os.path.join(ROOT, "tests", "lib", "consolecarry.html"), harness)
        shutil.copyfile(os.path.join(self.build, *build_loader.BOOT_PATH.split("/")),
                        os.path.join(self.tmp, "loader.js"))
        headless.check_harness(self, harness, 8)



class PostUpdateTests(unittest.TestCase):
    """tools/post_update.py: the one command that puts the package back in step after a
    game patch. What is worth testing without a game installed is the bookkeeping -- which
    flags exist, and reading and writing dups.json -- because that is what decides whether
    the expensive part runs at all."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="ace-postupdate-")
        self.book = os.path.join(self.tmp, "dups.json")
        # These tests write measurements, and the real file holds the ones this machine's
        # package was built against. An early draft monkeypatched the module global, which
        # a default argument had already bound at import, and overwrote it for real.
        self.real = read(build_loader.DUPS_FILE)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)
        self.assertEqual(read(build_loader.DUPS_FILE), self.real,
                         "a test wrote to the repo's real dups.json")

    def test_every_flag_it_accepts_is_documented(self):
        """A flag the code knows and the docstring does not is a flag nobody will use, and
        one the docstring promises and the code rejects is worse: post_update prints the
        docstring as its usage message."""
        documented = set(re.findall(r"^  (--[a-z-]+) ", post_update.__doc__, re.M))
        self.assertEqual(documented, post_update.KNOWN_FLAGS)

    def test_a_typo_is_refused_rather_than_ignored(self):
        with self.assertRaises(SystemExit) as caught:
            post_update.main(["--instal"])
        self.assertIn("--instal", str(caught.exception))

    def test_asking_to_tune_and_not_to_tune_is_refused(self):
        with self.assertRaises(SystemExit):
            post_update.main(["--tune", "--no-tune"])

    def test_no_measurement_reads_as_no_measurement(self):
        self.assertEqual(post_update.recorded("machine", self.book), {})

    def test_recording_one_mode_leaves_the_other_alone(self):
        tune_dups.record({"dups": 32, "fingerprint": "aaa"}, "machine", self.book)
        tune_dups.record({"dups": 64, "fingerprint": "bbb"}, "release", self.book)
        self.assertEqual(post_update.recorded("machine", self.book)["dups"], 32)
        self.assertEqual(post_update.recorded("release", self.book)["dups"], 64)

    def test_the_single_mode_file_this_replaced_is_still_read(self):
        """dups.json used to hold one measurement at the top level. A file written by an
        older checkout must not read as 'no measurement', which would silently re-measure,
        and recording the other mode must migrate it rather than drop it."""
        write(self.book, json.dumps({"dups": 32, "fingerprint": "aaa", "release": False}))
        self.assertEqual(post_update.recorded("machine", self.book)["dups"], 32)
        self.assertEqual(post_update.recorded("release", self.book), {})
        tune_dups.record({"dups": 64, "fingerprint": "bbb"}, "release", self.book)
        self.assertEqual(post_update.recorded("machine", self.book)["dups"], 32)
        self.assertEqual(post_update.recorded("release", self.book)["dups"], 64)

    def test_counts_that_all_win_every_set_are_told_apart_by_their_single_ties(self):
        # 16 and 32 records both won all 48 tuning sets; preferring the smaller count shipped
        # 16, which the 2000-folder measurement then showed loses 0.2% where 32 loses none.
        # The single ties -- each entry point on its own -- are what the small sets can see.
        results = [(48, 80, 16, 10, ["a"]), (48, 91, 32, 3, ["b"]), (47, 96, 64, 3, ["c"]), (48, 91, 128, 31, ["d"])]
        self.assertEqual(tune_dups.choose(results)[2], 32, "most sets, then most single ties, then the smaller count")
        self.assertEqual(tune_dups.choose([(48, 80, 16, 10, []), (48, 80, 32, 3, [])])[2], 16, "a true tie still goes to the smaller count")

    def test_a_measurement_taken_before_the_game_was_recorded_is_not_called_stale(self):
        """`game` is newer than the first measurements. Missing means unknown, and unknown
        is not a reason to spend the minutes -- only a game that is known and different."""
        tune_dups.record({"dups": 32, "fingerprint": "aaa"}, "machine", self.book)
        self.assertFalse(bool(post_update.recorded("machine", self.book).get("game")))

    def test_a_packages_overrides_are_counted_as_files_not_as_records(self):
        """A package with duplicate records repeats the override's hash once per record.
        Counting records reported ACEDOOM's one bank as 32 overrides, which would have read
        as 31 of 32 surviving -- a pass -- on the day the real one lost."""
        base = {10, 11, 12}
        bank_with_32_records = [10] * 32 + [99]
        self.assertEqual(post_update.overridden_base_files(bank_with_32_records, base), [10])
        self.assertEqual(post_update.overridden_base_files([99, 98], base), [])
        self.assertEqual(post_update.overridden_base_files([12, 10, 10], base), [10, 12])


class ReproducibleBytesTests(unittest.TestCase):
    """The packaged bytes must not depend on who checked the repo out."""

    def test_no_packaged_source_carries_windows_line_endings(self):
        """src/*.js goes into cohtml.js verbatim, so its line endings are shipped bytes.
        With no .gitattributes they follow each developer's core.autocrlf, and the same
        commit builds a different package on a different machine -- which does not change
        the lookup (identical paths, so identical padding and record counts) but does mean
        a published checksum cannot be verified by anyone rebuilding from source."""
        packaged = [os.path.join(SRC, name) for name in build_loader.LIB_ORDER]
        for src, info in build_loader.bundled_apps():
            packaged += [os.path.join(src, f) for f in info.get("scripts", []) + info.get("styles", [])]
            packaged.append(os.path.join(src, install_app.APP_FILE))
        self.assertGreater(len(packaged), len(build_loader.LIB_ORDER), "the apps' files count too")
        for path in packaged:
            with open(path, "rb") as f:
                body = f.read()
            with self.subTest(file=os.path.relpath(path, ROOT)):
                self.assertNotIn(b"\r\n", body, "must be LF; see .gitattributes")

    def test_gitattributes_pins_the_working_tree(self):
        """The test above only passes on a checkout that already has LF. This is what
        makes that true for the next person who clones."""
        path = os.path.join(ROOT, ".gitattributes")
        self.assertTrue(os.path.isfile(path), ".gitattributes is missing")
        with open(path, encoding="utf-8") as f:
            rules = [line.split("#")[0].strip() for line in f]
        self.assertIn("* text=auto eol=lf", rules)


class RepadTests(unittest.TestCase):
    """tools/repad.py: rebuilding whichever installed packages have stopped winning."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="ace-repad-")
        self.registry = os.path.join(self.tmp, "repad.json")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def write_registry(self, entries):
        write(self.registry, json.dumps(entries))
        return self.registry

    def test_only_packages_that_lost_an_override_count_as_losers(self):
        """A package with nothing to lose is not a loser, and neither is one whose overrides
        all still resolve. Car mods are the first kind: they only add new paths."""
        counts = {"car.kspkg": (0, 0), "fine.kspkg": (2, 2), "lost.kspkg": (1, 2),
                  "gone.kspkg": (0, 1)}
        self.assertEqual(sorted(repad.losers(counts)), ["gone.kspkg", "lost.kspkg"])

    def test_the_registry_lives_beside_the_mods_folder_not_in_the_repo(self):
        """It names this machine's checkouts, so it is not repo content."""
        self.assertEqual(os.path.dirname(repad.registry_path()),
                         os.path.dirname(_repos.mods_dir()))
        self.assertEqual(repad.registry_path("X"), "X")

    def test_a_registry_that_cannot_be_acted_on_is_refused(self):
        with self.assertRaises(SystemExit):
            repad.load_registry(os.path.join(self.tmp, "absent.json"))
        for broken in ({"a.kspkg": {"repo": self.tmp}},
                       {"a.kspkg": {"command": ["x"]}},
                       {"a.kspkg": {"repo": os.path.join(self.tmp, "nope"), "command": ["x"]}},
                       {"a.kspkg": {"repo": self.tmp, "command": "python build.py"}},
                       {"a.kspkg": {"repo": self.tmp, "command": []}}):
            with self.subTest(entry=broken):
                with self.assertRaises(SystemExit):
                    repad.load_registry(self.write_registry(broken))

    def test_a_usable_registry_is_returned_as_written(self):
        good = {"a.kspkg": {"repo": self.tmp, "command": ["python", "tools/build.py", "--install"]}}
        self.assertEqual(repad.load_registry(self.write_registry(good)), good)

    def test_a_dry_run_reports_the_command_without_running_it(self):
        ran = []
        entry = {"repo": self.tmp, "command": ["python", "-c", "raise SystemExit(1)"]}
        self.assertTrue(repad.rebuild("a.kspkg", entry, dry_run=True))
        self.assertEqual(ran, [], "nothing was run")

    def test_a_failing_rebuild_is_reported_as_failure(self):
        """A build that exits non-zero must stop the round, not be counted as repaired."""
        entry = {"repo": self.tmp, "command": [sys.executable, "-c", "raise SystemExit(3)"]}
        self.assertFalse(repad.rebuild("a.kspkg", entry, dry_run=False))
        entry = {"repo": self.tmp, "command": [sys.executable, "-c", "pass"]}
        self.assertTrue(repad.rebuild("a.kspkg", entry, dry_run=False))


class ReleaseZipTests(unittest.TestCase):
    """The download is a zip laid out as Saved Games\\ACE, with the package under its exact name."""

    def test_the_zip_holds_the_package_under_its_exact_name_and_the_apps_folder_note(self):
        import zipfile
        import release
        tmp = tempfile.mkdtemp()
        try:
            fake = os.path.join(tmp, "ACEUIAppLoader.kspkg")
            with open(fake, "wb") as f:
                f.write(b"\0" * 4096)
            dest = release.zip_release(fake, os.path.join(tmp, release.release_name("1.2.3", "0.9.1+release.6")))
            self.assertEqual(os.path.basename(dest), "ACEUIAppLoader-1.2.3-0.9.1+release.6.zip", "the version is on the zip")
            self.assertEqual(release.release_name("1.2.3", "0.9.1+release.6", alternate=True),
                             "ACEUIAppLoader-1.2.3-0.9.1+release.6-alternate.zip", "the alternate is the same zip under a name that says so")
            with zipfile.ZipFile(dest) as z:
                names = sorted(z.namelist())
                self.assertEqual(names, ["mods/ACEUIAppLoader.kspkg", "mods/uiresources/ACEUIAppLoader/PUT APPS HERE.txt"],
                                 "exactly the package, under its own name, and the note in the empty apps folder")
                self.assertEqual(z.read("mods/ACEUIAppLoader.kspkg"), b"\0" * 4096)
                note = z.read("mods/uiresources/ACEUIAppLoader/PUT APPS HERE.txt").decode("utf-8")
            self.assertIn("Video", note, "the note says an app needs its marker too")
            self.assertIn("extract into Saved Games\\ACE", note)
            self.assertNotIn("\n", note.replace("\r\n", ""), "Notepad-friendly line endings")
            # the folder the loader reads is exactly the one the installer writes to
            self.assertEqual(release.ZIP_APPS_DIR, "mods/uiresources/ACEUIAppLoader")
            self.assertEqual(release.ZIP_PACKAGE, "mods/" + os.path.basename(build_loader.OUT))
            # a published checksum must be checkable by someone rebuilding from source, so
            # the zip's bytes depend on its contents alone, not on when it was written
            again = release.zip_release(fake, os.path.join(tmp, "again.zip"))
            with open(dest, "rb") as a, open(again, "rb") as b:
                self.assertEqual(a.read(), b.read(), "the same package zips to the same bytes")
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_an_app_zip_is_exactly_what_the_installer_puts_on_disk(self):
        """release_app.py: the listed files under the loose apps root, and the empty marker
        under Video -- both halves, because an app needs both, and nothing else."""
        import zipfile
        import release
        import release_app
        tmp = tempfile.mkdtemp()
        try:
            repo = os.path.join(tmp, "ACEMyApp")
            app = os.path.join(repo, "myapp")
            os.makedirs(app)
            with open(os.path.join(app, "app.json"), "w", encoding="utf-8") as f:
                json.dump({"version": "1.2.3", "title": "My App", "scripts": ["myapp.js"], "styles": ["myapp.css"],
                           "files": ["data.bin"]}, f)
            for rel, data in (("myapp.js", b"// js"), ("myapp.css", b"/* css */"), ("data.bin", b"\0\1\2"),
                              ("notes.txt", b"not listed, must not ship")):
                with open(os.path.join(app, rel), "wb") as f:
                    f.write(data)
            dest = os.path.join(repo, "dist", release_app.release_name(repo, "1.2.3"))
            info, written = release_app.zip_app(app, dest)
            self.assertEqual(os.path.basename(written), "ACEMyApp-1.2.3.zip", "named after the repo and the version")
            with zipfile.ZipFile(written) as z:
                names = z.namelist()
                self.assertEqual(sorted(names), sorted([
                    "mods/uiresources/ACEUIAppLoader/myapp/app.json",
                    "mods/uiresources/ACEUIAppLoader/myapp/myapp.js",
                    "mods/uiresources/ACEUIAppLoader/myapp/myapp.css",
                    "mods/uiresources/ACEUIAppLoader/myapp/data.bin",
                    "Video/ACEUIAppLoader-myapp.settingspreset"]), "listed files and the marker, nothing else")
                self.assertEqual(z.getinfo("Video/ACEUIAppLoader-myapp.settingspreset").file_size, 0, "the marker must be empty")
                self.assertEqual(z.read("mods/uiresources/ACEUIAppLoader/myapp/data.bin"), b"\0\1\2")
                for i in z.infolist():
                    self.assertEqual(i.date_time, release.ZIP_TIMESTAMP, "pinned timestamps, as the loader's zip")
            # the same layout install_app.py writes, derived from the same constants
            self.assertTrue(names[0].startswith("mods/" + install_app.APPS_SUBDIR.replace(os.sep, "/") + "/myapp/"))
            self.assertEqual(names[-1], install_app.MARKER_DIR + "/" + install_app.MARKER_PREFIX + "myapp" + install_app.MARKER_EXT)
            again = release_app.zip_app(app, os.path.join(tmp, "again.zip"))[1]
            with open(written, "rb") as a, open(again, "rb") as b:
                self.assertEqual(a.read(), b.read(), "reproducible: the same app zips to the same bytes")
            # an app that would not install does not zip either
            with open(os.path.join(app, "app.json"), "w", encoding="utf-8") as f:
                json.dump({"version": "1.2.3", "scripts": ["missing.js"]}, f)
            with self.assertRaises(SystemExit):
                release_app.zip_app(app, os.path.join(tmp, "bad.zip"))
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_the_readme_installs_the_zip_the_way_the_zip_is_built(self):
        readme = read(os.path.join(ROOT, "README.md"))
        self.assertIn("Drag the `mods` folder out of the zip", readme)
        self.assertIn("%USERPROFILE%\\Saved Games\\ACE\n```", readme, "the target is Saved Games\\ACE, where the zip's mods folder merges in")
        self.assertIn("mods\\uiresources\\ACEUIAppLoader", readme, "and it says where apps go")


class ReadmeTests(unittest.TestCase):
    """The README is the front door: for most people it is the only page they will read."""

    def setUp(self):
        self.readme = read(os.path.join(ROOT, "README.md"))

    def referenced_images(self):
        markdown = re.findall(r"!\[[^\]]*\]\(([^)]+)\)", self.readme)
        html = re.findall(r"<img[^>]+src=\"([^\"]+)\"", self.readme)

        return [r for r in markdown + html if "img.shields.io" not in r]

    def test_every_picture_it_promises_is_actually_there(self):
        """A broken image on a public repo says "abandoned" before anyone reads a word.

        Screenshots are uploaded to GitHub's asset host (user-attachments) rather than
        committed, so most references are URLs, which only GitHub can check. Any picture
        committed under docs/ and referenced must exist; badges do not count as pictures.
        The shot list is docs/images/README.md.
        """
        referenced = self.referenced_images()
        self.assertTrue(referenced, "the README should show what the app looks like")
        local = [r for r in referenced if not r.startswith("http")]
        missing = [r for r in local if not os.path.isfile(os.path.join(ROOT, *r.split("/")))]
        self.assertEqual(missing, [], "these committed pictures are referenced and not there")

    def test_every_page_it_links_to_is_actually_there(self):
        pages = [r for r in re.findall(r"\]\((docs/[^)#]+)\)", self.readme)
                 if r not in self.referenced_images()]
        self.assertTrue(pages)
        for rel in sorted(set(pages)):
            with self.subTest(page=rel):
                self.assertTrue(os.path.exists(os.path.join(ROOT, *rel.split("/"))), rel)

    def test_it_says_which_game_version_the_release_is_for(self):
        """Every release is built for one game version, and the commonest question after a
        patch is which one this is. It belongs on the front page, not in a doc."""
        self.assertIn(build_loader.game_version() or "0.9.1+release.6", self.readme)


if __name__ == "__main__":
    unittest.main()
