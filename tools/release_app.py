#!/usr/bin/env python3
"""
release_app.py - the download for one UI app: a zip laid out as the contents of `Saved Games\\ACE`.

  python tools/release_app.py <repo>/<name> [--skip-tests] [--allow-dirty]

writes `<repo>/dist/<repo name>-<version>.zip` holding exactly what install_app.py puts on
disk, so a player installs an app the way they installed the loader -- drag the folders out
of the zip into `Saved Games\\ACE`, merge:

    mods/uiresources/ACEUIAppLoader/<name>/app.json      and the files app.json lists
    Video/ACEUIAppLoader-<name>.settingspreset           the marker, 0 bytes

Both halves are in the zip because both are needed: the marker is how the game tells the
loader the app exists, and it must stay EMPTY (the game reads every file in that folder as
a preset). The app.json is read through install_app.load_app_info, so an app that would
not install does not zip either. Entry timestamps are pinned (release.py), so the zip's
checksum depends on its contents alone.

Before zipping it refuses a dirty tree in the app's repo and runs the app's own tests, the
same gates release.py puts on the loader.
"""
import io
import os
import subprocess
import sys

import install_app
import release

KNOWN_FLAGS = {"--skip-tests", "--allow-dirty"}


def entries(app_dir):
    """[(published path, bytes)] for an app folder: the listed files under the loose root, then the empty marker."""
    info = install_app.load_app_info(app_dir)
    name = info["name"]
    root = release.ZIP_APPS_DIR + "/" + name + "/"
    files = [install_app.APP_FILE]
    for key in ("scripts", "styles", "files"):
        files.extend(info.get(key, []))
    out = []
    for rel in files:
        with io.open(os.path.join(app_dir, rel), "rb") as f:
            out.append((root + rel, f.read()))
    marker = install_app.MARKER_DIR + "/" + install_app.MARKER_PREFIX + name + install_app.MARKER_EXT
    out.append((marker, b""))
    return info, out


def zip_app(app_dir, dest):
    """Write the release zip for the app in `app_dir`; returns (info, dest)."""
    info, items = entries(app_dir)
    release.write_zip(dest, items)
    return info, dest


def release_name(repo_dir, version):
    """`ACEPedalGraph-0.8.1.zip`: the repository's name and the app's version. Apps are loose
    files, so they do not depend on the game build the way the loader's package does."""
    return f"{os.path.basename(os.path.abspath(repo_dir))}-{version}.zip"


def main(argv):
    flags = {a for a in argv if a.startswith("--")}
    args = [a for a in argv if not a.startswith("--")]
    unknown = sorted(flags - KNOWN_FLAGS)
    if unknown or len(args) != 1:
        print(__doc__)
        raise SystemExit("unknown option(s): " + ", ".join(unknown) if unknown else "give one app folder")
    app_dir = os.path.abspath(args[0])
    repo = os.path.dirname(app_dir)

    dirty = subprocess.run(["git", "status", "--porcelain"], cwd=repo, capture_output=True, text=True)
    if dirty.returncode == 0 and dirty.stdout.strip() and "--allow-dirty" not in flags:
        raise SystemExit("the app's working tree is not clean; commit first (or --allow-dirty to build anyway):\n  "
                         + "\n  ".join(dirty.stdout.splitlines()))

    if "--skip-tests" not in flags and os.path.isdir(os.path.join(repo, "tests")):
        print("running the app's suite...", flush=True)
        tests = subprocess.run([sys.executable, "-m", "unittest", "discover", "-s", "tests"], cwd=repo)
        if tests.returncode != 0:
            raise SystemExit("tests failed; not building a release from this tree")

    info = install_app.load_app_info(app_dir)
    dest = os.path.join(repo, "dist", release_name(repo, info["version"]))
    zip_app(app_dir, dest)
    print(f"\nrelease: {dest} ({os.path.getsize(dest) // 1024} KB)")
    print(f"sha256:  {release.sha256(dest)}")
    print("inside:  " + ", ".join(path for path, _ in entries(app_dir)[1]))
    print("next: extract it into Saved Games\\ACE here (merge), launch once, python tools/check_ingame_log.py")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
