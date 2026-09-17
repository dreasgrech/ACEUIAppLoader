<div align="center">

# ACE UI Mod Loader

**Mods for the Assetto Corsa EVO interface.**<br>
One file to install. One file to delete.

[![Latest release](https://img.shields.io/github/v/release/dreasgrech/ACEUIModLoader?style=flat-square&label=download&color=0a7)](../../releases/latest)
[![Built for](https://img.shields.io/badge/Assetto_Corsa_EVO-0.9.1%2Brelease.6-informational?style=flat-square)](#if-something-isnt-right)
[![Downloads](https://img.shields.io/github/downloads/dreasgrech/ACEUIModLoader/total?style=flat-square&color=555)](../../releases)
[![Issues](https://img.shields.io/github/issues/dreasgrech/ACEUIModLoader?style=flat-square&color=555)](../../issues)

[Install](#install) · [The app drawer](#the-app-drawer) · [Mods](#mods) · [Help](#if-something-isnt-right) · [Safety](#is-it-safe) · [Developers](#for-developers)

</div>

![The app drawer open while driving](docs/images/hero.png)

Assetto Corsa EVO builds its interface out of web pages. This lets other people's mods live
in there alongside the game's own screens, and gives you one place to switch them on and off.

---

## Why this exists

The game has no mod support for its interface, so the only way in is to replace one of its
files — and **only one mod can hold a file**. Two mods that both want the HUD overwrite each
other, and installing the second one silently breaks the first.

This does the replacing once, so mods are added alongside it instead of fighting over it.

---

## Install

<table>
<tr><td width="40" align="center"><h3>1</h3></td><td>

Download **`ACEUIModLoader.kspkg`** from the [latest release](../../releases/latest).

</td></tr>
<tr><td align="center"><h3>2</h3></td><td>

Press <kbd>Win</kbd> + <kbd>R</kbd>, paste this in, press <kbd>Enter</kbd>:

```
%USERPROFILE%\Saved Games\ACE\mods
```

No `mods` folder yet? Create one with exactly that name.

</td></tr>
<tr><td align="center"><h3>3</h3></td><td>

Drop the file in. No unzipping, no installer, nothing to run.

![The file in the mods folder](docs/images/mods-folder.png)

</td></tr>
</table>

---

## The app drawer

![Opening the drawer and switching an app on](docs/images/drawer.gif)

Move your mouse to the **right edge of the screen** and the drawer slides in. Every mod you
have installed is listed there with its own switch — flick one on and it appears straight
away, flick it off and it's gone.

| | |
|---|---|
| **Stays put** | Drag an app anywhere on screen. It's there next time. |
| **Settings in game** | Each mod gets its own page. Nothing to edit in a text file. |
| **Hotkeys** | Give an app a key. It won't fire while you're typing. |
| **No trace** | One file. Delete it and the game is untouched. |

---

## Mods

<table>
<tr>
<td width="33%" align="center"><a href="https://github.com/dreasgrech/ACEPedalGraph"><img src="docs/images/apps-pedalgraph.png" alt="Pedal graph"></a></td>
<td width="33%" align="center"><a href="https://github.com/dreasgrech/ACEUITelemetry"><img src="docs/images/apps-telemetry.png" alt="Telemetry"></a></td>
<td width="33%" align="center"><a href="https://github.com/dreasgrech/ACEDOOM"><img src="docs/images/apps-doom.png" alt="DOOM"></a></td>
</tr>
<tr>
<td align="center"><a href="https://github.com/dreasgrech/ACEPedalGraph"><b>Pedal Graph</b></a><br><sub>throttle, brake and clutch as you drive</sub></td>
<td align="center"><a href="https://github.com/dreasgrech/ACEUITelemetry"><b>Telemetry</b></a><br><sub>lap times and a live delta</sub></td>
<td align="center"><a href="https://github.com/dreasgrech/ACEDOOM"><b>DOOM</b></a><br><sub>yes, really — playable on your HUD</sub></td>
</tr>
</table>

Each is a separate download with its own instructions.

<p align="center"><img src="docs/images/settings.png" width="70%" alt="A mod's settings page"></p>

---

## If something isn't right

> [!IMPORTANT]
> Each release is built for **one version of the game** — this one for `0.9.1+release.6`.
> After the game updates, come back here for the matching release.

<details>
<summary><b>The drawer doesn't appear</b></summary><br>

1. **The game updated.** By far the most common cause.
2. **The file is in the wrong place.** Straight into `mods`, not a subfolder, and it keeps
   the name `ACEUIModLoader.kspkg`.
3. **Another mod that installs a `.kspkg` file.** Two of those can occasionally clash.

</details>

<details>
<summary><b>A mod isn't in the drawer</b></summary><br>

Check that mod's own instructions. Most are two pieces — a folder and a small marker file —
and it's easy to install one and miss the other.

</details>

<details>
<summary><b>Anything else</b></summary><br>

Open an [issue](../../issues) and say what you saw. If you can, attach the newest file from
`%USERPROFILE%\Saved Games\ACE\Logs` — it records what loaded and usually answers the
question on its own.

</details>

---

## Uninstalling

Delete `ACEUIModLoader.kspkg`. That's the whole procedure — nothing else to undo, nothing
left behind.

---

## Is it safe?

| | |
|---|---|
| **Nothing runs** | No executable, no installer, nothing in the background. It's a data file the game reads. |
| **Your game folder is untouched** | Everything lives in `Saved Games`, where your settings and setups already are. |
| **It doesn't go online** | No account, no telemetry, no update check. |
| **Not anti-cheat evasion** | It changes the interface you look at — nothing about how the car drives. |
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
