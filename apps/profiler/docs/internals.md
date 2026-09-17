# How the profiler sees the page

Why profiling the stock HUD is possible at all, what the numbers mean, and the API
another app can drive it with.

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
`updateDisplayValue`, `process`). Our own apps carry their name because
`ACEUIAppLoader.loop.start` takes an owner and stamps it on the callback it schedules.

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

## What it logs

Reading a table through a HUD panel while driving is hopeless, so everything important is
said in the game log as well, prefixed `[profiler]`:

- **REC** logs what was instrumented: frames, timers, DOM and engine events, layout reads,
  apps' named sections, and how many stock widget methods were wrapped, plus the clock and
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
