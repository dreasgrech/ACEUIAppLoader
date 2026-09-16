#!/usr/bin/env python3
"""
post_update.py - put the package back in step after the game has been patched.

A game update invalidates two things at once. The stock files the package carries --
cohtml.js and hud.html -- are Kunos', and a patch moves them; and which record the game
picks for an override is decided against content.kspkg's whole hash set, which a patch
also changes, so the padding and the duplicate counts were measured for a game that no
longer exists. Neither failure announces itself: the package simply stops being the one
the lookup finds, and the symptom is that nothing appears.

Recovering means re-reading the stock files, re-measuring the counts, rebuilding,
reinstalling and checking the result against the packages actually installed. That is
four commands in the right order with the right flags; this is one, and it says which
parts were needed rather than doing all of them blindly.

Re-measuring costs minutes, so it only runs when something it depends on has moved: the
game build it was measured on, or the package's own file set.

Usage:
  python tools/post_update.py [--install] [--tune] [--no-tune] [--release]

  --install   install the rebuilt package as well as building it
  --tune      re-measure even when nothing looks like it moved
  --no-tune   never re-measure; build with what dups.json already records
  --release   for a stock install rather than for this machine's mods folder
"""
import json
import os
import shutil
import sys

import _repos
import build_loader as bl
import pack_kspkg as pk
import tune_dups

_repos.add_internals_to_path()
import lookup_sim  # noqa: E402

KNOWN_FLAGS = {"--install", "--tune", "--no-tune", "--release"}


def recorded(mode, book=None):
    """
    What dups.json holds for one mode, or {}.

    Unlike build_loader.recorded_dups this is allowed to find nothing, because finding
    nothing is one of the answers it is asked for: no measurement is a reason to take one.
    """
    book = book or bl.DUPS_FILE
    if not os.path.exists(book):
        return {}
    with open(book, encoding="utf-8") as f:
        book = json.load(f)
    if "fingerprint" in book:              # the single-mode file this replaced
        book = {"release" if book.get("release") else "machine": book}
    return book.get(mode) or {}


def fingerprint_of(build_dir, targets):
    files, dirs = pk.collect(build_dir)
    return pk.paths_fingerprint([rel for rel, _ in files] + list(dirs), targets)


def overridden_base_files(file_hashes, base):
    """
    The distinct base files a package overrides.

    Distinct matters. A package that carries duplicate records for an override repeats that
    hash once per record, so counting records reports ACEDOOM's single bank as 32 overrides
    -- and would report 31 of them surviving as a pass while the real one had lost.
    """
    return sorted({h for h in file_hashes if h in base})


def installed_verdict(targets):
    """
    Replay the lookup over the packages actually in the mods folder.

    This is the check the build cannot do for itself: it plans against what is installed,
    but only once the file has been copied in is the real set known, and only then can the
    question "does our record win" be asked of the thing on disk rather than of a plan.

    Every package is checked, not just ours. A patch changes the hash set every override
    was measured against, so another package of ours -- ACEDOOM overrides gui.bank -- can
    lose on the same patch, and it loses just as quietly.

    Returns (names in load order, [(label, still ours, detail)]), where `still ours` is
    None for a package that overrides nothing and so has nothing it could lose.
    """
    mods = _repos.mods_dir()
    ours = os.path.basename(bl.OUT)
    base = set(lookup_sim.read_base_hashes(lookup_sim.find_base_package()))
    names = lookup_sim.scan_order([n for n in os.listdir(mods)
                                   if n.lower().endswith(".kspkg")
                                   and os.path.isfile(os.path.join(mods, n))])
    packages = [(n, lookup_sim.read_base_hashes(os.path.join(mods, n))) for n in names]
    vector = lookup_sim.merged(sorted(base), packages)

    rows = []
    for target in targets:
        winner = lookup_sim.resolve(vector, [pk.path_hash(target)])[pk.path_hash(target)]
        rows.append((pk.normalize(target), winner == ours, winner))
    for name, _, file_hashes in pk.installed_packages(mods, ours):
        overrides = overridden_base_files(file_hashes, base)
        if not overrides:
            rows.append((name, None, "adds only new paths, nothing it could lose"))
            continue
        owners = lookup_sim.resolve(vector, overrides)
        kept = sum(1 for h in overrides if owners[h] == name)
        rows.append((name, kept == len(overrides),
                     f"{kept} of {len(overrides)} override(s) still resolve to it"))
    return names, rows


