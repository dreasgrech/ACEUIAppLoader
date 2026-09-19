#!/usr/bin/env python3
"""
release.py - build the download other people will install, and nothing else by mistake.

The package on this machine is tuned for THIS mods folder (build_loader.py without
--release plans the padding against the packages installed here, and dups.json records a
different count for it). `dist/ACEUIAppLoader.kspkg` is whatever build ran last, so a
release taken from there can be the wrong one without anything saying so. This does the
release build the one right way and wraps it the one right way:

  1. refuses a dirty working tree (a release is a commit, not a moment);
  2. runs every test suite (tools/run_tests.py);
  3. builds with --release --dups=auto, which plans for a stock install and refuses a
     duplicate-count measurement taken for another file set;
  4. writes dist/ACEUIAppLoader-<version>-<game build>.zip, laid out as the contents of
     `Saved Games\\ACE`, and prints its SHA-256; then the same again for the ALTERNATE
     package (--alternate: the same files with the other measured record count, which loses
     the game's lookup on different folders), as ...-alternate.zip:

         mods/
           ACEUIAppLoader.kspkg
           uiresources/
             ACEUIAppLoader/
               PUT APPS HERE.txt

The zip carries the version; the package inside keeps its exact name, because the padding
was planned under that name and the scan order depends on it. The apps folder is created
empty so a player sees where apps go, and the note in it says what an app download is.
Every app zip has the same root, so every download installs the same way: drag `mods`
(and, for an app, `Video`) into `Saved Games\\ACE`, merge.

Then, before uploading: install the package from that zip here, launch once, and run
check_ingame_log.py; the log should carry no "Text transformation" and no "alignItems"
warnings (docs/building.md, Releasing).

Usage:
  python tools/release.py [--skip-tests] [--allow-dirty]
"""
import hashlib
import os
import subprocess
import sys
import zipfile

import _repos
import build_loader as bl
import install_app

KNOWN_FLAGS = {"--skip-tests", "--allow-dirty"}

# Inside the zip: the game's mods folder, and the loose apps root the loader reads.
ZIP_MODS = "mods"
ZIP_PACKAGE = ZIP_MODS + "/" + os.path.basename(bl.OUT)
ZIP_APPS_DIR = ZIP_MODS + "/" + install_app.APPS_SUBDIR.replace(os.sep, "/")
ZIP_NOTE = ZIP_APPS_DIR + "/PUT APPS HERE.txt"

APPS_NOTE = """This folder is where UI apps for the ACE UI App Loader live.

You do not put anything in here by hand. Each app is its own download: a zip laid out
like this one, which you extract into Saved Games\\ACE the same way. It puts a folder in
here and a small, completely empty marker file in Saved Games\\ACE\\Video, and the app
needs BOTH to appear in the drawer. The marker is how the game tells the loader the app
exists; a folder on its own is not seen.

Apps and the loader: https://github.com/dreasgrech/ACEUIAppLoader#apps

The loader ignores this file.
"""


def dirty_files():
    """Paths git reports as modified or untracked, or [] when the tree is clean."""
    out = subprocess.run(["git", "status", "--porcelain"], cwd=_repos.REPO, capture_output=True, text=True)
    if out.returncode != 0:
        raise SystemExit("git status failed: " + out.stderr.strip())
    return [line for line in out.stdout.splitlines() if line.strip()]


def release_name(version, game, alternate=False):
    """`ACEUIAppLoader-0.24.0-0.9.1+release.6.zip`, or `...-alternate.zip`: the loader version and the game build it was made for."""
    return f"ACEUIAppLoader-{version}-{game or 'unknown-game'}{'-alternate' if alternate else ''}.zip"


# Every entry carries this timestamp, so the zip's checksum depends on its contents alone:
# two builds of the same commit give the same bytes, and a published checksum can be
# checked by anyone rebuilding from source (the package itself is reproducible already).
ZIP_TIMESTAMP = (1980, 1, 1, 0, 0, 0)


def entry(name):
    info = zipfile.ZipInfo(name, date_time=ZIP_TIMESTAMP)
    info.compress_type = zipfile.ZIP_DEFLATED
    return info


def write_zip(dest, items):
    """Write `items` = [(published path, bytes)] as a reproducible zip; returns dest. release_app.py uses it too."""
    os.makedirs(os.path.dirname(os.path.abspath(dest)), exist_ok=True)
    with zipfile.ZipFile(dest, "w", compresslevel=9) as z:
        for path, blob in items:
            z.writestr(entry(path), blob)
    return dest


def zip_release(package, dest):
    """Write the release zip around a built package; returns dest. The layout is the module's docstring."""
    with open(package, "rb") as f:
        blob = f.read()
    return write_zip(dest, [(ZIP_PACKAGE, blob), (ZIP_NOTE, APPS_NOTE.replace("\n", "\r\n"))])


def sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main(argv):
    unknown = sorted(a for a in argv if a not in KNOWN_FLAGS)
    if unknown:
        print(__doc__)
        raise SystemExit("unknown option(s): " + ", ".join(unknown))

    dirty = dirty_files()
    if dirty and "--allow-dirty" not in argv:
        raise SystemExit("the working tree is not clean; commit first (or --allow-dirty to build anyway):\n  "
                         + "\n  ".join(dirty))

    if "--skip-tests" not in argv:
        print("running every suite...", flush=True)
        tests = subprocess.run([sys.executable, os.path.join(_repos.REPO, "tools", "run_tests.py")], cwd=_repos.REPO)
        if tests.returncode != 0:
            raise SystemExit("tests failed; not building a release from this tree")

    for alternate in (False, True):
        print(f"\nbuilding the {'alternate' if alternate else 'primary'} package for a stock install...", flush=True)
        build = subprocess.run([sys.executable, os.path.join(_repos.REPO, "tools", "build_loader.py"),
                                "--alternate" if alternate else "--release", "--dups=auto"], cwd=_repos.REPO)
        if build.returncode != 0:
            raise SystemExit("the release build failed")
        dest = zip_release(bl.OUT, os.path.join(os.path.dirname(bl.OUT),
                                                release_name(bl.read_version(), bl.game_version(), alternate)))
        print(f"\nrelease: {dest} ({os.path.getsize(dest) // 1024} KB)")
        print(f"sha256:  {sha256(dest)}")
        print("inside:  " + ", ".join(zipfile.ZipFile(dest).namelist()))
    print("\nnote: dist/ACEUIAppLoader.kspkg is now the ALTERNATE build; the zips hold each package under its own name")
    print("next: extract the primary zip into Saved Games\\ACE here (merge), launch once, python tools/check_ingame_log.py")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
