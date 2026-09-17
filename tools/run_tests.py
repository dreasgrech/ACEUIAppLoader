#!/usr/bin/env python3
"""
run_tests.py - the loader's own suite plus every bundled app's, in one command.

`python -m unittest discover` cannot do this on its own: the apps each have a
`tests/test_app.py`, and three files of the same name in directories that are not
packages collide on module name -- unittest imports the first and reports the rest as
errors. So each suite runs in its own subprocess, with its own repo root as the working
directory, exactly as it did when the app was its own repository.

Usage:
  python tools/run_tests.py             the library and every app under apps/
  python tools/run_tests.py <name> ...  only these apps (use "lib" for the library)
  python tools/run_tests.py --list      what would run
"""
import os
import subprocess
import sys

import _repos

APPS_DIR = os.path.join(_repos.REPO, "apps")
LIB = "lib"


def suites():
    """[(label, working directory)]: the library first, then each app that has tests."""
    out = [(LIB, _repos.REPO)]
    if os.path.isdir(APPS_DIR):
        for name in sorted(os.listdir(APPS_DIR)):
            app = os.path.join(APPS_DIR, name)
            if os.path.isdir(os.path.join(app, "tests")):
                out.append((name, app))
    return out


def run(label, cwd):
    print("\n=== %s (%s) ===" % (label, cwd), flush=True)
    return subprocess.run([sys.executable, "-m", "unittest", "discover", "-s", "tests", "-v"],
                          cwd=cwd).returncode == 0


if __name__ == "__main__":
    wanted = [a for a in sys.argv[1:] if not a.startswith("--")]
    chosen = [s for s in suites() if not wanted or s[0] in wanted]

    if "--list" in sys.argv[1:]:
        for label, cwd in chosen:
            print("%-14s %s" % (label, cwd))
        sys.exit(0)

    if not chosen:
        raise SystemExit("nothing to run; known: " + ", ".join(label for label, _ in suites()))

    failed = [label for label, cwd in chosen if not run(label, cwd)]

    print("\n%d suite(s) run, %d failed%s" % (len(chosen), len(failed),
                                              (": " + ", ".join(failed)) if failed else ""))
    sys.exit(1 if failed else 0)
