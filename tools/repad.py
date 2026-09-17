#!/usr/bin/env python3
"""
repad.py - rebuild whichever installed packages have lost their override.

A package wins the file lookup with padding and duplicate records chosen against the hash
set of everything installed *at the time it was built*. Install or remove another package
and that set changes, so a package built for yesterday's folder can quietly stop winning.
Nothing announces it: the file simply resolves to the game's copy and the mod looks broken.

`post_update.py` already reports this. Repairing it is what this does, and it cannot be one
build, because the padding lives in each package's own repo -- so this needs to be told how
to rebuild each one. That is the registry, a JSON file beside the mods folder:

    {
      "ACEUIModLoaderMods-doom.kspkg": {
        "repo": "C:/Users/User/Documents/GitHub/ACEDOOM",
        "command": ["python", "tools/build_audio.py", "--install"]
      }
    }

Rebuilding is iterative on purpose. Each package plans against the others as they are on
disk, so repairing one changes the set the next one was planned against, and can break it.
This rebuilds, re-checks, and goes round again until every override resolves or nothing
improved -- which is the honest stopping point, because two packages can want layouts that
cannot both hold.

Usage:
  python tools/repad.py [--all] [--dry-run] [--passes=N] [--registry=<path>]

  --all         rebuild every registered package, not only the ones that have lost
  --dry-run     say what would run, run nothing
  --passes=N    give up after N rounds (default 4)
  --registry    a registry somewhere other than beside the mods folder
"""
import io
import json
import os
import subprocess
import sys

import _repos
import post_update

KNOWN_FLAGS = {"--all", "--dry-run"}
VALUED_FLAGS = ("--passes=", "--registry=")
DEFAULT_PASSES = 4


def registry_path(given=None):
    """Beside the mods folder by default: it describes this machine, not the repo."""
    if given:
        return given
    return os.path.join(os.path.dirname(_repos.mods_dir()), "repad.json")


def load_registry(path):
    if not os.path.exists(path):
        raise SystemExit(f"no registry at {path}\n" + __doc__)
    with io.open(path, encoding="utf-8") as f:
        entries = json.load(f)
    for name, entry in entries.items():
        missing = [k for k in ("repo", "command") if k not in entry]
        if missing:
            raise SystemExit(f"{path}: {name} has no {', '.join(missing)}")
        if not os.path.isdir(entry["repo"]):
            raise SystemExit(f"{path}: {name} names a repo that is not there: {entry['repo']}")
        if not isinstance(entry["command"], list) or not entry["command"]:
            raise SystemExit(f"{path}: {name} needs a command as a list of arguments")
    return entries


def losers(counts):
    """Packages with at least one override that no longer resolves to them."""
    return [name for name, (kept, total) in counts.items() if total and kept < total]


def rebuild(name, entry, dry_run):
    where = entry["repo"]
    command = list(entry["command"])
    print(f"  {name}: {' '.join(command)}   (in {where})")
    if dry_run:
        return True
    done = subprocess.run(command, cwd=where)
    if done.returncode != 0:
        print(f"  {name}: FAILED with exit {done.returncode}")
        return False
    return True


def main(argv):
    unknown = sorted(a for a in argv if a not in KNOWN_FLAGS and not a.startswith(VALUED_FLAGS))
    if unknown:
        print(__doc__)
        raise SystemExit("unknown option(s): " + ", ".join(unknown))
    given = [a.split("=", 1)[1] for a in argv if a.startswith("--passes=")]
    if given and not given[0].isdigit():
        raise SystemExit(f"--passes takes a whole number, not {given[0]!r}")
    passes = int(given[0]) if given else DEFAULT_PASSES
    dry_run = "--dry-run" in argv
    registry = load_registry(registry_path(
        next((a.split("=", 1)[1] for a in argv if a.startswith("--registry=")), None)))

    names, counts = post_update.survey()
    print(f"{len(names)} package(s) installed, {len(registry)} registered")
    for name in names:
        kept, total = counts[name]
        state = "nothing to lose" if not total else f"{kept} of {total} override(s) resolve to it"
        print(f"   {name:<38} {state}{'' if kept == total else '   <- LOST'}")

    wanted = list(registry) if "--all" in argv else losers(counts)
    unknown_names = [n for n in wanted if n not in registry]
    if unknown_names:
        raise SystemExit("\nlost, but not in the registry, so there is no way to rebuild them: "
                         + ", ".join(unknown_names))
    if not wanted:
        print("\nNothing to repad.")
        return 0

    for round_number in range(1, passes + 1):
        print(f"\npass {round_number}: rebuilding {len(wanted)} package(s)")
        for name in wanted:
            if not rebuild(name, registry[name], dry_run):
                return 1
        if dry_run:
            print("\n(dry run: nothing was rebuilt, so nothing is re-checked)")
            return 0
        _, counts = post_update.survey()
        still = losers(counts)
        if not still:
            print("\nEvery override in the folder resolves to the package that means it.")
            return 0
        if set(still) == set(wanted) and round_number > 1:
            print(f"\nNo better than the last pass: {', '.join(still)} still lose.")
            print("Two packages may want layouts that cannot both hold; the way out is to "
                  "give one of them a name that loads later, or to drop one.")
            return 1
        missing = [n for n in still if n not in registry]
        if missing:
            print(f"\n{', '.join(missing)} lost and cannot be rebuilt from here (not registered).")
            return 1
        wanted = still

    print(f"\nStill losing after {passes} pass(es): {', '.join(losers(counts))}")
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
