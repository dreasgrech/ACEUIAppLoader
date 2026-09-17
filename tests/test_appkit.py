"""new_app.py must produce an app that passes the shared test kit (appkit.py) out of the box,
and the kit must catch the boilerplate it exists to remove."""
import json
import os
import shutil
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tools"))

import appkit  # noqa: E402
import new_app  # noqa: E402


def run_kit(repo, **attrs):
    """Run AppTests against a repo; returns the unittest result."""
    cls = type("GeneratedAppTests", (appkit.AppTests,), dict(ROOT=repo, **attrs))
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(cls)
    return unittest.TextTestRunner(stream=open(os.devnull, "w"), verbosity=0).run(suite)


class NewAppTests(unittest.TestCase):
    def setUp(self):
        # the generated repo must sit next to a folder named ACEUIAppLoader so its relative links resolve
        self.tmp = tempfile.TemporaryDirectory()
        self.parent = os.path.join(self.tmp.name, "GitHub")
        os.makedirs(self.parent)
        link = os.path.join(self.parent, "ACEUIAppLoader")
        os.makedirs(os.path.join(link, "tools"))
        os.makedirs(os.path.join(link, "tests"))
        shutil.copytree(os.path.join(ROOT, "src"), os.path.join(link, "src"))
        shutil.copy(os.path.join(ROOT, "tests", "lib", "doubles.js"), os.path.join(link, "tests", "lib", "doubles.js")) if os.path.isdir(os.path.join(link, "tests", "lib")) else None
        os.makedirs(os.path.join(link, "tests", "lib"), exist_ok=True)
        for name in ("doubles.js", "lib.js"):
            shutil.copy(os.path.join(ROOT, "tests", "lib", name), os.path.join(link, "tests", "lib", name))
        for name in ("headless.py", "appkit.py"):
            shutil.copy(os.path.join(ROOT, "tools", name), os.path.join(link, "tools", name))

    def tearDown(self):
        self.tmp.cleanup()

    def test_generated_app_has_only_the_essentials(self):
        repo = new_app.create("fuelcalc", self.parent, "Fuel Calc")
        self.assertEqual(os.path.basename(repo), "ACEFuelCalc")
        files = sorted(os.path.relpath(os.path.join(d, f), repo).replace(os.sep, "/")
                       for d, _, fs in os.walk(repo) for f in fs)
        self.assertEqual(files, [".gitignore", "README.md", "dev/preview.html", "fuelcalc/app.json",
                                 "fuelcalc/fuelcalc.css", "fuelcalc/fuelcalc.js",
                                 "tests/harness.html", "tests/test_app.py"])
        js = open(os.path.join(repo, "fuelcalc", "fuelcalc.js"), encoding="utf-8").read()
        self.assertIn('ACEUIAppLoader.app("fuelcalc")', js)
        self.assertNotIn("const VERSION", js, "the version lives in app.json only")
        self.assertIn("const FuelCalc = (function () {", js)
        self.assertNotIn("__", js.replace("__clock", ""), "no unrendered template tokens")

    def test_generated_app_passes_the_kit(self):
        repo = new_app.create("fuelcalc", self.parent, "Fuel Calc")
        result = run_kit(repo, MIN_CASES=3, HOT_PATH=("// ---- rendering", "// ---- lifecycle"))
        failures = [(str(t), msg[-400:]) for t, msg in result.failures + result.errors]
        self.assertEqual(failures, [], "the generated app must pass its own kit")
        self.assertGreaterEqual(result.testsRun, 8)

    def test_kit_catches_legacy_boilerplate_and_a_declared_version(self):
        repo = new_app.create("fuelcalc", self.parent, "Fuel Calc")
        with open(os.path.join(repo, "VERSION"), "w") as f:
            f.write("0.1.0\n")
        with open(os.path.join(repo, "fuelcalc", "mod.js"), "w") as f:
            f.write("(function () {}());\n")
        path = os.path.join(repo, "fuelcalc", "fuelcalc.js")
        with open(path, encoding="utf-8") as f:
            js = f.read()
        with open(path, "w", encoding="utf-8") as f:
            f.write(js.replace('const me = ACEUIAppLoader.app("fuelcalc");', 'const VERSION = "0.1.0";\n    const me = ACEUIAppLoader.app("fuelcalc");'))
        result = run_kit(repo, MIN_CASES=3)
        failed = {str(t).split(" ")[0] for t, _ in result.failures}
        self.assertIn("test_no_legacy_boilerplate", failed)
        self.assertIn("test_nothing_ships_that_is_not_listed", failed, "mod.js is not listed in app.json")

    def test_developer_flag_is_scaffolded_and_accepted(self):
        repo = new_app.create("fuelcalc", self.parent, "Fuel Calc", developer=True)
        with open(os.path.join(repo, "fuelcalc", "app.json"), encoding="utf-8") as f:
            info = json.load(f)
        self.assertIs(info["developer"], True)
        self.assertEqual(sorted(set(info) - appkit.KNOWN_KEYS), [], "the kit accepts it")

    def test_bad_names_are_rejected(self):
        with self.assertRaises(SystemExit):
            new_app.create("Bad Name", self.parent)
        with self.assertRaises(SystemExit):
            new_app.create("../x", self.parent)


if __name__ == "__main__":
    unittest.main()
