# ACE UI Mod Loader

The single package that lets several UI mods coexist in Assetto Corsa EVO, the
shared library those mods are built on, and the tools that build it and install
mods for it. Version 0.5.1.

Why a loader is needed at all, and why it has this shape, is in
[`docs/design.md`](docs/design.md); the game mechanics it relies on are
documented in the `ACEGameInternals` repository.

## The app drawer

Every installed mod shows up in an **app drawer** that lives off the right edge of the
screen and slides in when the pointer reaches that edge, in the spirit of Content
Manager's app bar. Each row is a switch that shows or hides that mod, and the choice
persists across the HUD reload on Escape/resume. A mod that failed to load still gets a
row, saying why, rather than vanishing silently.

The drawer is part of the loader rather than a mod, because the loader is the only thing
that knows what is installed.

A mod can add its own options pane, which the drawer opens from the gear on its row:

```js
ACEUIModLoader.drawer.registerOptions("telemetry", function (pane) {
    pane.appendChild(myControls);     // called once, lazily, the first time it is opened
});
```

If that callback throws, the failure is shown inside the pane and the rest of the drawer
keeps working.

API: `open()`, `close()`, `toggle()`, `isVisible(name)`, `setVisible(name, on)`,
`toggleApp(name)`, `registerOptions(name, render)`, `build(mods)`.

The drawer is styled with inline styles rather than a stylesheet: the loader ships as a
single overriding file inside a package whose layout is delicate, so adding a CSS file to
it is a risk not worth taking, and a script-created `<style>` element is unproven in this
Cohtml build. Inline `transition` still animates the slide.

## How it works

The game serves every UI page (menu, in-game, HUD, ...) from `content.kspkg`
and loads `uiresources/js/cohtml.js` first on each of them. This repo ships
one package, `ACEUIModLoader.kspkg`, containing that one file: the untouched
stock script with the library files from `src/` appended in a fixed order. The
packer adds the padding entries that make the override win the game's
unstable-sort lookup for the installed game version.

A UI page cannot list folders, but the game lists one folder for it: the video
settings presets in `Saved Games\ACE\Video\*.settingspreset`. On every page the
loader sends the game's own `SettingsRequestVideoPresetList` command, keeps the
answers that start with `ACEUIModLoaderMods-`, and treats the rest of each name as
an installed mod. It then reads that mod's `ACEUIModLoaderMods/<name>/mod.json` and
injects the mod's stylesheets and scripts, in order, on the pages the mod asked
for. So a mod is two things a player unzips into `Saved Games\ACE` and nothing
else: its folder and one **empty** marker file. No manifest, no script, no
registration step. Mod folders live under a loose-file search path of the game,
so nothing is packaged or padded; only the loader is a package.

```
Saved Games\ACE\
  mods\ACEUIModLoader.kspkg                        <- built here (69 MB, mostly the fixed-size table)
  mods\uiresources\ACEUIModLoaderMods\pedalgraph\  <- one folder per mod: mod.json + its files
  mods\uiresources\ACEUIModLoaderMods\devconsole\
  Video\ACEUIModLoaderMods-pedalgraph.settingspreset   <- 0-byte markers; the game lists this folder
  Video\ACEUIModLoaderMods-devconsole.settingspreset      for the UI, the loader reads the names back
```

The markers must stay empty: the game deserialises every listed file before
naming it, and an empty file is a valid default message. The stock UI shows the
same list in its video presets menu, so the loader wraps `engine.on` and hands
stock handlers a copy of the answer without our markers. The game's answer is
the only source of mod names: without an engine or without an answer within
1.5 s the loader logs why and loads nothing.

Never request a URL that could be a folder: the game's loose-file lookup only
checks that the path exists and then crashes opening it. The loader only ever
requests plain file names listed in a `mod.json`.

A mod's `mod.json` holds only what cannot be inferred:

```json
{ "version": "0.4.0", "styles": ["pedalgraph.css"], "scripts": ["pedalgraph.js"] }
```

The mod's name is its folder's (and its marker's). Optional keys: `title` (the
log prefix, default the name), `pages` (default `["hud.html"]`, `"*"` = every
page), `files` (other plain file names the mod fetches itself, e.g. a `.wasm`;
copied by the install tool, never injected), `root: false` (no root element),
`name` (must equal the folder if given).
Scripts run in order as classic scripts; the loader waits for each before adding
the next.

