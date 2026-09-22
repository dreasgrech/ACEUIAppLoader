# The surfaces the loader draws

Three things an app gets without building them: the app drawer every app appears in, a
draggable window whenever it needs a second surface, and a settings page it declares
rather than draws.

## The app drawer

Every app shows up in an **app drawer** -- installed or bundled with the loader -- that lives off the right edge of the
screen and slides in when the pointer reaches that edge, in the spirit of Content
Manager's app bar. Each row is a switch that shows or hides that app, and the choice
persists across the HUD reload on Escape/resume. An app that failed to load still gets a
row, saying why, rather than vanishing silently.

The drawer is part of the loader rather than an app, because the loader is the only thing
that knows what is installed.

At the foot of the panel is a **DEVELOPER APPS** switch, off by default. An app whose
`app.json` says `"developer": true` -- the profiler, the dev console and the capabilities
probe, which ship with the loader -- is listed only while that switch is on. It is a
master switch rather than a filter: an app it hides is stopped as well, and cannot be
brought back by its own hotkey or by `app().show(true)` while it is off (both say so in
the log). An app on the screen with no row to switch it off again is exactly what the
show/hide lifecycle exists to prevent. Each app's own switch is left untouched, so they
come back as they were -- and since an app is on unless switched off, turning developer
apps on shows them working rather than three rows that each need switching on as well.

Switches are written to **both** stores: `localStorage` so a switched-off app is hidden
instantly on the Escape/resume reload, and the stock **HUD layout container**, which is
the only one the game writes to disk and therefore the only one that survives a game
restart. The HUD store appears a little after app scripts run, so it is adopted when it
turns up and mirrored back into `localStorage`; a switch flipped in the meantime wins
over the copy from disk. The game saves that store when the HUD closes, so quitting via
Escape is what commits it.

An app should hand `mount` both halves of its lifecycle, so the drawer can really turn it
off rather than merely hide it:

```js
ACEUIAppLoader.app("telemetry").mount(ACEUITelemetry.attach, ACEUITelemetry.detach);
```

Hiding the root is not enough on its own: a hidden app keeps its key handlers, its
frame loop and its sounds. With a detach the loader stops the app through it, and an app
switched off at startup is never attached at all. An app that supplies no detach is only
hidden, which is all the drawer can do for it.

Each row's OPTIONS button opens whatever that app registered:

```js
ACEUIAppLoader.drawer.registerOpener("telemetry", function () { myWindow.open(); });
```

Declaring settings does this for you, so most apps never call it. If the opener throws,
the failure is logged and the rest of the drawer keeps working.

API: `open()`, `close()`, `toggle()`, `isVisible(name)`, `setVisible(name, on)`,
`toggleApp(name)`, `registerOpener(name, open)`, `build(apps)`.

The drawer is styled with inline styles rather than a stylesheet: the loader reaches the
page by overriding a game file, and every file the package adds changes which layouts win
that override (see [`how-it-works.md`](how-it-works.md)), so adding a stylesheet is a cost
for something inline styles already do. A script-created `<style>` element is also unproven
in this Cohtml build. Inline `transition` still animates the slide.

## Windows

Any app that needs a second surface — settings, help, a picker, a report — gets one
without hand-building a panel, wiring dragging, remembering where the player put it or
running a frame loop:

```js
const win = ACEUIAppLoader.window.open("doom.help", { title: "DOOM help" });
win.body.appendChild(myContent);      // fill it with whatever you like
win.setTitle("DOOM help (page 2)");
win.close();

ACEUIAppLoader.window.toggle("doom.help", { title: "DOOM help" });
ACEUIAppLoader.window.isOpen("doom.help");
ACEUIAppLoader.window.get("doom.help");
ACEUIAppLoader.window.closeAll();
ACEUIAppLoader.window.ids();
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

**The id is per window, not per app** — an app can have several. It is also the storage
key, so each window remembers its own position; prefix it with the app name
(`"doom.help"`, `"telemetry.laps"`) to keep them apart.

Dragging and position persistence come from `ACEUIAppLoader.panel`, which settles a
restored position over a few frames, so one shared frame loop runs while any window is
open and stops when the last one closes.

## A settings page per app

An app declares what it has; the loader stores the values, draws the controls in the app
drawer's options pane, and tells the app when something changes. The app never touches
storage or builds a form.

```js
const opts = ACEUIAppLoader.settings.define("devconsole", [
    { key: "toggleKey", type: "key",    label: "Toggle key",    value: "Backquote" },
    { key: "scale",     type: "range",  label: "Panel scale",   value: 1, min: 0.6, max: 2, step: 0.1 },
    { key: "follow",    type: "toggle", label: "Follow newest", value: true },
    { key: "theme",     type: "choice", label: "Theme", value: "dark", options: ["dark", "light"] }
]);

