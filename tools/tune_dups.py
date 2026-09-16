#!/usr/bin/env python3
"""
tune_dups.py - choose how many table records the package's overrides should carry.

The game resolves an overridden path by taking the first record with that hash out of
one merged, unstably-sorted vector. content.kspkg is added first, so its record starts
at a lower index than ours, and the partition that gathers equal hashes moves
lower-indexed equals to the front -- which is what lower_bound returns. That bias is why
a single override wins only about half the time once the player installs anything else.

Extra records (pack_kspkg --dups) give the override several places in that equal run.
The count is NOT a dial: measured against a population of plausible package sets, 32, 64
and 96 behave well while 48 and 256 are an order of magnitude worse, because certain
counts make our hash set couple the entry points together so they fail on the same
scenarios. The good values depend on the package's whole hash set, so they change
whenever the package gains or loses a file -- which is what the fingerprint below is for.

This scores each candidate count against synthetic car-mod packages (plus whatever is
really installed) and writes the winner to dups.json, which build_loader.py --dups=auto
reads and refuses to use once the package's file set has moved on.

Usage:
  python tools/tune_dups.py [--scenarios=N] [--candidates=8,16,32] [--write]

  --scenarios   package sets to score each candidate against (default 24)
  --candidates  duplicate counts to try (default 1,16,32,64,96,128)
  --write       write dups.json; without it this only reports
  --release     measure for a STOCK install: empty mods folder, no local packages
"""
import io
import json
import os
import random
import shutil
import sys
import tempfile
import time

import _repos
import build_loader
import pack_kspkg as pk

_repos.add_internals_to_path()
import lookup_sim  # noqa: E402

OUT_FILE = os.path.join(_repos.REPO, "dups.json")
DEFAULT_CANDIDATES = (1, 16, 32, 64, 96, 128)
DEFAULT_SCENARIOS = 24


def population(installed, count, seed=20260916):
    """
    Package sets to score against: synthetic car mods, sized and named like the real ones
    (both of the ones we have hold only new paths, 369 and 776 entries), with whatever is
    actually installed mixed into some of them.
    """
    rng = random.Random(seed)
    sets = []
    for _ in range(count):
        others = []
        for _ in range(rng.randrange(1, 7)):
            size = rng.randrange(250, 1200)
            others.append(("%s%d.kspkg" % (rng.choice("0ABKMTZz"), rng.randrange(10 ** 7)),
                           [rng.getrandbits(64) for _ in range(size)]))
        for name, hashes in installed:
            if rng.random() < 0.5:
                others.append((name, hashes))
        sets.append(others)
    return sets


def score(base, our_hashes, target_hashes, sets, package_name):
    """How many of the package sets leave at least one override resolving to us."""
    wins = 0
    per = [0] * len(target_hashes)
    for others in sets:
        packages = [(package_name, our_hashes)] + list(others)
        packages.sort(key=lambda p: p[0].upper())
        vector = lookup_sim.merged(base, packages)
        got = []
        for i, h in enumerate(target_hashes):
            at = lookup_sim.lower_bound(vector, h)
            won = at < len(vector) and vector[at][0] == h and vector[at][1] == package_name
            per[i] += 1 if won else 0
            got.append(won)
        if any(got):
            wins += 1
    return wins, per


def confirm_against_a_real_build(build_dir, targets, dups, scored, game_dir, mods_dir):
    """
    Pack for real and check the hash set that was scored is the one that gets written.

    Worth the two seconds: a tuning that plans one package and scores another is exactly
    the bug that shipped a build whose report said another mod kept its override when in
    game it had lost. A prediction about a package nobody built is worse than none.
    """
    with tempfile.TemporaryDirectory() as tmp:
        out = os.path.join(tmp, os.path.basename(build_loader.OUT))
        quiet = io.StringIO()
        stdout, sys.stdout = sys.stdout, quiet
        try:
            pk.pack(build_dir, out, game_dir=game_dir, mods_dir=mods_dir,
                    dups=dups, dup_targets=targets)
        finally:
            sys.stdout = stdout
        written = lookup_sim.read_base_hashes(out)
    if sorted(written) != sorted(scored):
        raise SystemExit(f"tuning scored {len(scored)} records but a real build writes "
                         f"{len(written)}; the two are not planning the same package")
    print(f"confirmed against a real build: {len(written)} records, identical hash set")


def candidate_hashes(mod_paths, targets, dups, pad_paths):
    hashes = [pk.path_hash(p) for p in mod_paths] + [pk.path_hash(p) for p in pad_paths]
    for target in targets:
        hashes += [pk.path_hash(target)] * (dups - 1)
    return hashes


