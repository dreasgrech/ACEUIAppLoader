#!/usr/bin/env python3
"""
validate_override.py - how often the shipped packages actually win, over many mod folders.

The record counts were chosen against sixty package sets, which puts the failure rate
somewhere under a few percent rather than at a number worth printing. This runs the same
question over thousands of sets, and over a realistic spread of how many mods a player has
installed, so the answer is a curve rather than a single figure: what matters is not only
"does it win" but "does it still win once someone has thirty car mods".

Two things make this different from `tune_dups.py`, which measures in order to choose:

  - it reads the **built packages** off disk and uses their real table hashes, so what is
    scored is the artifact that ships, not a reconstruction of it;
  - the population includes **real published car mods**, not only synthetic ones.

Two arms, because both are real situations:

  loader        the loader package alone among car mods
  loader+doom   ACEDOOM installed too -- a second package that overrides game files, and the
                harder case, because DOOM needs BOTH of its overrides where the loader needs
                either of its two

Results are appended to a JSONL file as they are produced, so the run can be stopped at any
time and whatever it reached is still usable. Re-running resumes: scenarios already recorded
are skipped. Nothing else is written -- no package is built, installed or modified, and the
mods folder is only read.

Usage:
  python tools/validate_override.py [--hours=N] [--target=N] [--out=<path>] [--summary]

  --hours=N     stop after this long (default 8)
  --target=N    stop after this many scenarios per arm (default 20000)
  --out=<path>  results file (default: <Saved Games>\\ACE\\validation\\override-runs.jsonl)
  --summary     read the results file and report; run nothing
"""
import hashlib
import io
import json
import os
import random
import sys
import time

import _repos
import pack_kspkg as pk

_repos.add_internals_to_path()
import lookup_sim  # noqa: E402

CAR_MOD_DIR = r"C:\Users\User\Downloads\ACEMods"
DEFAULT_HOURS = 8.0
DEFAULT_TARGET = 20000
# How many other packages a player might have. Weighted towards the plausible, with a long
# tail: the question "does it still hold at thirty" is the one nobody has answered.
MOD_COUNTS = [0, 1, 1, 2, 2, 3, 3, 4, 5, 6, 8, 10, 12, 15, 20, 25, 30]
# Sizes drawn from the four real car mods measured on 2026-09-17: 369-803 table entries.
SYNTHETIC_MIN, SYNTHETIC_MAX = 350, 820
SEED = 20260917

LOADER_PKG = os.path.join(_repos.REPO, "dist", "ACEUIModLoader.kspkg")
DOOM_PKG = os.path.join(os.path.dirname(_repos.REPO), "ACEDOOM", "dist",
                        "ACEUIModLoaderMods-doom.kspkg")
LOADER_TARGETS = ("uiresources/js/cohtml.js", "uiresources/hud.html")
DOOM_TARGETS = ("content/sfx/gui.bank", "system/gui_events.table")


def default_out():
    return os.path.join(os.path.dirname(_repos.mods_dir()), "validation", "override-runs.jsonl")


def load_real_car_mods():
    """[(name, hashes)] for every published car mod on disk, or [] if the folder is absent."""
    out = []
    if not os.path.isdir(CAR_MOD_DIR):
        return out
    for folder in sorted(os.listdir(CAR_MOD_DIR)):
        here = os.path.join(CAR_MOD_DIR, folder)
        if not os.path.isdir(here):
            continue
        for name in sorted(os.listdir(here)):
            if name.lower().endswith(".kspkg"):
                out.append((name, lookup_sim.read_base_hashes(os.path.join(here, name))))
    return out


def synthetic(rng):
    """A car mod that is not real but is shaped like one, with a name that sorts anywhere.

    The first character matters more than the rest: load order is by upper-cased name, and
    a package that sorts before ours is added before it. A population of names that all sort
    one side of "ACEUIModLoader.kspkg" would only ever measure half the problem.
    """
    first = rng.choice("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_-")
    name = first + "".join(rng.choice("abcdefghijklmnopqrstuvwxyz0123456789_") for _ in range(7))
    size = rng.randrange(SYNTHETIC_MIN, SYNTHETIC_MAX)
    return name + ".kspkg", sorted(rng.getrandbits(64) for _ in range(size))


