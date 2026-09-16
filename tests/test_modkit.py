"""new_mod.py must produce a mod that passes the shared test kit (modkit.py) out of the box,
and the kit must catch the boilerplate it exists to remove."""
import json
import os
import shutil
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tools"))

import modkit  # noqa: E402
import new_mod  # noqa: E402


def run_kit(repo, **attrs):
    """Run ModTests against a repo; returns the unittest result."""
    cls = type("GeneratedModTests", (modkit.ModTests,), dict(ROOT=repo, **attrs))
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(cls)
    return unittest.TextTestRunner(stream=open(os.devnull, "w"), verbosity=0).run(suite)


class NewModTests(unittest.TestCase):
    def setUp(self):
        # the generated repo must sit next to a folder named ACEUIModLoader so its relative links resolve
        self.tmp = tempfile.TemporaryDirectory()
        self.parent = os.path.join(self.tmp.name, "GitHub")
        os.makedirs(self.parent)
        link = os.path.join(self.parent, "ACEUIModLoader")
        os.makedirs(os.path.join(link, "tools"))
        os.makedirs(os.path.join(link, "tests"))
        shutil.copytree(os.path.join(ROOT, "src"), os.path.join(link, "src"))
        shutil.copy(os.path.join(ROOT, "tests", "lib", "doubles.js"), os.path.join(link, "tests", "lib", "doubles.js")) if os.path.isdir(os.path.join(link, "tests", "lib")) else None
        os.makedirs(os.path.join(link, "tests", "lib"), exist_ok=True)
        for name in ("doubles.js", "lib.js"):
            shutil.copy(os.path.join(ROOT, "tests", "lib", name), os.path.join(link, "tests", "lib", name))
        for name in ("headless.py", "modkit.py"):
            shutil.copy(os.path.join(ROOT, "tools", name), os.path.join(link, "tools", name))

    def tearDown(self):
        self.tmp.cleanup()

    def test_generated_mod_has_only_the_essentials(self):
        repo = new_mod.create("fuelcalc", self.parent, "Fuel Calc")
        self.assertEqual(os.path.basename(repo), "ACEFuelCalc")
        files = sorted(os.path.relpath(os.path.join(d, f), repo).replace(os.sep, "/")
                       for d, _, fs in os.walk(repo) for f in fs)
        self.assertEqual(files, [".gitignore", "README.md", "dev/preview.html", "fuelcalc/fuelcalc.css", "fuelcalc/fuelcalc.js",
                                 "fuelcalc/mod.json", "tests/harness.html", "tests/test_mod.py"])
        js = open(os.path.join(repo, "fuelcalc", "fuelcalc.js"), encoding="utf-8").read()
        self.assertIn('ACEUIModLoader.mod("fuelcalc")', js)
        self.assertNotIn("const VERSION", js, "the version lives in mod.json only")
        self.assertIn("const FuelCalc = (function () {", js)
        self.assertNotIn("__", js.replace("__clock", ""), "no unrendered template tokens")

    def test_generated_mod_passes_the_kit(self):
        repo = new_mod.create("fuelcalc", self.parent, "Fuel Calc")
        result = run_kit(repo, MIN_CASES=3, HOT_PATH=("// ---- rendering", "// ---- lifecycle"))
        failures = [(str(t), msg[-400:]) for t, msg in result.failures + result.errors]
        self.assertEqual(failures, [], "the generated mod must pass its own kit")
        self.assertGreaterEqual(result.testsRun, 8)

    def test_kit_catches_legacy_boilerplate_and_a_declared_version(self):
        repo = new_mod.create("fuelcalc", self.parent, "Fuel Calc")
        with open(os.path.join(repo, "VERSION"), "w") as f:
            f.write("0.1.0\n")
        with open(os.path.join(repo, "fuelcalc", "mod.js"), "w") as f:
            f.write("(function () {}());\n")
        path = os.path.join(repo, "fuelcalc", "fuelcalc.js")
        with open(path, encoding="utf-8") as f:
            js = f.read()
        with open(path, "w", encoding="utf-8") as f:
            f.write(js.replace('const me = ACEUIModLoader.mod("fuelcalc");', 'const VERSION = "0.1.0";\n    const me = ACEUIModLoader.mod("fuelcalc");'))
        result = run_kit(repo, MIN_CASES=3)
        failed = {str(t).split(" ")[0] for t, _ in result.failures}
        self.assertIn("test_no_legacy_boilerplate", failed)
        self.assertIn("test_nothing_ships_that_is_not_listed", failed, "mod.js is not listed in mod.json")

    def test_developer_flag_is_scaffolded_and_accepted(self):
        repo = new_mod.create("fuelcalc", self.parent, "Fuel Calc", developer=True)
        with open(os.path.join(repo, "fuelcalc", "mod.json"), encoding="utf-8") as f:
            info = json.load(f)
        self.assertIs(info["developer"], True)
        self.assertEqual(sorted(set(info) - modkit.KNOWN_KEYS), [], "the kit accepts it")

    def test_bad_names_are_rejected(self):
        with self.assertRaises(SystemExit):
            new_mod.create("Bad Name", self.parent)
        with self.assertRaises(SystemExit):
            new_mod.create("../x", self.parent)


if __name__ == "__main__":
    unittest.main()
