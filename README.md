# ACE UI Mod Loader

**Adds mods to the Assetto Corsa EVO interface. One file to install, one file to delete.**

![The app drawer open while driving](docs/images/hero.png)

Assetto Corsa EVO builds its interface out of web pages. This lets other people's mods live
in there alongside the game's own screens — a pedal graph, a lap delta, a telemetry
readout — and gives you one place to switch them on and off.

Nothing is added to the game's own folder. No launcher, no program running in the
background, no setting to change. It is one file sitting in your Saved Games folder, and
deleting it puts everything back exactly as it was.

---

## Install

**1. Download `ACEUIModLoader.kspkg`** from the [latest release](../../releases/latest).

**2. Open your mods folder.** Press `Win + R`, paste this in, press Enter:

```
%USERPROFILE%\Saved Games\ACE\mods
```

If there is no `mods` folder yet, create one with exactly that name.

**3. Put the file in it.** No unzipping, no installer, nothing to run.

![The file in the mods folder](docs/images/mods-folder.png)

Start the game and drive. **Move your mouse to the right edge of the screen** and the app
drawer slides in.

![Opening the drawer and switching an app on](docs/images/drawer.gif)

---

## Adding mods

Each mod is a separate download with its own instructions:

| | |
|---|---|
| [**Pedal Graph**](https://github.com/dreasgrech/ACEPedalGraph) | throttle, brake and clutch traces as you drive |
| [**Telemetry**](https://github.com/dreasgrech/ACEUITelemetry) | lap times and a live delta against your reference lap |
| [**DOOM**](https://github.com/dreasgrech/ACEDOOM) | the actual game of DOOM, playable on your HUD |

<p align="center">
  <img src="docs/images/apps-pedalgraph.png" width="32%" alt="Pedal graph">
  <img src="docs/images/apps-telemetry.png" width="32%" alt="Telemetry">
  <img src="docs/images/apps-doom.png" width="32%" alt="DOOM">
</p>

Every mod gets its own switch in the drawer, and most can be configured in game.

![A mod's settings page](docs/images/settings.png)

---

## If something isn't right

**The drawer doesn't appear.** Nearly always one of these:

- **The game updated.** Each release is built for one version of the game — this one for
  **0.9.1+release.6**. After a game update, come back here for the matching release.
- **The file is in the wrong place.** It goes straight into `mods`, not a subfolder, and it
  has to keep the name `ACEUIModLoader.kspkg`.
- **Another mod that installs a `.kspkg` file.** Two of those can occasionally clash.

**A mod isn't in the drawer.** Check that mod's own instructions — most are two pieces, and
it is easy to miss one.

**Anything else.** Open an [issue](../../issues) and say what you saw. If you can, attach
the newest file from `%USERPROFILE%\Saved Games\ACE\Logs`, which records what loaded.

---

## Uninstalling

Delete `ACEUIModLoader.kspkg`. That is the whole procedure.

The loader never writes into the game, so there is nothing else to undo and nothing left
behind.

---

## Is it safe?

Worth answering specifically rather than just saying yes:

- **Nothing runs.** No executable, no installer, nothing in the background, nothing that
  starts with Windows. It is a data file the game reads.
- **The game folder is never touched.** Everything lives in `Saved Games`, where the game
  already keeps your settings and setups.
- **It does not go online.** No account, no telemetry, no update check.
- **It is not anti-cheat evasion.** It changes the interface you look at, nothing about how
  the car drives or how results are reported.
- **You can read all of it.** Every line is in this repository.

---

## For developers

A mod is one folder and a JavaScript file. No build step, no registration, and a shared
library for the parts that are genuinely hard in this engine.

```js
const me = ACEUIModLoader.mod("mymod");

me.mount(attach, detach);                              // the drawer starts and stops you
me.toggle(function () { return options.toggleKey; });  // a hotkey that respects typing
```

Start with [**`docs/writing-a-mod.md`**](docs/writing-a-mod.md).

| | |
|---|---|
| [`docs/writing-a-mod.md`](docs/writing-a-mod.md) | the mod lifecycle and `mod.json` |
| [`docs/library.md`](docs/library.md) | `ACEUIModLoader.*`: storage, hotkeys, the frame loop |
| [`docs/ui.md`](docs/ui.md) | the drawer, windows, and settings pages |
| [`docs/building.md`](docs/building.md) | building the package, the tools, the tests |
| [`docs/how-it-works.md`](docs/how-it-works.md) | how one file overrides a game file, and why that is hard |
| [`docs/testing.md`](docs/testing.md) | the test kit and the browser harnesses |
| [`docs/style.md`](docs/style.md) | the JavaScript rules and why each one is there |
| [`docs/design.md`](docs/design.md) | the investigation behind the loader |
| [`docs/developer-apps.md`](docs/developer-apps.md) | why the developer tools ship inside the package |
| [`docs/roadmap.md`](docs/roadmap.md) | what is missing |

Three developer apps ship inside the package — a capabilities probe, a console and a
profiler — behind a **developer apps** switch at the bottom of the drawer, off by default.

The game mechanics all of this rests on are documented in
[ACEGameInternals](https://github.com/dreasgrech/ACEGameInternals).

---

Loader 0.20.0 · built for Assetto Corsa EVO **0.9.1+release.6**
