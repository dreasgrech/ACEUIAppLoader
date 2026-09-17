# Capabilities Probe

A capability probe for the Assetto Corsa EVO HUD. One of the loader's **developer apps**: it ships inside `ACEUIModLoader.kspkg`, and the app drawer keeps it behind the `DEVELOPER APPS` switch that is off by default.

It exists to answer one question before anything ambitious gets built on the HUD: **what can JavaScript actually do inside the game's Cohtml/V8?** The game runs V8 9.4 started with `--noexpose_wasm`, in a Cohtml sandbox with no Web Audio and no video demuxers — so the browser is not a reliable guide. This runs about 70 feature detections in the real in-game engine and reports each as **yes / no / partial / warn**, both in a draggable panel and in the game log.

The findings themselves belong in the [`ACEGameInternals`](https://github.com/dreasgrech/ACEGameInternals) notes; this is the instrument that produces them, and the place to prototype the next capability worth leaning on — the pixel path ACEDOOM uses, a track-map renderer, networked overlays.

## What it probes

Ten categories, ~70 checks:

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

### Safety of the active probes

Two checks do more than test for a global's presence: they exercise it. Both are
deliberately harmless — a `fetch` of a local `data:` URI (no network, no loose-file
lookup — which would crash the game — just an in-memory string) and a `Worker` loaded
from a `Blob` URL that doubles a number and is terminated immediately. Each runs
behind a timeout and reports `warn` rather than hanging if the engine never answers,
so the probe can never wedge the HUD.

## Layout

- `capabilities/` — the shipped app, exactly what lands in
  `Saved Games\ACE\mods\uiresources\ACEUIModLoaderApps\capabilities\`:
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
