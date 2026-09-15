# ACE UI Mod Loader

The single package that lets several UI mods coexist in Assetto Corsa EVO, the
shared library those mods are built on, and the tools that build it and install
mods for it. Version 0.11.0.

Why a loader is needed at all, and why it has this shape, is in
[`docs/design.md`](docs/design.md); the game mechanics it relies on are
documented in the `ACEGameInternals` repository.

## House style

Modules are self-invoking functions assigned onto the namespace — **no classes, no
`this`, no `var`, no arrow functions, no function declarations**; 4-space indent, double
quotes, braces on every `if`. The shared test kit (`tools/modkit.py`, `check_style`)
enforces this on every mod, and as of 0.9.1 on the loader's own `src/` too — that was the
one place the rule lived on memory rather than on a test.

## Windows

Any mod that needs a second surface — settings, help, a picker, a report — gets one
without hand-building a panel, wiring dragging, remembering where the player put it or
running a frame loop:

```js
const win = ACEUIModLoader.window.open("doom.help", { title: "DOOM help" });
win.body.appendChild(myContent);      // fill it with whatever you like
win.setTitle("DOOM help (page 2)");
win.close();

ACEUIModLoader.window.toggle("doom.help", { title: "DOOM help" });
ACEUIModLoader.window.isOpen("doom.help");
ACEUIModLoader.window.get("doom.help");
ACEUIModLoader.window.closeAll();
ACEUIModLoader.window.ids();
```

| | |
|---|---|
| `open(id, options)` | opens it and returns the handle; opening one already open returns the same handle rather than stacking a copy |
| `close(id)` / `closeAll()` | `close` returns false if it was not open |
| `toggle(id, options)` | returns true when it ended up open |
| `isOpen(id)` / `get(id)` / `ids()` | |

The handle is `{ id, root, header, body, close(), setTitle(text), isOpen() }` — put your
content in `body`.

Options, all optional: `title`, `width`, `left`, `top`, `onOpen(win)`, `onClose(id)`. A
hook that throws is logged and ignored rather than breaking the window.

**The id is per window, not per mod** — a mod can have several. It is also the storage
key, so each window remembers its own position; prefix it with the mod name
(`"doom.help"`, `"telemetry.laps"`) to keep them apart.

Dragging and position persistence come from `ACEUIModLoader.panel`, which settles a
restored position over a few frames, so one shared frame loop runs while any window is
open and stops when the last one closes.

## A settings page per mod

A mod declares what it has; the loader stores the values, draws the controls in the app
drawer's options pane, and tells the mod when something changes. The mod never touches
storage or builds a form.

```js
const opts = ACEUIModLoader.settings.define("devconsole", [
    { key: "toggleKey", type: "key",    label: "Toggle key",    value: "Backquote" },
    { key: "scale",     type: "range",  label: "Panel scale",   value: 1, min: 0.6, max: 2, step: 0.1 },
    { key: "follow",    type: "toggle", label: "Follow newest", value: true },
    { key: "theme",     type: "choice", label: "Theme", value: "dark", options: ["dark", "light"] }
]);

opts.scale;                                    // stored value, already merged over the default
ACEUIModLoader.settings.get("devconsole", "scale");
ACEUIModLoader.settings.onChange("devconsole", function (key, value) { ... });
```

Declaring settings is all it takes for a way in to appear on that mod's drawer row.
Clicking it opens **that mod's own settings window** — an `ACEUIModLoader.window`, so it
is a normal draggable panel with an [X] at its top right, whose position is remembered per
mod. It can also be driven directly: `settings.open(mod)`, `.close(mod)`, `.toggle(mod)`,
`.isOpen(mod)`. Settings deliberately do *not*
unfold inside the drawer: with more than a couple of mods an inline pane pushes every row
below it down the list and the drawer stops being usable. `registerOptions` still exists
for a small bespoke pane; `registerOpener` is what the settings module uses.

Besides the value types there are two that carry no value: **`action`** is a button the
mod handles (`{ type: "action", label, button, press: fn }`) and **`info`** is a line the
mod computes (`{ type: "info", label, text: fn }`, recomputed on every repaint, so it can
show live state). Without those a mod needs a hand-built pane for a single button, which
is exactly what the settings page is meant to replace.

**Types are limited to controls this engine is known to render.** Cohtml is not a browser:
`<input type="range">` and `<select>` are unproven here, so a `range` is a pair of −/+
buttons and a `choice` cycles on click — both patterns already proven in the dev console
and DOOM. `text` uses a plain `<input>` (proven by the console prompt) and takes the
keyboard through `ACEUIModLoader.input` while focused, so typing a value cannot drive the
car.

**`key` is why this exists.** Mods that hardcode hotkeys collide with whatever the player
has bound in the game, and their bindings are not ours to shadow — so the dev console's
toggle and DOOM's show/hide key are both rebindable from the drawer.

Values are written to both stores: the HUD layout container, which the game writes to disk
and is the only thing that survives a restart, and `localStorage`, read synchronously so a
value is there the moment a mod asks for it.

## Three places to keep state

| | survives Escape/resume | survives a game restart | good for |
|---|---|---|---|
| `localStorage` | yes | **no** | anything, read synchronously |
| HUD layout container (`readHud` / `writeHud`) | yes | yes | a position, a switch, a handful of values |
| engine key/value container (`readStore` / `writeStore`) | yes | yes | state too big for the HUD layout |