def main(argv):
    unknown = sorted(a for a in argv if a not in KNOWN_FLAGS)
    if unknown:
        print(__doc__)
        raise SystemExit("unknown option(s): " + ", ".join(unknown))
    if "--tune" in argv and "--no-tune" in argv:
        raise SystemExit("--tune and --no-tune ask for opposite things")
    release = "--release" in argv
    mode = "release" if release else "machine"
    targets = list(bl.TARGETS)

    version = bl.game_version()
    was = recorded(mode)
    print(f"game installed now: {version or 'unknown'}")
    print(f"dups.json [{mode}]: {was.get('dups', '-')} record(s) per override, measured on "
          f"game {was.get('game') or 'unknown'} for package {was.get('fingerprint', '-')}")

    # Rebuild first. It re-extracts the stock files from the patched content.kspkg, which is
    # also how a changed hud.html is caught: assemble_page refuses a page it does not
    # recognise rather than shipping last version's copy of it.
    build = bl.assemble(with_apps=True, with_host=True)
    now = fingerprint_of(build, targets)
    moved = now != was.get("fingerprint")
    # A measurement with no game recorded predates this tool; that is not evidence the game
    # moved, so it is not a reason to spend the minutes. An explicit --tune still is.
    aged = bool(was.get("game")) and bool(version) and was["game"] != version
    print(f"package file set: {now} ({'changed' if moved else 'unchanged'})")
    if aged:
        print(f"the measurement was taken on game {was['game']}, which is not the one running")

    tune = "--tune" in argv or moved or aged or not was
    if "--no-tune" in argv:
        tune = False
    if tune:
        print("\nre-measuring the duplicate count for "
              f"{'a stock install' if release else 'this machine'} (minutes, not seconds)...")
        chosen = tune_dups.tune(build, targets, tune_dups.DEFAULT_CANDIDATES,
                                tune_dups.DEFAULT_SCENARIOS, release=release)
        print(f"wrote {tune_dups.record(chosen, mode)} [{mode}]\n")
    else:
        print("nothing that decides the counts has moved; keeping the recorded measurement\n")

    # Read it back through the build's own validator rather than trusting what was just
    # written: it re-checks the fingerprint, which is what catches a measurement taken
    # against a different build than the one about to be packed.
    dups = bl.recorded_dups(build, targets, release=release)
    temporary = []
    mods_dir = bl.release_mods_dir(temporary) if release else None
    if release:
        print("release build: padding planned for a stock install, not this machine's mods folder")
    try:
        written = pk.pack(build, bl.OUT, dups=dups, dup_targets=targets if dups > 1 else [],
                          mods_dir=mods_dir)
        pk.verify(bl.OUT, written, dups=dups, dup_targets=targets if dups > 1 else [])
    finally:
        for path in temporary:
            shutil.rmtree(path, ignore_errors=True)

    if "--install" not in argv:
        print("\nbuilt but not installed; re-run with --install when you are ready")
        return 0

    dest = os.path.join(_repos.mods_dir(), os.path.basename(bl.OUT))
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    shutil.copyfile(bl.OUT, dest)
    print(f"installed {dest}")
    if release:
        print("NOTE: this one is padded for a stock install, so another package you have may "
              "stop overriding. Re-run without --release afterwards.")

    names, rows = installed_verdict(targets)
    print(f"\npackages installed: {', '.join(names)}")
    lost = []
    for label, ok, detail in rows:
        if ok is None:                      # a package with no base file to lose
            print(f"   {label:<34} {detail}")
            continue
        if not ok:
            lost.append(label)
        print(f"   {label:<34} -> {detail}{'' if ok else '   <- LOST'}")
    if not lost:
        print("\nEvery override in the folder still resolves to the package that means it. "
              "Launch the game, then python tools/check_ingame_log.py to confirm it where it counts.")
        return 0
    if any(label.startswith("uiresources") for label in lost):
        print("\nA way into the page lost. --tune is the first thing to try; if a re-measured "
              "build still loses, what to re-check against this game build is the lookup model "
              "itself, not the count.")
    other = [label for label in lost if not label.startswith("uiresources")]
    if other:
        print(f"\nAnother package lost its override: {', '.join(other)}. Each package plans its "
              "own padding, so that one has to be rebuilt and reinstalled by its own repo's tool.")
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