opts.scale;                                    // stored value, already merged over the default
ACEUIAppLoader.settings.get("devconsole", "scale");
ACEUIAppLoader.settings.onChange("devconsole", function (key, value) { ... });
```

Values live in both stores (the HUD layout store on disk, localStorage for the session).
If the HUD store is not loaded yet when an app declares its settings, its contents are
**adopted** when it appears: stored values replace the defaults and `onChange` listeners
hear about it, exactly as if the player had just moved them; a value the player changed
before that moment is newer than the disk and is written to the store instead. The same
goes for `me.remember` / `me.recall`, which keep a small value under the app's own key in
both stores -- console filters, profiler bands, DOOM's open state -- so they, too, survive a
game restart, not only the HUD reload.

Declaring settings is all it takes for a way in to appear on that app's drawer row.
Clicking it opens **that app's own settings window** — an `ACEUIAppLoader.window`, so it
is a normal draggable panel with an [X] at its top right, whose position is remembered per
app. It can also be driven directly: `settings.open(app)`, `.close(app)`, `.toggle(app)`,
`.isOpen(app)`. Settings deliberately do *not*
unfold inside the drawer: with more than a couple of apps an inline pane pushes every row
below it down the list and the drawer stops being usable. An app with something more
bespoke than a settings page registers what to open itself, with `registerOpener`.

Besides the value types there are two that carry no value: **`action`** is a button the
app handles (`{ type: "action", label, button, press: fn }`) and **`info`** is a line the
app computes (`{ type: "info", label, text: fn }`, recomputed on every repaint, so it can
show live state). Without those an app needs a hand-built pane for a single button, which
is exactly what the settings page is meant to replace.

A page with more than a handful of rows is a wall. **`section`** breaks it up: a header
that every spec after it belongs to, until the next section. Clicking the header folds
the rows under it and the loader remembers which sections are folded, per app, in the
same two stores as the values (only the HUD layout store survives a game restart). A section
with `columns: 2` (or `3`) lays its rows out side by side, which halves a run of toggles;
`collapsed: true` starts it folded until the player opens it.

```js
{ key: "inputs", type: "section", label: "Inputs", columns: 2 },
{ key: "showThrottle", type: "toggle", label: "Throttle", value: true },
...
{ key: "demo", type: "section", label: "Demo", collapsed: true },
```

**A pane that reads as a form, not a wall.** The default pane is one control per row in a
narrow window with a hint under every row, which is right for a handful of settings and
wrong for twenty. Three things, all opt-in so an app drawn the old way is unchanged, turn it
horizontal:

```js
ACEUIAppLoader.settings.define("betterdeltabar", [
    { key: "shape", type: "section", label: "Layout", columns: 2 },
    { key: "layout", type: "choice", label: "Layout", value: "full", options: ["full", "compact"],
      segmented: true, hint: "full: the figure on the bar; compact: a thin bar" },
    ...
    { key: "show", type: "section", label: "Show", flow: "chips" },
    { key: "showArrows", type: "toggle", label: "Trend chevrons", value: true },
    ...
], { width: "36rem", hints: "footer" });
```

- `define`'s third argument sets the pane's **width** (the window opens at it) and puts the
  **hints in a footer**: one line at the foot of the pane showing the hint of whatever row
  the pointer is over, with the reset button beside it, instead of a line under every row.
- A choice with **`segmented: true`** shows every option at once as a row of joined pills,
  the current one lit, so the alternatives are visible without cycling. Options are shown
  with a capital (`full` reads `Full`); `labels: { full: "Full layout" }` names them
  otherwise. Keep it for a handful of short options; a long list still wants the cycle.
- A section with **`flow: "chips"`** draws its toggles as chips in a wrapping row, the
  label inside the pill, lit green when on. Anything in the section that is not a toggle
  is drawn as an ordinary row.

The Better Delta Bar's pane is the reference: five sections, two controls to a row, a row
of nine chips, and no hint text until you point at something.

**`order`** is a list the player reorders by dragging a row. Its value is the array of
item keys, top first, stored and reset like any other value; a stored list is made whole
on load (unknown keys dropped, an item the app added since appended), so it is always a
permutation of `items`. The drag is mouse events, not HTML5 drag-and-drop, which this
engine is not known to support.

```js
{ key: "stack", type: "order", label: "Draw order", value: ["gas", "brake"],
  items: [{ key: "gas", label: "Throttle" }, { key: "brake", label: "Brake" }] }
```

Any row, and any `order` item, can carry a **`swatch`** drawn before its label: a colour
(`swatch: "#44ea78"`), or `{ className, attrs }` for an app whose colours live in its
stylesheet, which then keys on them (PedalGraph puts `data-trace` on it). A section of
switches named after coloured things is skimmed by colour rather than read.

**Types are limited to controls this engine is known to render.** Cohtml is not a browser:
`<input type="range">` and `<select>` are unproven here, so a `range` is a pair of −/+
buttons and a `choice` cycles on click — both patterns already proven in the dev console
and DOOM. `text` uses a plain `<input>` (proven by the console prompt) and takes the
keyboard through `ACEUIAppLoader.input` while focused, so typing a value cannot drive the
car.

**`key` is why this exists.** Apps that hardcode hotkeys collide with whatever the player
has bound in the game, and their bindings are not ours to shadow — so the dev console's
toggle and DOOM's show/hide key are both rebindable from the drawer. Clicking the control
waits for a key; Escape or a click anywhere else cancels, because a control that could only
be escaped by pressing *some* key would swallow whichever one you pressed next.

Values are written to both stores: the HUD layout container, which the game writes to disk
and is the only thing that survives a restart, and `localStorage`, read synchronously so a
value is there the moment an app asks for it.
