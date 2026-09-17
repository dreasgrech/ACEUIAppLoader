# Using the console

Everything the panel does, and the two commands that exist for a reason rather than
for convenience.

## Commands

Type a dot and a word at the prompt; they never collide with JavaScript (`.5 + 1` still
evaluates).

| command | what it does |
|---|---|
| `.run <name>` | loads `ACEUIModLoaderApps/snippets/<name>.js` as a script — write it in an editor, run it in game, no reinstall and no pasting |
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
which ships under app.json's `files` key and is **loaded on demand**, so the HUD never pays
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
  `Saved Games/ACE/mods/uiresources/ACEUIModLoaderApps/snippets/`, as a script.
  Write anything longer than a line in an editor, save, type `.run name` in
  game: no reinstall, no pasting. The folder sits next to the app folders and
  outside every app, so reinstalling an app never touches it. Only plain file
  names are accepted (a folder URL would crash the game); a missing file is one
  warning in the log and a red line in the console. Commands start with a dot
  and a word so they never collide with JavaScript (`.5 + 1` is still a number).
- The buffer holds the last 500 lines and lives in the page: it starts fresh
  whenever the HUD page is reloaded (Escape/resume), but everything the loader
  and other apps logged while the page was loading is already in it.
- Drag anywhere except the buttons and the prompt to move it; the position
  persists like the stock widgets' (see the loader's `ACEUIModLoader.panel`).

Keyboard in game: the first launch showed typing reaches the prompt, but Enter
did nothing because the game's engine reports keys through the legacy
`keyCode` only (the stock bundle's chat input checks `keyCode == 13` and never
reads `key` or `code`). Every key check therefore accepts `key`, `code` or
`keyCode` (`KEY_CODES` in the script). Whether typed keys also reach the car
(W/A/S/D while the prompt has focus) is still to be observed; the stock chat
input has the same exposure.

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
console is closed, and when the app is detached (including being switched off in the app
drawer).
