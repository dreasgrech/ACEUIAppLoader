# ACE UI Mod Loader

One package that lets several UI mods coexist in Assetto Corsa EVO, the shared library those mods are built on, and the tools that build it.

**It is a single file you drop into a folder, and deleting that file puts the game back exactly as it was.** Nothing is written into the game's own install, no launcher, no script to run, no setting to change.

Loader 0.19.0, built against game version **0.9.1+release.6**. A game update needs a new build, because of how the override works.

## Installing

Put the package here:

```
Saved Games\ACE\mods\ACEUIModLoader.kspkg
```

That is the whole procedure. The developer apps are inside it, so there is nothing else to install and nothing to keep in step.

Mods are separate downloads, and each is two things a player unzips into `Saved Games\ACE`: its folder and one **empty** marker file.

```
Saved Games\ACE\
  mods\ACEUIModLoader.kspkg                            <- this repo
  mods\uiresources\ACEUIModLoaderMods\pedalgraph\      <- one folder per mod: mod.json + its files
  Video\ACEUIModLoaderMods-pedalgraph.settingspreset   <- 0-byte marker; the game lists this folder
                                                          for the UI, and the loader reads the names back
```

**If the app drawer does not slide in from the right edge of the screen**, the package lost the coin toss described in [`docs/how-it-works.md`](docs/how-it-works.md) — most likely because the game has been updated, or because another package mod is installed. Building the package against your own game (below) settles it. `python tools/check_ingame_log.py` reads the game's log and says what happened.

## What ships with it

The library every mod is written against, and three developer apps that live inside the package:

| | |
|---|---|
| **Capabilities probe** | what JavaScript can actually do inside the game's Cohtml engine — about 70 checks, answered in the real engine rather than a browser |
| **Dev console** | the game's own log, a prompt that evaluates in the page, and readable dumps of the HUD's protobuf models |
| **Profiler** | where a frame goes: animation frames, timers, events, and any work a mod names for itself |

All three are **developer apps**: the app drawer keeps them behind a `DEVELOPER APPS` switch that is off by default, because nobody installs a mod loader to look at a profiler.