Before the scripts run the loader creates the mod's root, `<div id="<name>"
data-mod="<name>">`, inside the HUD's positioning container (`.absolutecenter`,
or `<body>` on pages without one). While they run, `ACEUIModLoader.mod()` describes
the mod being loaded, and `ACEUIModLoader.mod("<name>")` does so at any time:

| field | value |
|---|---|
| `name`, `title`, `version` | from the folder and `mod.json` (`version` is `"dev"` on pages the loader did not load the mod on, e.g. a preview) |
| `root` | the `#<name>` element |
| `log`, `prefix` | a logger writing `[Title] ...` |
| `hudId`, `storageKey`, `key(suffix)` | `hud_<name>`, `ace<name>.pos`, `ace<name>.<suffix>`: the HUD layout id and storage keys for `ACEUIModLoader.panel` / `.persist` |
| `base`, `loaded` | the mod folder's URL; whether this loader instance loaded it |
| `mount(attach)` | calls `attach(#<name>)` once the DOM has the root (now or on DOMContentLoaded), once per root: the whole boot code of a mod is `ACEUIModLoader.mod("x").mount(X.attach);` |

So a mod's script declares none of that itself. Everything the loader logs
starts with `[ACEUIModLoader]` and lands in the game log as `[gameface]` lines.

## The library (`ACEUIModLoader.*`)

One global, `ACEUIModLoader` (also `window.ACEUIModLoader`), one namespace per file, loaded
in this order because each builds on the previous:

| File | Namespace | What it gives mods |
|---|---|---|
| `src/ACEUIModLoader.core.js` | `ACEUIModLoader` | `VERSION`, `page`, `log`, `logger(prefix)`, `clamp`, `el`/`close` (markup strings), `toArray`, `percentText`, `hudHidden()`, `closestWithAttribute`, `HUD_HIDDEN_CLASS` |
| `src/ACEUIModLoader.console.js` | `ACEUIModLoader.console` | hooks `console.log/info/debug/warn/error` before the stock bundle runs (originals still called, nothing echoed), ring buffer of the last 500 `{seq, t, level, text}` entries, uncaught errors and unhandled rejections captured, `entries()`, `subscribe(fn)`, `capture(level, text)`, `clear()`, `format(value)` |
| `src/ACEUIModLoader.persist.js` | `ACEUIModLoader.persist` | the stock HUD layout store (`HUD.elementModified` / `HUD.StoredData`, saved by the game on HUD close) and `localStorage`: `readHud`, `writeHud`, `hudAvailable`, `readLocal`, `writeLocal`, `removeLocal`, `save(hudId, key, data)` |
| `src/ACEUIModLoader.panel.js` | `ACEUIModLoader.panel` | `attach(root, {hudId, storageKey, log, onSaved})`: drag inside the HUD container, clamped; position persisted as screen fractions; hidden until the stored position is applied (immediate `localStorage`, then the HUD store has the last word in `update(panel, now)`); `data-nodrag` on descendants that must not start a drag; `detach` |
| `src/ACEUIModLoader.loop.js` | `ACEUIModLoader.loop` | `start(onFrame)` / `stop(handle)`; `sampler(hz, maxGapMs)` + `advance(sampler, now, onSample)` for fixed-rate sampling independent of frame rate, returning the 0..1 fraction towards the next sample |
| `src/ACEUIModLoader.loader.js` | `ACEUIModLoader.loader` | mod discovery through the game's video preset list, the `engine.on` wrapper that hides markers from the stock presets menu, root creation, mod injection, `mod(name)`; aliases `ACEUIModLoader.mod`, `.ready(cb)`, `.mods`, `.addScript`, `.addStylesheet`, `.ROOT` |

A mod is one folder: `mod.json`, one script and one stylesheet. The script is an
IIFE module that reads its identity from `ACEUIModLoader.mod("<name>")`, uses
`ACEUIModLoader.panel` for its root and `ACEUIModLoader.loop` for its frame, and
attaches to `#<name>` when the page has it (the loader in game, the preview and
harness pages outside it). `python tools/new_mod.py <name> --title "Nice Name"`
writes exactly that, plus a harness, a preview and a one-class test file that
runs the shared kit. `ACEPedalGraph` and `ACEDevConsole` are the two reference mods.

## The mod test kit (`tools/modkit.py`)

A mod repo's whole test suite is one file that subclasses `modkit.ModTests` with
`ROOT` set. The kit checks the shipped folder (`mod.json` valid and minimal,
nothing unlisted ships, no stock file overridden, no legacy `VERSION` /
`mod.js` / install wrapper / `const VERSION`), the JavaScript style rules, the
Cohtml rules, that class names used by scripts exist in the stylesheet, that
identity comes from `ACEUIModLoader.mod(...)`, optionally a per-frame hot path
(`HOT_PATH` markers), and runs every `tests/**/harness.html` headlessly. Browser
pages include `tests/lib/doubles.js` (fake frame clock, in-memory storage,
console capture, and the `window.__harness` helpers `t`/`eq`/`ok`/`near`/`finish`
that write the report the runner parses) and `tests/lib/lib.js` (the library in
`LIB_ORDER`) from this repo, so a harness holds only its own cases and the
library load order exists in one place.

