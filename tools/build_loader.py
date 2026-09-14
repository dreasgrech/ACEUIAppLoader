#!/usr/bin/env python3
"""
build_loader.py - build the ACEUIModLoader package.

1. Extract the stock `uiresources/js/cohtml.js` from the installed content.kspkg
   (never committed; it is Kunos'/Coherent's file).
2. Append the library files in LIB_ORDER (src/ACEUIModLoaderMods.*.js) to it
   -> build/uiresources/js/cohtml.js. The order matters: core defines the
   namespace, console hooks console.* before the stock bundle runs, loader
   comes last and starts loading mods once the DOM exists.
3. Pack build/ with tools/pack_kspkg.py (which adds the padding that makes this
   single override win the game's lookup) -> dist/ACEUIModLoader.kspkg.
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
SRC_DIR = os.path.join(_repos.REPO, "src")
LIB_ORDER = [
    "ACEUIModLoader.core.js",
    "ACEUIModLoader.console.js",
    "ACEUIModLoader.persist.js",
    "ACEUIModLoader.panel.js",
    "ACEUIModLoader.loop.js",
    "ACEUIModLoader.loader.js",
]
BUILD_DIR = os.path.join(_repos.REPO, "build")
OUT = os.path.join(_repos.REPO, "dist", "ACEUIModLoader.kspkg")


def read_version():
    with open(os.path.join(_repos.REPO, "VERSION"), encoding="utf-8") as f:
        return f.read().strip()


def marker(name):
    return f"\n\n/* ---- {name} (ACEUIModLoader {read_version()}, appended by ACEUIModLoader/tools/build_loader.py) ---- */\n"


def library_sources():
    """[(file name, text)] in load order; checks the version constant and that nothing is missing."""
    version = read_version()
    out = []
    for name in LIB_ORDER:
        path = os.path.join(SRC_DIR, name)
        if not os.path.exists(path):
            raise SystemExit(f"missing library file {path}")
        with open(path, encoding="utf-8") as f:
            out.append((name, f.read()))
    core = dict(out)["ACEUIModLoader.core.js"]
    if f'const VERSION = "{version}";' not in core:
        raise SystemExit(f"src/ACEUIModLoader.core.js VERSION does not match VERSION file ({version})")
    unlisted = sorted(n for n in os.listdir(SRC_DIR) if n.endswith(".js") and n not in LIB_ORDER)
    if unlisted:
        raise SystemExit(f"src/ has files not in LIB_ORDER: {unlisted}")
    return out


def assemble(build_dir=BUILD_DIR, game_dir=None):
    base_pkg = os.path.join(game_dir or _repos.game_dir(), "content.kspkg")
    if not os.path.exists(base_pkg):
        raise SystemExit(f"content.kspkg not found at {base_pkg} (set ACE_GAME_DIR)")
    stock = kspkg.extract(base_pkg, HOST_PATH)
    sources = library_sources()

    if os.path.isdir(build_dir):
        shutil.rmtree(build_dir)
    target = os.path.join(build_dir, *HOST_PATH.split("/"))
    os.makedirs(os.path.dirname(target), exist_ok=True)
    appended = 0
    with open(target, "wb") as f:
        f.write(stock)
        for name, text in sources:
            f.write(marker(name).encode("utf-8"))
            f.write(text.encode("utf-8"))
            appended += len(text)
    print(f"assembled {HOST_PATH}: stock {len(stock)} bytes + {len(sources)} library files, {appended} chars (v{read_version()})")
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
