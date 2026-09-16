#!/usr/bin/env python3
"""
new_mod.py - start a UI mod for the ACEUIModLoader with everything in place.

    python tools/new_mod.py <name> [<parent dir>] [--title "Nice Name"] [--developer]

creates <parent dir>/ACE<Title>/ (default parent: next to this repo) holding

    <name>/mod.json          version, styles, scripts  (the folder IS the shipped mod)
    <name>/<name>.js         an IIFE module: attach/detach, draggable persistent panel, frame loop
    <name>/<name>.css        stock-looking panel styling
    tests/test_mod.py        the shared test kit (modkit.py) pointed at this repo
    tests/harness.html       browser cases run headlessly by the kit
    dev/preview.html         the mod outside the game
    README.md, .gitignore

--developer marks it a developer tool in its mod.json, which keeps it behind the app
drawer's "developer apps" switch -- for a profiler or a probe rather than a HUD widget.

Nothing here repeats the version or the name in a second place: the script reads
both from `ACEUIModLoader.mod("<name>")`, and the loader creates `#<name>` before the
script runs. Install with `python tools/install_mod.py <repo>/<name>`.
"""
import os
import re
import sys

import _repos

NAME_RE = re.compile(r"^[a-z][a-z0-9_-]*$")

MOD_JSON = """{
  "version": "0.1.0",
  "title": "__TITLE__",__DEVELOPER__
  "styles": ["__NAME__.css"],
  "scripts": ["__NAME__.js"]
}
"""

DEVELOPER_KEY = """
  "developer": true,"""

SCRIPT = """/**
 * __TITLE__ -- a UI mod for Assetto Corsa EVO, built on the ACEUIModLoader library.
 *
 * The loader creates `<div id="__NAME__">` inside the HUD container before this
 * script runs and `ACEUIModLoader.mod("__NAME__")` describes the mod (name, version
 * from mod.json, title, root, a prefixed logger, derived storage keys), so none of
 * that is declared here. Styling lives in __NAME__.css.
 *
 * Cohtml rules: build the markup once, then only change textContent, classes,
 * one attribute and transforms per frame; never rebuild SVG geometry.
 */
const __GLOBAL__ = (function () {

    const me = ACEUIModLoader.mod("__NAME__");

    /** Class names shared with __NAME__.css. */
    const CLASS = {
        root: "ace-__NAME__",
        header: "__ABBR__-header",
        body: "__ABBR__-body",
        value: "__ABBR__-value"
    };

    const el = ACEUIModLoader.el;
    const close = ACEUIModLoader.close;

    // ---- markup ------------------------------------------------------------------

    const markup = function () {
        return el("div", CLASS.header) + me.title + close("div")
            + el("div", CLASS.body) + el("span", CLASS.value) + "-" + close("span") + close("div");
    };

    /** Build the DOM once (or re-use it) and return the state the loop works on. */
    const create = function (root) {
        root.classList.add(CLASS.root);

        if (!root.querySelector("." + CLASS.body)) { root.innerHTML = markup(); }

        return {
            root: root,
            value: root.querySelector("." + CLASS.value),
            lastText: "",
            panel: null,                // ACEUIModLoader.panel state (drag + position)
            loop: null                  // ACEUIModLoader.loop handle
        };
    };

    // ---- rendering -----------------------------------------------------------------

    /** One animation frame: settle the panel, then draw. Only touch the DOM when something changed. */
    const tick = function (state, now) {
        const car = window.ModelCurrentCar;
        const text = car && car.has_focused_car ? ACEUIModLoader.percentText(car.gas_percent || 0) : "-";

        ACEUIModLoader.panel.update(state.panel, now);

        if (ACEUIModLoader.hudHidden() || text === state.lastText) { return; }

        state.lastText = text;
        state.value.textContent = text;
    };

    // ---- lifecycle ---------------------------------------------------------------

    const attach = function (root) {
        const state = create(root);

        state.panel = ACEUIModLoader.panel.attach(root, { hudId: me.hudId, storageKey: me.storageKey, log: me.log });
        state.loop = ACEUIModLoader.loop.start(function (now) { tick(state, now); });
        me.log("attached");

        return state;
    };

    const detach = function (state) {
        ACEUIModLoader.loop.stop(state.loop);
        ACEUIModLoader.panel.detach(state.panel);
    };

    me.log("script loaded, version=" + me.version + ", lib=" + ACEUIModLoader.VERSION);

    return {
        CLASS: CLASS,
        create: create,
        tick: tick,
        attach: attach,
        detach: detach
    };
}());

/* Attach to #__NAME__: the loader creates it in game, the preview page carries it. */
ACEUIModLoader.mod("__NAME__").mount(__GLOBAL__.attach);
"""

