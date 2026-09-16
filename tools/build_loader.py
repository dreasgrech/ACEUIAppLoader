#!/usr/bin/env python3
"""
build_loader.py - build the ACEUIModLoader package.

1. Extract the stock `uiresources/js/cohtml.js` from the installed content.kspkg
   (never committed; it is Kunos'/Coherent's file).
2. Append the library files in LIB_ORDER (src/ACEUIModLoaderMods.*.js) to it
   -> build/uiresources/js/cohtml.js. The order matters: core defines the
   namespace, console hooks console.* before the stock bundle runs, loader
   comes second to last and starts loading mods once the DOM exists, and the
   drawer comes last because it registers an ACEUIModLoader.ready callback.
3. Copy the bundled apps -- the developer tools in apps/, the manifest-listed files
   and nothing else -- to build/uiresources/ACEUIModLoaderApps/<name>/, and write the
   index the loader reads, ACEUIModLoaderApps/apps.json. They go in as NEW paths, which
   always resolve whatever the package layout turns out to be; only cohtml.js is an
   override. They are deliberately not at the installed mods' path: loose files never
   beat packed files, so a bundled app there could never be overridden, and iterating on
   one with install_mod.py would silently do nothing.
4. Pack build/ with tools/pack_kspkg.py (which adds the padding that makes this
   single override win the game's lookup) -> dist/ACEUIModLoader.kspkg.
5. --install copies it to the game's mods folder.

Usage:
  python tools/build_loader.py [--install] [--no-verify] [--no-apps]
"""
import json
import os
import shutil
import sys

import _repos
import install_mod

_repos.add_internals_to_path()
import kspkg  # noqa: E402
import pack_kspkg as pk  # noqa: E402

HOST_PATH = "uiresources/js/cohtml.js"
APPS_DIR = os.path.join(_repos.REPO, "apps")
APPS_PATH = "uiresources/ACEUIModLoaderApps"
APPS_INDEX = "apps.json"
SRC_DIR = os.path.join(_repos.REPO, "src")
LIB_ORDER = [
    "ACEUIModLoader.core.js",
    "ACEUIModLoader.console.js",
    "ACEUIModLoader.dom.js",
    "ACEUIModLoader.keys.js",
    "ACEUIModLoader.scroll.js",
    "ACEUIModLoader.persist.js",
    "ACEUIModLoader.panel.js",
    "ACEUIModLoader.loop.js",
    "ACEUIModLoader.input.js",
    "ACEUIModLoader.apps.js",
    "ACEUIModLoader.loader.js",
    "ACEUIModLoader.drawer.js",
    "ACEUIModLoader.window.js",
    "ACEUIModLoader.settings.js",
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


def bundled_apps(apps_dir=APPS_DIR):
    """[(shipped folder, info)] for every app under apps/, in load order (by name).

    The manifest is read through install_mod, so a bundled app is held to exactly the
    rules a loose one is: known keys only, a version, listed files that exist, and a
    folder whose name is the mod's.
    """
    out = []
    for name in sorted(os.listdir(apps_dir) if os.path.isdir(apps_dir) else []):
        app = os.path.join(apps_dir, name)
        folders = [d for d in sorted(os.listdir(app))
                   if os.path.isfile(os.path.join(app, d, install_mod.MOD_FILE))] if os.path.isdir(app) else []
        if not folders:
            continue
        if len(folders) > 1:
            raise SystemExit(f"{app} holds more than one mod folder: {folders}")
        src = os.path.join(app, folders[0])
        out.append((src, install_mod.load_mod_info(src)))
    return out


def copy_apps(build_dir, apps_dir=APPS_DIR):
    """The listed files, the index the loader reads, and nothing else."""
    apps = bundled_apps(apps_dir)
    root = os.path.join(build_dir, *APPS_PATH.split("/"))
    index = []
    os.makedirs(root, exist_ok=True)
    for src, info in apps:
        dest = os.path.join(root, info["name"])
        files = [install_mod.MOD_FILE]
        for key in ("scripts", "styles", "files"):
            files.extend(info.get(key, []))
        os.makedirs(dest, exist_ok=True)
        for rel in files:
            shutil.copyfile(os.path.join(src, rel), os.path.join(dest, rel))
        index.append({"name": info["name"], "version": info["version"],
                      "title": info.get("title", info["name"]), "developer": bool(info.get("developer"))})
        print(f"bundled app {info['name']} {info['version']}: {len(files)} file(s)")
    with open(os.path.join(root, APPS_INDEX), "w", encoding="utf-8", newline="\n") as f:
        json.dump({"apps": index}, f, indent=2)
        f.write("\n")
    return index


def assemble(build_dir=BUILD_DIR, game_dir=None, with_apps=True):
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

    if with_apps:
        copy_apps(build_dir)

    return build_dir


if __name__ == "__main__":
    flags = set(sys.argv[1:])
    build = assemble(with_apps="--no-apps" not in flags)
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    written = pk.pack(build, OUT)
    if "--no-verify" not in flags:
        pk.verify(OUT, written)
    if "--install" in flags:
        dest = os.path.join(_repos.mods_dir(), os.path.basename(OUT))
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        shutil.copyfile(OUT, dest)
        print(f"installed {dest}")
