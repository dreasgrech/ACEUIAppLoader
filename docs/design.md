# Shared library for ACE UI mods -- investigation

Written 2026-09-14, before starting the second mod (an in-game debug console).
Goal: pull the reusable parts out of PedalGraph so both mods, and later ones,
share one library, one HUD entry point and one package.

## 1. What is in PedalGraph today (627 lines)

Census of `src/uiresources/js/pedalgraph.js`, grouped by what it is really about:

| Group | Functions | Lines (approx) | Reusable? |
|---|---|---|---|
| DOM / string helpers | `clamp`, `el`, `close`, `toArray`, `percentText` | 40 | yes, verbatim |
| Logging | `log` (prefix), boot log line, `LOG_PREFIX` | 10 | yes, parametrised by prefix |
| Position persistence | `hudElements`, `isPosition`, `currentPosition`, `savePosition`, `readLocalPosition`, `applyPosition`, `parentHasSize`, `finishRestore`, `restoreImmediately`, `maybeRestore` | 135 | yes, this is the biggest win |
| Drag | `moveTo`, `onMouseDown`, `onMouseMove`, `onMouseUp`, listener wiring in `attach`/`detach` | 60 | yes |
| Frame loop | `tick` scaffolding (reschedule, hidden-HUD check, periodic log) | 25 | yes, as a "widget runtime" |
| Lifecycle | `attach`, `detach`, `create` shell, boot block | 60 | yes, the pattern; the markup is per mod |
| PedalGraph proper | `TRACES`, `markup`/`stripMarkup`, `setSlot`, `scaleTransform`, `shiftTransform`, `readModel`, `commitSample`, `renderFrame`, `logSample` | 200 | no, this is the mod |

Roughly two thirds of the file is infrastructure a debug console needs
unchanged: a draggable panel that remembers where it was, hides with the HUD,
logs under a prefix and runs a per-frame loop.

## 2. Constraints that shape the design

These come from the engine and from what we learned the hard way; the library
must respect all of them.

- **Classic scripts, global bindings.** hud.html loads classic (non-module)
  scripts; `const X = (function () { ... }());` at top level is visible to
  later scripts by name. There is no `import`. The library is therefore a
  handful of IIFE modules loaded in order, exactly like uplinkjs.
- **One `hud.html`.** Only one package can override it (the game's lookup
  returns one record per hash). Two mods cannot each ship their own copy, so
  the override must become a shared **entry point** that loads the library
  and then every enabled mod.
- **One package is far simpler than several.** The game re-sorts the merged
  table after each package it adds; `lookup_sim` models one mod package. With
  several mod packages the padding search would have to model the whole
  chain and depends on the order the directory listing returns them. One
  package for "all our UI mods" keeps `find_padding` as it is.
- **Cohtml rules.** Per-frame work may only change transforms (SVG/geometry
  rebuilds crashed the game); no `var(--x, fallback)`; the HUD page is
  reloaded on Escape/resume, so every mod restarts and must restore state.
- **Project style.** No classes, no `this`, function expressions, `let`/`const`
  (tests enforce this on every shipped script).
- **Logging goes to the game log.** Every `console.log` from the UI lands in
  `Logs\log-*.txt` as `[gameface] [info]`. `console.warn` and `console.error`
  do too, as `[warning]`. That is our only output channel today -- and the
  thing the debug console mod wants to show in-game.

## 3. What the debug console needs that PedalGraph did not

- **Hook `console.*` as early as possible.** The stock bundle calls
  `console.log` 658 times, `warn` 205, `error` 132, `trace` 143 (it already
  wraps `console.trace` itself, so wrapping must chain, not replace). To catch
  the stock HUD's own messages the hook must be installed in `hud.html` before
  `components.js`, i.e. in the entry point, not in the mod's widget script
  which loads later.
- **Catch errors.** `window.addEventListener("error", ...)` already proved
  useful (hud.html diagnostics); `unhandledrejection` should join it.
- **Survive page reloads or accept the loss.** The HUD page is unloaded on
  Escape; a log buffer in JS dies with it. Options: accept per-session
  buffers (simplest), or park the buffer in the HUD layout store / `localStorage`
  (bounded, a few hundred lines). Menu pages (`menu.html`, `ingame.html`,
  `singleplayer.html`) are separate loads too; covering them means overriding
  those pages as well (more overrides, still one padding search).
- **A text panel that scrolls.** Text updates are cheap in Cohtml as long as
  we append/replace `textContent` in a bounded list and do not rebuild layout
  every frame; batch appends per frame.

