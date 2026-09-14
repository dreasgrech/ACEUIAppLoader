# ACE DevConsole

In-game debug console for Assetto Corsa EVO's HUD. Version 0.2.0, for game
version 0.9.1+release.6.

A draggable panel that shows everything the UI logs, including the stock
bundle's own `console.log` / `warn` / `error` output and uncaught errors, with
per-level filters and counts, and a prompt that runs JavaScript against the HUD
page (`ModelCurrentCar.speed`, `ACEUIModLoader.mods`, `HUD.StoredData`, ...). Toggle
it with the backquote key.

This repository is the mod only. It is loaded by the `ACEUIModLoader` package
and built on that package's shared library: `ACEUIModLoader.console` captures the
lines (it hooks `console.*` before the stock bundle runs, so the stock HUD's
messages are in the buffer), `ACEUIModLoader.panel` handles drag and position
persistence, `ACEUIModLoader.loop` the frame loop, `ACEUIModLoader.persist` the open state
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
- `src/devconsole.css` - all styling, in the stock HUD widgets' language (black
  75 % panel, solid `#1c1e1f` header bar, flat buttons that turn `#bd0000` on
  hover, the stock scrollbar look); line colours keyed by `data-level`.
- `VERSION` - the mod version, single source of truth.
- `dev/preview.html` - runs the console outside the game (see below).
- `tools/install.py` - thin wrapper around the loader's `install_mod.py`.
- `tests/` - this mod's tests, see below.

The mod does not override any stock file. It is a loose folder the game reads
from `%USERPROFILE%\Saved Games\ACE\mods\uiresources\ACEUIModLoaderMods\devconsole\`.

## Install

The loader package must be installed once (from `ACEUIModLoader`:
`python tools/build_loader.py --install`). Then:

```
python tools/install.py            # copy src/ into the mods folder and write its empty marker
python tools/install.py --remove
```

Edits to `src/` need only a re-run of `install.py` and a HUD reload in game
(Escape, resume). Set `ACE_LOADER_DIR` if the loader repo is elsewhere.

## Using it

- **Backquote** (`` ` ``) opens and closes the panel; the state is remembered
  for the session. The `×` button closes it too.
- **LOG / WARN / ERR** toggle those levels; the number is how many lines of
  that level the buffer holds. Prompt echo and results are always shown.
- **− / +** scale the whole panel (text, buttons, scrollbar) in 10 % steps
  between 60 % and 200 %; the scale is remembered like the position.
- **CLEAR** empties the shared buffer (for every consumer of it).
- **Filter text**: the field in the header hides every line that does not
  contain what you type (case-insensitive); Escape clears it. Level filters
  and the counts are unaffected.
- **Scrolling**: the wheel moves the list (a quarter of the visible height per
  notch; Cohtml reports the wheel with the opposite sign to a browser, positive
  is up, and the console is built for that), the thumb can be dragged, a click on the
  scrollbar track jumps there. The newest line is
  followed until you scroll away; a **LATEST** chip then appears and brings you
  back. Cohtml scrolls nothing by itself, so the console owns all of this and
  draws the stock-style scrollbar (thumb height set on content change, position
  as a transform).
- **Prompt**: type an expression and press Enter. It is compiled as an
  expression first so its value is printed (`ModelCurrentCar.speed`); if that
  is not valid syntax it runs as statements (`window.x = 1`). Errors are shown
  in red. Arrow up/down walk the history (50 entries). Escape leaves the prompt.
- The buffer holds the last 500 lines and lives in the page: it starts fresh
  whenever the HUD page is reloaded (Escape/resume), but everything the loader
  and other mods logged while the page was loading is already in it.
- Drag anywhere except the buttons and the prompt to move it; the position
  persists like the stock widgets' (see the loader's `ACEUIModLoader.panel`).

Keyboard in game: the first launch showed typing reaches the prompt, but Enter
did nothing because the game's engine reports keys through the legacy
`keyCode` only (the stock bundle's chat input checks `keyCode == 13` and never
reads `key` or `code`). Every key check therefore accepts `key`, `code` or
`keyCode` (`KEY_CODES` in the script). Whether typed keys also reach the car
(W/A/S/D while the prompt has focus) is still to be observed; the stock chat
input has the same exposure.

## Preview outside the game

Open `dev/preview.html` in Edge or Chrome (double-click, no server needed). It
loads the library from the sibling loader checkout, then the real
`devconsole.css` and `devconsole.js` from `src/`, inside a 16:9 stand-in for
the game's HUD container, with buttons that emit log, warn, error, object and
uncaught-error lines, a one-line-per-second flood, the HUD hide toggle and a
fake `ModelCurrentCar` to inspect from the prompt.

## Versioning

`VERSION` holds the semantic version; `devconsole.js` repeats it in
`const VERSION` and in its first log line (`script loaded, version=0.2.0,
source=ACEUIModLoader, lib=<loader version>`), `src/mod.json` repeats it for the
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
  21 behavioural cases covering pre-attach buffering, rendering and its skip
  of unchanged rows, filters, the prompt (results, statements, errors,
  history), clear, the row cap, the scrollbar and wheel scrolling with the
  follow/LATEST behaviour, thumb dragging, the text filter, scaling, the toggle key, hidden HUD, drag exclusions and
  lifecycle. Skipped if no browser is found (`ACE_BROWSER=<path>`
  overrides). The runner, shared from `ACEUIModLoader/tools/headless.py`,
  uses a throwaway profile, kills the process tree on timeout and verifies no
  browser process is left behind.

## Verifying in game

Run `python ..\ACEUIModLoader\tools\check_ingame_log.py` after playing:
`[ACEUIModLoader] mod devconsole 0.2.0: loading` followed by
`[DevConsole] script loaded, ... source=ACEUIModLoader` and `console attached, N
buffered line(s)` means the loader served the mod. Lines typed into the prompt
never reach the game log; only what other code logs does.
