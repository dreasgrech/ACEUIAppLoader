# Testing

```
python tools/run_tests.py          # this repo and every app under apps/
python tools/run_tests.py lib      # this repo alone
```

One subprocess per suite, because three files named `test_app.py` in non-package directories collide under `unittest discover`.

## The app test kit

An app repo's whole test suite is one file that subclasses `appkit.AppTests` with `ROOT` set. The kit checks:

- the shipped folder — `app.json` valid and minimal, nothing unlisted ships, no stock game file overridden, no legacy `VERSION` / `app.js` / install wrapper / `const VERSION`
- the JavaScript style rules and the Cohtml rules
- that every class a script uses exists in the stylesheet
- that identity comes from `ACEUIAppLoader.app(...)` rather than being hardcoded
- optionally a per-frame hot path, marked with `HOT_PATH`
- and it runs every `tests/**/harness.html` in a headless browser

A harness holds only its own cases. It includes `tests/lib/doubles.js` from this repo — a fake frame clock, in-memory storage, console capture, and the `window.__harness` helpers `t`/`eq`/`ok`/`near`/`finish` that write the report the runner parses — and `tests/lib/lib.js`, which loads the library in `LIB_ORDER`. So the load order exists in one place and an app's harness cannot drift from it.

## Browser hygiene

The browser runs with its own throwaway `--user-data-dir`, is killed as a whole process tree on timeout, and afterwards any *browser* process still referencing that profile directory is terminated.

Filtering by executable name matters: the shell that launched the browser also has the profile path on its command line and must never be killed. **A leaked headless browser is invisible and holds its profile for ever**, which is why this is enforced rather than left to the runner exiting cleanly.

Nothing here proves Cohtml compatibility. It exercises logic deterministically; the engine's own behaviour is what the in-game check below is for.

## What runs where

| | |
|---|---|
| `tests/test_loader_tools.py` | library style and contracts, `install_app`, the bundled apps, a real build and both entry points (needs the game) |
| `tests/test_pack_kspkg.py` | the package format, padding, duplicate records and what `verify` rejects |
| `tests/test_lib_browser.py`, `tests/lib/harness.html` | the library's behaviour in a headless browser, against a fake clock, storage, HUD store and engine |
| `tests/test_lib_browser.py`, `tests/lib/reload-session.html`, `reload-disk.html`, `reload-ops.html`, `reload-pending.html` and `first-panel.html` | the library loading on a fresh page, as it does after Escape and resume (localStorage full, no HUD store yet) and after a game restart (localStorage empty, the HUD store arriving later): the windows remembered as open come back for their owners, a frame later, on the page they belong to, including a window opened before the HUD store arrived and changes made on the load before; and the click rule's first root on a page being let go. Module state is per page, which is why these are pages of their own |
| `tests/test_loader_tools.py` (SecondEntryPointTests), `tests/lib/timeline/hud.html` | the **shipped** `cohtml.js` (stock file plus library) on a page called `hud.html`, with Coherent's own engine implementation and a scripted game: bindings ready after DOMContentLoaded, the stock UI wiping the preset-answer handlers while ours is pending, the game version filled in late and mismatched, a stock pause menu holding the input flags, the HUD store arriving late. Asserts that no error escapes and that every recovery path fires |
| `tests/test_check_ingame_log.py` | the in-game smoke test's verdicts, against synthetic game logs |
| `tests/test_appkit.py` | that `new_app.py` output passes the kit, and that the kit catches legacy boilerplate |
| `apps/<name>/tests/` | each bundled app's own suite, through the same kit |

## The in-game check

Nothing above runs the actual game, so after a launch:

```
python tools/check_ingame_log.py
```

reads the newest game log and reports the loader's version, which pages it ran on, what loaded on each, anything that failed, and whether the game crashed. It distinguishes the C++ exceptions the game logs constantly — which are noise — from a real crash.

It is the only test that can catch an engine-level problem, and it is worth running after any change to the package, the library's load order, or anything an app fetches.
