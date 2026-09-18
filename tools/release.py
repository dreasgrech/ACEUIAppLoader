#!/usr/bin/env python3
"""
release.py - build the package other people will install, and nothing else by mistake.

The package on this machine is tuned for THIS mods folder (build_loader.py without
--release plans the padding against the packages installed here, and dups.json records a
different count for it). `dist/ACEUIAppLoader.kspkg` is whatever build ran last, so a
release taken from there can be the wrong one without anything saying so. This does the
release build the one right way and names the result so it cannot be mistaken:

  1. refuses a dirty working tree (a release is a commit, not a moment);
  2. runs every test suite (tools/run_tests.py);
  3. builds with --release --dups=auto, which plans for a stock install and refuses a
     duplicate-count measurement taken for another file set;
  4. copies the verified package to dist/ACEUIAppLoader-<version>-<game build>.kspkg and
     prints its SHA-256.

Then, before uploading: install that same file here, launch once, and run
check_ingame_log.py; the log should carry no "Text transformation" and no "alignItems"
warnings (docs/building.md, Releasing).

Usage:
  python tools/release.py [--skip-tests] [--allow-dirty]
"""
import hashlib
import os
import shutil
import subprocess
import sys

import _repos
import build_loader as bl

KNOWN_FLAGS = {"--skip-tests", "--allow-dirty"}


def dirty_files():
    """Paths git reports as modified or untracked, or [] when the tree is clean."""
    out = subprocess.run(["git", "status", "--porcelain"], cwd=_repos.REPO, capture_output=True, text=True)
    if out.returncode != 0:
        raise SystemExit("git status failed: " + out.stderr.strip())
    return [line for line in out.stdout.splitlines() if line.strip()]


def release_name(version, game):
    """`ACEUIAppLoader-0.24.0-0.9.1+release.6.kspkg`: the loader version and the game build it was made for."""
    return f"ACEUIAppLoader-{version}-{game or 'unknown-game'}.kspkg"


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

    print("\nbuilding for a stock install...", flush=True)
    build = subprocess.run([sys.executable, os.path.join(_repos.REPO, "tools", "build_loader.py"),
                            "--release", "--dups=auto"], cwd=_repos.REPO)
    if build.returncode != 0:
        raise SystemExit("the release build failed")

    version = bl.read_version()
    game = bl.game_version()
    dest = os.path.join(os.path.dirname(bl.OUT), release_name(version, game))
    shutil.copyfile(bl.OUT, dest)
    print(f"\nrelease: {dest}")
    print(f"sha256:  {sha256(dest)}")
    print("next: install this same file here, launch once, python tools/check_ingame_log.py")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
