# Developer apps in the loader -- investigation

**Decided and done, 2026-09-16, in loader 0.19.0.** All three were absorbed with their
history (`tools/absorb_app.py`) and now ship inside the package: `apps/capabilities` 0.3.0,
`apps/devconsole` 0.11.0, `apps/profiler` 0.10.0. Their repos are archived rather than
deleted. What follows is the investigation as written before any of it, with 6b recording
what changed while building it.

Written 2026-09-16, before changing anything. Question: ship the dev console, the
capabilities probe and the profiler *with* the loader -- installed as ordinary apps but
flagged as developer tools, hidden behind a switch at the bottom of the app drawer, and
exposed as part of the loader's API -- and decide how their source should be managed.

## 1. What the packaging facts allow

| Fact | Where from | What it means here |
|---|---|---|
| A kspkg is 1 MB of header + a 64 MB file table plus the blobs; ours is 69 MB | `pack_kspkg.py` format notes, `dist/` | The three apps are 254 KB of text. Bundling them costs 0.4% of a file we already ship, and takes the install from three downloads and six unzipped paths down to one package |
| **New files always resolve** -- unique hash, no duplicate, from any package | game-internals.md 3 | Bundled app files are new paths, so they add *no* override risk. The only override stays `cohtml.js` |
| The merged table is re-sorted after every package; a second package flipped a padded override in 25-70% of simulated cases | game-internals.md 3, proven launch 26 | Fewer packages is safer. Folding the dev apps into the loader package is the direction `design.md` 2 already argued for |
| **Loose files never beat packed files** | game-internals.md 3, proven, 3 launches | The one hard constraint on layout, see below |