## 4. Proposed structure

```
ACEPedalGraph/                (rename later; it is becoming "ACE UI mods")
  lib/                        shared library, one IIFE per file, loaded in this order
    acemods.core.js           AceMods.core: clamp, el/close, toArray, percentText, log(prefix)
    acemods.persist.js        AceMods.persist: HUD-store + localStorage position/state store
    acemods.panel.js          AceMods.panel: draggable, hide-with-HUD, positioning class, attach/detach
    acemods.loop.js           AceMods.loop: per-frame runtime with fixed-rate sampling helper
    acemods.console.js        AceMods.console: console.* hook + ring buffer + error capture (entry point uses it)
  mods/
    pedalgraph/               pedalgraph.js + pedalgraph.css (only the mod-specific 200 lines)
    console/                  debugconsole.js + debugconsole.css
  hud/
    hud.html                  the single entry point: stock page + <link>s + <script>s in order + one <div> per mod
  build/                      generated: uiresources/{js,assets,hud.html} assembled from lib + mods + hud
  tools/                      pack_kspkg.py (packs build/), lookup_sim.py, check_ingame_log.py, build.py (assemble)
  tests/                      per-library tests + per-mod tests, one harness per library module
```

Key decisions inside that:

- **Namespaces, not globals soup.** `AceMods` is one global object; each lib
  file adds one namespace (`AceMods.core`, ...). Mods are `PedalGraph`,
  `DebugConsole` etc. and only talk to `AceMods.*`.
- **Persistence API** (extracted from today's code, generalised beyond
  position): `AceMods.persist.save(id, data)`, `AceMods.persist.load(id, onReady)`
  where `onReady(data, source)` fires once the HUD store is available or the
  wait window ends, plus a synchronous `AceMods.persist.peek(id)` for the
  immediate localStorage attempt. Position handling on top:
  `AceMods.panel.attach(root, { id, onFrame })` does the hidden-until-placed
  dance itself.
- **The entry point owns load order and diagnostics.** hud.html installs the
  console hook and error capture first, then the library, then each mod. The
  per-mod `PEDALGRAPH_SOURCE` tag becomes `AceMods.source`.
- **Build step assembles, packer packs.** `build.py` copies lib + mods + hud
  into `build/uiresources/...` (single place for the game paths), then the
  existing packer runs on `build/`. The padding search already handles
  several overrides (`hud.html` today, more pages later).
- **Versioning per mod and for the bundle.** `VERSION` stays for the bundle;
  each mod carries its own `VERSION` constant, all logged at boot.

## 5. Migration order (small, testable steps)

1. Create `lib/acemods.core.js` and `lib/acemods.persist.js` by moving the
   functions listed in section 1 unchanged; PedalGraph calls `AceMods.*`.
   Tests: move the corresponding harness cases to a library harness.
2. Extract `acemods.panel.js` (drag + hidden-until-placed + hide-with-HUD) and
   `acemods.loop.js`; PedalGraph shrinks to its 200 lines.
3. Introduce `build.py` and the `hud/` entry point; move mod sources to
   `mods/pedalgraph/`. Packer input becomes `build/`.
4. Add `acemods.console.js` (hook + buffer) to the entry point, verify in a
   launch that stock messages are captured (they will appear twice in the
   game log if we also re-log them -- the hook must not echo).
5. Build the debug console mod on `AceMods.panel` + `AceMods.console`.

Each step ends with the full test suite and one launch checked by
`check_ingame_log.py`; steps 1-3 change no behaviour in game.

## 6a. Separate packages per mod (decision 2026-09-14)

Requirement from the project owner: PedalGraph and the debug console are
separate, separately installable mods. Section 4's "one package" therefore
splits into a **loader package** plus one package per mod.

What the game allows:

- Only one record per path wins, so only one package may override
  `hud.html`. That package is the loader. It ships the library and probes a
  fixed set of mod slots (`uiresources\acemods\slotNN.js`, tried with dynamic
  `<script>` elements and `onerror`; Cohtml has no directory listing).
- Mod packages ship only **new** files: their slot script, their own
  `uiresources\acemods\<mod>\...` assets. New paths have unique hashes and
  always resolve regardless of layout, so mods never need padding.

What the game does not allow us to ignore, measured with `lookup_sim`:

- The loader's `hud.html` win is **not stable under other packages**. The
  merged vector is re-sorted after every package. A second package with only
  new entries flipped the loader's win in 14-17 of 60 trials when added after
  the loader, and in 42 of 60 when added before it.
