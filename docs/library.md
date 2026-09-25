# The library

One global, `ACEUIAppLoader` (also `window.ACEUIAppLoader`), one namespace per file, loaded
in the order below because each builds on the previous. Apps only ever talk to
`ACEUIAppLoader.*`.

The surfaces the loader draws for you -- the app drawer, windows and a settings page per
app -- are in [`ui.md`](ui.md); the app lifecycle is in [`writing-an-app.md`](writing-an-app.md).

## The namespaces

| File | Namespace | What it gives apps |
|---|---|---|
| `src/ACEUIAppLoader.core.js` | `ACEUIAppLoader` | `VERSION`, `page`, `log`, `logger(prefix)`, `clamp`, `el`/`close` (markup strings), `toArray`, `percentText`, `errorText(e)`, `safely(what, fn)`, `otherButton(e)` (a middle or right press or release; anything else counts as the left), `RIGHT_BUTTON`, `HUD_PAGE`, `section(name, fn)` (names a piece of work for a profiler; a call through when none is attached), `hudHidden()`, `closestWithAttribute`, `HUD_HIDDEN_CLASS` |
| `src/ACEUIAppLoader.console.js` | `ACEUIAppLoader.console` | hooks `console.log/info/debug/warn/error` before the stock bundle runs (originals still called, nothing echoed), ring buffer of the last 500 `{seq, t, level, text}` entries, uncaught errors and unhandled rejections captured, `entries()`, `subscribe(fn)`, `capture(level, text)`, `clear()`, `format(value)`. The tail is mirrored to `localStorage` and restored on load, so the buffer survives the HUD page reload that Escape and resume cause -- the lines you reloaded to go and read. Restored entries are marked `carried`, and `carriedCount()` says how many; `save()` writes immediately, which ordinary logging does on a timer. It keeps its own `localStorage` calls rather than using `persist`, because it loads first, on purpose, so that it catches what every later module logs |
| `src/ACEUIAppLoader.dom.js` | `ACEUIAppLoader.dom` | `make(tag, props, text)` / `div`, `css`, `setClass`, `clear`, `on(target, type, fn)` returning its own undo, `listeners()` -- a bag whose `off()` drops every listener it added -- and `THEME`, the one palette every loader-drawn surface uses |
| `src/ACEUIAppLoader.keys.js` | `ACEUIAppLoader.keys` | `is(e, name)` (matches `code`, the character `key` sends, and the legacy `keyCode` the stock bundle reads), `nameOf(e)`, `isTyping(e)`, `bind(keyOrGetter, handler)` -> unbind: a hotkey that follows a key kept in settings and never fires while the player is typing; `CODES`, `ALIASES` |
| `src/ACEUIAppLoader.scroll.js` | `ACEUIAppLoader.scroll` | `attach({body, track, thumb, follow, nofitClass, draggingClass, onFollow})`: the wheel (whose sign Cohtml inverts), a thumb written only when its geometry changes, click-to-jump on the track, drag on the window (both the left button only), and the follow-the-newest rule; `sync`, `scrollBy`, `toBottom`, `setFollow`, `invalidate`, `detach` |
| `src/ACEUIAppLoader.persist.js` | `ACEUIAppLoader.persist` | three stores: the stock HUD layout store (`HUD.elementModified` / `HUD.StoredData`, saved by the game on HUD close), `localStorage`, and the engine's own key/value container under a top-level key of the app's choosing: `readHud`, `writeHud` (false when the store is not there or throws, logged once per record when it throws; `save` and the loader's own writers also write localStorage, which keeps the change), `hudAvailable`, `readLocal`, `writeLocal`, `removeLocal`, `save(hudId, key, data)`, `whenHudReady(cb, {pollMs, waitMs, onTimeout})`, `storeLoaded`, `readStore`, `writeStore`, `removeStore` |
| `src/ACEUIAppLoader.panel.js` | `ACEUIAppLoader.panel` | `attach(root, {hudId, storageKey, log, onSaved, onRightClick, settle, placed})`: drag inside the HUD container with the left button (a window moved within `DRAG_SLOP_PX` is a click and goes back), clamped; `settle` (windows) shows the root once laid out and keeps it on screen as it grows, and at its share of the screen when that is resized; `placed` (an owner-placed spot) restores only a position the player dragged to, which `savePosition(panel, dragged)` marks `dragged` (it stores nothing and returns null while the container has no size, the UI hidden), and places afresh otherwise; `moveTo` returns the `{ x, y }` it wrote; position persisted as screen fractions; hidden until the stored position is applied (immediate `localStorage`, then the HUD store has the last word in `update(panel, now)`; a window prefers a position the player dragged it to, from either store); `data-nodrag` on descendants that must not start a drag; a right-button press calls `onRightClick(e)` except inside `data-noright` (`NO_RIGHT_ATTR`, the root included), after a `preventDefault` inside the panel, or while the left button is held (`leftHeld()`), and keeps a browser's menu off only when `onRightClick` returned true or the left button is held; the click after the release of a middle or right press made on the panel presses nothing inside it (outside `data-noright`), and `guardClicks(root)` gives another element that rule (the app drawer), returning a release that works once; `detach` |
| `src/ACEUIAppLoader.loop.js` | `ACEUIAppLoader.loop` | `start(onFrame)` / `stop(handle)`; `sampler(hz, maxGapMs)` + `advance(sampler, now, onSample)` for fixed-rate sampling independent of frame rate, returning the 0..1 fraction towards the next sample |
| `src/ACEUIAppLoader.shared.js` | `ACEUIAppLoader.shared` | what one app offers another: `register(name, api)`, `unregister`, `get(name)` (null when that app is not there), `has`, `names()`. A table rather than a global each, because the names collide -- `ACEUIAppLoader.console` is this library's console hook, so the dev console could never have had it. An app is registered only while it is loaded and switched on, so `has` is the only honest way to ask |
| `src/ACEUIAppLoader.loader.js` | `ACEUIAppLoader.loader` | app discovery through the game's video preset list plus the apps bundled in the package, the `engine.on` wrapper that hides markers from the stock presets menu, root creation, app injection, `app(name)`, `isDeveloper(name)`; aliases `ACEUIAppLoader.app`, `.ready(cb)`, `.apps`, `.addScript`, `.addStylesheet`, `.ROOT` |

## Three places to keep state

| | survives Escape/resume | survives a game restart | good for |
|---|---|---|---|
| `localStorage` | yes | **no** | anything, read synchronously |
| HUD layout container (`readHud` / `writeHud`) | yes | yes | a position, a switch, a handful of values |
| engine key/value container (`readStore` / `writeStore`) | yes | yes | state too big for the HUD layout |

The first two are what most apps need. The third exists because the HUD layout is one key
*inside* the engine's own container (`window.STORAGE`), and that container also takes
top-level keys of our own:

```js
if (ACEUIAppLoader.persist.storeLoaded()) {                 // it fills in asynchronously
    const mine = ACEUIAppLoader.persist.readStore("acedoom.saves");
}
ACEUIAppLoader.persist.writeStore("acedoom.saves", { v: 1, slots: {} });
ACEUIAppLoader.persist.removeStore("acedoom.saves");
```

Everything in it is written to `ui_storage.uistorage` in `Saved Games/ACE`, which is how a
DOOM saved game survives closing the game. Two things to know: it **fills in
asynchronously**, so a read before `storeLoaded()` sees nothing (poll it from a frame loop
rather than reading once), and `save` re-serialises and sends **every** key, not only
yours. Write rarely and keep values small - the whole file is around 17 kB before an app
adds anything to it.

## Keeping keystrokes out of the car

An app that takes typed input has to stop the game reading those keys as gameplay
bindings, or typing toggles headlights and wipers and the arrow keys shove the seat
about. `ACEUIAppLoader.input` does that:

```js
const release = ACEUIAppLoader.input.bindFocus(myTextBox, "myapp");     // a text box
const release = ACEUIAppLoader.input.bindClickFocus(myPanel, "myapp"); // click to focus
ACEUIAppLoader.input.capture("myapp");        // or by hand (DOOM does this while open)
ACEUIAppLoader.input.release("myapp");        // and in detach
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
what lets an app stay open without holding the keyboard hostage — DOOM can sit in a corner
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
Always release in detach: an app that keeps the capture after it is gone leaves the car
unable to read its own controls.
