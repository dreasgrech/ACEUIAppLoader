# ACEUIProfiler

A profiler for Assetto Corsa EVO's UI, in the shape of the Unity profiler: a graph of the
last frames on top, a table of what cost what underneath. It profiles the mods loaded by
the [ACEUIModLoader](../..), inside whose package it ships, **and the game's own stock HUD**, which turns out
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
- **WINDOW / TREE / WORST** are one picker, because they are one choice of what the table
  is showing.
- **Any column header** sorts the table; the same header again turns it round. Total finds
  the expensive branch, **self** the expensive function inside it, **calls** the thing
  running four hundred times a frame, **layout** whoever is making the engine re-measure.
  In TREE the sort applies within each parent, so the hierarchy survives it.
- **total vs self**: total is the branch, self is the row's own hands. A mod at 2 ms total
  and 0.05 ms self is not slow -- it is calling something slow, and the row under it in
  TREE names it.
- **Any legend entry** switches its category off, in the graph and the table together, and
  the choice is remembered. On a real HUD `engine` is most of every frame, so dropping it
  is the difference between a grey wall and a picture of what the scripts did.
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
- The graph ranges itself between 17.1, 33, 66 and 133 ms full height, following the
  window's worst frame and forgetting it slowly (about two and a half seconds). 17.1 ms is
  one of the HUD page's frames -- the engine advances the page at half the game's 117 fps --
  and 8.5 ms, one of the game's, is the lower of the two ruled lines. A fixed 33 ms scale
  drew every ordinary frame at half height and clipped anything worse.
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

## Its API

`window.ACEUIProfiler` is a small surface, not the module's inside. The panel on screen is
a handle, and every verb on it is the one behind the matching button, so a snippet in the
dev console and a click do the same thing:

```js
const p = ACEUIProfiler.panel();   // null until the loader has mounted it

p.record(true);                    // start; record() alone answers whether it is on
p.band("other", false);            // drop the engine's slice from graph and table
p.sort("self");                    // heaviest on its own hands first
p.mode("tree");                    // window | tree | worst
p.report().rows[0];                // read the numbers rather than look at them
p.worst();                         // the slowest recorded frame
p.dump();                          // print the current view to the game log
p.scale(1.4);                      // panel size; p.open(false) hides it
```

`ACEUIProfiler.sampler` is the measuring half on its own, for a caller with no use for a
panel, and `BANDS`, `COLUMNS` and `MODES` describe what the panel shows. `internals` is
everything else, named so that nothing depends on it by accident: the test harness uses it
and it can change without notice.

## Layout

- `profiler/sampler.js` - the instrumentation: wraps the page's entry points, builds a
  per-frame sample tree, keeps a ring of 300 frames and aggregates them. No DOM, and
  usable on its own from the dev console (`ACEProfilerSampler.start()`, `.aggregate()`).
- `profiler/profiler.js` - the panel: graph, table, controls.
- `profiler/profiler.css` - styling. The band colours are declared here for the legend and
  again in the script for the canvas: `getComputedStyle` in this engine reports inline
  styles and initial values rather than the cascade, so a canvas cannot read a colour out
  of CSS. A test keeps the two lists in step.
- `tests/harness.html` - the panel's cases; `tests/sampler/harness.html` - the sampler's:
  frame boundaries, nesting, call merging, the ring buffer, the counters and the clock.
- `dev/preview.html` - the mod outside the game, measuring a faked HUD.
- `dev/gallery.html` - the panel with fixed numbers in it, for judging the design: same
  picture every time, so a change to the look is visible as a change to the picture.
  `?tree`, `?worst` and `?narrow` show the other views.

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
python tools/install_mod.py apps/profiler/profiler
python tools/install_mod.py --remove profiler
```

## Tests

```
python -m unittest discover -s tests -v
```
