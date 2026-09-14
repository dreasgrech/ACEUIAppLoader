"""Tests for the loader's runtime source, install_mod.py and build_loader.py."""
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
import _repos  # noqa: E402

LOADER_JS = os.path.join(ROOT, "src", "acemods.loader.js")


def read(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


def strip_js(src):
    src = re.sub(r"/\*.*?\*/", "", src, flags=re.S)
    src = re.sub(r"//[^\n]*", "", src)
    return re.sub(r"'(?:\\.|[^'\\\n])*'|\"(?:\\.|[^\"\\\n])*\"|`(?:\\.|[^`\\])*`", "''", src)


class LoaderSourceTests(unittest.TestCase):
    def setUp(self):
        self.js = read(LOADER_JS)
        self.code = strip_js(self.js)

    def test_version_matches_version_file(self):
        v = read(os.path.join(ROOT, "VERSION")).strip()
        self.assertIn(f'const VERSION = "{v}";', self.js)
        self.assertIn(v, read(os.path.join(ROOT, "README.md")))

    def test_style_rules(self):
        self.assertIsNone(re.search(r"\bclass\s+[A-Za-z_$]", self.code))
        self.assertIsNone(re.search(r"\bthis\b", self.code))
        self.assertIsNone(re.search(r"^\s*function\s+[A-Za-z_$][\w$]*\s*\(", self.code, re.M))
        self.assertNotIn("=>", self.code)
        self.assertIsNone(re.search(r"\bvar\s", self.code))
        self.assertIsNotNone(re.search(r"const AceMods = \(function \(\) \{", self.code))
        self.assertNotIn("\t", self.js)
        for a, b in ("()", "{}", "[]"):
            self.assertEqual(self.code.count(a), self.code.count(b))

    def test_manifest_paths_and_logging(self):
        self.assertIn('const ROOT = "acemods/";', self.js)
        self.assertIn('ROOT + "manifest.json"', self.js)
        self.assertIn('const MOD_FILE = "mod.json";', self.js)
        self.assertIn('const LOG_PREFIX = "[AceMods]";', self.js)
        for line in ("loader \" + VERSION + \" on /", "manifest: ", " loaded", " FAILED", "no manifest at "):
            self.assertIn(line, self.js, line)

    def test_scripts_load_sequentially_and_only_on_wanted_pages(self):
        self.assertIn("loadScripts(base, files, index + 1, onDone)", self.js)
        self.assertIn("const wantsPage = function (info)", self.js)
        self.assertIn('const DEFAULT_PAGES = ["hud.html"];', self.js)

    def test_module_is_reachable_as_window_property(self):
        self.assertRegex(self.js, r"\n\}\(\)\);\n(\n|/\*[^\n]*\*/\n)*window\.AceMods = AceMods;\n")

    def test_exports(self):
        for name in ("VERSION", "LOG_PREFIX", "ROOT", "page", "mods", "log", "logger", "addStylesheet", "addScript", "ready"):
            self.assertRegex(self.js, rf"\n\s+{name}: [A-Za-z_.]+,?\n", f"{name} not exported")


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
        # reinstall is idempotent
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
    def test_assemble_is_stock_plus_loader_and_override_wins(self):
        import build_loader
        import kspkg
        import pack_kspkg as pk
        import lookup_sim
        with tempfile.TemporaryDirectory() as tmp:
            build = build_loader.assemble(os.path.join(tmp, "build"))
            host = os.path.join(build, "uiresources", "js", "cohtml.js")
            stock = kspkg.extract(os.path.join(_repos.game_dir(), "content.kspkg"), build_loader.HOST_PATH)
            data = open(host, "rb").read()
            self.assertTrue(data.startswith(stock), "host must start with the untouched stock file")
            self.assertIn(b"const AceMods = (function () {", data)
            out = os.path.join(tmp, "loader.kspkg")
            written = pk.pack(build, out)
            pk.verify(out, written)
            base = lookup_sim.read_base_hashes(os.path.join(_repos.game_dir(), "content.kspkg"))
            entries = kspkg.read_entries(out)
            w = lookup_sim.winners(base, [e.hash for e in entries.values()])
            self.assertEqual(w[pk.path_hash(build_loader.HOST_PATH)], "mod", "cohtml.js override would lose")


if __name__ == "__main__":
    unittest.main()
