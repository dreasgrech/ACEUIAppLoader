# Capabilities Probe

A capability probe for the Assetto Corsa EVO HUD. One of the loader's **developer apps**: it ships inside `ACEUIAppLoader.kspkg`, and the app drawer keeps it behind the `DEVELOPER APPS` switch that is off by default.

It exists to answer one question before anything ambitious gets built on the HUD: **what can JavaScript actually do inside the game's Cohtml/V8?** The game runs V8 9.4 started with `--noexpose_wasm`, in a Cohtml sandbox with no Web Audio and no video demuxers — so the browser is not a reliable guide. This runs about 70 feature detections in the real in-game engine and reports each as **yes / no / partial / warn**, both in a draggable panel and in the game log.

The findings themselves belong in the [`ACEGameInternals`](https://github.com/dreasgrech/ACEGameInternals) notes; this is the instrument that produces them, and the place to prototype the next capability worth leaning on — the pixel path ACEDOOM uses, a track-map renderer, networked overlays.

## What it probes

Eleven categories, ~80 checks:

- **Language & engine** — WebAssembly (expected absent), `new Function`/eval, async
  functions, Promise, BigInt, Proxy, typed arrays, TextEncoder, `structuredClone`, Intl.
- **Timing & scheduling** — timers, `requestAnimationFrame`, `queueMicrotask`,
  `performance.now`, `MessageChannel`.
- **Storage** — `localStorage` (known good — the loader persists panel positions
  through it), `sessionStorage`, IndexedDB, CacheStorage, cookies.
- **Network** — `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `sendBeacon`,
  the Fetch plumbing, plus an active `fetch("data:...")` round-trip. This is the big
  unknown that decides whether networked overlays are possible at all.
- **Graphics & pixel path** — canvas 2D, `canvas.toDataURL("image/png")` (the exact
  path ACEDOOM presents frames through), `ImageData`, `OffscreenCanvas`, WebGL /
  WebGL2, `Path2D`, `DOMMatrix`, and SVG (which Renoir re-tessellates on every change
  — usable, but never per frame).
- **Workers & concurrency** — `Worker`, `SharedWorker`, `Blob`, `URL.createObjectURL`,
  and an active Blob-URL worker round-trip.
- **Media & audio** — `AudioContext` (expected absent), `HTMLAudioElement.play`
  (exists but silent — no decoder), video `canPlayType` (empty — the "no demuxers"
  evidence), and the `engine.trigger` FMOD/UI-command bridge the apps actually use
  for sound.
- **Crypto & encoding** — `crypto.getRandomValues`, `crypto.subtle`, `btoa`/`atob`.
- **DOM & observers** — Mutation/Resize/Intersection observers, `DOMParser`,
  `customElements`, `getComputedStyle`, `matchMedia`.
- **Pointer & screen** — the viewport in css px, px per rem (`window.FontSize`, written by
  the stock `resize()`), `window.screen` and `devicePixelRatio`, whether the HUD has hidden
  the cursor right now, and counters the probe fills from the moment it attaches: mousemove
  (last and highest x), the pointer at the right edge, window `blur`/`focus`, `mouseleave` and
  `mouseout` on the document, `e.buttons` on a press, and a hit test of an inline
  `pointer-events: none`. See below for how to read them.
- **Gameface bridge & telemetry** — `window.engine` and its `on`/`off`/`trigger`/
  `call`/`BindingsReady`, `cohtml`, and a scan of the `Model*` telemetry globals the
  game publishes on `window` (so you can see, live, exactly which models exist).

### Reading the results

The panel groups the checks by category with a coloured dot per row. The same run is
written to the game log with the app's prefix, so `check_ingame_log.py` (in the
loader repo) can read the capability list off a headless-friendly game session:

```
[ACE UI Capabilities Probe] probe on hud.html: 48 yes, 17 no, 4 partial, 1 warn
[ACE UI Capabilities Probe] missing: WebAssembly, AudioContext, WebGL, WebGL2, ...
[ACE UI Capabilities Probe] partial: SVG elements, HTMLAudioElement.play, video codecs, ...
[ACE UI Capabilities Probe] probe fetch(data:) round-trip = yes (data: URI fetched ok)
```

**Re-run** re-probes; **Log to console** dumps every row (name = status — detail) to
the log for the full record.

### The pointer and the screen

Two things about the pointer cannot be learned from the stock bundle or from a browser, and
the app drawer (which opens from a screen edge) needs both: **does any event fire when the
pointer leaves the game window** — onto a second monitor — and **is the cursor confined to
the game in fullscreen**. The *Pointer & screen* rows are counters that fill while the probe
is attached, so the answers take one deliberate session: open the probe, push the mouse hard
off the right edge and keep moving it, alt-tab away and back, click once, then **Re-run**.

- *pointer at the right edge*: if the count of `x = width − 1` kept rising while you pushed
  further, the cursor is confined and every flick to the edge lands in the drawer's zone. If
  it stopped, the pointer left the window.
- *pointer leaving the document* and *window blur / focus*: whether the engine says anything
  when that happens. Zero after the session means a surface cannot rely on `mouseleave` or
  `blur` to notice the pointer is gone.
- *pointer jumps*: samples more than a quarter of the screen from the previous one, which no
  hand produces. The drawer opened when the pointer left the window on the far side
  (2026-09-23), so the engine most likely reports a position such as `0,0` as the pointer
  leaves; the last jump's coordinates say what it reports.
- *mouse buttons field*: whether `e.buttons` is populated on a press (the stock never reads
  it; a surface that wants to know a button is held must otherwise track it).
- *inline pointer-events: none*: the stock stylesheets use the property; this hit-tests the
  inline form, which the drawer's edge hint relies on.
- *cursor hidden by the HUD*: the stock HUD hides the cursor three seconds after the last
  move and shows it again only after a 100px move — the reason an edge hint exists.

Record what you find in `ACEGameInternals/docs/gameface-notes.md`; that is where these facts
live once they are known.

### Safety of the active probes

Two checks do more than test for a global's presence: they exercise it. Both are
deliberately harmless — a `fetch` of a local `data:` URI (no network, no loose-file
lookup — which would crash the game — just an in-memory string) and a `Worker` loaded
from a `Blob` URL that doubles a number and is terminated immediately. Each runs
behind a timeout and reports `warn` rather than hanging if the engine never answers,
so the probe can never wedge the HUD.

## Recording the HUD models

The probe also carries the **model recorder**: the in-game verification run behind the
research notes in ACEAppResearch (`research/*.md`). It is off by default. The **Record
models** button, or the *Record HUD models to the log* setting in the app drawer, starts
it; the button stays lit while it runs. Because the loader starts this app on every HUD
page load, a recording carries on through Escape and resume, which a console snippet
cannot.

Every line it writes carries `rec:` after the app prefix, so the game log can be filtered
for it. What it writes:

- every change of the slow fields: timing strings and splits (with the lap position at
  the change), pit window, low-frequency car state and flags, pit plan, mandatory stops,
  session phase and clock, weather, car location (with pit time), FFB multiplier, fuel per
  lap, realtime leaderboard order (reorders throttled to one line per half second, with a
  count);
- a summary at every lap boundary: FFB range and clip counts, g-force range per axis,
  steering extremes against both locks, fuel at the line, per-corner tyre and brake ranges
  beside their normalized companions, slip and lock, the distinct leaderboard state values;
- calibration pairs of raw against normalized values as temperatures and pressures move;
- the g vector at the first hard-brake and the first hard-steer frame of each lap;
- refuelling in the pit lane, as litres per second;
- the game clock of both models against the wall clock every minute;
- a heartbeat every ten seconds with the per-frame fields and the leaderboard lines around
  the focused car, and a compact dump of every leaderboard, cars-on-track and radar line
  every thirty seconds.

Switching it off, or the app being detached, writes a final summary. The findings so far
are in ACEAppResearch's `research/in-game-findings.md`.

## Layout

- `capabilities/` — the shipped app, exactly what lands in
  `Saved Games\ACE\mods\uiresources\ACEUIAppLoader\capabilities\`:
  `app.json` (version, styles, scripts), `capabilities.js`, `capabilities.css`.
- `tests/test_app.py` — runs the loader's shared test kit (`appkit.py`): app.json,
  the project's JavaScript style rules, the Cohtml rules, class/stylesheet
  agreement, and `tests/harness.html` in a headless browser.
- `dev/preview.html` — the app outside the game (most features read "yes" in a real
  browser; the in-game run is the one that matters).

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
python tools/install_app.py apps/capabilities/capabilities
python tools/install_app.py --remove capabilities
```

## Tests

```
python -m unittest discover -s tests -v
```
