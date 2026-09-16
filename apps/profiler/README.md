# Profiler

A profiler for Assetto Corsa EVO's UI, in the shape of the Unity profiler: a graph of the last frames on top, a table of what cost what underneath. One of the loader's **developer apps** -- it ships inside `ACEUIModLoader.kspkg`, and the app drawer keeps it behind the `DEVELOPER APPS` switch that is off by default.

It profiles the mods the loader runs **and the game's own stock HUD**, which turns out to be possible for three reasons, all measured rather than assumed -- see [`docs/internals.md`](docs/internals.md).

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

## Working on it

It ships inside the loader's package, so building and installing the loader installs it:

```
python tools/build_loader.py --dups=auto --install
```

To iterate, install it loose as well; the installed copy wins over the bundled one until it is removed:

```
python tools/install_mod.py apps/profiler/profiler
python tools/install_mod.py --remove profiler
```

`dev/preview.html` runs it outside the game against a faked HUD, and `dev/gallery.html` shows the panel with fixed numbers in it -- the same picture every time, so a change to the look is visible as a change to the picture (`?tree`, `?worst`, `?narrow` for the other views).

## Tests

```
python -m unittest discover -s tests -v     # or tools/run_tests.py from the loader root
```

## Layout

```
profiler/
  sampler.js      the instrumentation: wraps the page's entry points, builds a per-frame
                  sample tree, keeps a ring of 300 frames and aggregates them. No DOM,
                  and usable on its own from the dev console
  profiler.js     the panel: graph, table, controls
  profiler.css    styling. Band colours are declared here for the legend and again in the
                  script for the canvas, because getComputedStyle in this engine reports
                  inline and initial values rather than the cascade -- a test keeps them in step
tests/
  harness.html            the panel's cases
  sampler/harness.html    frame boundaries, nesting, call merging, the ring, the clock
dev/
  preview.html    the profiler outside the game
  gallery.html    the panel with fixed numbers, for judging the design
docs/internals.md why profiling the stock HUD works, what it logs, and its API
```
