#!/usr/bin/env python3
"""
install_app.py - install (or remove) a loose UI app for the ACEUIAppLoader.

An app is a folder containing `app.json` plus the files it lists; the folder's name is
the app's name (a legacy `src/` folder needs a "name" key). Installing copies
the folder to `<ACE>/mods/uiresources/ACEUIAppLoader/<name>/` and writes the
EMPTY marker file `<ACE>/Video/ACEUIAppLoader-<name>.settingspreset`. The game
lists that folder for the UI (video settings presets), which is how the loader
discovers installed apps without any registry. A release zip of an app contains
exactly these two things, laid out relative to `Saved Games/ACE`.

The marker must be empty: the game deserialises every listed file, and an empty
file is a valid default message. No packaging, no padding, no manifest.

Usage:
  python tools/install_app.py <app folder>          install / update
  python tools/install_app.py --remove <name>       remove folder and marker
  python tools/install_app.py --list

Environment: ACE_MODS_DIR overrides the game's mods folder (its parent is <ACE>).
"""
import json
import os
import re
import shutil
import sys

import _repos

APPS_SUBDIR = os.path.join("uiresources", "ACEUIAppLoader")
MARKER_DIR = "Video"
MARKER_PREFIX = "ACEUIAppLoader-"
MARKER_EXT = ".settingspreset"
APP_FILE = "app.json"
# "developer": a tool rather than something a player installed for fun; the app drawer
# keeps those behind its own switch. Must match appkit.KNOWN_KEYS (a test checks).
KNOWN_KEYS = {"name", "version", "title", "pages", "scripts", "styles", "files", "root", "developer"}
LEGACY_MANIFEST = "manifest.json"
# Where apps have lived before, newest first: (root under the mods folder, marker prefix).
# The loader reads none of these, so a copy left at one is invisible rather than broken --
# which is worse, because nothing says why the app is missing. Installing and removing both
# clear every one. 0.21.0 renamed mod -> app, 0.22.0 renamed the loader itself; neither was
# released, but this machine ran both. See docs/naming.md.
LEGACY_LAYOUTS = (
    (os.path.join("uiresources", "ACEUIModLoaderApps"), "ACEUIModLoaderApps-"),   # 0.21.0
    (os.path.join("uiresources", "ACEUIModLoaderMods"), "ACEUIModLoaderMods-"),   # before that
)
NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]*$")
IGNORE = shutil.ignore_patterns("__pycache__", "*.swp", "*~", ".*")


def apps_root_dir(mods_dir=None):
    return os.path.join(mods_dir or _repos.mods_dir(), APPS_SUBDIR)


def legacy_root_dirs(mods_dir=None):
    root = mods_dir or _repos.mods_dir()
    return [os.path.join(root, sub) for sub, _ in LEGACY_LAYOUTS]


def ace_dir(mods_dir=None):
    """`Saved Games/ACE`: the parent of the mods folder."""
    return os.path.dirname(os.path.abspath(mods_dir or _repos.mods_dir()))


def marker_dir(mods_dir=None):
    return os.path.join(ace_dir(mods_dir), MARKER_DIR)


def marker_path(name, mods_dir=None):
    return os.path.join(marker_dir(mods_dir), MARKER_PREFIX + name + MARKER_EXT)


def check_name(name):
    if not NAME_RE.match(name or ""):
        raise SystemExit(f"app name {name!r} must be letters, digits, '_', '.', '-' (it becomes a file name)")
    if name != name.lower():
        # the loader accepts it; the test kit every app runs does not, so say so here rather
        # than let the two disagree in silence
        print(f"WARNING: app name {name!r} has upper-case letters; the test kit requires lower case ({name.lower()!r})")
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
    """App names that have a marker, as the game would list them; non-empty markers are reported."""
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
    root = apps_root_dir(mods_dir)
    if not os.path.isdir(root):
        return []
    return sorted(n for n in os.listdir(root) if os.path.isdir(os.path.join(root, n)))


