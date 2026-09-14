#!/usr/bin/env python3
"""
install.py - install DevConsole as a loose ACEUIModLoader mod.

Thin wrapper: copies src/ into the game mods folder and writes the empty marker file the
loader discovers it by, via ../ACEUIModLoader/tools/install_mod.py (or ACE_LOADER_DIR).
The loader package itself is built and installed from the ACEUIModLoader repo.

Usage:
  python tools/install.py            install / update
  python tools/install.py --remove   remove
"""
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MOD_NAME = "devconsole"


def loader_dir():
    for c in (os.environ.get("ACE_LOADER_DIR"), os.path.join(os.path.dirname(ROOT), "ACEUIModLoader")):
        if c and os.path.isfile(os.path.join(c, "tools", "install_mod.py")):
            return c
    raise SystemExit("ACEUIModLoader not found: clone it next to this repo or set ACE_LOADER_DIR")


if __name__ == "__main__":
    tool = os.path.join(loader_dir(), "tools", "install_mod.py")
    if "--remove" in sys.argv:
        cmd = [sys.executable, tool, "--remove", MOD_NAME]
    else:
        cmd = [sys.executable, tool, os.path.join(ROOT, "src")]
    sys.exit(subprocess.call(cmd))
