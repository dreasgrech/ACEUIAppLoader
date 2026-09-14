#!/usr/bin/env python3
"""
install_mod.py - install (or remove) a loose UI mod for the ACEUIModLoader.

A mod is a folder containing `mod.json` plus the files it lists. Installing copies
the folder to `<ACE>/mods/uiresources/ACEUIModLoaderMods/<name>/` and writes the
EMPTY marker file `<ACE>/Video/ACEUIModLoaderMods-<name>.settingspreset`. The game
lists that folder for the UI (video settings presets), which is how the loader
discovers installed mods without any registry. A release zip of a mod contains
exactly these two things, laid out relative to `Saved Games/ACE`.

The marker must be empty: the game deserialises every listed file, and an empty
file is a valid default message. No packaging, no padding, no manifest.

Usage:
  python tools/install_mod.py <mod folder>          install / update
  python tools/install_mod.py --remove <name>       remove folder and marker
  python tools/install_mod.py --list

Environment: ACE_MODS_DIR overrides the game's mods folder (its parent is <ACE>).
"""
import json
import os
import re
import shutil
import sys

import _repos

MODS_SUBDIR = os.path.join("uiresources", "ACEUIModLoaderMods")
MARKER_DIR = "Video"
MARKER_PREFIX = "ACEUIModLoaderMods-"
MARKER_EXT = ".settingspreset"
MOD_FILE = "mod.json"
LEGACY_MANIFEST = "manifest.json"
NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]*$")
IGNORE = shutil.ignore_patterns("__pycache__", "*.swp", "*~", ".*")


def mods_root_dir(mods_dir=None):
    return os.path.join(mods_dir or _repos.mods_dir(), MODS_SUBDIR)


def ace_dir(mods_dir=None):
    """`Saved Games/ACE`: the parent of the mods folder."""
    return os.path.dirname(os.path.abspath(mods_dir or _repos.mods_dir()))


def marker_dir(mods_dir=None):
    return os.path.join(ace_dir(mods_dir), MARKER_DIR)


def marker_path(name, mods_dir=None):
    return os.path.join(marker_dir(mods_dir), MARKER_PREFIX + name + MARKER_EXT)


def check_name(name):
    if not NAME_RE.match(name or ""):
        raise SystemExit(f"mod name {name!r} must be letters, digits, '_', '.', '-' (it becomes a file name)")
    return name


def write_marker(name, mods_dir=None):
    path = marker_path(check_name(name), mods_dir)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb"):
        pass
    if os.path.getsize(path) != 0:
        raise SystemExit(f"marker {path} is not empty")
    return path


def remove_marker(name, mods_dir=None):
    path = marker_path(name, mods_dir)
    if os.path.exists(path):
        os.remove(path)


def marker_names(mods_dir=None):
    """Mod names that have a marker, as the game would list them; non-empty markers are reported."""
    folder = marker_dir(mods_dir)
    names = []
    if not os.path.isdir(folder):
        return names
    for entry in sorted(os.listdir(folder)):
        if entry.startswith(MARKER_PREFIX) and entry.endswith(MARKER_EXT):
            name = entry[len(MARKER_PREFIX):-len(MARKER_EXT)]
            if os.path.getsize(os.path.join(folder, entry)) != 0:
                print(f"WARNING: marker {entry} is not empty; the game may refuse to list it")
            names.append(name)
    return names


def folder_names(mods_dir=None):
    root = mods_root_dir(mods_dir)
    if not os.path.isdir(root):
        return []
    return sorted(n for n in os.listdir(root) if os.path.isdir(os.path.join(root, n)))


def load_mod_info(src_dir):
    path = os.path.join(src_dir, MOD_FILE)
    if not os.path.exists(path):
        raise SystemExit(f"{src_dir} has no {MOD_FILE}")
    with open(path, encoding="utf-8") as f:
        info = json.load(f)
    for key in ("name", "version"):
        if not info.get(key):
            raise SystemExit(f"{MOD_FILE}: missing '{key}'")
    check_name(info["name"])
    for key in ("scripts", "styles"):
        for rel in info.get(key, []):
            if os.path.basename(rel) != rel or not rel:
                raise SystemExit(f"{MOD_FILE} lists {rel!r}: entries must be plain file names in the mod folder")
            if not os.path.isfile(os.path.join(src_dir, rel)):
                raise SystemExit(f"{MOD_FILE} lists {rel} but the file is missing")
    return info


def install(src_dir, mods_dir=None):
    info = load_mod_info(src_dir)
    dest = os.path.join(mods_root_dir(mods_dir), info["name"])
    if os.path.isdir(dest):
        shutil.rmtree(dest)
    shutil.copytree(src_dir, dest, ignore=IGNORE)
    marker = write_marker(info["name"], mods_dir)
    print(f"installed mod {info['name']} {info['version']} -> {dest}")
    print(f"marker: {marker}")
    return dest


def remove(name, mods_dir=None):
    dest = os.path.join(mods_root_dir(mods_dir), name)
    if os.path.isdir(dest):
        shutil.rmtree(dest)
    remove_marker(name, mods_dir)
    print(f"removed mod {name} (folder and marker)")


def list_mods(mods_dir=None):
    markers = marker_names(mods_dir)
    folders = folder_names(mods_dir)
    for name in sorted(set(markers) | set(folders)):
        path = os.path.join(mods_root_dir(mods_dir), name, MOD_FILE)
        version = "?"
        if os.path.exists(path):
            with open(path, encoding="utf-8") as f:
                version = json.load(f).get("version", "?")
        if name in markers and name in folders:
            status = "ok"
        elif name in markers:
            status = "MARKER ONLY (folder missing, loader will skip it)"
        else:
            status = "FOLDER ONLY (no marker, the game will not list it)"
        print(f"{name} {version} {status}")
    if not markers and not folders:
        print("no mods installed")
    legacy = os.path.join(mods_root_dir(mods_dir), LEGACY_MANIFEST)
    if os.path.exists(legacy):
        print(f"note: legacy {LEGACY_MANIFEST} present; the loader only reads it when the game gives no preset list")


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