def scenario(rng, real):
    """The other packages installed alongside ours: some real, the rest shaped like them."""
    count = rng.choice(MOD_COUNTS)
    chosen = rng.sample(real, min(count, len(real))) if real else []
    while len(chosen) < count:
        chosen.append(synthetic(rng))
    return chosen


def wins(base, vector_packages, targets, package_name, require):
    vector = lookup_sim.merged(base, vector_packages)
    got = []
    for target in targets:
        at = lookup_sim.lower_bound(vector, pk.path_hash(target))
        got.append(at < len(vector) and vector[at][1] == package_name)
    return (all(got) if require == "all" else any(got)), got


def fingerprint(path):
    with io.open(path, "rb") as f:
        return hashlib.md5(f.read()).hexdigest()[:12]


def stamp(out_path, packages, game):
    """
    Record which artifacts a results file belongs to, and refuse to mix two.

    Results are appended across runs, so a rebuild between runs would quietly blend
    measurements of two different packages into one number -- which is the same class of
    mistake as scoring one build and shipping another, and it is invisible afterwards.
    """
    meta_path = out_path + ".meta.json"
    now = {"packages": packages, "game": game, "seed": SEED}
    if os.path.exists(meta_path):
        with io.open(meta_path, encoding="utf-8") as f:
            was = json.load(f)
        if was.get("packages") != packages:
            raise SystemExit(
                "this results file was produced for different packages:\n"
                + f"  recorded: {was.get('packages')}\n"
                + f"  now:      {packages}\n"
                + "Start a new file with --out=<path>, or delete the old one. Appending would "
                  "average two different builds into one number.")
        return
    with io.open(meta_path, "w", encoding="utf-8", newline="\n") as f:
        json.dump(now, f, indent=2, sort_keys=True)
        f.write("\n")


def run(out_path, hours, target):
    for path, what in ((LOADER_PKG, "the loader package"), (DOOM_PKG, "ACEDOOM's package")):
        if not os.path.isfile(path):
            raise SystemExit(f"{what} is not built: {path}\nBuild it first; this scores the "
                             "artifact that ships, not a reconstruction of it.")
    base_pkg = lookup_sim.find_base_package()
    if not base_pkg:
        raise SystemExit("content.kspkg not found; this needs the installed game")

    base = lookup_sim.read_base_hashes(base_pkg)
    loader = (os.path.basename(LOADER_PKG), lookup_sim.read_base_hashes(LOADER_PKG))
    doom = (os.path.basename(DOOM_PKG), lookup_sim.read_base_hashes(DOOM_PKG))
    real = load_real_car_mods()

    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    stamp(out_path, {os.path.basename(LOADER_PKG): fingerprint(LOADER_PKG),
                     os.path.basename(DOOM_PKG): fingerprint(DOOM_PKG)},
          os.path.basename(base_pkg))
    done = 0
    if os.path.exists(out_path):
        with io.open(out_path, encoding="utf-8") as f:
            done = sum(1 for line in f if line.strip())
    print(f"base {os.path.basename(base_pkg)}: {len(base)} entries")
    print(f"ours: {loader[0]} ({len(loader[1])} entries), {doom[0]} ({len(doom[1])} entries)")
    print(f"real car mods: {len(real)}" + (" (" + ", ".join(n for n, _ in real) + ")" if real else ""))
    print(f"results: {out_path}" + (f"  (resuming, {done} already done)" if done else ""))
    print(f"stopping after {hours} h or {target} scenarios per arm\n")

    rng = random.Random(SEED)
    for _ in range(done):                       # replay the stream so a resume does not repeat
        scenario(rng, real)

    deadline = time.time() + hours * 3600
    started = time.time()
    written = 0
    with io.open(out_path, "a", encoding="utf-8", newline="\n") as f:
        while done + written < target and time.time() < deadline:
            others = scenario(rng, real)
            row = {"n": len(others), "real": sum(1 for n, _ in others if any(n == r for r, _ in real))}

            packages = [loader] + list(others)
            packages.sort(key=lambda p: p[0].upper())
            row["loader"], row["loader_each"] = wins(base, packages, LOADER_TARGETS, loader[0], "any")

            packages = [loader, doom] + list(others)
            packages.sort(key=lambda p: p[0].upper())
            ok_l, each_l = wins(base, packages, LOADER_TARGETS, loader[0], "any")
            ok_d, each_d = wins(base, packages, DOOM_TARGETS, doom[0], "all")
            row["both_loader"], row["both_loader_each"] = ok_l, each_l
            row["both_doom"], row["both_doom_each"] = ok_d, each_d

            f.write(json.dumps(row) + "\n")
            f.flush()
            os.fsync(f.fileno())
            written += 1

            if written % 25 == 0:
                spent = time.time() - started
                rate = spent / written
                left = min(target - done - written, int((deadline - time.time()) / rate))
                print(f"  {done + written:>6} scenarios  {rate:4.2f} s each  "
                      f"~{left * rate / 3600:4.1f} h to go", flush=True)

    print(f"\nwrote {written} scenario(s) this run; {done + written} in total")
    return summarise(out_path)