- Duplicating the `hud.html` record inside the loader (8, 32, 128 copies) does
  not fix it: introsort gathers equal keys into one band and the base copy
  still lands first often (6/40 after, 31-40/40 before).

Consequence: padding must be computed against the **actual set of installed
packages**, on the user's machine, in the game's package order. A `repad`
tool does that: read every `mods\*.kspkg` table, replay the adds in listing
order, and rewrite only the loader's 64 MB table region with padding that
wins for that set. Every mod installer runs it after copying its package;
removing a mod should run it too. `check_ingame_log.py` remains the final
check. To verify before relying on it: the order in which the game's
directory listing returns `mods\*.kspkg` (assumed alphabetical, NTFS order);
one launch with two packages settles it.

## 7. Final investigation (2026-09-14): is a loader unavoidable, and what shape?

Question asked: do multiple UI mods require our own loader, with certainty?
Everything below comes from the 0.9.1+release.6 exe (disassembly with
pefile/capstone) and the extracted stock UI files.

**Certain.** One record wins per path hash (merged vector + `lower_bound`).
Two packages cannot both own the same stock file. Every UI mod needs code in
the HUD page, and every code path into the HUD page is a stock file. So one
package must own the entry point; whether that package is "a loader" or
"the first mod" is naming.

**Searched for a loader-free hook, none found:**

- Resources the HUD/menu pages request that the base package lacks: only
  textures, localization files and the native `custom/hud/display` URL. No
  script.
- `uiconfig.json`: dev-mode only, never requested in retail sessions, and it
  carries two flags (`skipintro`, `ignorebackend`).
- The bundle's dynamic `import(...)` calls target internal module paths; the
  `importScript(url)` helper has no caller that takes a mod-supplied URL.
- Entry-record flags: only `1 = directory` and `0x100 = XOR` are read; no
  priority bit; the lookup ignores flags when choosing between equal hashes.
- Car dash displays run in separate Cohtml views; no access to the HUD DOM.

**Two findings that change the design for the better:**

