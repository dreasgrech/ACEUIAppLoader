# Changelog

## 0.27.0 — 2026-09-25

### Right-click for options
- Right-click an app to open its options window beside it; right-click the app or the window again to close it.
- The window opens beside the app each time, kept on screen; after Escape/resume it comes back where it was.
- Drag the window somewhere and it opens there from then on.
- A window spot saved by an earlier version no longer pins the window: the next right-click places it beside the app.
- A window growing past the edge of the screen (a section unfolded) moves back inside, and back where it was when the section folds again.
- A window keeps its share of the screen when the game window is resized.
- Hiding the UI in the middle of a drag no longer moves the panel or window.
- Drawer option "Right-click an app for its options" (on by default) turns it off for every app. While it is on, the drawer's own options close on a right-click too.
- DOOM before 0.6.1 also opens its options on a right-click on its screen: update DOOM with the loader.
- The middle and right buttons no longer drag, or end a drag of, panels, windows, scrollbars or order rows, nor open the drawer during a drag.
- "Click at edge" opens the drawer on a left click only.
- A click that moves a window by a pixel or two no longer counts as a drag; it goes back where it was.

### For app authors
- `define(app, specs, { rightClick: false })` turns it off for the app; `{ rightClickCloses: false }` keeps the window open on its own right-click.
- A later `define` layout that leaves those two out keeps them.
- `me.panel(root, onFrame, { rightClick: false })` keeps one panel out of it.
- `data-noright` on an element (or the panel root) keeps its right-clicks, and `preventDefault` in a listener inside the panel keeps its right press.
- New in settings: `open(app, near)`, `rightClick`, `rightClickable`, `rightClickWindow`, `besideSpot`, `stored`, `BESIDE_GAP_REM`, `WINDOW_WIDTH`.
- New in window: options `right`, `bottom`, `onRightClick`, `placed`; `container()`, `BORDER_PX`. Windows show once laid out.
- New in panel: options `onRightClick` (returns true when it acted), `placed`, `settle`; `NO_RIGHT_ATTR`, `DRAG_SLOP_PX`, `leftHeld()`, `guardClicks(root)`.
- Panel: a position stored after a drag is marked `dragged` (`savePosition(panel, dragged)`, which stores nothing and returns null while the UI is hidden); `moveTo` returns the `{ x, y }` it wrote.
- New in core: `otherButton(e)`, `RIGHT_BUTTON`, `HUD_PAGE`. New in drawer: `rightClickOn()`.
- Stored settings and folded sections are read from both stores key by key, so a setting newer than an app's HUD record keeps its value.
- A damaged settings or folds record is ignored, and one app's cannot keep another's from being adopted.
- `persist.writeHud` returns false when the HUD store's write throws, logged once per record; `save` and the loader's own writers keep the change in localStorage.
- The click after a middle or right press on a panel or the drawer presses nothing (only `data-noright` exempts a part).
- `errorText` and `safely` no longer throw on an error that cannot be printed.
- A browser's own drag and drop does not start inside a panel (except in a `data-nodrag` part), nor anywhere while one is being dragged.
- Off the HUD page a window no longer waits for a HUD store before it shows.
- A redefine while the app's window is open redraws it: new controls, width and title.
- 279 library browser cases.

### UI Capabilities Probe 0.6.0
- New "right button" row: what right presses and releases report, whether a click or `contextmenu` follows, and a WARN if a right click comes too late; the mouse-buttons row also shows the last release's `e.buttons`.

## 0.26.0 — 2026-09-24

Includes 0.25.0, which was never published.

### App drawer
- Opens when the mouse comes near the edge instead of on a 10px strip. The zone scales with the screen (2rem: 32px at 1080p, 43px at 1440p) and is adjustable up to 10rem.
- Zone can be limited to the top, middle or bottom third of the edge, with an optional dwell.
- Three ways to open: hover, "Click at edge" or "Hotkey only".
- Hotkey to toggle the drawer (unbound by default, Delete unbinds).
- "Close after" sets how long it waits before closing.
- "Always open" pins the drawer; PIN button in the header does the same.
- Can sit on the left edge.
- Width, top/bottom insets, scale and opacity are settings.
- Motion: slide, fade or none.
- Red edge line lights up when the mouse gets near; shown for 4 s after every HUD load. Can be set to always or off.
- The zone is drawn as a red box while the drawer options are open, and the drawer stays open meanwhile.
- Mouse leaving the game window to another monitor no longer opens the drawer.
- Triple screen (experimental) and Edge offset settings.
- App list scrolls when it is longer than the panel.
- Hidden HUD closes the drawer; dragging a panel to the edge does not open it; clicking outside closes it unless it is pinned.
- The hotkey closes a pinned drawer and unpins it.
- Opened with the hotkey, it waits for the mouse to reach it before closing by itself.
- All settings clamped on apply; Reset to defaults in the pane, `ACEUIAppLoader.drawer.resetSettings()` from the dev console.
- New README troubleshooting entry: "The drawer is there but I can't open it".
- Logs `[drawer] built: right, zone 2rem (43px), 1rem = 21.33px, viewport 2560x1440, trigger hover` once per load.

### Windows
- Windows left open through Escape/resume or a restart come back, on the page they were opened on.
- A window closed by hand stays closed.
- Each page keeps its own list, so a window used on a menu page no longer wipes the HUD's.

### Settings windows
- Panes can be wider, use 2 or 3 columns, show choices as pills, toggles as chips, hints in a footer, and hide rows that don't apply. Opt-in; old panes unchanged.
- Range settings can show a unit ("2 rem", "350 ms").
- Key settings can be unbound.

### UI Capabilities Probe 0.5.0
- New "Pointer & screen" category.
- Model recorder: logs what the HUD telemetry models do over a session (`rec:` lines). Keeps going through Escape/resume and game restarts until switched off.

### Fixes
- An app whose start-up threw stayed marked as running and could not be started or stopped again.
- A toggle setting with a non-boolean stored value read as on.
- Settings panes wrote "Trying to set display property to invalid value!" to the game log every time they opened.
- Log check: a preset-list retry that succeeds is a note; the give-up line on the HUD is a failure; each HUD load is checked on its own; app names listed once.
- A panel with no parent element no longer throws.
- A drawer switch flipped right after a game start no longer wipes the other saved switches.
- The headless test runner can no longer hang after a timeout and leave a browser running.

### For app authors
- `settings.define(app, specs, layout)`: `width`, `hints: "footer"`, `title`. Sections: `columns: 2|3`, `flow: "chips"`. Choice: `segmented`, `labels`. Range: `unit`. Key: `empty`. Any spec: `when(app)`. See `docs/ui.md`.
- `window.reopen(id, fn)`, `discard(id)`, `discardAll()`.
- Drawer API: `setPinned`, `isPinned`, `resetSettings`, `metrics`, `inZone`, `inPanel`, `applyLook`.
- An app's `attach` should be all or nothing: if it throws, the drawer can start the app again.
- App kit rejects `display: inline-flex` and `inline-block` (not supported by the engine).
- `MIN_CASES` counts all of an app's harnesses together.
- The test doubles' `near()` fails on NaN (a transform never written used to pass).
- `release_app.py` says so when given a folder that is not an app.
- New library tests for reloads after Escape/resume and after a restart. 135 browser cases.

## 0.24.0 — 2026-09-21

First public release. Built for game `0.9.1+release.6`.
