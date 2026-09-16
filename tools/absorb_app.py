#!/usr/bin/env python3
"""
absorb_app.py - move a mod repo into this one as `apps/<name>/`, history and all.

The developer apps (dev console, capabilities probe, profiler) ship with the loader
rather than as three loose downloads; see docs/developer-apps.md. This is the one-off
git surgery per app, written down so it is reviewable before it runs and identical for
all three.

What it does, in the app's own repo and in a scratch clone of it:

  1. git clone <app repo> <scratch>
  2. git filter-repo --to-subdirectory-filter apps/<name> --tag-rename ":<name>/"
     Every historical commit is rewritten to record `apps/<name>/...` paths, so
     `git log -- apps/<name>` reaches the first commit with no rename in the middle and
     `git blame` needs no --follow. Commit *authors* are untouched: this rewrites paths
     and hashes, not identity. The tag rename keeps three sets of v0.x.y apart.
  3. git merge --allow-unrelated-histories, into a branch of this repo.

The result has two root commits, which is normal: the repo's history and the app's are
both there, joined at the merge.

It never pushes, and it makes exactly one commit (the merge) in this repo, under
whatever `git config user.name/user.email` says -- run it yourself so that is you.

Usage:
  python tools/absorb_app.py <app repo>            print the commands, run nothing
  python tools/absorb_app.py <app repo> --run      run them, stopping at the first error
  python tools/absorb_app.py <app repo> --name x   the mod name, if it is not the one
                                                   folder with a mod.json in the repo
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile

import _repos

MOD_FILE = "mod.json"
APPS_DIR = "apps"
BRANCH_PREFIX = "absorb-"
REMOTE_SUFFIX = "-absorb"


def run(cmd, cwd, capture=False):
    """One git command. Raises SystemExit on a non-zero status, so nothing runs after a failure."""
    if capture:
        out = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True)
        if out.returncode:
            raise SystemExit("failed in %s: %s\n%s" % (cwd, " ".join(cmd), out.stderr.strip()))
        return out.stdout.strip()
    print("  %s> %s" % (cwd, " ".join(cmd)))
    if subprocess.run(cmd, cwd=cwd).returncode:
        raise SystemExit("failed: " + " ".join(cmd))
    return ""


def git_out(cmd, cwd):
    """A git command whose output is wanted and whose failure is not fatal (returns "")."""
    out = subprocess.run(["git"] + cmd, cwd=cwd, capture_output=True, text=True)
    return out.stdout.strip() if out.returncode == 0 else ""


def mod_name(repo):
    """The mod's name: the one folder in the repo holding a mod.json. It becomes apps/<name>."""
    found = [d for d in sorted(os.listdir(repo))
             if os.path.isdir(os.path.join(repo, d)) and os.path.isfile(os.path.join(repo, d, MOD_FILE))]
    if len(found) != 1:
        raise SystemExit("expected exactly one folder with %s in %s, found %s" % (MOD_FILE, repo, found))
    with open(os.path.join(repo, found[0], MOD_FILE), encoding="utf-8") as f:
        info = json.load(f)
    return info.get("name") or found[0]


