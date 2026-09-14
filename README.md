# ACE UI Mod Loader

The single package that lets several UI mods coexist in Assetto Corsa EVO, plus
the tools that build it and install mods for it. Loader version 0.1.0.

Why a loader is needed at all, and why it has this shape, is in
[`docs/design.md`](docs/design.md); the game mechanics it relies on are
documented in the `ACEGameInternals` repository.

## How it works

The game serves every UI page (menu, in-game, HUD, ...) from `content.kspkg`
and loads `uiresources/js/cohtml.js` first on each of them. This repo ships
one package, `acemods_loader.kspkg`, containing that one file: the untouched
stock script with `src/acemods.loader.js` appended. The packer adds the padding
entries that make the override win the game's unstable-sort lookup for the
installed game version.

On every page the loader reads `acemods/manifest.json`, then each listed mod's
`acemods/<name>/mod.json`, and injects that mod's stylesheets and scripts, in
order, on the pages the mod asked for. Mods are plain folders under
`%USERPROFILE%\Saved Games\ACE\mods\uiresources\acemods\<name>\`; that
directory is one of the game's loose-file search paths, so new files there are
served with no packaging and no padding. Only the loader is a package.

```
Saved Games\ACE\mods\
  acemods_loader.kspkg                  <- built here (69 MB, mostly the fixed-size table)
  uiresources\acemods\manifest.json     <- { "mods": ["pedalgraph"] }, kept by install_mod.py
  uiresources\acemods\pedalgraph\       <- one folder per mod: mod.json + its files
```

A mod's `mod.json`:

```json
{ "name": "pedalgraph", "version": "0.3.0", "pages": ["hud.html"],
  "styles": ["pedalgraph.css"], "scripts": ["pedalgraph.js", "mod.js"] }
```

`pages` defaults to `["hud.html"]`; `"*"` means every page. Scripts run in
order as classic scripts; the loader waits for each before adding the next.
The runtime is the global `AceMods` (also `window.AceMods`, so mods can detect it) and exposes `.VERSION`, `.page`, `.mods`, `.log`,
`.logger("[Prefix]")`, `.addStylesheet`, `.addScript`, `.ready(cb)`. Everything
it logs starts with `[AceMods]` and lands in the game log as `[gameface]` lines.

## Build and install

```
python tools/build_loader.py --install     # extract stock cohtml.js, append loader, pack, pad, install
python tools/install_mod.py <mod/src>      # copy a mod folder in place and register it
python tools/install_mod.py --list
python tools/install_mod.py --remove <name>
python tools/check_ingame_log.py           # after a launch: did the loader run, which mods loaded, crashes?
```

Deleting `acemods_loader.kspkg` from the mods folder restores the stock game;
the loose mod folders are then simply never read.

## Layout

| Path | Contents |
|---|---|
| `VERSION` | loader version, mirrored by `const VERSION` in the runtime (test-enforced) |
| `src/acemods.loader.js` | the runtime: manifest discovery, per-mod injection, logging |
| `tools/build_loader.py` | assembles `build/uiresources/js/cohtml.js` (stock + loader), packs to `dist/`, `--install` |
| `tools/install_mod.py` | validates a mod folder against its `mod.json`, copies it, updates the manifest |
| `tools/pack_kspkg.py` | generic `.kspkg` writer with override padding, verify, `--install` |
| `tools/check_ingame_log.py` | reads the newest game log and reports loader/mod status |
| `tools/_repos.py` | locates the sibling `ACEGameInternals`, the game and the mods folder (`ACE_*_DIR` overrides) |
| `docs/design.md` | the investigation and decisions behind the loader |
| `tests/` | packer format tests; runtime style/contract tests; install_mod tests; a real build test (skipped without the game) |

## Dependencies

`ACEGameInternals` checked out next to this repo (or `ACE_INTERNALS_DIR`
pointing at it): the tools import `lookup_sim.py` and `kspkg.py` from there.
The game location is auto-detected (`ACE_GAME_DIR` overrides), the mods folder
is `Saved Games\ACE\mods` (`ACE_MODS_DIR` overrides, used by the tests).

```
python -m unittest discover -s tests -v
```

## Roadmap

1. `lib/`: shared library for mods (persistence through the stock HUD layout
   store, draggable panel, sampling loop, console), extracted from PedalGraph.
2. `tools/repad.py`: recompute the loader's padding against every package
   installed on a machine (needed when car-mod packages are present).
3. The in-game debug console mod.
4. Verify the package listing order assumption and compare the notes in
   `ACEGameInternals` against Coherent's official Gameface documentation.

## Code style (JavaScript)

Same conventions as PedalGraph and the uplinkjs scripts, enforced by
`tests/test_loader_tools.py`: one IIFE module, no classes, no `this`, functions
as assigned expressions, no arrow functions, `let`/`const` only, double quotes,
four-space indentation.
