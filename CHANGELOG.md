# Changelog

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
