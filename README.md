<div align="center">

# ACE UI Mod Loader

**Mods for the Assetto Corsa EVO interface.**<br>
One file to install. One file to delete.

[![Latest release](https://img.shields.io/github/v/release/dreasgrech/ACEUIModLoader?style=flat-square&label=download&color=0a7)](../../releases/latest)
[![Built for](https://img.shields.io/badge/Assetto_Corsa_EVO-0.9.1%2Brelease.6-informational?style=flat-square)](#if-something-isnt-right)
[![Downloads](https://img.shields.io/github/downloads/dreasgrech/ACEUIModLoader/total?style=flat-square&color=555)](../../releases)
[![Issues](https://img.shields.io/github/issues/dreasgrech/ACEUIModLoader?style=flat-square&color=555)](../../issues)

[Install](#install) · [Mods](#mods) · [Troubleshooting](#if-something-isnt-right) · [Uninstall](#uninstalling) · [Is it safe?](#is-it-safe) · [Developers](#for-developers)

</div>

![The app drawer open while driving](docs/images/hero.png)

Assetto Corsa EVO builds its interface out of web pages. This lets other people's mods live
in there alongside the game's own screens — a pedal graph, a lap delta, a telemetry
readout — and gives you one place to switch them on and off.

Nothing is added to the game's own folder. No launcher, no program running in the
background, no setting to change. It is one file in your Saved Games folder, and deleting
it puts everything back exactly as it was.

---

## Install

<table>
<tr><td width="40"><h3>1</h3></td><td>

**Download `ACEUIModLoader.kspkg`** from the [latest release](../../releases/latest).

</td></tr>
<tr><td><h3>2</h3></td><td>

**Open your mods folder.** Press <kbd>Win</kbd> + <kbd>R</kbd>, paste this in, press <kbd>Enter</kbd>:

```
%USERPROFILE%\Saved Games\ACE\mods
```

If there is no `mods` folder yet, create one with exactly that name.

</td></tr>
<tr><td><h3>3</h3></td><td>

**Put the file in it.** No unzipping, no installer, nothing to run.

![The file in the mods folder](docs/images/mods-folder.png)

</td></tr>
</table>

Start the game and drive. **Move your mouse to the right edge of the screen** and the app
drawer slides in.

![Opening the drawer and switching an app on](docs/images/drawer.gif)

---

## Mods

Each one is a separate download with its own instructions.

<table>
<tr>
<td width="33%" align="center"><a href="https://github.com/dreasgrech/ACEPedalGraph"><img src="docs/images/apps-pedalgraph.png" alt="Pedal graph"></a></td>
<td width="33%" align="center"><a href="https://github.com/dreasgrech/ACEUITelemetry"><img src="docs/images/apps-telemetry.png" alt="Telemetry"></a></td>
<td width="33%" align="center"><a href="https://github.com/dreasgrech/ACEDOOM"><img src="docs/images/apps-doom.png" alt="DOOM"></a></td>
</tr>
<tr>
<td align="center"><a href="https://github.com/dreasgrech/ACEPedalGraph"><b>Pedal Graph</b></a><br><sub>throttle, brake and clutch traces as you drive</sub></td>
<td align="center"><a href="https://github.com/dreasgrech/ACEUITelemetry"><b>Telemetry</b></a><br><sub>lap times and a live delta against your reference lap</sub></td>
<td align="center"><a href="https://github.com/dreasgrech/ACEDOOM"><b>DOOM</b></a><br><sub>the actual game of DOOM, playable on your HUD</sub></td>
</tr>
</table>

Every mod gets its own switch in the drawer, and most can be configured in game.

![A mod's settings page](docs/images/settings.png)

---

## If something isn't right

> [!IMPORTANT]
> Each release is built for **one version of the game** — this one for `0.9.1+release.6`.
> After the game updates, come back here for the matching release.

<details>
<summary><b>The drawer doesn't appear</b></summary><br>

Almost always one of three things:

1. **The game updated.** See above — this is by far the most common cause.
2. **The file is in the wrong place.** It goes straight into `mods`, not a subfolder, and it
   has to keep the name `ACEUIModLoader.kspkg`.
3. **Another mod that installs a `.kspkg` file.** Two of those can occasionally clash.

</details>

<details>
<summary><b>A mod isn't in the drawer</b></summary><br>

Check that mod's own instructions. Most mods are two pieces — a folder and a small marker
file — and it is easy to install one and miss the other.

</details>

<details>
<summary><b>Anything else</b></summary><br>

Open an [issue](../../issues) and say what you saw.

If you can, attach the newest file from `%USERPROFILE%\Saved Games\ACE\Logs`. It records
what loaded and what didn't, and usually answers the question on its own.

</details>

---

## Uninstalling

Delete `ACEUIModLoader.kspkg`. That is the whole procedure.

The loader never writes into the game, so there is nothing else to undo and nothing left
behind.

---

## Is it safe?

> [!NOTE]
> Worth answering specifically rather than just saying yes.

| | |
|---|---|
| **Nothing runs** | No executable, no installer, nothing in the background, nothing that starts with Windows. It is a data file the game reads. |
| **Your game folder is untouched** | Everything lives in `Saved Games`, where the game already keeps your settings and setups. |
| **It doesn't go online** | No account, no telemetry, no update check. |
| **It isn't anti-cheat evasion** | It changes the interface you look at — nothing about how the car drives or how results are reported. |
| **You can read all of it** | Every line is in this repository. |

---

## For developers

A mod is one folder and a JavaScript file. No build step, no registration, and a shared
library for the parts that are genuinely hard in this engine.

```js
const me = ACEUIModLoader.mod("mymod");

me.mount(attach, detach);                              // the drawer starts and stops you
me.toggle(function () { return options.toggleKey; });  // a hotkey that respects typing
```

Start with **[`docs/writing-a-mod.md`](docs/writing-a-mod.md)**.

<details>
<summary><b>All documentation</b></summary><br>

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

</details>

---

<div align="center">
<sub>Loader 0.20.0 · built for Assetto Corsa EVO <b>0.9.1+release.6</b></sub>
</div>