That last one decides the design. If a bundled app lived at the existing
`uiresources\ACEUIModLoaderMods\profiler\`, then `install_mod.py profiler` would go on
copying files the game would never serve again -- the packed copy wins for ever. The apps
hardest to iterate on would be the three developer tools, and the failure is silent. So a
bundled app must not occupy a path a loose mod can occupy.

## 2. Layout

```
uiresources\ACEUIModLoaderApps\<name>\                       inside ACEUIModLoader.kspkg, no marker
mods\uiresources\ACEUIModLoaderMods\<name>\ + Video\ACEUIModLoaderMods-<name>.settingspreset
```

Discovery gains a second source. The built-in names are compiled into the loader (it ships
them, so it knows them); the marker list keeps finding loose mods exactly as it does today.
**A loose mod of the same name wins**, and the loader says so in the log:

    [ACEUIModLoader] profiler: loose copy overrides the bundled 0.9.0

which is the whole development loop preserved -- `install_mod.py profiler`, reload, and you
are testing your working copy against a shipped loader.

Two side benefits fall out: built-ins need no `.settingspreset` marker, so they load even
when the preset answer never arrives (the `PRESET_TIMEOUT_MS` path, which today loads
nothing at all), and a bundled app cannot be half-installed -- the "MARKER ONLY / FOLDER
ONLY" states `install_mod.py --list` reports do not exist for it.

The cost, said out loud: a bundled app can no longer be *uninstalled*. It can only be
switched off. That is the right trade for developer tools and the wrong one for anything a
player would want gone, which is why nothing player-facing moves.

## 3. The `developer` flag

A key in `mod.json`, not a list of three names inside the loader:

```json
{ "version": "0.9.0", "title": "ACE UI Profiler", "developer": true }
```

added to `KNOWN_KEYS` in both `modkit.py` and `install_mod.py`, so anyone's mod can set it
and a loose developer tool behaves like a bundled one. The drawer grows a footer row with a
switch, stored beside the app switches.

**It has to be a master switch, not a filter.** The rule settled in 0.18.0 is that an app
on the screen must be reachable in the drawer -- that was the point of making a panel's
close button call `me.show(false)`. A filter that merely hid the rows would leave a running
profiler drawn over the HUD with its row gone: precisely the bug just fixed, reintroduced
through a different door. So switching developer apps off switches those apps off,
remembering each one's own switch and restoring it when they are shown again.

Whether to *load* a hidden developer app at all is a separate question. Recommendation:
load them, hide the rows. Lazy loading is possible -- `loadMod` already does everything
needed and could run on demand -- but it breaks the drawer's build-once-from-a-complete-list
contract and changes what `ready()` means, to save a quarter of a megabyte of script that
costs nothing while detached: no root mounted, no frame loop, no listeners.

## 4. What "part of the API" actually buys

Not access -- a loose mod can already put itself on a global and be called. What bundling
buys is **guaranteed presence**: the loader can depend on these three, and so can anyone
writing against a known loader version.

One registry rather than three names:

```js
ACEUIModLoader.apps.register("profiler", { mark: mark, report: report });
ACEUIModLoader.apps.get("profiler");
ACEUIModLoader.apps.has("profiler");
ACEUIModLoader.apps.names();
```

- `ACEUIModLoader.console` is already the console-hook module, so the dev console could not
  have taken that name anyway. A registry sidesteps the collision question entirely and is
  open to third-party mods, which a hardcoded trio is not.
- The coupling already exists in one direction: the sampler reads mod names off the
  callbacks `ACEUIModLoader.loop` schedules. Bundling makes the other direction legitimate
  -- the library handing its own timings to a profiler it knows is there, rather than the
  profiler monkey-patching to find them. It keeps the patching for the *stock* page, which
  is the only way to see that.
- The caveat to document: guaranteed for the loader version that shipped it. A mod should
  still ask `apps.has("profiler")`, because a player may be on an older loader, or a loose
  override may have replaced it.

## 5. Source management

| Option | Reproducible build from this repo alone | Ceremony | Repos stay independently releasable |
|---|---|---|---|
| **Submodules** at `apps/<name>` | yes, pinned by commit | a pointer bump per app release | yes |
| Subtree merge (vendored with history) | yes | pushing changes back upstream | in principle |
| Sibling checkouts, like `ACEGameInternals` | no -- builds whatever is checked out | none | yes |
| Absorb: move the three in, archive the repos | yes | none; one version, one test run | no |

Sibling checkouts are tempting because the precedent is right there in `_repos.py`, but a
release built from "whatever happens to be checked out" cannot answer *which version of the
profiler shipped in loader 0.19.0*. Adding a lock file to fix that is a worse submodule.

**Recommendation: submodules at `apps/<name>`**, pointing at the three existing repos, plus
an `apps.json` written at build time and committed, recording each bundled app's name,
version and source commit. The package then describes itself, `--list` can print it, and
the three repos stay publishable for anyone running an older loader.

Absorbing them is the better end state *if* they stop being independently installable --
they are the loader's own developer tools, their value is tied to the loader version, and
one maintainer bumping three submodule pointers is pure overhead. The criterion to watch:
the day a pointer bump is noise rather than information, subtree them in and archive the
repos. Submodules now lose nothing, and the move is reversible in either direction.

## 6. Directory structure once they are absorbed

```
ACEUIModLoader/
  apps/
    devconsole/
      devconsole/          <- ships: mod.json, devconsole.js, devconsole.css, protofields.js
      dev/preview.html
      tests/test_mod.py, tests/console/harness.html
      tools/gen_protofields.py
      README.md
    profiler/
      profiler/            <- ships: mod.json, profiler.js, sampler.js, profiler.css
      dev/gallery.html, dev/preview.html
      tests/test_mod.py, tests/harness.html, tests/sampler/harness.html
      README.md
    capabilities/
      capabilities/        <- ships: mod.json, capabilities.js, capabilities.css
      dev/preview.html
      tests/test_mod.py, tests/harness.html
      tools/ws_echo.py
      README.md
  src/ACEUIModLoader.*.js
  tools/*.py
  tests/lib/, tests/test_*.py
  docs/, dev/snippets/, README.md, VERSION
  build/ -> uiresources/js/cohtml.js + uiresources/ACEUIModLoaderApps/<name>/
  dist/ACEUIModLoader.kspkg
```

Each app keeps the shape it has as a repo, which is worth more than it looks. The inner
folder *is* the shipped mod and its name *is* the mod name -- `install_mod.py` and
`modkit.py` both derive it from the folder, it is what lands in the package as
`ACEUIModLoaderApps\profiler\`, and it is what you install loose to
`ACEUIModLoaderMods\profiler\` to iterate. Collapsing the two levels would ship `tests/`,
`dev/` and the README into the game unless an exclude list is invented. It is also exactly
what `git filter-repo --to-subdirectory-filter apps/<name>` produces, so nothing moves
inside the rewrite and `git log -- apps/profiler` reaches the first commit with no rename
in the middle.

The alternative -- `apps/<name>/` holding only the shipped files, with the tests and dev
pages moved into the loader's own trees -- makes `apps/` exactly what ships, at the cost of
the apps no longer being self-contained units (modkit would need a `TESTS_DIR` beside
`MOD_DIR`), a path map instead of one prefix in the history rewrite, and a manual job if an
app is ever pulled back out. Not worth it for one repeated word in a path.

## 6b. Two things that changed while building it

- **No compiled-in list of bundled apps.** The plan had a `BUILTIN` constant in the
  loader's source; what shipped is an index file, `ACEUIModLoaderApps/apps.json`, written
  by the build from the manifests in `apps/`. It cannot drift from what is actually in the
  package, `--no-apps` needs no source edit, and the harness can put its own fixture index
  next to its fixture app. The loader asks for it and for the preset list *at the same
  time*: the preset list is an engine round trip with a 1.5 s timeout behind it, and there
  is nothing to gain by making it wait on a file read.
- **The developer switch is one condition in `drawer.isVisible`**, not a pass over the
  apps. Everything already goes through that function -- `applyVisibility`, `applyStored`,
  `refreshAll`, and the loader's `enabled`, which decides whether a mod is started at all
  -- so a developer app cannot be started, shown, or recalled by its hotkey while the
  switch is off, and each app's own switch is left untouched for when it goes back on.
  The refusal that `mod().show(true)` has to report falls out of the same condition.

## 7. Work breakdown

Versions at the end of it: loader **0.19.0**, the three apps bumped, `apps.json` recording
what went in. PedalGraph and DOOM are untouched throughout.

### A. Repo surgery (git only, no code changes)

1. Commit and push all three app repos so nothing is in flight; note each head commit.
2. `pip install git-filter-repo` (not installed here; it is a single script).
3. Per app, in a scratch clone: `git filter-repo --to-subdirectory-filter apps/<name>`,
   with `--tag-rename ':<name>/'` so the three `v0.x.y` tag sets cannot collide.
4. In a branch of this repo: add each scratch clone as a remote, fetch, and
   `git merge --allow-unrelated-histories <remote>/main`.
5. Delete the three `.gitignore` files (byte-identical to this repo's) and check `build/`,
   `dist/` and `__pycache__/` are still covered.
6. Verify: `git log -- apps/profiler` reaches the first profiler commit, `git blame` on a
   moved file crosses the merge, and the working tree matches the three repos.
7. Afterwards, archive the three GitHub repos rather than deleting them, so old commit
   links and release zips keep resolving.

### B. Make them build and test where they now live

8. `tools/modkit.py`: find the loader by walking up for `tools/modkit.py` instead of
   assuming a sibling checkout (`ACE_LOADER_DIR` still overrides). Today's line resolves to
   `apps/ACEUIModLoader` and would break all three suites. Update the recipe in its
   docstring.
9. The three `tests/test_mod.py` headers adopt that lookup.
10. A test runner that walks `apps/*/tests` as well as `tests/`. `unittest discover` from
    the repo root will not do: three files named `test_mod.py` in non-package directories
    collide on module name. A small `tools/run_tests.py` running each suite in a
    subprocess is the honest fix, and it is what the README should document.
11. Green run: loader suite plus all three app suites from their new home, no behaviour
    change yet. This is the commit to stop at if anything looks wrong.

### C. The loader learns about bundled apps

12. `src/ACEUIModLoader.loader.js`: `APPS_ROOT = "ACEUIModLoaderApps/"` beside `ROOT`; a
    compiled-in `BUILTIN` name list (also the load order); an entry gains `base` and
    `builtin`; discovery merges the built-in names with the marker names, **a loose mod of
    the same name wins**, with a log line saying so; the manifest's `developer` flag is
    carried on the entry. Export `APPS_ROOT`, `BUILTIN`, and `base` per entry.
13. New `src/ACEUIModLoader.apps.js`: `register(name, api)`, `get`, `has`, `names`. Must be
    added to `LIB_ORDER` in `build_loader.py` (the build fails on an unlisted `src/` file)
    before `loader.js`, since mods register while their scripts run.
14. `tests/lib/`: a fixture app under `tests/lib/ACEUIModLoaderApps/<name>/`, and cases in
    `harness.html` for: a built-in loads with no marker, a loose mod of the same name wins
    and logs, the `developer` flag reaches the entry, and the registry.
15. `tests/test_loader_tools.py`: assert the new constants alongside the existing
    `const ROOT = ...` checks.

### D. The drawer

16. A footer row with a switch, in the drawer's inline-style idiom, persisted in its own
    HUD store (`hud_acedrawer_dev`) plus localStorage, read synchronously like the app
    switches. Default **off**.
17. Master-switch behaviour: switching developer apps off remembers each developer app's
    own switch and switches it off; switching them on restores what was remembered.
18. **`me.show(true)` on a developer app must be refused while developer apps are off**,
    with one log line. Otherwise the hotkey the loader now holds (0.18.0) would put a
    profiler on screen whose row is hidden -- the same unreachable-app bug, through a third
    door. The drawer is reachable with the mouse, so nothing is lost.
19. The "N loaded" count counts the rows actually listed, so it agrees with what is on
    screen.
20. Drawer cases in `tests/lib/harness.html`.

### E. The `developer` key, everywhere a manifest is read

21. `KNOWN_KEYS` in `tools/modkit.py` and `tools/install_mod.py`, plus whatever asserts the
    two lists agree.
22. `tools/new_mod.py`: a `--developer` flag so a scaffolded dev tool starts right.

### F. Build and package

23. `build_loader.py`: after assembling `cohtml.js`, copy each app's **manifest-listed
    files only** into `build/uiresources/ACEUIModLoaderApps/<name>/`, validated through
    `install_mod.load_mod_info` so a bundled app is held to the same manifest rules as a
    loose one; print a line per app; write `apps.json` (name, version, title, developer)
    into the build and commit a copy at the repo root as the record of what shipped.
    `--no-apps` builds a library-only package.
24. `tests/test_loader_tools.py`: the built tree holds exactly the listed files and nothing
    else; `apps.json` matches the manifests.
25. Note in the README that the package's file set has changed, so the padding is new: this
    is a rebuild and reinstall, not a hot swap.

### G. The three apps

26. `"developer": true` in each `mod.json`, versions bumped.
27. Each registers its public surface through `ACEUIModLoader.apps.register(...)`, keeping
    its existing global for anyone already using it.
28. Cases in each app's `test_mod.py` for the flag and the registration.

### H. Documentation

29. Loader README: the install section drops to one package for the dev tools; `developer`
    joins the mod.json key table; `ACEUIModLoader.apps` joins the library section; Layout
    gains `apps/`; the test command becomes the new runner.
30. Each app README: ships with the loader, install loose only to iterate on it.
31. This document: mark the decision taken and what actually shipped.

### I. In game

32. `build_loader.py --install`, then `install_mod.py --remove` for all three, so the
    bundled copies are what is actually being tested and no stale marker is left behind.
33. Check: the drawer's footer switch, developer apps off by default, the close/disable rule
    still holds, the profiler records, and `install_mod.py profiler` makes the loose copy
    win with the log line to prove it.
34. `check_ingame_log.py` clean; no browser process left behind by the headless runs.

Rollback is cheap at every point: the merge lives on a branch, and until F the three apps
still install loose exactly as they do today.