def tune(build_dir, targets, candidates, scenarios, game_dir=None, mods_dir=None, release=False):
    base_pkg = lookup_sim.find_base_package(game_dir)
    if not base_pkg:
        raise SystemExit("content.kspkg not found; tuning needs the installed game (set ACE_GAME_DIR)")
    base = lookup_sim.read_base_hashes(base_pkg)
    files, dirs = pk.collect(build_dir)
    targets = [pk.normalize(t) for t in targets]
    package_name = os.path.basename(build_loader.OUT)
    # Resolve this exactly as pack() does, and use the same value for the padding search:
    # planning against a different set of installed packages produces a different layout,
    # and then the count would be scored against a package the build will not write.
    # A release is measured for a stock install: an empty folder to plan padding against,
    # and a population with none of THIS machine's packages in it.
    # `scratch` is the only thing this function is ever allowed to delete. In a non-release
    # run `mods_dir` is the player's real mods folder, so it must never be handed to rmtree.
    scratch = tempfile.mkdtemp(prefix="ace-release-") if release else None
    mods_dir = scratch or mods_dir or pk.default_mods_dir()
    installed = [] if release else [(name, hashes) for name, hashes, _
                                    in pk.installed_packages(mods_dir, package_name)]
    try:
        return _tune(build_dir, targets, candidates, scenarios, game_dir, mods_dir, release,
                     base, base_pkg, files, dirs, package_name, installed)
    finally:
        if scratch:
            shutil.rmtree(scratch, ignore_errors=True)


def _tune(build_dir, targets, candidates, scenarios, game_dir, mods_dir, release,
          base, base_pkg, files, dirs, package_name, installed):
    # Three populations. Selection needs a big enough sample to be stable -- picking the
    # argmax of a single 60-set population chose a count that scored 90% on fresh data when
    # another candidate scored 98% -- so two populations are pooled to choose with, and a
    # third is never looked at until the winner is decided. That last number is the estimate
    # to trust, because nothing was selected on it.
    select_a = population(installed, scenarios, seed=20260916)
    select_b = population(installed, scenarios, seed=1618033)
    holdout = population(installed, scenarios, seed=27182818)
    print(f"base {os.path.basename(base_pkg)} ({len(base)} entries), "
          f"{len(files)} files, {len(targets)} override target(s), "
          f"{scenarios} package set(s) per population, {len(installed)} installed alongside")

    target_hashes = [pk.path_hash(t) for t in targets]
    results = []
    for dups in candidates:
        started = time.time()
        extra_dirs = [pk.DECOY_PARENT] if dups > 1 else []
        pad_paths, _ = pk.plan_padding(files, dirs + extra_dirs, game_dir, mods_dir, package_name,
                                       dups=dups, dup_targets=targets)
        paths = [rel for rel, _ in files] + list(dirs) + extra_dirs
        hashes = candidate_hashes(paths, targets, dups, pad_paths)
        a, per = score(base, hashes, target_hashes, select_a, package_name)
        b, _ = score(base, hashes, target_hashes, select_b, package_name)
        results.append((a + b, dups, len(pad_paths), hashes))
        print("  %4d record(s): %3d/%-3d selection sets %6.1f%%   padding %-3d  (%.0fs)"
              % (dups, a + b, 2 * scenarios, 100.0 * (a + b) / (2 * scenarios),
                 len(pad_paths), time.time() - started))

    results.sort(key=lambda r: (-r[0], r[1]))
    chosen, dups, pads, hashes = results[0]
    held, _ = score(base, hashes, target_hashes, holdout, package_name)
    print(f"\nchosen on {2 * scenarios} selection sets: {dups} record(s) per override "
          f"-> {held}/{scenarios} ({100.0 * held / scenarios:.1f}%) on the held-out population")
    if dups == 1:
        print("  (no duplicate count beat a plain build here)")
    confirm_against_a_real_build(build_dir, targets, dups, hashes, game_dir, mods_dir)
    return {"dups": dups, "targets": targets, "scenarios": scenarios, "release": release,
            "selection": chosen, "selection_sets": 2 * scenarios, "unseen": held,
            "fingerprint": pk.paths_fingerprint([rel for rel, _ in files] + list(dirs), targets)}


if __name__ == "__main__":
    flags = {a for a in sys.argv[1:] if a.startswith("--")}
    scenarios = int(next((a.split("=", 1)[1] for a in flags if a.startswith("--scenarios=")),
                         DEFAULT_SCENARIOS))
    raw = next((a.split("=", 1)[1] for a in flags if a.startswith("--candidates=")), None)
    candidates = tuple(int(x) for x in raw.split(",")) if raw else DEFAULT_CANDIDATES
    build = build_loader.assemble()
    chosen = tune(build, list(build_loader.TARGETS), candidates, scenarios,
                  release="--release" in flags)
    mode = "release" if "--release" in flags else "machine"
    if "--write" in flags:
        # Both modes live in one file under their own key: a release is measured for a stock
        # install and a local build for this machine's mods folder, and switching between them
        # should not mean re-measuring the other.
        recorded = {}
        if os.path.exists(OUT_FILE):
            with open(OUT_FILE, encoding="utf-8") as f:
                recorded = json.load(f)
            if "fingerprint" in recorded:      # the single-mode file this replaced
                recorded = {"release" if recorded.get("release") else "machine": recorded}
        recorded[mode] = chosen
        with open(OUT_FILE, "w", encoding="utf-8", newline="\n") as f:
            json.dump(recorded, f, indent=2, sort_keys=True)
            f.write("\n")
        print(f"wrote {OUT_FILE} [{mode}]")
    else:
        print(json.dumps({mode: chosen}, indent=2))
        print("(re-run with --write to record this for build_loader.py --dups=auto)")
