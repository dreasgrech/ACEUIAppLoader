"""Runs the shared ACEUIModLoader test kit against this app (see appkit.py in the loader repo)."""
import json
import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# The loader is either beside this repo or above it -- a bundled app lives in the loader's
# own apps/<name>/ -- so walk up looking for it. ACE_LOADER_DIR overrides both.
LOADER = os.environ.get("ACE_LOADER_DIR")
HERE = ROOT
while not LOADER:
    for candidate in (HERE, os.path.join(HERE, "ACEUIModLoader")):
        if os.path.isfile(os.path.join(candidate, "tools", "appkit.py")):
            LOADER = candidate
    if not LOADER and HERE == os.path.dirname(HERE):
        raise SystemExit("ACEUIModLoader not found: clone it next to this repo or set ACE_LOADER_DIR")
    HERE = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(LOADER, "tools"))

from appkit import AppTests  # noqa: E402


class Tests(AppTests):
    ROOT = ROOT
    MIN_CASES = 4
    HOT_PATH = ("// ---- rendering", "// ---- lifecycle")


class ProbeContractTests(unittest.TestCase):
    """What being a bundled developer app means for this app's own files."""

    @classmethod
    def setUpClass(cls):
        with open(os.path.join(ROOT, "capabilities", "app.json"), encoding="utf-8") as f:
            cls.info = json.load(f)
        with open(os.path.join(ROOT, "capabilities", "capabilities.js"), encoding="utf-8") as f:
            cls.js = f.read()

    def test_it_is_a_developer_app(self):
        """A probe is a tool, not something a player installed for fun: the app drawer
        keeps it behind its developer switch, and that comes from this one key."""
        self.assertIs(self.info.get("developer"), True)

    def test_it_offers_its_answers_while_it_is_running_and_withdraws_them_when_it_is_not(self):
        self.assertIn("ACEUIModLoader.shared.register(me.name, surface(state));", self.js)
        self.assertIn("ACEUIModLoader.shared.unregister(me.name);", self.js)
        self.assertLess(self.js.index("shared.unregister"), self.js.index("state.ui.stop();"),
                        "withdrawn first thing in detach: the results go with the run that made them")


if __name__ == "__main__":
    unittest.main()
