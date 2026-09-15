# ACEUIProfiler

A profiler for Assetto Corsa EVO's UI, in the shape of the Unity profiler: a graph of the
last frames on top, a table of what cost what underneath. It profiles the mods loaded by
the [ACEUIModLoader](../ACEUIModLoader) **and the game's own stock HUD**, which turns out
to be possible for three reasons, all measured rather than assumed
(`ACEUIModLoader/dev/snippets/profileprobe.js`, run in game 2026-09-15).

## What makes it possible

**The page's scheduling is visible.** The stock bundle re-resolves its globals at every
call -- `components.js` line 4261 is
`return requestAnimationFrame(ksUI$1.perFrameAllModelUpdate);` -- so replacing
`window.requestAnimationFrame`, `setTimeout`, `setInterval`, `addEventListener` and
`engine.on` intercepts the whole page, including frame chains that were already running
before the profiler started.

**The work has names.** The stock bundle ships unminified, so its callbacks arrive as
`perFrameAllModelUpdate`, `visibilityChecker`, `fetchAllModels`. Of the 27 kinds of custom
element on a live HUD, 26 have wrappable methods with real names (`onBindingUpdate`,
`updateDisplayValue`, `process`). Our own mods carry their name because
`ACEUIModLoader.loop.start` takes an owner and stamps it on the callback it schedules.

**The clock, however, is poor.** `performance.now()` **does not advance within a frame**:
200,000 reads across 29 ms of real time returned one single value, because the engine hands
the page its frame timestamp and freezes it until the next frame. A profiler built on it
reports 0.00 ms for everything while looking like it works. So:

| what | how it is measured | quality |
|---|---|---|
| frame budget | the animation-frame timestamp, which *is* precise between frames | exact |
| call counts | counted | exact |
| per-call cost | `Date.now()`, 1 ms steps | quantised but unbiased: recovered by averaging |
| allocation | not available (`performance.memory` is absent) | replaced by layout reads, counted **against the app that caused them**, children included |

That is why the table reports **calls per frame, ms per frame and share of the frame across
a window of frames** rather than one frame's reading: over a few hundred calls the 1 ms
quantisation averages out, and what is left is the number you act on. The per-frame line is
for spikes, where a millisecond of error does not matter because the spike is twenty.

## Using it

Recording is off until asked: instrumenting costs about 0.26 us per call, and a profiler
that started with the HUD would be measuring every session whether asked or not.

- **F9** shows and hides the panel (rebindable in its settings, from the app drawer).
- **REC** starts and stops recording; **CLEAR** empties the graph and the table.
- **TREE** is the stack-trace view: every app with what it called inside it, indented and
  merged across the window. Wrapping alone only reaches as deep as a mod's frame callback,
  so the mods name their own parts with `ACEUIModLoader.section(...)` -- PedalGraph's
  `read model` / `render`, Telemetry's `draw map` / `draw trace`, DOOM's `doom tic` /
  `present frame` -- and those appear here as children of the mod that ran them.
- **WORST** switches the table to the slowest frame in the window and lists what was in
  it, engine time included. This is deliberately not Unity's frame-by-frame scrubber:
  with a 1 ms clock an ordinary frame's rows are mostly zeroes, but a 40 ms spike is 40 ms
  however coarsely you measure it, so the spike is the frame worth looking at.
- **LOG** prints the current table to the game log, which is where this project does its
  debugging -- reading a table through a HUD panel while driving is hopeless.
- **Panel scale** (a setting) sizes the whole panel: it is one `font-size` in rem and
  everything inside is em, the same way the dev console and DOOM scale themselves.
- **Profile stock widgets** (a setting, off by default) wraps the methods of every custom
  element on the page, so `ks-huddamage.process` and friends appear in the table beside our
  own mods. It is about 150 wrappers, which is worth asking for rather than assuming; it
  can be turned on and off between recordings.
- The graph sweeps like a heart monitor rather than scrolling: one pixel column per frame,
  stacked by category, wiping the columns ahead of the sweep. Scrolling would mean either
  blitting the canvas onto itself every frame (unproven in Renoir) or redrawing 300 stacked
  columns at 58 fps, which is exactly the per-frame work this project has a rule against.
- `engine` (grey) is frame time that no script accounted for: style, layout, tessellation,
  paint. On this HUD it is usually the biggest slice, and seeing it apart from script time
  is the point.

## What it logs

Reading a table through a HUD panel while driving is hopeless, so everything important is
said in the game log as well, prefixed `[profiler]`:

- **REC** logs what was instrumented: frames, timers, DOM and engine events, layout reads,
  mods' named sections, and how many stock widget methods were wrapped, plus the clock and
  the window size.
- **pause** logs how many frames were kept and the window's average frame time.
- **LOG** prints the view currently on screen -- window, tree or worst frame -- with share,
  ms/f, calls/f and layout/f per row, the tree indented.
- **Stop on a frame over N ms** (a setting) logs the spike, stops recording and switches to
  that frame, so the evidence is still there when you park.
- `.run profile` (a dev-console snippet) records ten seconds and prints the table without
  the panel being open at all.

## Layout

- `profiler/sampler.js` - the instrumentation: wraps the page's entry points, builds a
  per-frame sample tree, keeps a ring of 300 frames and aggregates them. No DOM, and
  usable on its own from the dev console (`ACEProfilerSampler.start()`, `.aggregate()`).
- `profiler/profiler.js` - the panel: graph, table, controls.
- `profiler/profiler.css` - styling, including the band colours, which the canvas reads
  back with `getComputedStyle` so the palette exists in one place.
- `tests/harness.html` - the panel's cases; `tests/sampler/harness.html` - the sampler's:
  frame boundaries, nesting, call merging, the ring buffer, the counters and the clock.
- `dev/preview.html` - the mod outside the game.

## Install

With the loader package installed (`python tools/build_loader.py --install` in the loader
repo):

```
python ..\ACEUIModLoader\tools\install_mod.py profiler
```

Escape and resume in the car reloads the HUD and picks up changes.

## Tests

```
python -m unittest discover -s tests -v
```
