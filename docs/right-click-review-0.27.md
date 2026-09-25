# Right-click for options (loader 0.27.0): review record and what is left

Status on 2026-09-25: the feature is built, documented and tested, and every repo's suite passes. Nothing is committed, built or installed yet. The review loop was stopped by choice after round 13 (see "Why the loop stopped"). This file is the record of that work; keep it, fold it into the investigation log, or drop it before committing.

## What 0.27.0 does

- A right-click on an app's panel opens that app's settings window beside it; a right-click on the app or on the window closes it again. Placed beside the app each time until the player drags the window, then it opens where it was dragged.
- Opt-outs: `define(app, specs, { rightClick: false })` (the whole app), `{ rightClickCloses: false }` (the window's own right-click only), `me.panel(root, onFrame, { rightClick: false })` (one panel), `data-noright` on an element or the root (a part that uses the right button itself), `preventDefault` on the press inside the panel.
- Player switch: the drawer's *Right-click an app for its options* (on by default), in its "Apps" section.
- Only the left button drags; middle and right releases do not end a drag.
- DOOM 0.6.1 marks its screen `data-noright` (right-click is "use") and lets its held key go on blur, close, and any release but a right one while fire is held.
- The capabilities probe 0.6.0 has a "right button" row that measures what the engine does (see "Open questions only the game can answer").
- Along the way: windows stay on screen as sections unfold and fold back to their spot; a windowed resize keeps a window at its share of the screen; hiding the UI mid-drag no longer moves anything; settings and folds are read from both stores key by key; a failed HUD store write is caught and logged; a right-click's click presses no control (the click rule, below).

Full list: `CHANGELOG.md`, 0.27.0. Author docs: `docs/ui.md` (settings page, ways-out table, click rule), `docs/library.md`, `docs/writing-an-app.md`.

## Test state at the stop

| Suite | Result |
|---|---|
| Loader library harness (`python -m unittest tests.test_lib_browser`) | 270/270, plus 4 reload pages (2 each) and `first-panel.html` (1): 279 |
| Loader, everything (`python tools/run_tests.py`) | 4 suites, 0 failed |
| Capabilities probe | 16/16 |
| DOOM (`python -m unittest tests.test_app`) | 21/21 |
| BetterDeltaBar | 153/153 |
| PedalGraph | 31/31 |
| Telemetry | 12/12 |

Mutation testing: every deliberate bug planted in the code changed since round 7 is caught by a test (the last focused run: 92 mutants, the 16 survivors got killing tests, all added). Style check, `git diff --check` and the duplicate-title check are clean. No headless browser or test process is left running.

## How it was reviewed

Thirteen rounds of up to ten independent reviewers, each with its own angle: input events, lifecycle and state, placement geometry (every painted frame, three frame-lag settings, four resolutions), API and docs, the player switch, compatibility and release, test quality (mutation testing), style, robustness, and end to end in the real apps with real mouse input. After each round the findings were fixed, tested and mutation-checked before the next round.

- Rounds 1 to 7 found real problems: windows placed off screen or jumping when shown, drags that never ended, DOOM's "use" key stuck, settings lost across Escape/resume, the hide-UI key throwing panels into the corner, folds depending on which store turned up first.
- From round 8 on, nearly every finding was in the click rule and depended on engine behaviour nobody has measured (below). Round 8 added a store for refused HUD writes; round 9 removed it again after showing the stock store cannot refuse a write once it is readable (its layout is "default" from the start).
- Last round each angle came back clean: geometry (rounds 9, 10), lifecycle (round 10), end to end (round 11), player switch, API/docs and compatibility (round 12, compatibility with one nit). Input, robustness, style and test quality found something every round, most recently small edge cases and test gaps.

## Why the loop stopped

The goal was a round where all ten angles come back clean on the same code. Round 13 did not get there: its first wave (input, lifecycle, robustness) found only small edge cases, its test-quality reviewer found test gaps (now filled), and geometry and end to end were stopped part way. Running ten reviewers at once made the PC unresponsive; the lighter waves still loaded it noticeably. The remaining findings are about how the game's engine delivers right-button events, which more rounds in headless Chrome cannot settle. One game session with the probe can.

## What is left

### 1. Build and install (game closed)

The installed package is stale: `Saved Games\ACE\mods\...\ACEUIAppLoader.kspkg` is a build from before round 1, and DOOM's files in the game folder are from round 0. Nothing in game today is this code.

- Close the game, then in `ACEUIAppLoader`: `python tools/build_loader.py --dups=auto --install`.
- Copy DOOM's updated files into `Saved Games\ACE\mods\uiresources\ACEUIAppLoader\doom` and compare them afterwards (never `cd` into the installed app folder).

### 2. In-game checks

- Right-click each app (BetterDeltaBar, PedalGraph, DOOM's title bar, the probe, the dev console, the profiler): the window opens beside it; a second right-click on the app, or one on the window, closes it. Drag the window, close it, right-click: it opens where it was dragged. Escape/resume: an open window comes back where it was.
- The drawer's *Right-click an app for its options* off: right-clicks do nothing; on again: they work.
- DOOM: right-click on its screen is "use" and opens nothing; fire held while tapping right keeps firing; alt-tab with a key held lets it go.
- Unfold a section of a window near the bottom of the screen: it moves up; fold it: it goes back.
- Hide the UI (the stock key) while dragging a panel, let go, show it: nothing moved, nothing stored.
- **The probe (DEVELOPER APPS, Capabilities Probe): right-click a few times, left-click, drag something, then re-run and read the "right button" and "mouse buttons field" rows.** This answers the open questions below. Send the row texts back.
- `python tools/check_ingame_log.py` for errors afterwards.

In-game results so far (2026-09-25, logs `log-260925-182422.txt` and `log-260925-182627.txt`, locally installed build of the release code):
- `check_ingame_log.py` RESULT OK: loader 0.27.0 on 6 pages, all 7 apps on the HUD, DOOM 0.6.1, no crashes beyond the usual driver exceptions; "Text transformation" 0 and "alignItems" 0.
- 12 right-clicks on BetterDeltaBar and the probe each opened or closed the options once, in strict alternation: a right press reaches the page as `e.button === 2`.
- The options window reopened at its stored spot every time (BetterDeltaBar) and was placed beside the app and stored (the probe); two drags of the probe ended and saved on release.
- No setting changed and no control was pressed around the right-clicks.
- Second session (`log-260925-183144.txt`, the step-by-step list): left clicks on a toggle right after a right-click all responded (BetterDeltaBar's attract toggle flipped six times); the window reopened at its dragged spot and came back open at it after Escape/resume; a right-click on the window closed it; PedalGraph's and DOOM's options opened and closed by right-click with DOOM running. Not visible in the log (they are never logged): section folding, DOOM's screen right-click and alt-tab, the drawer switch itself.
- **The probe's answer** (full report, 18:37:11): "right button = yes -- 14 right-button press(es), cancelable true. e.button seen: 0, 2; right releases 14, left releases reported as another button 0, right clicks 0, clicks after a middle or right release 0, right clicks after their release's task 0, contextmenu events 0"; "mouse buttons field = yes -- e.buttons = 1 on the last press, 0 on the last release". The engine sends no click and no contextmenu for the right button, and releases report their button correctly: the click rule never acts in game (a guard only), and none of the accepted misreported-release cases below can occur. Recorded in `ACEGameInternals/docs/gameface-notes.md`.

### 3. Open questions only the game can answer (answered 2026-09-25, above: no right-button click, releases report their button, `e.buttons` present)

- Does the engine send a `click` for a right or middle press at all? (Chrome does not.) If it does not, the click rule never acts in game and is a harmless guard. If it does, the row says whether it arrives in the release's own task (the rule catches it) or later (a WARN: the rule cannot).
- What `e.button` does a release report, and does a left release ever report another button (WARN: left drags would not end)?
- Does a release carry `e.buttons` (shown in the mouse-buttons row)?

### 4. Release

- Commit in each repo (the user commits, pushes and tags): ACEUIAppLoader (includes the new, untracked `tests/lib/first-panel.html`, which the release scripts need committed since they refuse a dirty tree), ACEDOOM, and the one-line README edits in ACEBetterDeltaBar and ACEPedalGraph.
- Release DOOM 0.6.1 with or before loader 0.27.0: without it, a right-click on DOOM 0.6.0's screen can also open its options (the CHANGELOG and README say so). DOOM's release gate runs its tests against the loader next to it, which must be 0.27.
- DOOM 0.6.1: re-run `tools/release_sound.py` and attach `ACEDOOM-sound-0.6.1.zip`.
- Push the BetterDeltaBar and PedalGraph README lines ("with ACE UI App Loader 0.27.0 or newer") with or after the loader release. Their release zips do not carry the README, so no version bump is needed; rebuild BetterDeltaBar's dist zip after its commits.

### 5. Optional, if more review is wanted

- Re-run the input, lifecycle and robustness angles on the final code (round 13's first wave reviewed it before its own fixes), and the geometry and end-to-end angles that were stopped. Run them two or three at a time, one browser each.
- Round 13's end-to-end reviewer was checking a Space-key case when it was stopped: Space held across a right-click did not click a button, a stock button included, so it looks like Chrome's own behaviour; unconfirmed.

## Accepted limitations (decided during the review, not changed)

Input and the click rule:
- Mouse side buttons (3/4) and presses with no button field count as the left button (deliberately failing open).
- The click rule lasts until a 0 ms timer after the release (a key or a left release disarms it sooner). A click the engine sends later passes, as in 0.26; the probe WARNs if that happens.
- When a right press shuts its own window, the click that follows is swallowed anywhere for that release's task.
- A right press held across a blur or dragend, then released on a panel, is not swallowed.
- With an engine that reports every release as the left, a chord whose right is let go first takes the left's click.
- A right release lost without any blur leaves its press set until the next press of that button.
- After a right press that acted with no `contextmenu` following, a keyboard-invoked browser menu is kept off once (browser preview only).
- A panel root inside a shadow tree is outside the click rule (nothing uses shadow DOM).
- A stuck app drag after a lost release follows the pointer until the next left click (pre-0.27); a window blur does not end a panel drag.
- A right-click in a text input toggles the window (the engine has no native menu); a right press on DOOM's title bar also gives DOOM the keyboard (as in 0.26).

Placement:
- One painted frame of overflow when a section unfolds (the engine's layout reads lag a frame).
- A window opened at rem/px or right/bottom spots with nothing stored keeps its share on a resize while a reload re-measures those spots (only settings windows open windows, with exact spots).
- App panels keep their px on a windowed resize (as 0.26).

Storage:
- A HUD store write that throws is logged and the change lives in localStorage only, so the store's record wins at the next HUD load (unreachable with the stock store).
- The drawer's own settings pane also closes on a right-click while the switch is on (documented).

Compatibility:
- DOOM 0.6.0 is only partly covered on loader 0.27 (update DOOM with the loader; no app-name special case in the loader).
- `panel.leftHeld()` stays exported as a read-only accessor.

## Where the working files were

The review's scratch work (round summaries `round1_fixed.md` to `round13_fixed.md`, the review brief, every reviewer's harness pages and scripts) is in the background job's temp folder, `C:\Users\User\.claude\jobs\c44617e9\tmp\`, which is deleted with the job. The design decisions and accepted items from those summaries are collected above.
