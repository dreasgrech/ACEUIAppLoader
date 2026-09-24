# Writing an app

An app is one folder and an empty marker file. No registration step, no manifest to edit, nothing to rebuild. `python tools/new_app.py <name> --title "Nice Name"` writes the folder, a preview page, a harness and a test file that runs the shared kit.

```
myapp/
  app.json
  myapp.js
  myapp.css
```

## app.json

It holds only what cannot be inferred:

```json
{ "version": "0.4.0", "styles": ["myapp.css"], "scripts": ["myapp.js"] }
```

The app's name is its folder's, and its marker's. Everything else is optional:

| key | |
|---|---|
| `title` | the log prefix; defaults to the name |
| `pages` | which pages to load on; defaults to `["hud.html"]`, `"*"` means every page |
| `files` | other plain file names the app fetches itself, a `.wasm` say — copied by the install tool, never injected |
| `root` | `false` for no root element |
| `developer` | `true` for a tool rather than something a player installed for fun: the app drawer keeps it behind its `DEVELOPER APPS` switch |
| `name` | must equal the folder if given |

Scripts run in order as classic scripts, and the loader waits for each before adding the next.

**Never request a URL that could be a folder.** The loader only ever asks for the plain file
names an `app.json` lists, and refuses anything with a separator in it, because the game's
loose-file lookup accepts a folder as a hit and then dies opening it -- three launches
proved it. An app that fetches its own `files` inherits that rule: fetch `me.base + "name.ext"`,
never a path built from anything a player could have typed, and never a name without an
extension. A missing file is harmless (one warning in the log); a folder is fatal.

## The lifecycle

Before your scripts run, the loader creates the app's root — `<div id="<name>" data-app="<name>">` — inside the HUD's positioning container. `ACEUIAppLoader.app("<name>")` then tells the app who it is, so its script declares none of it:

```js
const me = ACEUIAppLoader.app("myapp");

const attach = function (root) {
    const state = create(root);
    state.ui = me.panel(root, function (now) { tick(state, now); });   // panel + frame loop
    return state;
};

const detach = function (state) {
    state.ui.stop();                  // stops the loop and releases the panel's listeners
};

me.mount(attach, detach);
me.toggle(function () { return options.toggleKey; });   // shows and hides the app
```

| field | value |
|---|---|
| `name`, `title`, `version` | from the folder and `app.json` (`version` is `"dev"` on pages the loader did not load the app on, e.g. a preview) |
| `root` | the `#<name>` element |
| `log`, `prefix` | a logger writing `[Title] ...` |
| `hudId`, `storageKey`, `key(suffix)` | `hud_<name>`, `ace<name>.pos`, `ace<name>.<suffix>`: the HUD layout id and storage keys for `ACEUIAppLoader.panel` / `.persist` |
| `base`, `loaded` | the app folder's URL — whichever root it came from, bundled or installed; whether this loader instance loaded it |
| `developer` | whether its `app.json` calls it a developer tool |
| `panel(root, onFrame)` | the whole widget lifecycle: a draggable panel that remembers its position plus the frame loop that drives it. Returns a handle with `panel`, `loop` and `stop()` (safe to call twice) |
| `scale(root, {min, max, step, onScale})` | panel scale: one `font-size` in rem on the root, everything inside in em. Applies it, clamps it, follows the app's own `scale` setting when it declared one — so a −/+ button and the settings window move the same value — and remembers it either way. Returns `{ value, set, nudge, bounds, stop }` |
| `scaleSpec({label, value, min, max, step})` | the settings spec for that scale, to drop into the app's own `define` call |
| `recall(key, fallback)`, `remember(key, value)`, `forget(key)` | a small value under the app's own key, for state that must survive the HUD reload on Escape/resume |
| `mount(attach, detach)` | calls `attach(#<name>)` once the DOM has the root, once per root, and logs the app's script-loaded line. Passing `detach` is what lets the app drawer really stop the app. Make `attach` all or nothing: if it throws, release whatever it had already set up before rethrowing, because the loader then treats the app as not started and the drawer's switch can start it again |
| `show(on)`, `shown()` | switch this app on or off exactly as the drawer's own switch does — root hidden, app stopped through its `detach`, started again on the way back |
| `toggle(getKey)` | bind a key that shows and hides this app, for as long as the page lives. Returns an unbind |

## Two rules that fail quietly

**A close button is `me.show(false)`, not a class on the root.** "Closed" and "switched off in the drawer" were two different states until 0.18.0: closing the profiler left it running and invisible with the drawer still saying it was on, and the only way back was a hotkey the panel itself was holding. They are one state now. The side effect is the honest one — closing an app stops it, so a profiler recording ends with its panel.

**The hotkey belongs to the loader, not the app.** `me.toggle()` hands it over, because an app that is switched off is not running to hold anything — which is exactly when the key is needed.

`me.panel` owns two more that used to be every app's to remember: the panel must be ticked every frame until its stored position settles (miss it and the widget never returns to where the player left it), and the frame loop must be stopped in `detach` (miss it and an app switched off in the drawer keeps running for ever).

## Do not write these twice

Five things every panel in this project needed, and that two or three apps had each grown their own copy of before they moved into the library. If you are about to write one of them, it is already here:

| you want to | use |
|---|---|
| scroll a list (Cohtml ignores `overflow: auto`) | `ACEUIAppLoader.scroll.attach(...)` |
| a hotkey that respects the player's setting and stays out of text boxes | `ACEUIAppLoader.keys.bind(...)` |
| recognise a key the engine may report three ways | `ACEUIAppLoader.keys.is(e, "Backquote")` |
| let go of every listener in `detach` | `ACEUIAppLoader.dom.listeners()` |
| a switch, a slider, a hotkey or a button in your own settings window | `ACEUIAppLoader.settings.define(...)` |
| a draggable panel that remembers where it was, and its frame loop | `ACEUIAppLoader.app("x").panel(root, onFrame)` |
| keep a small value across the Escape/resume reload | `me.remember(key, value)` / `me.recall(key, fallback)` |

The last one matters most: a declared setting is stored in both stores, drawn in the app's own window, reachable from the app drawer, and announced to the app when it changes. A hand-built toggle is markup, a class, a click handler and a storage key that you then have to keep in step — which is what PedalGraph's attract mode was until it became four lines of `define`.

## Naming your own work

A profiler can see what the page schedules — animation frames, timers, events — because those go through globals it can replace. It cannot see inside your frame callback: those are closures in your IIFE, so the best it can say on its own is "this app cost 2 ms". Name the parts worth separating and it can say where the 2 ms went:

```js
ACEUIAppLoader.section("render", function () { renderFrame(state, v, frac); });
```

Sections nest, so a section inside a section is a child in the tree. With no profiler attached this is a property read and a call through, which is all an app pays for being profilable when nobody is profiling it.

## Installing it

```
python tools/install_app.py <repo>/<name>
```

copies the folder into `Saved Games\ACE\mods\uiresources\ACEUIAppLoader\` and writes the empty marker. Escape and resume in the car reloads the HUD and picks up changes.

`ACEPedalGraph` is the reference app; `apps/devconsole` and `apps/profiler` are the same shape one level in.

Reference: [`library.md`](library.md) for the primitives, [`ui.md`](ui.md) for the drawer, windows and settings, [`style.md`](style.md) for the rules the test kit enforces.
