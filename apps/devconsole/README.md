# DevConsole

An in-game debug console for Assetto Corsa EVO's HUD. One of the loader's **developer apps**: it ships inside `ACEUIModLoader.kspkg`, so there is nothing separate to install, and the app drawer keeps it behind the `DEVELOPER APPS` switch that is off by default.

A draggable panel showing everything the UI logs — including the stock bundle's own `console.log` / `warn` / `error` and uncaught errors — with per-level filters and counts, and a prompt that runs JavaScript against the live HUD page (`ModelCurrentCar.speed`, `ACEUIModLoader.apps`, `HUD.StoredData`). Toggle it with the backquote key, rebindable from its settings.

The version is in `devconsole/app.json` and nowhere else.

## Using it

Turn `DEVELOPER APPS` on at the foot of the app drawer, then press `` ` ``.

[`docs/using-it.md`](docs/using-it.md) covers the panel, the prompt's completion and result formatting, the two built-in commands, and why typing in it cannot drive the car.

## Working on it

It ships inside the loader's package, so building and installing the loader installs it:

```
python tools/build_loader.py --dups=auto --install
```

To iterate, install it loose as well — the installed copy wins over the bundled one until it is removed, which makes the edit loop install, Escape, resume:

```
python tools/install_app.py apps/devconsole/devconsole
python tools/install_app.py --remove devconsole
```

`dev/preview.html` runs the console outside the game in Edge or Chrome, with a fake engine and synthetic log traffic.

## Tests

```
python -m unittest discover -s tests -v     # or tools/run_tests.py from the loader root
```

`tests/test_app.py` runs the loader's shared kit plus the console's own contract; `tests/console/harness.html` holds the browser cases.

## Layout

```
devconsole/
  app.json          version, title, stylesheet, scripts
  devconsole.js     the console: DevConsole.attach(root) / .detach(state)
  devconsole.css    styling in the stock HUD widgets' language, sized in em so it scales
  protofields.js    generated field tables for the .fields command
tools/gen_protofields.py   regenerates protofields.js from the recovered schemas
dev/preview.html    the console outside the game
tests/
  test_app.py       the shared kit plus this app's contract
  console/harness.html   the browser cases
docs/using-it.md    the panel, the prompt and the commands
```

The console is a fixed pool of 200 row elements recycled over the library's shared line buffer, so a busy log costs no allocation per line. It overrides no game file.