def load_app_info(src_dir):
    path = os.path.join(src_dir, APP_FILE)
    if not os.path.exists(path):
        raise SystemExit(f"{src_dir} has no {APP_FILE}")
    with open(path, encoding="utf-8") as f:
        info = json.load(f)
    if not info.get("version"):
        raise SystemExit(f"{APP_FILE}: missing 'version'")
    folder = os.path.basename(os.path.abspath(src_dir))
    info["name"] = check_name(info.get("name") or folder)
    if folder != info["name"] and folder != "src":
        raise SystemExit(f"{APP_FILE} names the app {info['name']!r} but the folder is {folder!r}; they must match")
    unknown = sorted(set(info) - KNOWN_KEYS)
    if unknown:
        raise SystemExit(f"{APP_FILE}: unknown key(s) {unknown}; known: {sorted(KNOWN_KEYS)}")
    for key in ("scripts", "styles", "files"):
        for rel in info.get(key, []):
            if os.path.basename(rel) != rel or not rel:
                raise SystemExit(f"{APP_FILE} lists {rel!r}: entries must be plain file names in the app folder")
            if not os.path.isfile(os.path.join(src_dir, rel)):
                raise SystemExit(f"{APP_FILE} lists {rel} but the file is missing")
    return info


def clear_legacy(name, mods_dir=None):
    """Delete this app's folder and marker at every layout we used to use."""
    gone = []
    root = mods_dir or _repos.mods_dir()
    for sub, prefix in LEGACY_LAYOUTS:
        old_dir = os.path.join(root, sub, name)
        if os.path.isdir(old_dir):
            shutil.rmtree(old_dir)
            gone.append(old_dir)
        old_marker = os.path.join(marker_dir(mods_dir), prefix + name + MARKER_EXT)
        if os.path.exists(old_marker):
            os.remove(old_marker)
            gone.append(old_marker)
    return gone


def install(src_dir, mods_dir=None):
    info = load_app_info(src_dir)
    dest = os.path.join(apps_root_dir(mods_dir), info["name"])
    if os.path.isdir(dest):
        shutil.rmtree(dest)
    shutil.copytree(src_dir, dest, ignore=IGNORE)
    marker = write_marker(info["name"], mods_dir)
    print(f"installed app {info['name']} {info['version']} -> {dest}")
    print(f"marker: {marker}")
    for path in clear_legacy(info["name"], mods_dir):
        print(f"removed an older copy: {path}")
    return dest


def remove(name, mods_dir=None):
    dest = os.path.join(apps_root_dir(mods_dir), name)
    if os.path.isdir(dest):
        shutil.rmtree(dest)
    remove_marker(name, mods_dir)
    for path in clear_legacy(name, mods_dir):
        print(f"removed an older copy: {path}")
    print(f"removed app {name} (folder and marker)")


def list_apps(mods_dir=None):
    markers = marker_names(mods_dir)
    folders = folder_names(mods_dir)
    for name in sorted(set(markers) | set(folders)):
        path = os.path.join(apps_root_dir(mods_dir), name, APP_FILE)
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
        print("no apps installed")
    for old_root in legacy_root_dirs(mods_dir):
        if not os.path.isdir(old_root):
            continue
        left = sorted(d for d in os.listdir(old_root) if os.path.isdir(os.path.join(old_root, d)))
        if left:
            print(f"note: {len(left)} app(s) still at an older path ({', '.join(left)});")
            print(f"      the loader ignores {old_root} -- install each one again to clear it")
    legacy = os.path.join(apps_root_dir(mods_dir), LEGACY_MANIFEST)
    if os.path.exists(legacy):
        print(f"note: stale {LEGACY_MANIFEST} present; the loader ignores it, you can delete it")


if __name__ == "__main__":
    argv = sys.argv[1:]
    if argv and argv[0] == "--list":
        list_apps()
    elif len(argv) == 2 and argv[0] == "--remove":
        remove(argv[1])
    elif len(argv) == 1 and not argv[0].startswith("--"):
        install(argv[0])
    else:
        print(__doc__)
        sys.exit(1)