STYLE = """/*
 * __TITLE__ -- stylesheet. Linked by the ACEUIModLoader after the stock CSS, so
 * --font-family-main is the game's. Stock HUD widget look: black 75 % panel,
 * solid #1c1e1f header, #bd0000 accents. No var() fallbacks (Cohtml).
 */

.ace-__NAME__ {
    position: absolute;
    left: 2rem;
    top: 5rem;
    width: 12em;
    display: flex;
    flex-direction: column;
    background: rgba(0, 0, 0, 0.75);
    border: 2px solid transparent;
    color: rgba(255, 255, 255, 0.8);
    font-family: var(--font-family-main);
    font-size: 1rem;
    cursor: pointer;
}

.ace-__NAME__.dragging {
    border-color: #fff;
}

body.hide-hud .ace-__NAME__ {
    visibility: hidden;
}

.ace-__NAME__ .__ABBR__-header {
    height: 2.2em;
    padding: 0 1em;
    display: flex;
    align-items: center;
    background: #1c1e1f;
    color: #fff;
    font-size: 0.75em;
    font-weight: 600;
    letter-spacing: 0.05em;
}

.ace-__NAME__ .__ABBR__-body {
    padding: 0.5em 1em;
    font-size: 1.4em;
    font-weight: 600;
    text-align: center;
}

.ace-__NAME__ .__ABBR__-value {
    color: #fff;
}
"""

TEST = """\"\"\"Runs the shared ACEUIModLoader test kit against this mod (see modkit.py in the loader repo).\"\"\"
import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# The loader is either beside this repo or above it -- a bundled app lives in the loader's
# own apps/<name>/ -- so walk up looking for it. ACE_LOADER_DIR overrides both.
LOADER = os.environ.get("ACE_LOADER_DIR")
HERE = ROOT
while not LOADER:
    for candidate in (HERE, os.path.join(HERE, "ACEUIModLoader")):
        if os.path.isfile(os.path.join(candidate, "tools", "modkit.py")):
            LOADER = candidate
    if not LOADER and HERE == os.path.dirname(HERE):
        raise SystemExit("ACEUIModLoader not found: clone it next to this repo or set ACE_LOADER_DIR")
    HERE = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(LOADER, "tools"))

from modkit import ModTests  # noqa: E402


class Tests(ModTests):
    ROOT = ROOT
    MIN_CASES = 3
    HOT_PATH = ("// ---- rendering", "// ---- lifecycle")


if __name__ == "__main__":
    unittest.main()
"""

HARNESS = """<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>__TITLE__ tests</title>
<style>
  body { margin: 0; background: #222; color: #ddd; font: 12px monospace; }
  .absolutecenter { position: relative; width: 1600px; height: 900px; overflow: hidden; }
  #results { white-space: pre; }
</style>
<!-- shared test doubles (fake frame clock, in-memory localStorage, console capture) and the library, from the loader repo -->
<script src="__LIB__/doubles.js"></script>
<script src="__LIB__/lib.js"></script>
<link rel="stylesheet" type="text/css" href="../__NAME__/__NAME__.css">
<script>window.ModelCurrentCar = { has_focused_car: true, gas_percent: 0.5 };</script>
<script src="../__NAME__/__NAME__.js"></script>
</head>
<body>
<div class="absolutecenter" id="center"></div>
<script>
(function () {
    const H = window.__harness;
    const t = H.t, eq = H.eq, ok = H.ok;
    let frame = 1000;
    const nextFrame = function () { frame += 16; window.__clock.step(frame); };

    const root = document.createElement("div");
    root.id = "__NAME__";
    document.getElementById("center").appendChild(root);
    const state = __GLOBAL__.attach(root);

    t("attach builds the markup once, hidden until placed, and logs with the mod's prefix", function () {
        ok(root.classList.contains("ace-__NAME__"), "root class");
        ok(root.querySelector(".__ABBR__-header"), "header"); eq(root.querySelector(".__ABBR__-header").textContent, "__NAME__", "title falls back to the name outside the game");
        eq(root.style.visibility, "hidden", "hidden until positioned"); ok(state.loop.running, "loop running");
        ok(window.__log.some(function (l) { return l.indexOf("[__NAME__] attached") === 0; }), "prefixed log");
    });

    t("a frame draws the value once and skips unchanged frames", function () {
        nextFrame(); eq(root.querySelector(".__ABBR__-value").textContent, "50%");
        root.querySelector(".__ABBR__-value").textContent = "sentinel"; nextFrame();
        eq(root.querySelector(".__ABBR__-value").textContent, "sentinel", "unchanged value not rewritten");
        window.ModelCurrentCar.gas_percent = 0.75; nextFrame(); eq(root.querySelector(".__ABBR__-value").textContent, "75%");
    });

    t("detach stops the loop and releases the panel", function () {
        const cancelled = window.__clock.cancelled;
        __GLOBAL__.detach(state);
        eq(window.__clock.cancelled, cancelled + 1); eq(state.loop.running, false);
    });

    H.finish();
}());
</script>
</body>
</html>
"""