The first two are what most mods need. The third exists because the HUD layout is one key
*inside* the engine's own container (`window.STORAGE`), and that container also takes
top-level keys of our own:

```js
if (ACEUIModLoader.persist.storeLoaded()) {                 // it fills in asynchronously
    const mine = ACEUIModLoader.persist.readStore("acedoom.saves");
}
ACEUIModLoader.persist.writeStore("acedoom.saves", { v: 1, slots: {} });
ACEUIModLoader.persist.removeStore("acedoom.saves");
```

Everything in it is written to `ui_storage.uistorage` in `Saved Games/ACE`, which is how a
DOOM saved game survives closing the game. Two things to know: it **fills in
asynchronously**, so a read before `storeLoaded()` sees nothing (poll it from a frame loop
rather than reading once), and `save` re-serialises and sends **every** key, not only
yours. Write rarely and keep values small - the whole file is around 17 kB before a mod
adds anything to it.

## Keeping keystrokes out of the car

A mod that takes typed input has to stop the game reading those keys as gameplay
bindings, or typing toggles headlights and wipers and the arrow keys shove the seat
about. `ACEUIModLoader.input` does that:

```js
const release = ACEUIModLoader.input.bindFocus(myTextBox, "mymod");     // a text box
const release = ACEUIModLoader.input.bindClickFocus(myPanel, "mymod"); // click to focus
ACEUIModLoader.input.capture("mymod");        // or by hand (DOOM does this while open)
ACEUIModLoader.input.release("mymod");
ACEUIModLoader.input.releaseAll("mymod");     // in detach
```

`UIMenuState` carries **two** flags and both are needed:

| `ksUI.menuState` method | flag | covers |
|---|---|---|
| `toggleKeyboardInput` | `is_chat_active` (field 10) | the text path — letters |
| `ignoreInputActions` | `ignore_gameplay_input_actions` (field 7) | bound gameplay actions |

The stock chat box only flips the first, which is why letters stop toggling car functions
but the arrow keys still move the seat — a gap in the base game that anyone copying the
chat box inherits.

`bindClickFocus` is for a panel that is not a text box: it takes the keyboard when the
pointer goes down inside the element and gives it back on a click anywhere else. That is
what lets a mod stay open without holding the keyboard hostage — DOOM can sit in a corner
while you drive, and take the keys back when you click it.

**Getting the keyboard back never depends on one key.** `ignore_gameplay_input_actions`
suppresses bound actions, and the pause action is one of them — so a capture that is never
released leaves the game with no way to open the pause menu, and because the flags live in
the game's menu state they survive the HUD reload. That happened once, from a `blur` that
never fired.

Crucially the escape hatch must respect **custom bindings**: a player who moved pause off
Escape would be stranded by a hardcoded Escape check. So the primary signal is the
player's own bound action, by name — the engine sends `UIExInputsAction` with
`e.action`, and `InputAction_UI_Menu` / `InputAction_UI_Cancel` arrive under those names
whatever key produced them. On top of that: the raw Escape key, losing window focus
(alt-tab), a fresh HUD page clearing the flags whether or not it thinks anything is held,
and `bindFocus` releasing on a click outside the element rather than trusting `blur`.

**Holders are counted, not a boolean.** The console wants the keyboard while its prompt
has focus and DOOM wants it while it is open; if the console released on blur it would
yank the keyboard out from under DOOM. The flags only drop when the last holder lets go.
Always release in detach: a mod that keeps the capture after it is gone leaves the car
unable to read its own controls.

## The app drawer

Every installed mod shows up in an **app drawer** that lives off the right edge of the
screen and slides in when the pointer reaches that edge, in the spirit of Content
Manager's app bar. Each row is a switch that shows or hides that mod, and the choice
persists across the HUD reload on Escape/resume. A mod that failed to load still gets a
row, saying why, rather than vanishing silently.

The drawer is part of the loader rather than a mod, because the loader is the only thing
that knows what is installed.

Switches are written to **both** stores: `localStorage` so a switched-off app is hidden
instantly on the Escape/resume reload, and the stock **HUD layout container**, which is
the only one the game writes to disk and therefore the only one that survives a game
restart. The HUD store appears a little after mod scripts run, so it is adopted when it
turns up and mirrored back into `localStorage`; a switch flipped in the meantime wins
over the copy from disk. The game saves that store when the HUD closes, so quitting via
Escape is what commits it.

A mod can add its own options pane, which the drawer opens from the gear on its row:

A mod should hand `mount` both halves of its lifecycle, so the drawer can really turn it
off rather than merely hide it:

```js
ACEUIModLoader.mod("telemetry").mount(ACEUITelemetry.attach, ACEUITelemetry.detach);
```

Hiding the root is not enough on its own: a hidden mod keeps its key handlers, its
frame loop and its sounds. With a detach the loader stops the mod through it, and a mod
switched off at startup is never attached at all. A mod that supplies no detach is only
hidden, which is all the drawer can do for it.

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
| `src/ACEUIModLoader.persist.js` | `ACEUIModLoader.persist` | three stores: the stock HUD layout store (`HUD.elementModified` / `HUD.StoredData`, saved by the game on HUD close), `localStorage`, and the engine's own key/value container under a top-level key of the mod's choosing: `readHud`, `writeHud`, `hudAvailable`, `readLocal`, `writeLocal`, `removeLocal`, `save(hudId, key, data)`, `storeLoaded`, `readStore`, `writeStore`, `removeStore` |
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
