# Working on the loader

Everything the README leaves out, for anyone building the loader rather than installing it.
Installing is one file in a folder; this is the rest.

[`writing-a-app.md`](writing-a-app.md) is the guide to writing an app against the library --
that needs none of this, because an app is loose files and no build step.

## Commands

Needs Python 3.12, the game installed, and [`ACEGameInternals`](https://github.com/dreasgrech/ACEGameInternals) checked out next to this repo — the tools import its package reader and its replay of the game's file lookup. The browser tests need Edge or Chrome and are skipped without one.

```
python tools/build_loader.py --dups=auto --install   # build and install for this machine
python tools/build_loader.py --dups=auto --release   # build for someone else's stock install
python tools/tune_dups.py --write                    # re-measure after the package gains a file
python tools/install_app.py <repo>/<name>            # install a loose app and write its marker
python tools/check_ingame_log.py                     # after a launch: what loaded, what failed
python tools/post_update.py --install                # after the game has been patched
python tools/repad.py                                # after installing or removing another package mod
```

**`--release` matters more than it looks.** A normal build plans its override against *your* mods folder, so it is tuned to keep the packages you happen to have installed working. Somebody else has a different set, usually none. A package other people will install has to be built for a stock install, which is what that flag does.

**After a game patch, run `post_update.py`.** A patch moves the stock files the package carries and changes the hash set the override is measured against, so the package quietly stops being the one the game picks and the symptom is that nothing appears. That tool rebuilds, re-measures when something it depends on has moved, reinstalls, and then replays the lookup over the packages actually in your mods folder to say whether both ways in still resolve to it.

**`--dups=auto` reads a measurement, not a constant.** How many table records the overrides carry is chosen by `tune_dups.py` and recorded in `dups.json` behind a fingerprint of the package's file set; the build refuses to use a measurement taken for a different set. Why any of that is necessary is [`docs/how-it-works.md`](docs/how-it-works.md).

**Another package mod can take your override away.** Padding is chosen against everything installed when a package is built, so installing or removing one can make another stop winning, silently. `repad.py` replays the lookup over the whole mods folder, rebuilds whichever packages lost, and repeats until they all resolve or nothing improves. It needs a registry beside the mods folder saying how to rebuild each one, because the padding lives in each package's own repo — run it once to see the format.

## Tests

```
python tools/run_tests.py          # this repo and every app under apps/
python tools/run_tests.py lib      # this repo alone
```

The browser cases run in a headless Edge or Chrome with its own throwaway profile, and the runner kills the process tree afterwards — a hard rule here, because a leaked headless browser is invisible and holds the profile directory for ever.

## Layout

```
VERSION                    loader and library version; ACEUIAppLoader.core.js must agree (tested)
dups.json                  how many records each override carries, measured, per build mode
src/                       the library, one namespace per file; LIB_ORDER in build_loader.py is the load order
apps/<name>/               a developer app shipped inside the package, laid out as its own repo was
tools/
  build_loader.py          assembles the library into the package and packs it
  tune_dups.py             measures how many records the overrides need
  pack_kspkg.py            writes a .kspkg, with the padding and duplicate records that win the lookup
  install_app.py           installs a loose app folder and writes its empty marker
  new_app.py               scaffolds an app repo
  appkit.py                the shared test kit every app's suite subclasses
  headless.py              runs an HTML harness in a headless browser and reads its report
  check_ingame_log.py      reads the newest game log and says what the loader did
  post_update.py           rebuild, re-measure, reinstall and re-check after a game patch
  repad.py                 rebuild whichever installed packages have lost their override
  run_tests.py             this repo's suite plus each app's, one subprocess each
  absorb_app.py            one-off git surgery: move an app repo into apps/ with its history
tests/
  lib/                     harness pages, test doubles, and the fixtures the loader is tested against
docs/                      see below
```

## Style

No classes, no `this`, no `var`, no arrow functions, no function declarations. One self-invoking module per file assigned onto the namespace, four-space indent, double quotes, braces on every `if`. The test kit enforces it on every app and on `src/` — see [`docs/style.md`](docs/style.md).