1. **`mods\` is a loose-file search directory.** The scanner, right after
   adding `mods\*.kspkg`, pushes `<Saved Games\ACE>\mods` onto the resource
   manager's search-path vector (the one the lookup falls back to when no
   package has the hash). Loose files never beat packed ones (that is why the
   loose `hud.html` tests failed), but a path no package contains resolves to
   `Saved Games\ACE\mods\<path>`. Consequence: **mods that only add new files
   need no package at all** -- a folder under `mods\uiresources\...` is enough,
   editable in place, reloaded by Escape/resume. Only the entry-point override
   must be a package. With no mod packages in play, the merged table is base +
   loader only, so the inter-package padding hazard of section 6a disappears
   for UI mods (car mod packages still participate and still need `repad`).
   Pending one launch to confirm loose new files load (staged: `hud.html`
   in the package, `js/pedalgraph.js` and `assets/pedalgraph.css` loose).
2. **`js/cohtml.js` is a better host than `hud.html`.** It is the first
   `<script>` of all 13 stock pages, it is the Cohtml SDK's JavaScript
   interface (VERSION 2.0.3, 13940 bytes), not Kunos code, and Kunos already
   ships two variants of it. Overriding it with "stock content + loader
   appended" gives one override that runs on every page before
   `components.js` (the console hook sees menu logs too), and it changes only
   when Kunos upgrades the UI SDK, whereas `hud.html` may change with any HUD
   edit. The loader reads `location.pathname` to know the page and attaches
   widgets only on `hud.html`.

**Still assumed, not proven:** the order in which the game lists
`mods\*.kspkg` (the listing helper showed no sort call in a quick pass; NTFS
returns alphabetical). It only matters when several packages override stock
files, i.e. for `repad` with car mods installed; the tool can sidestep it by
choosing padding that wins under every permutation of the installed packages.

**Recommendation.** One loader package (`js/cohtml.js` override + library,
padded per game version, `repad` for machines with car-mod packages); every
UI mod a loose folder under `mods\uiresources\acemods\<mod>\` plus one slot
script the loader probes. No per-mod packaging, no per-mod padding, and live
editing during development.

## 8. Second deep pass (2026-09-14, later)

- **Search directories.** `AddSearchDir` has exactly two callers: the resource
  manager's constructor (one default entry built next to its logger name,
  most likely the working directory, i.e. the game folder) and the mod
  scanner (`<Saved Games\ACE>\mods`). So loose lookups try the game folder
  first, then `mods\`. Both only matter for paths no package has.
- **The constructor also holds the XOR key** (`0x9F9721A97D1135C1` written to
  the manager at +0x788), confirming the community-derived format.
- **UI preload and Gameface requests** go through Cohtml-facing code
  (0x140db... range) rather than calling the manager's lookup directly within
  one call level. The directory-listing vectors the manager keeps hold only
  name strings (no offsets), so any preload must read by path through the
  same lookup; an override that wins the lookup is therefore also what a
  preload cache would hold. Empirical confirmation pending (below).
- **Documents-path call after `mods`** is backend URL configuration, not mod
  related.
- **Package listing order** still unverified statically (no obvious sort in
  the listing helper).

Experiment (launched 2026-09-14 01:13): package = `hud.html` override +
`js/cohtml.js` override (stock 13940 bytes + one `console.log` of
`location.pathname`), 34 padding entries so both win; `pedalgraph.js` and
`pedalgraph.css` as loose files under `mods\uiresources\`.

**Result: both confirmed.**

- The widget appeared, logged `source=kspkg-hud+loose-js`, sampled, saved and
  restored its position; no "Failed loading resource" for the loose files.
  Loose new files under `Saved Games\ACE\mods\` are served.
- The `cohtml.js` marker fired on every page load, always with
  `readyState=loading` (i.e. before `components.js`): intro, menu (x2),
  multiplayer, singleplayer, ingame (x2), hud. A `cohtml.js` override is a
  valid host for all pages.

Decision basis is therefore complete: one loader package hosted in
`js/cohtml.js` (no `hud.html` override needed at all), padded per game
version; UI mods as loose folders with no packaging and no padding.

## 6. Open questions to settle before step 4

- Should the console hook also run in the menu pages? Requires overriding
  `ingame.html`, `menu.html`, `singleplayer.html`; padding search handles it,
  but each is another stock file we shadow and must re-check on game updates.
- Log buffer persistence across the Escape reload: per-session (lose on
  reload) or parked in a store? Start per-session; add parking only if the
  reload loss hurts in practice.
- Toggle key for the console: the stock HUD routes input actions through
  `engine.on("UIExInputsAction", ...)`; a keyboard shortcut needs either that
  event or a plain `keydown` listener, to be tested in Cohtml.

## 9. Implemented (2026-09-14, loader 0.2.0)

The library exists and both mods run on it; this section records what was
built against sections 4 and 5, and where it deviates.

- **Where the library lives.** Not as loose files: all six `src/acemods.*.js`
  files are appended to the stock `js/cohtml.js` inside the loader package, in
  `LIB_ORDER` (core, console, persist, panel, loop, loader). Reason: the
  console hook must run before `components.js`, which only the host can
  guarantee, and mods may then rely on `AceMods.*` existing synchronously.
  The cost is a rebuild + reinstall for library changes (padding unchanged,
  it depends only on paths).
- **Namespaces** as planned: `AceMods` (core), `.console`, `.persist`,
  `.panel`, `.loop`, `.loader`; flat aliases `AceMods.ready/mods/addScript/
  addStylesheet/ROOT` keep the 0.1.0 surface.
- **Hidden-until-placed** is an inline `visibility` style set by the panel,
  not a CSS class, so the library needs no stylesheet.
- **`data-nodrag`** on descendants (prompt, buttons) excludes them from
  starting a drag; needed by the console.
- **Persistence API** ended up lower-level than section 4's
  `persist.load(id, onReady)`: `readHud/readLocal/save` plus the polling done
  by `panel.update(panel, now)` in the mod's frame. Simpler, same behaviour.
- **Console buffer** is per page (section 6, first option): lost on the
  Escape/resume reload, but the hook runs on every page so menu-page logs are
  captured too; only the HUD shows them today.
- **PedalGraph 0.4.0** shrank from 627 to ~330 lines and is only the graph.
  **DevConsole 0.1.0** (repo `ACEDevConsole`) is the second mod: row pool of
  200 recycled elements, filters, prompt with expression-then-statement
  compilation, backquote toggle. Open question left for the first launch:
  whether keyboard focus reaches the prompt while driving.
- **Tests.** Library behaviour is tested in the loader repo
  (`tests/lib/harness.html`, 17 cases); each mod tests its own logic plus its
  integration with the panel. The headless runner moved to
  `tools/headless.py` and is shared.
