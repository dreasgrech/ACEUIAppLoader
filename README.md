# ACE UI Mod Loader

The single package that lets several UI mods coexist in Assetto Corsa EVO, the
shared library those mods are built on, and the tools that build it and install
mods for it. Version 0.3.0.

Why a loader is needed at all, and why it has this shape, is in
[`docs/design.md`](docs/design.md); the game mechanics it relies on are
documented in the `ACEGameInternals` repository.

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
stock handlers a copy of the answer without our markers. Without an engine (the
browser harness) or without an answer within 1.5 s it falls back to
`ACEUIModLoaderMods/manifest.json` (`{ "mods": [...] }`).

Never request a URL that could be a folder: the game's loose-file lookup only
checks that the path exists and then crashes opening it. The loader only ever
requests plain file names listed in a `mod.json`.

A mod's `mod.json`:

```json
{ "name": "pedalgraph", "version": "0.4.0", "pages": ["hud.html"],
  "styles": ["pedalgraph.css"], "scripts": ["pedalgraph.js", "mod.js"] }
```

`pages` defaults to `["hud.html"]`; `"*"` means every page. Scripts run in
order as classic scripts; the loader waits for each before adding the next.
Everything the loader logs starts with `[ACEUIModLoader]` and lands in the game log
as `[gameface]` lines.

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
| `src/ACEUIModLoader.loader.js` | `ACEUIModLoader.loader` | mod discovery through the game's video preset list (manifest fallback), the `engine.on` wrapper that hides markers from the stock presets menu, mod injection; aliases `ACEUIModLoader.ready(cb)`, `.mods`, `.addScript`, `.addStylesheet`, `.ROOT` |

A mod is typically: `const MyMod = (function () { ... attach/detach ... }());`
using `ACEUIModLoader.panel` for its root and `ACEUIModLoader.loop` for its frame, plus a
`mod.js` that creates the root inside `.absolutecenter` and calls `attach`.
`ACEPedalGraph` and `ACEDevConsole` are the two reference mods.

## Build and install

```
python tools/build_loader.py --install     # extract stock cohtml.js, append the library, pack, pad, install
python tools/install_mod.py <mod/src>      # copy a mod folder in place and write its empty marker
python tools/install_mod.py --list
python tools/install_mod.py --remove <name>
python tools/check_ingame_log.py           # after a launch: did the loader run, which mods loaded, crashes?
```

Deleting `ACEUIModLoader.kspkg` from the mods folder restores the stock game;
the loose mod folders are then simply never read. Library changes need a
rebuild and reinstall of the package (the padding depends only on the file
paths, so it stays the same).

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
| `tools/_repos.py` | locates the sibling `ACEGameInternals`, the game and the mods folder (`ACE_*_DIR` overrides) |
| `docs/design.md` | the investigation and decisions behind the loader and the library |
| `tests/test_pack_kspkg.py` | package format tests |
| `tests/test_loader_tools.py` | library style/contract tests, install_mod tests, a real build test (skipped without the game) |
| `tests/test_lib_browser.py`, `tests/lib/harness.html` | 17 behavioural cases for the library in a headless browser (fake clock, storage, HUD store) |

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

1. `tools/repad.py`: recompute the loader's padding against every package
   installed on a machine (needed when car-mod packages are present).
2. Verify the package listing order assumption and compare the notes in
   `ACEGameInternals` against Coherent's official Gameface documentation.
3. Console capture on menu pages is already there (the hook runs on every
   page); a way to carry the buffer across the HUD page reload is not.

## Code style (JavaScript)

Same conventions as the mods and the uplinkjs scripts, enforced by
`tests/test_loader_tools.py`: one IIFE module per file, no classes, no `this`,
functions as assigned expressions, no arrow functions, `let`/`const` only,
double quotes, four-space indentation.