def check(repo, name):
    """Everything that has to be true before any of this is worth starting."""
    problems = []

    if not os.path.isdir(os.path.join(repo, ".git")):
        problems.append("%s is not a git repository" % repo)
    if git_out(["status", "--porcelain"], repo):
        problems.append("%s has uncommitted changes" % repo)

    # Only work under apps/<name>/ can be clobbered: that is the whole of what the merge
    # brings in. Uncommitted work elsewhere in this repo is untouched by it and stays
    # uncommitted afterwards, so it is reported rather than refused.
    here = git_out(["status", "--porcelain"], _repos.REPO)
    incoming = APPS_DIR + "/" + name + "/"
    clash = [l for l in here.splitlines() if l[3:].strip('"').startswith(incoming)]
    if clash:
        problems.append("%s has uncommitted changes where the app is going:\n    %s"
                        % (_repos.REPO, "\n    ".join(clash)))

    # commits that are not on GitHub would be absorbed here and then lost when the repo
    # is archived, which is a quiet way to lose work
    ahead = git_out(["log", "--oneline", "@{u}.."], repo)
    if ahead:
        problems.append("%s has commits that are not pushed:\n    %s" % (repo, ahead.replace("\n", "\n    ")))

    if subprocess.run(["git", "filter-repo", "--version"], capture_output=True).returncode:
        problems.append("git-filter-repo is not installed (pip install git-filter-repo)")

    dest = os.path.join(_repos.REPO, APPS_DIR, name)
    if os.path.exists(dest):
        problems.append("%s already exists" % dest)

    if problems:
        raise SystemExit("cannot absorb %s:\n- %s" % (repo, "\n- ".join(problems)))

    if here:
        print("note: %s has uncommitted work elsewhere; the merge does not touch it\n" % _repos.REPO)


def plan(repo, name):
    """The steps, as (working directory, argv) pairs, so --run and the dry run cannot drift."""
    scratch = os.path.join(tempfile.gettempdir(), "ace-absorb-" + name)
    branch = git_out(["symbolic-ref", "--short", "HEAD"], repo) or "main"
    here = _repos.REPO
    remote = name + REMOTE_SUFFIX

    return scratch, [
        (os.path.dirname(scratch), ["git", "clone", repo, scratch]),
        (scratch, ["git", "filter-repo", "--force",
                   "--to-subdirectory-filter", APPS_DIR + "/" + name,
                   "--tag-rename", ":" + name + "/"]),
        (here, ["git", "checkout", "-b", BRANCH_PREFIX + name]),
        (here, ["git", "remote", "add", remote, scratch]),
        (here, ["git", "fetch", remote]),
        (here, ["git", "merge", "--allow-unrelated-histories", "--no-edit",
                "-m", "absorb %s as %s/%s" % (os.path.basename(repo), APPS_DIR, name),
                remote + "/" + branch]),
        (here, ["git", "remote", "remove", remote]),
    ]


def report(name):
    """What to look at afterwards; the history is the whole point, so it is worth checking."""
    print("")
    print("then check, in %s:" % _repos.REPO)
    print("  git log --oneline -- %s/%s | tail -3        <- reaches the app's first commit" % (APPS_DIR, name))
    print("  git log --format=\"%%an <%%ae>\" -- %s/%s | sort -u   <- only your identity" % (APPS_DIR, name))
    print("  git blame %s/%s/<a file>                    <- crosses the merge" % (APPS_DIR, name))
    print("")
    print("and then, in this repo: delete %s/%s/.gitignore (this repo already has one)," % (APPS_DIR, name))
    print("run python tools/run_tests.py, and commit that as the follow-up.")


if __name__ == "__main__":
    argv = [a for a in sys.argv[1:] if not a.startswith("--")]
    flags = [a for a in sys.argv[1:] if a.startswith("--")]
    named = [a.split("=", 1)[1] for a in flags if a.startswith("--name=")]

    if len(argv) != 1:
        print(__doc__)
        sys.exit(1)

    app_repo = os.path.abspath(argv[0])
    app_name = named[0] if named else mod_name(app_repo)
    scratch_dir, steps = plan(app_repo, app_name)

    if "--run" not in flags:
        print("absorb %s as %s/%s -- these are the commands, nothing has run:\n" % (app_repo, APPS_DIR, app_name))
        for cwd, cmd in steps:
            print("  %s> %s" % (cwd, " ".join(cmd)))
        report(app_name)
        print("\nrun it with --run once you are happy with the above.")
        sys.exit(0)

    check(app_repo, app_name)

    if os.path.isdir(scratch_dir):
        shutil.rmtree(scratch_dir)

    for cwd, cmd in steps:
        run(cmd, cwd)

    print("\nabsorbed %s as %s/%s on branch %s%s" % (app_repo, APPS_DIR, app_name, BRANCH_PREFIX, app_name))
    report(app_name)
