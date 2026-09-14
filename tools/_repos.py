"""Locate the sibling repositories and the game's folders.

Overrides: ACE_INTERNALS_DIR (ACEGameInternals checkout), ACE_GAME_DIR (game install
folder), ACE_MODS_DIR (the game's mods folder, default %USERPROFILE%\\Saved Games\\ACE\\mods).
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)

DEFAULT_GAME_DIR = r"C:\Program Files (x86)\Steam\steamapps\common\Assetto Corsa EVO"


def internals_tools():
    for c in (os.environ.get("ACE_INTERNALS_DIR"), os.path.join(os.path.dirname(REPO), "ACEGameInternals")):
        if c and os.path.isfile(os.path.join(c, "tools", "lookup_sim.py")):
            return os.path.join(c, "tools")
    raise SystemExit("ACEGameInternals not found: clone it next to this repo or set ACE_INTERNALS_DIR")


def add_internals_to_path():
    p = internals_tools()
    if p not in sys.path:
        sys.path.insert(0, p)
    return p


def game_dir():
    return os.environ.get("ACE_GAME_DIR") or DEFAULT_GAME_DIR


def mods_dir():
    return os.environ.get("ACE_MODS_DIR") or os.path.join(os.path.expanduser("~"), "Saved Games", "ACE", "mods")