## Build and install

```
python tools/build_loader.py --install     # extract stock cohtml.js, append the library, pack, pad, install
python tools/install_mod.py <repo>/<name>  # copy a mod folder in place and write its empty marker
python tools/install_mod.py --list
python tools/install_mod.py --remove <name>
python tools/check_ingame_log.py           # after a launch: did the loader run, which mods loaded, crashes?
python tools/new_mod.py <name> [<parent dir>] [--title "Nice Name"]   # start a new mod repo
```

Deleting `ACEUIModLoader.kspkg` from the mods folder restores the stock game;
the loose mod folders are then simply never read. Library changes need a
rebuild and reinstall of the package (the padding depends only on the file
paths, so it stays the same).

A mod that must override a packed game file (ACEDOOM's `gui_events.table`)
ships its own package. The game re-sorts its shared file table after every
package it adds, so such a package is named `ACEUIModLoaderMods-<name>.kspkg`
to list after the loader, and `pack_kspkg.py` searches its padding with every
installed package in the vector (`--mods-dir`), keeping their file overrides
winning too. Adding a package can still need the others rebuilt; the
`check_ingame_log.py` verdict after a launch is the test.

## Layout

| Path | Contents |
|---|---|
| `VERSION` | loader/library version, mirrored by `const VERSION` in `ACEUIModLoader.core.js` (test-enforced) |
| `src/ACEUIModLoaderMods.*.js` | the library, see above; `LIB_ORDER` in `tools/build_loader.py` is the load order |
| `tools/build_loader.py` | assembles `build/uiresources/js/cohtml.js` (stock + library), packs to `dist/`, `--install` |
| `tools/install_mod.py` | validates a mod folder against its `mod.json`, copies it, writes the empty marker in `Saved Games\ACE\Video\` |
| `tools/pack_kspkg.py` | generic `.kspkg` writer with override padding, verify, `--install` |
| `tools/check_ingame_log.py` | reads the newest game log and reports loader/mod status |
| `tools/headless.py` | runs an HTML test harness in a headless Edge/Chrome and parses its report; shared with the mod repos |
| `tools/modkit.py` | the shared mod test kit (`ModTests` base class), see above |
| `tools/new_mod.py` | writes a new mod repo: folder with `mod.json` + script + stylesheet, harness, preview, kit test file, README |
| `tests/lib/doubles.js`, `tests/lib/lib.js` | test doubles and the library loader for browser pages, used by this repo's harness and every mod's |
| `tests/lib/ACEUIModLoaderMods/alpha/` | harness fixture: a mod the fake engine lists, to prove injection, root creation and `mod()` |
| `tools/_repos.py` | locates the sibling `ACEGameInternals`, the game and the mods folder (`ACE_*_DIR` overrides) |
| `docs/design.md` | the investigation and decisions behind the loader and the library |
| `tests/test_pack_kspkg.py` | package format tests |
| `tests/test_loader_tools.py` | library style/contract tests, install_mod tests, a real build test (skipped without the game) |
| `tests/test_lib_browser.py`, `tests/lib/harness.html` | 23 behavioural cases for the library in a headless browser (fake clock, storage, HUD store, fake engine) |
| `tests/test_modkit.py` | `new_mod.py` output passes the kit; the kit catches legacy boilerplate |

## Dependencies

`ACEGameInternals` checked out next to this repo (or `ACE_INTERNALS_DIR`
pointing at it): the tools import `lookup_sim.py` and `kspkg.py` from there.
The game location is auto-detected (`ACE_GAME_DIR` overrides), the mods folder
is `Saved Games\ACE\mods` (`ACE_MODS_DIR` overrides, used by the tests). The
browser tests need Edge or Chrome (`ACE_BROWSER=<path>` overrides) and are
skipped without one; the runner leaves no browser process behind.

```
python -m unittest discover -s tests -v
```

## Roadmap

1. Repadding: `pack_kspkg.py` already searches against the installed
   packages; a `repad` command that rebuilds every installed package in one go
   is still missing (needed when car-mod packages are present).
2. Verify the package listing order assumption and compare the notes in
   `ACEGameInternals` against Coherent's official Gameface documentation.
3. Console capture on menu pages is already there (the hook runs on every
   page); a way to carry the buffer across the HUD page reload is not.

## Code style (JavaScript)

Same conventions as the mods and the uplinkjs scripts, enforced by
`tests/test_loader_tools.py`: one IIFE module per file, no classes, no `this`,
functions as assigned expressions, no arrow functions, `let`/`const` only,
double quotes, four-space indentation.
