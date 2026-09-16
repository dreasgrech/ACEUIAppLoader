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
`ACEGameInternals` (`docs/`), checked out beside the loader. The console ships
inside the loader's own package as one of its developer apps, so it lives in
`apps/devconsole/` and its preview page and tests load the library and the shared
fixtures from the repo it sits in.

## Typing does not drive the car

While the prompt or the filter box has focus, the game stops reading keystrokes as car
controls — otherwise typing an expression toggles headlights, wipers and everything else
bound to a letter.

This uses the game's own mechanisms rather than new ones. `UIMenuState` carries two
separate flags, and **both** are needed:

| method on `ksUI.menuState` | flag | covers |
|---|---|---|
| `toggleKeyboardInput` | `is_chat_active` (field 10) | the text path — letters |
| `ignoreInputActions` | `ignore_gameplay_input_actions` (field 7) | bound gameplay actions |

The stock chat box (`components.js:35038`) only flips the first, which is why letters
stopped toggling car functions but the **arrow keys still moved the seat**. Both are set
on focus and cleared on blur; either one alone counts as captured, so an engine that
offers only one still gets what it has. Both implementations are at `components.js:4033`
and `4056`, and the menu state is pushed back with
`triggerUICommand("UIMenuState", ...)`.

Releasing it matters more than taking it — a console still holding the capture would
leave the car unable to read its own controls — so it is released on blur, when the
console is closed, and when the mod is detached (including being switched off in the app
drawer).

## Commands

Type a dot and a word at the prompt; they never collide with JavaScript (`.5 + 1` still
evaluates).

| command | what it does |
|---|---|
| `.run <name>` | loads `ACEUIModLoaderMods/snippets/<name>.js` as a script — write it in an editor, run it in game, no reinstall and no pasting |
| `.fields [name]` | the **schema** fields of a `Model*` global or message, against what the game actually published |
| `.logtest` | which console methods really reach this console, measured from the inside |

### `.fields` — schema versus reality

The game mirrors protobuf messages into the `Model*` globals, but a live object only shows
the fields *this build happens to fill in*. The recovered schemas say what else the message
can carry, and the difference is the interesting part:

```
> .fields ModelCurrentCar
  gas_percent                     float                   #15     = 0.12
  npos                            float                   #113    = 0.42
  kers_charge_perc                float                   #42     (not published)
  ...
UICurrentCarState <- ModelCurrentCar  PlatformUiTypes.proto  91 defined, 88 live
  live but not in the schema: __Type
```

`.fields` with no name lists every message mapped to a global. The data is generated from
`ACEGameInternals/proto` by `tools/gen_protofields.py` into `devconsole/protofields.js`,
which ships under mod.json's `files` key and is **loaded on demand**, so the HUD never pays
for it unless someone asks. Regenerate it after a game update:

```
python tools/gen_protofields.py
```

### `.logtest` — proving the capture

The library wraps `console.log/info/debug/warn/error/trace/dir/table`, wraps
`console.assert` separately (recording only failures) and listens for uncaught errors and
unhandled rejections. `.logtest` emits one marked line through every method the engine
offers and then reports which ones came back — so coverage is a measurement, not an
assumption. Methods the engine does not provide are listed as absent.

## Prompt: completion and readable results

**Tab completes object paths.** Type `ModelCurrentCar.` and press Tab to walk into the
game's models; press Tab again to cycle the alternatives, or click a chip. The completer
only ever *reads* property names, walking from `window` through the prototype chain — it
never compiles or calls anything, so completing a path cannot have side effects on the
game. Any other keystroke drops the suggestion list, and so does an edit the console did
not make (a paste), which would otherwise splice a completion into the wrong place.

**Results are expanded, not squashed.** A game model is a wall of fields, so an object
result is printed over many lines — one property per line, indented, in the style of a
browser's dev tools — rather than the single line `ACEUIModLoader.console.format` uses for
log lines:

```
> ModelTiming
Object {
  __Type: "UITimingState"
  current: "00:06.272"
  splits: Array(0) [
  ]
  invalid: true
}
```

Depth, key count and total lines are capped (so a careless `window` cannot flood the
buffer), cycles are marked `[circular]` rather than followed, and a property whose getter
throws prints the error instead of killing the print.

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

It ships inside the loader's package, so building and installing the loader
installs it:

```
python tools/run_tests.py                    # this app's suite is part of the run
python tools/build_loader.py --install
```

To work on it, install it loose as well: the installed copy wins over the bundled
one until it is removed again, and then a re-run of the install plus a HUD reload
in game (Escape, resume) is the whole edit loop.

```
python tools/install_mod.py apps/devconsole/devconsole
python tools/install_mod.py --remove devconsole
```

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
from the loader's `tests/lib/`. Skipped without a browser (`ACE_BROWSER=<path>`
overrides); the runner leaves no browser process behind.

## Verifying in game

Run `python ..\ACEUIModLoader\tools\check_ingame_log.py` after playing:
`[ACEUIModLoader] mod devconsole <version>: loading` followed by
`[DevConsole] script loaded, ... source=ACEUIModLoader` and `console attached, N
buffered line(s)` means the loader served the mod. Lines typed into the prompt
never reach the game log; only what other code logs does.
