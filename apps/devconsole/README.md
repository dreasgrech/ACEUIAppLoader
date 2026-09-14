# ACE DevConsole

In-game debug console for Assetto Corsa EVO's HUD. Version 0.1.0, for game
version 0.9.1+release.6.

A draggable panel that shows everything the UI logs, including the stock
bundle's own `console.log` / `warn` / `error` output and uncaught errors, with
per-level filters and counts, and a prompt that runs JavaScript against the HUD
page (`ModelCurrentCar.speed`, `AceMods.mods`, `HUD.StoredData`, ...). Toggle
it with the backquote key.

This repository is the mod only. It is loaded by the `ACEUIModLoader` package
and built on that package's shared library: `AceMods.console` captures the
lines (it hooks `console.*` before the stock bundle runs, so the stock HUD's
messages are in the buffer), `AceMods.panel` handles drag and position
persistence, `AceMods.loop` the frame loop, `AceMods.persist` the open state
and filters. Everything learned about the game and its UI engine is in
`ACEGameInternals` (`docs/`). Clone all three side by side: the preview page
and the tests load the library from `../ACEUIModLoader/src/`.

## Layout

- `src/mod.json` - what the loader reads: name, version, the pages to load on
  (`hud.html`), the stylesheet and the scripts in load order.
- `src/devconsole.js` - the console, an IIFE module
  (`DevConsole.attach(root)` / `DevConsole.detach(state)`): a fixed pool of
  200 row elements recycled over the shared line buffer, filters, the prompt
  (expression first, statements as fallback, history with the arrow keys),
  the toggle key and the close/clear buttons.
- `src/mod.js` - loader entry point: creates `<div id="devconsole">` inside
  the HUD's positioning container and calls `DevConsole.attach`.
- `src/devconsole.css` - all styling; line colours keyed by `data-level`.
- `VERSION` - the mod version, single source of truth.
- `dev/preview.html` - runs the console outside the game (see below).
- `tools/install.py` - thin wrapper around the loader's `install_mod.py`.
- `tests/` - this mod's tests, see below.

The mod does not override any stock file. It is a loose folder the game reads
from `%USERPROFILE%\Saved Games\ACE\mods\uiresources\acemods\devconsole\`.

## Install

The loader package must be installed once (from `ACEUIModLoader`:
`python tools/build_loader.py --install`). Then:

```
python tools/install.py            # copy src/ into the mods folder and register it
python tools/install.py --remove
```

Edits to `src/` need only a re-run of `install.py` and a HUD reload in game
(Escape, resume). Set `ACE_LOADER_DIR` if the loader repo is elsewhere.

## Using it

- **Backquote** (`` ` ``) opens and closes the panel; the state is remembered
  for the session. The `x` button closes it too.
- **LOG / WARN / ERR** toggle those levels; the number is how many lines of
  that level the buffer holds. Prompt echo and results are always shown.
- **clear** empties the shared buffer (for every consumer of it).
- **Prompt**: type an expression and press Enter. It is compiled as an
  expression first so its value is printed (`ModelCurrentCar.speed`); if that
  is not valid syntax it runs as statements (`window.x = 1`). Errors are shown
  in red. Arrow up/down walk the history (50 entries). Escape leaves the prompt.
- The buffer holds the last 500 lines and lives in the page: it starts fresh
  whenever the HUD page is reloaded (Escape/resume), but everything the loader
  and other mods logged while the page was loading is already in it.
- Drag anywhere except the buttons and the prompt to move it; the position
  persists like the stock widgets' (see the loader's `AceMods.panel`).

Known unknown for the first in-game run: whether keyboard focus reaches the
prompt while driving (the game may keep consuming keys). If it does not, the
log view and the toggle still work; the prompt is the part to test.

## Preview outside the game

Open `dev/preview.html` in Edge or Chrome (double-click, no server needed). It
loads the library from the sibling loader checkout, then the real
`devconsole.css` and `devconsole.js` from `src/`, inside a 16:9 stand-in for
the game's HUD container, with buttons that emit log, warn, error, object and
uncaught-error lines, a one-line-per-second flood, the HUD hide toggle and a
fake `ModelCurrentCar` to inspect from the prompt.

## Versioning

`VERSION` holds the semantic version; `devconsole.js` repeats it in
`const VERSION` and in its first log line (`script loaded, version=0.1.0,
source=acemods, lib=<loader version>`), `src/mod.json` repeats it for the
loader, and this README must mention it. A test fails if they disagree.

## Code style (JavaScript)

Same conventions as the other ACE mods and the uplinkjs scripts, enforced by
`tests/test_sources.py`: one IIFE module per file, no classes, no `this`,
functions as assigned expressions, no arrow functions, `let`/`const` only,
double quotes, four-space indentation, braces on every `if`.

## Tests

```
python -m unittest discover -s tests -v
```

- `tests/test_sources.py` - static rules: `mod.json` lists exactly the files in
  `src/` in the right order and overrides nothing; the per-frame code only
  rewrites text on a fixed row pool and only when something changed; no CSS in
  the script, no `var(--x, fallback)`, no magic numbers in the hot path; the
  console uses the library for everything that is not the console; the prompt
  never echoes into the game log; class names and level colours exist in the
  stylesheet; versions agree; the preview and harness load the library first;
  the JavaScript style rules.
- `tests/test_console_browser.py` - runs `tests/console/harness.html` in a
  headless Edge or Chrome with a fake animation clock and fake `localStorage`:
  12 behavioural cases covering pre-attach buffering, rendering and its skip
  of unchanged rows, filters, the prompt (results, statements, errors,
  history), clear, the row cap, the toggle key, hidden HUD, drag exclusions
  and lifecycle. Skipped if no browser is found (`ACE_BROWSER=<path>`
  overrides). The runner, shared from `ACEUIModLoader/tools/headless.py`,
  uses a throwaway profile, kills the process tree on timeout and verifies no
  browser process is left behind.

## Verifying in game

Run `python ..\ACEUIModLoader\tools\check_ingame_log.py` after playing:
`[AceMods] mod devconsole 0.1.0: loading` followed by
`[DevConsole] script loaded, ... source=acemods` and `console attached, N
buffered line(s)` means the loader served the mod. Lines typed into the prompt
never reach the game log; only what other code logs does.
