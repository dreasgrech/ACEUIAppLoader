# ACEUIProfiler

ACE UI Profiler: a UI mod for Assetto Corsa EVO, loaded by the
[ACEUIModLoader](../ACEUIModLoader) and built on its library.

## Layout

- `profiler/` - the shipped mod, exactly what lands in
  `Saved Games\ACE\mods\uiresources\ACEUIModLoaderMods\profiler\`:
  `mod.json` (version, styles, scripts), `profiler.js`, `profiler.css`.
- `tests/test_mod.py` - runs the loader's shared test kit (`modkit.py`) against
  this repo: mod.json, style and Cohtml rules, and `tests/harness.html` in a
  headless browser.
- `dev/preview.html` - the mod outside the game.

## Install

With the loader package installed (`python tools/build_loader.py --install` in
the loader repo):

```
python ..\ACEUIModLoader\tools\install_mod.py profiler
```

Escape and resume in the car reloads the HUD and picks up changes.

## Tests

```
python -m unittest discover -s tests -v
```
