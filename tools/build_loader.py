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
  python tools/build_loader.py [--install] [--no-verify] [--no-apps] [--no-host]
                               [--release] [--dups=N|auto]

  --install   copy the result into the game's mods folder
  --no-verify skip re-reading the package to check every entry against its source
  --no-apps   build the library alone, without the developer apps in apps/
  --no-host   leave out the cohtml.js override, so the HUD page is the only way in
  --release   plan the padding for a STOCK install instead of this machine's mods
              folder -- what a package other people will install has to be built for
  --dups=N    write N table records for each override instead of one, so the game's
              merged vector holds N of ours against the base package's single record.
              `auto` reads the measurement in dups.json. See pack_kspkg.py for why this
              matters and tune_dups.py for why N has to be measured rather than chosen.
"""
import json
import os
import shutil
import sys
import tempfile

import _repos
import install_mod

_repos.add_internals_to_path()
import kspkg  # noqa: E402
import pack_kspkg as pk  # noqa: E402

HOST_PATH = "uiresources/js/cohtml.js"
# The second way in. Every stock page loads cohtml.js, and the page itself is a file in
# content.kspkg too, so overriding it is a SECOND, independent tie for the same library --
# and the script it adds sits at a new path, which always resolves whatever the merged
# layout turns out to be. The loader runs if either tie falls our way.
PAGE_PATH = "uiresources/hud.html"
BOOT_PATH = "uiresources/ACEUIModLoaderApps/loader.js"
PAGE_ANCHOR = "<script src='js/cohtml.js'></script>"
PAGE_TAG = "<script src='ACEUIModLoaderApps/loader.js'></script>"
TARGETS = (HOST_PATH, PAGE_PATH)   # the overrides that carry duplicate records
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
DUPS_FILE = os.path.join(_repos.REPO, "dups.json")


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


def assemble_page(build_dir, base_pkg, sources):
    """
    Our copy of the stock HUD page plus the library at a new path.

    The page is Kunos' own, byte for byte, with one script tag added, so it has to be
    re-extracted for every game version: if the stock page changes and we serve last
    version's copy, the whole HUD breaks rather than merely failing to load the loader.
    The anchor check below is what makes that a build failure instead of a launch one.

    The library copy is wrapped in a guard because both ways in can win at once, and
    loading it twice would register every mod twice. cohtml.js runs first (the page loads
    it above our tag), so when that tie went our way this file does nothing at all.
    """
    stock = kspkg.extract(base_pkg, PAGE_PATH).decode("utf-8")
    if PAGE_ANCHOR not in stock:
        raise SystemExit(f"stock {PAGE_PATH} no longer contains {PAGE_ANCHOR!r}; "
                         f"the page changed in this game version -- re-check before building")
    # Match the page's own line ending: the stock file is entirely CRLF, and a lone LF in
    # the middle of it would be the one byte that is not Kunos'.
    eol = "\r\n" if "\r\n" in stock else "\n"
    page = stock.replace(PAGE_ANCHOR, PAGE_ANCHOR + eol + "    " + PAGE_TAG, 1)
    target = os.path.join(build_dir, *PAGE_PATH.split("/"))
    os.makedirs(os.path.dirname(target), exist_ok=True)
    with open(target, "w", encoding="utf-8", newline="") as f:
        f.write(page)

    boot = os.path.join(build_dir, *BOOT_PATH.split("/"))
    os.makedirs(os.path.dirname(boot), exist_ok=True)
    with open(boot, "w", encoding="utf-8", newline="\n") as f:
        f.write("/* ACEUIModLoader %s -- the library, loaded by our copy of hud.html.\n"
                "   Does nothing when the cohtml.js override already won its tie. */\n"
                "(function () {\n    if (window.ACEUIModLoader) { return; }\n" % read_version())
        for name, text in sources:
            f.write(marker(name))
            f.write(text)
        f.write("\n}());\n")
    print(f"assembled {PAGE_PATH}: stock {len(stock)} bytes + one script tag, "
          f"and {BOOT_PATH} ({len(sources)} library files, guarded)")


def assemble(build_dir=BUILD_DIR, game_dir=None, with_apps=True, with_host=True):
    """
    Build the package tree. `with_host=False` leaves out the cohtml.js override, so the
    HUD page is the only way in -- which is how that route gets tested on its own. With
    both present the page route never has to carry anything, because cohtml.js runs first
    and wins far more often than not.
    """
    base_pkg = os.path.join(game_dir or _repos.game_dir(), "content.kspkg")
    if not os.path.exists(base_pkg):
        raise SystemExit(f"content.kspkg not found at {base_pkg} (set ACE_GAME_DIR)")
    sources = library_sources()

    if os.path.isdir(build_dir):
        shutil.rmtree(build_dir)
    if with_host:
        stock = kspkg.extract(base_pkg, HOST_PATH)
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
    else:
        print(f"NOT assembling {HOST_PATH}: the HUD page is the only way in for this build")

    assemble_page(build_dir, base_pkg, sources)

    if with_apps:
        copy_apps(build_dir)

    return build_dir


def release_mods_dir(stack):
    """
    An empty folder to plan the padding against, for a package other people will install.

    A normal build plans against THIS machine's mods folder, so the layout it picks is the
    one that keeps the packages you happen to have installed working. A stranger has a
    different set -- usually none -- and a package tuned for your folder is tuned for a
    world they are not in. A release is therefore planned for a stock install: content.kspkg
    and our file, nothing else.
    """
    empty = tempfile.mkdtemp(prefix="ace-release-")
    stack.append(empty)
    return empty


def recorded_dups(build_dir, targets, release=False):
    """
    The duplicate count tools/tune_dups.py measured for THIS file set.

    A tuning is only valid for the package it was measured against -- which counts win
    depends on the whole hash set -- so a mismatched fingerprint is a build failure
    rather than a silent fallback to an arbitrary number.
    """
    mode = "release" if release else "machine"
    retune = f"run python tools/tune_dups.py{' --release' if release else ''} --write"
    if not os.path.exists(DUPS_FILE):
        raise SystemExit(f"--dups=auto needs {DUPS_FILE}: {retune}")
    with open(DUPS_FILE, encoding="utf-8") as f:
        recorded = json.load(f).get(mode)
    if not recorded:
        raise SystemExit(f"{DUPS_FILE} has no '{mode}' measurement: {retune}")
    files, dirs = pk.collect(build_dir)
    want = pk.paths_fingerprint([rel for rel, _ in files] + list(dirs), targets)
    if recorded.get("fingerprint") != want:
        raise SystemExit(f"{DUPS_FILE} [{mode}] was measured for a different package "
                         f"({recorded.get('fingerprint')} != {want}); {retune}")
    print(f"duplicates: {recorded['dups']} per override, measured for "
          f"{'a stock install' if release else 'this machine'} "
          f"({recorded.get('unseen', '?')}/{recorded['scenarios']} unseen package sets)")
    return int(recorded["dups"])


KNOWN_FLAGS = {"--install", "--no-verify", "--no-apps", "--no-host", "--release"}
VALUED_FLAGS = ("--dups=",)


if __name__ == "__main__":
    flags = set(sys.argv[1:])
    # A typo'd flag must not look like success: --instal used to build the package and
    # quietly not install it, which reads exactly like a build that worked.
    unknown = sorted(f for f in flags if f not in KNOWN_FLAGS and not f.startswith(VALUED_FLAGS))
    if unknown:
        print(__doc__)
        raise SystemExit("unknown option(s): " + ", ".join(unknown))
    # argv, not the set: given --dups=16 --dups=32 the set would pick one arbitrarily, and
    # this option decides the whole construction.
    given = [a.split("=", 1)[1] for a in sys.argv[1:] if a.startswith("--dups=")]
    if len(set(given)) > 1:
        raise SystemExit("--dups given more than once: " + ", ".join(sorted(set(given))))
    asked = given[0] if given else "1"
    if asked != "auto" and not asked.isdigit():
        raise SystemExit(f"--dups takes a whole number or 'auto', not {asked!r}")
    with_host = "--no-host" not in flags
    release = "--release" in flags
    temporary = []
    build = assemble(with_apps="--no-apps" not in flags, with_host=with_host)
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    # The overrides this build actually carries, which is also what a recorded measurement
    # has to have been taken for -- a --no-host build has only the page.
    wanted = list(TARGETS) if with_host else [PAGE_PATH]
    dups = recorded_dups(build, wanted, release=release) if asked == "auto" else int(asked)
    targets = wanted if dups > 1 else []
    mods_dir = release_mods_dir(temporary) if release else None
    if release:
        print("release build: padding planned for a stock install, not this machine's mods folder")
    try:
        written = pk.pack(build, OUT, dups=dups, dup_targets=targets, mods_dir=mods_dir)
        if "--no-verify" not in flags:
            pk.verify(OUT, written, dups=dups, dup_targets=targets)
    finally:
        for path in temporary:
            shutil.rmtree(path, ignore_errors=True)
    if release and "--install" in flags:
        print("NOTE: installing a release build here; it is padded for a stock install, so any "
              "other package you have may stop overriding. Rebuild without --release afterwards.")
    if "--install" in flags:
        dest = os.path.join(_repos.mods_dir(), os.path.basename(OUT))
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        shutil.copyfile(OUT, dest)
        print(f"installed {dest}")