PREVIEW = """<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>__TITLE__ preview</title>
<!-- The mod outside the game: the library from the sibling loader checkout, then the real files. Open directly in Edge or Chrome. -->
<script src="__LIB__/lib.js"></script>
<link rel="stylesheet" type="text/css" href="../__NAME__/__NAME__.css">
<style>
    :root { --font-family-main: "Bahnschrift", "Segoe UI", Arial, sans-serif; font-size: 16px; }
    html, body { margin: 0; height: 100%; background: #101214; color: #ddd; font-family: var(--font-family-main); }
    .absolutecenter { position: relative; width: 1600px; height: 900px; margin: auto; overflow: hidden;
                      background: radial-gradient(ellipse at 50% 60%, #4a5560 0%, #1b1e22 70%); }
</style>
<script>window.ModelCurrentCar = { has_focused_car: true, gas_percent: 0.42 };</script>
<script src="../__NAME__/__NAME__.js"></script>
</head>
<body>
<div class="absolutecenter"><div id="__NAME__"></div></div>
</body>
</html>
"""

README = """# __REPO__

__TITLE__: a UI mod for Assetto Corsa EVO, loaded by the
[ACEUIModLoader](../ACEUIModLoader) and built on its library.

## Layout

- `__NAME__/` - the shipped mod, exactly what lands in
  `Saved Games\\ACE\\mods\\uiresources\\ACEUIModLoaderMods\\__NAME__\\`:
  `mod.json` (version, styles, scripts), `__NAME__.js`, `__NAME__.css`.
- `tests/test_mod.py` - runs the loader's shared test kit (`modkit.py`) against
  this repo: mod.json, style and Cohtml rules, and `tests/harness.html` in a
  headless browser.
- `dev/preview.html` - the mod outside the game.

## Install

With the loader package installed (`python tools/build_loader.py --install` in
the loader repo):

```
python ..\\ACEUIModLoader\\tools\\install_mod.py __NAME__
```

Escape and resume in the car reloads the HUD and picks up changes.

## Tests

```
python -m unittest discover -s tests -v
```
"""

GITIGNORE = """# python
__pycache__/
*.pyc

# editor swap / temp files (install_mod.py skips them too)
*.swp
*~
"""


def render(template, **values):
    out = template
    for key, value in values.items():
        out = out.replace(f"__{key}__", value)
    return out


def abbreviation(name):
    parts = re.split(r"[_-]", name)
    return "".join(p[0] for p in parts if p) if len(parts) > 1 else name[:2]


def create(name, parent, title=None, developer=False):
    if not NAME_RE.match(name):
        raise SystemExit("name: lower-case letters, digits, _ and - only, starting with a letter")
    title = title or name.capitalize()
    global_name = re.sub(r"[^A-Za-z0-9]", "", title)
    repo = os.path.join(parent, "ACE" + global_name)
    if os.path.exists(repo):
        raise SystemExit(f"{repo} already exists")
    lib = "../../ACEUIModLoader/tests/lib"
    values = dict(NAME=name, TITLE=title, GLOBAL=global_name, ABBR=abbreviation(name), LIB=lib,
                  REPO="ACE" + global_name, DEVELOPER=DEVELOPER_KEY if developer else "")
    files = {
        os.path.join(name, "mod.json"): MOD_JSON,
        os.path.join(name, f"{name}.js"): SCRIPT,
        os.path.join(name, f"{name}.css"): STYLE,
        os.path.join("tests", "test_mod.py"): TEST,
        os.path.join("tests", "harness.html"): HARNESS,
        os.path.join("dev", "preview.html"): PREVIEW,
        "README.md": README,
        ".gitignore": GITIGNORE,
    }
    for rel, template in files.items():
        path = os.path.join(repo, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8", newline="\n") as f:
            f.write(render(template, **values))
    return repo


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    title = None
    if "--title" in sys.argv:
        title = sys.argv[sys.argv.index("--title") + 1]
        args = [a for a in args if a != title]
    if not args:
        print(__doc__)
        sys.exit(1)
    parent = args[1] if len(args) > 1 else os.path.dirname(_repos.REPO)
    print("created", create(args[0], parent, title, "--developer" in sys.argv))