Mods built on the library, each its own download: [ACEPedalGraph](https://github.com/dreasgrech/ACEPedalGraph), [ACEDOOM](https://github.com/dreasgrech/ACEDOOM), [ACEUITelemetry](https://github.com/dreasgrech/ACEUITelemetry).

## Writing a mod

A mod is one folder — `mod.json`, a script, a stylesheet — and an empty marker file. No registration step, no manifest to edit, nothing to rebuild.

```
python tools/new_mod.py <name> --title "Nice Name"
```

writes that folder, a preview page, a test harness and a test file that runs the shared kit. The script declares nothing about itself; it asks the loader who it is:

```js
const me = ACEUIModLoader.mod("mymod");

const attach = function (root) {
    const state = create(root);
    state.ui = me.panel(root, function (now) { tick(state, now); });   // panel + frame loop
    return state;
};

const detach = function (state) {
    state.ui.stop();
};

me.mount(attach, detach);
me.toggle(function () { return options.toggleKey; });   // shows and hides the app
```

[`docs/writing-a-mod.md`](docs/writing-a-mod.md) is the guide; [`docs/library.md`](docs/library.md) and [`docs/ui.md`](docs/ui.md) are the reference.

## Building it

Needs Python 3.12, the game installed, and [`ACEGameInternals`](https://github.com/dreasgrech/ACEGameInternals) checked out next to this repo — the tools import its package reader and its replay of the game's file lookup. The browser tests need Edge or Chrome and are skipped without one.

```
python tools/build_loader.py --dups=auto --install   # build and install for this machine
python tools/build_loader.py --dups=auto --release   # build for someone else's stock install
python tools/tune_dups.py --write                    # re-measure after the package gains a file
python tools/install_mod.py <repo>/<name>            # install a loose mod and write its marker
python tools/check_ingame_log.py                     # after a launch: what loaded, what failed
python tools/post_update.py --install                # after the game has been patched
```

**`--release` matters more than it looks.** A normal build plans its override against *your* mods folder, so it is tuned to keep the packages you happen to have installed working. Somebody else has a different set, usually none. A package other people will install has to be built for a stock install, which is what that flag does.

**After a game patch, run `post_update.py`.** A patch moves the stock files the package carries and changes the hash set the override is measured against, so the package quietly stops being the one the game picks and the symptom is that nothing appears. That tool rebuilds, re-measures when something it depends on has moved, reinstalls, and then replays the lookup over the packages actually in your mods folder to say whether both ways in still resolve to it.

**`--dups=auto` reads a measurement, not a constant.** How many table records the overrides carry is chosen by `tune_dups.py` and recorded in `dups.json` behind a fingerprint of the package's file set; the build refuses to use a measurement taken for a different set. Why any of that is necessary is [`docs/how-it-works.md`](docs/how-it-works.md).

## Tests

```
python tools/run_tests.py          # this repo and every app under apps/
python tools/run_tests.py lib      # this repo alone
```

The browser cases run in a headless Edge or Chrome with its own throwaway profile, and the runner kills the process tree afterwards — a hard rule here, because a leaked headless browser is invisible and holds the profile directory for ever.

## Layout

```
VERSION                    loader and library version; ACEUIModLoader.core.js must agree (tested)
dups.json                  how many records each override carries, measured, per build mode
src/                       the library, one namespace per file; LIB_ORDER in build_loader.py is the load order
apps/<name>/               a developer app shipped inside the package, laid out as its own repo was
tools/
  build_loader.py          assembles the library into the package and packs it
  tune_dups.py             measures how many records the overrides need
  pack_kspkg.py            writes a .kspkg, with the padding and duplicate records that win the lookup
  install_mod.py           installs a loose mod folder and writes its empty marker
  new_mod.py               scaffolds a mod repo
  modkit.py                the shared test kit every mod's suite subclasses
  headless.py              runs an HTML harness in a headless browser and reads its report
  check_ingame_log.py      reads the newest game log and says what the loader did
  post_update.py           rebuild, re-measure, reinstall and re-check after a game patch
  run_tests.py             this repo's suite plus each app's, one subprocess each
  absorb_app.py            one-off git surgery: move a mod repo into apps/ with its history
tests/
  lib/                     harness pages, test doubles, and the fixtures the loader is tested against
docs/                      see below
```

### Style

No classes, no `this`, no `var`, no arrow functions, no function declarations. One self-invoking module per file assigned onto the namespace, four-space indent, double quotes, braces on every `if`. The test kit enforces it on every mod and on `src/` — see [`docs/style.md`](docs/style.md).

## Documentation

| | |
|---|---|
| [`docs/writing-a-mod.md`](docs/writing-a-mod.md) | the mod lifecycle, `mod.json`, and the things the library already does for you |
| [`docs/library.md`](docs/library.md) | `ACEUIModLoader.*` reference: storage, hotkeys, scrolling, the frame loop, keeping typing out of the car |
| [`docs/ui.md`](docs/ui.md) | the surfaces the loader draws: the app drawer, windows, and a settings page per mod |
| [`docs/how-it-works.md`](docs/how-it-works.md) | how a package overrides a game file, why that is a coin toss, and what makes it reliable |
| [`docs/testing.md`](docs/testing.md) | the test kit, the browser harnesses, and the in-game smoke test |
| [`docs/style.md`](docs/style.md) | the JavaScript rules and why each one is there |
| [`docs/design.md`](docs/design.md) | the investigation behind the loader and the library |
| [`docs/developer-apps.md`](docs/developer-apps.md) | why the developer tools ship inside the package |
| [`docs/roadmap.md`](docs/roadmap.md) | what is missing |

The game mechanics all of this rests on are documented in [`ACEGameInternals`](https://github.com/dreasgrech/ACEGameInternals).
