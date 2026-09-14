#!/usr/bin/env python3
"""
build_loader.py - build the AceMods loader package.

1. Extract the stock `uiresources/js/cohtml.js` from the installed content.kspkg
   (never committed; it is Kunos'/Coherent's file).
2. Append src/acemods.loader.js to it -> build/uiresources/js/cohtml.js.
3. Pack build/ with tools/pack_kspkg.py (which adds the padding that makes this
   single override win the game's lookup) -> dist/acemods_loader.kspkg.
4. --install copies it to the game's mods folder.

Usage:
  python tools/build_loader.py [--install] [--no-verify]
"""
import os
import shutil
import sys

import _repos

_repos.add_internals_to_path()
import kspkg  # noqa: E402
import pack_kspkg as pk  # noqa: E402

HOST_PATH = "uiresources/js/cohtml.js"
LOADER_SRC = os.path.join(_repos.REPO, "src", "acemods.loader.js")
BUILD_DIR = os.path.join(_repos.REPO, "build")
OUT = os.path.join(_repos.REPO, "dist", "acemods_loader.kspkg")


def read_version():
    with open(os.path.join(_repos.REPO, "VERSION"), encoding="utf-8") as f:
        return f.read().strip()


def assemble(build_dir=BUILD_DIR, game_dir=None):
    base_pkg = os.path.join(game_dir or _repos.game_dir(), "content.kspkg")
    if not os.path.exists(base_pkg):
        raise SystemExit(f"content.kspkg not found at {base_pkg} (set ACE_GAME_DIR)")
    stock = kspkg.extract(base_pkg, HOST_PATH)
    with open(LOADER_SRC, encoding="utf-8") as f:
        loader = f.read()
    version = read_version()
    if f'const VERSION = "{version}";' not in loader:
        raise SystemExit(f"src/acemods.loader.js VERSION does not match VERSION file ({version})")

    if os.path.isdir(build_dir):
        shutil.rmtree(build_dir)
    target = os.path.join(build_dir, *HOST_PATH.split("/"))
    os.makedirs(os.path.dirname(target), exist_ok=True)
    with open(target, "wb") as f:
        f.write(stock)
        f.write(b"\n\n/* ---- AceMods loader appended by ACEUIModLoader/tools/build_loader.py ---- */\n")
        f.write(loader.encode("utf-8"))
    print(f"assembled {HOST_PATH}: stock {len(stock)} bytes + loader {len(loader)} chars (v{version})")
    return build_dir


if __name__ == "__main__":
    flags = set(sys.argv[1:])
    build = assemble()
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    written = pk.pack(build, OUT)
    if "--no-verify" not in flags:
        pk.verify(OUT, written)
    if "--install" in flags:
        dest = os.path.join(_repos.mods_dir(), os.path.basename(OUT))
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        shutil.copyfile(OUT, dest)
        print(f"installed {dest}")
