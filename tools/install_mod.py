#!/usr/bin/env python3
"""
install_mod.py - install (or remove) a loose UI mod for the ACEUIModLoader.

A mod is a folder containing `mod.json` plus the files it lists. Installing copies
the folder to `<mods>\\uiresources\\ACEUIModLoaderMods\\<name>\\` and adds the name to
`<mods>\\uiresources\\ACEUIModLoaderMods\\manifest.json`, which the loader reads on every page.
No packaging, no padding: the game serves these as loose files (see
ACEGameInternals/docs/game-internals.md section 3).

Usage:
  python tools/install_mod.py <mod folder>          install / update
  python tools/install_mod.py --remove <name>       remove files and manifest entry
  python tools/install_mod.py --list

Environment: ACE_MODS_DIR overrides the game's mods folder.
"""
import json
import os
import shutil
import sys

import _repos

MODS_SUBDIR = os.path.join("uiresources", "ACEUIModLoaderMods")
MANIFEST = "manifest.json"
MOD_FILE = "mod.json"


def mods_root_dir(mods_dir=None):
    return os.path.join(mods_dir or _repos.mods_dir(), MODS_SUBDIR)


def read_manifest(root):
    path = os.path.join(root, MANIFEST)
    if not os.path.exists(path):
        return {"mods": []}
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    data.setdefault("mods", [])
    return data


def write_manifest(root, data):
    os.makedirs(root, exist_ok=True)
    with open(os.path.join(root, MANIFEST), "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
        f.write("\n")


def load_mod_info(src_dir):
    path = os.path.join(src_dir, MOD_FILE)
    if not os.path.exists(path):
        raise SystemExit(f"{src_dir} has no {MOD_FILE}")
    with open(path, encoding="utf-8") as f:
        info = json.load(f)
    for key in ("name", "version"):
        if not info.get(key):
            raise SystemExit(f"{MOD_FILE}: missing '{key}'")
    for key in ("scripts", "styles"):
        for rel in info.get(key, []):
            if not os.path.isfile(os.path.join(src_dir, rel)):
                raise SystemExit(f"{MOD_FILE} lists {rel} but the file is missing")
    return info


def install(src_dir, mods_dir=None):
    info = load_mod_info(src_dir)
    root = mods_root_dir(mods_dir)
    dest = os.path.join(root, info["name"])
    if os.path.isdir(dest):
        shutil.rmtree(dest)
    shutil.copytree(src_dir, dest, ignore=shutil.ignore_patterns("__pycache__", "*.swp", "*~", ".*"))
    manifest = read_manifest(root)
    if info["name"] not in manifest["mods"]:
        manifest["mods"].append(info["name"])
    write_manifest(root, manifest)
    print(f"installed mod {info['name']} {info['version']} -> {dest}")
    print(f"manifest: {manifest['mods']}")
    return dest


def remove(name, mods_dir=None):
    root = mods_root_dir(mods_dir)
    dest = os.path.join(root, name)
    if os.path.isdir(dest):
        shutil.rmtree(dest)
    manifest = read_manifest(root)
    manifest["mods"] = [m for m in manifest["mods"] if m != name]
    write_manifest(root, manifest)
    print(f"removed mod {name}; manifest: {manifest['mods']}")


def list_mods(mods_dir=None):
    root = mods_root_dir(mods_dir)
    manifest = read_manifest(root)
    for name in manifest["mods"]:
        path = os.path.join(root, name, MOD_FILE)
        version = "?"
        if os.path.exists(path):
            with open(path, encoding="utf-8") as f:
                version = json.load(f).get("version", "?")
        print(f"{name} {version} {'ok' if os.path.isdir(os.path.join(root, name)) else 'FOLDER MISSING'}")
    if not manifest["mods"]:
        print("no mods installed")


if __name__ == "__main__":
    argv = sys.argv[1:]
    if argv and argv[0] == "--list":
        list_mods()
    elif len(argv) == 2 and argv[0] == "--remove":
        remove(argv[1])
    elif len(argv) == 1 and not argv[0].startswith("--"):
        install(argv[0])
    else:
        print(__doc__)
        sys.exit(1)