def summarise(out_path):
    rows = []
    with io.open(out_path, encoding="utf-8") as f:
        for line in f:
            if line.strip():
                rows.append(json.loads(line))
    if not rows:
        print("no results yet")
        return 0

    def rate(subset, key):
        if not subset:
            return None
        return 100.0 * sum(1 for r in subset if r[key]) / len(subset)

    print(f"\n{len(rows)} scenarios, {sum(r['real'] for r in rows)} real car mod installs among them\n")
    print(f"{'other packages':<16}{'n':>7}{'loader alone':>15}{'loader+doom':>14}{'doom':>9}")
    buckets = [(0, 0), (1, 2), (3, 5), (6, 10), (11, 20), (21, 30)]
    for low, high in buckets:
        subset = [r for r in rows if low <= r["n"] <= high]
        if not subset:
            continue
        label = f"{low}" if low == high else f"{low}-{high}"
        print(f"{label:<16}{len(subset):>7}{rate(subset, 'loader'):>14.2f}%"
              f"{rate(subset, 'both_loader'):>13.2f}%{rate(subset, 'both_doom'):>8.2f}%")
    print(f"{'ALL':<16}{len(rows):>7}{rate(rows, 'loader'):>14.2f}%"
          f"{rate(rows, 'both_loader'):>13.2f}%{rate(rows, 'both_doom'):>8.2f}%")

    # Per target, not just per package. A scenario only counts as a loss when EVERY way in
    # failed, so reporting "all the losses were total losses" says nothing -- it is the
    # definition. What is worth knowing is how reliable each override is ON ITS OWN, because
    # that is what says whether the redundancy is doing any work.
    print()
    for arm, key, targets, require in (("loader", "loader_each", LOADER_TARGETS, "any"),
                                       ("doom", "both_doom_each", DOOM_TARGETS, "all")):
        each = [sum(1 for r in rows if not r[key][i]) for i in range(len(targets))]
        together = sum(1 for r in rows if not any(r[key]))
        print(f"{arm}: needs {'all' if require == 'all' else 'either'} of its overrides")
        for name, count in zip(targets, each):
            print(f"    {name:<28} lost {count:>5}   {100.0 * count / len(rows):5.2f}% on its own")
        if require == "any":
            expected = len(rows)
            for count in each:
                expected *= count / len(rows)
            print(f"    {'BOTH at once':<28} lost {together:>5}   {100.0 * together / len(rows):5.3f}%"
                  f"   (independence would predict {expected:.1f})")
        else:
            failed = sum(1 for r in rows if not all(r[key]))
            print(f"    {'package failed':<28}      {failed:>5}   {100.0 * failed / len(rows):5.2f}%"
                  f"   -- needing both ADDS the two risks together")
        print()
    return 0


def main(argv):
    known = {"--summary"}
    valued = ("--hours=", "--target=", "--out=")
    unknown = sorted(a for a in argv if a not in known and not a.startswith(valued))
    if unknown:
        print(__doc__)
        raise SystemExit("unknown option(s): " + ", ".join(unknown))
    out = next((a.split("=", 1)[1] for a in argv if a.startswith("--out=")), default_out())
    if "--summary" in argv:
        if not os.path.exists(out):
            raise SystemExit(f"no results at {out}")
        return summarise(out)
    hours = float(next((a.split("=", 1)[1] for a in argv if a.startswith("--hours=")), DEFAULT_HOURS))
    target = int(next((a.split("=", 1)[1] for a in argv if a.startswith("--target=")), DEFAULT_TARGET))
    return run(out, hours, target)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
