# ACE DevConsole

In-game debug console for Assetto Corsa EVO's HUD, for game version
0.9.1+release.6. The mod's version is in `devconsole/mod.json` and nowhere else.

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
and the tests load the library and the shared test fixtures from
`../ACEUIModLoader/`.

## Layout

- `devconsole/` - the shipped mod, exactly what lands in
  `%USERPROFILE%\Saved Games\ACE\mods\uiresources\ACEUIModLoaderMods\devconsole\`:
  - `mod.json` - version, title, stylesheet and script. The loader reads it
    and hands the values back through `ACEUIModLoader.mod("devconsole")`
    (name, version, title, root, logger, storage keys), so none of them is
    repeated in the source.
  - `devconsole.js` - the console, an IIFE module
    (`DevConsole.attach(root)` / `DevConsole.detach(state)`): a fixed pool of
    200 row elements recycled over the shared line buffer, level and text
    filters, the scrollbar, the prompt (expression first, statements as
    fallback, history with the arrow keys), scaling, the toggle key and the
    header buttons. It attaches to `#devconsole`, which the loader creates in
    game and the preview and harness pages carry themselves.
  - `devconsole.css` - all styling, in the stock HUD widgets' language (black
    75 % panel, solid `#1c1e1f` header bar, flat buttons that turn `#bd0000` on
    hover, the stock scrollbar look), sized in em so the panel scales; line
    colours keyed by `data-level`.
- `dev/preview.html` - runs the console outside the game (see below).
- `tests/test_mod.py` - the loader's shared test kit pointed at this repo plus
  the console's own contract; `tests/console/harness.html` holds the browser cases.

The mod does not override any stock file. It is a loose folder the game reads,
discovered through its marker file (see the loader's README).

## Install

With the loader package installed (`python tools/build_loader.py --install` in
the loader repo, checked out next to this one):

```
python ..\ACEUIModLoader\tools\install_mod.py devconsole
python ..\ACEUIModLoader\tools\install_mod.py --remove devconsole
```

Edits need only a re-run of the install and a HUD reload in game (Escape,
resume).

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
- **`.run <name>`**: loads `<name>.js` from the snippets folder,
  `Saved Games/ACE/mods/uiresources/ACEUIModLoaderMods/snippets/`, as a script.
  Write anything longer than a line in an editor, save, type `.run name` in
  game: no reinstall, no pasting. The folder sits next to the mod folders and
  outside every mod, so reinstalling a mod never touches it. Only plain file
  names are accepted (a folder URL would crash the game); a missing file is one
  warning in the log and a red line in the console. Commands start with a dot
  and a word so they never collide with JavaScript (`.5 + 1` is still a number).
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
`devconsole.css` and `devconsole.js` from `devconsole/`, inside a 16:9 stand-in for
the game's HUD container, with buttons that emit log, warn, error, object and
uncaught-error lines, a one-line-per-second flood, the HUD hide toggle and a
fake `ModelCurrentCar` to inspect from the prompt.

## Code style (JavaScript)

Same conventions as the other ACE mods and the uplinkjs scripts, enforced by
the loader's test kit: one IIFE module per file, no classes, no `this`,
functions as assigned expressions, no arrow functions, `let`/`const` only,
double quotes, four-space indentation, braces on every `if`.

## Tests

```
python -m unittest discover -s tests -v
```

`tests/test_mod.py` subclasses `modkit.ModTests` from the loader repo, which
checks the shipped folder (`mod.json` valid and minimal, nothing unlisted ships,
no stock override, no legacy boilerplate), the JavaScript style rules, the
Cohtml rules, that class names exist in the stylesheet, that identity comes from
the loader, that the per-frame hot path only rewrites text, and runs
`tests/console/harness.html` in a headless Edge or Chrome: 21 behavioural cases
covering pre-attach buffering, rendering and its skip of unchanged rows,
filters, the prompt (results, statements, errors, history), clear, the row cap,
the scrollbar and wheel scrolling with the follow/LATEST behaviour, thumb
dragging, the text filter, scaling, the toggle key, hidden HUD, drag exclusions
and lifecycle. A second class keeps the console's own contract (fixed row pool,
legacy `keyCode` handling, the Cohtml wheel sign, the prompt never echoing into
the game log). The harness includes the shared test doubles and library loader
from `ACEUIModLoader/tests/lib/`. Skipped without a browser (`ACE_BROWSER=<path>`
overrides); the runner leaves no browser process behind.

## Verifying in game

Run `python ..\ACEUIModLoader\tools\check_ingame_log.py` after playing:
`[ACEUIModLoader] mod devconsole <version>: loading` followed by
`[DevConsole] script loaded, ... source=ACEUIModLoader` and `console attached, N
buffered line(s)` means the loader served the mod. Lines typed into the prompt
never reach the game log; only what other code logs does.
