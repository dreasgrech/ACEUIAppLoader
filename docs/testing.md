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
