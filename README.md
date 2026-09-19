<div align="center">

# Assetto Corsa EVO UI App Loader

**Support for custom UI Apps in Assetto Corsa EVO.**<br>

[![Latest release](https://img.shields.io/github/v/release/dreasgrech/ACEUIAppLoader?style=flat-square&label=download&color=0a7)](../../releases/latest)
[![Built for](https://img.shields.io/badge/Assetto_Corsa_EVO-0.9.1%2Brelease.6-informational?style=flat-square)](#if-something-isnt-right)
[![Downloads](https://img.shields.io/github/downloads/dreasgrech/ACEUIAppLoader/total?style=flat-square&color=555)](../../releases)
[![Issues](https://img.shields.io/github/issues/dreasgrech/ACEUIAppLoader?style=flat-square&color=555)](../../issues)

</div>

<img width="2560" height="1440" alt="The game while driving, with the app drawer open on the right and apps on the HUD" src="https://github.com/user-attachments/assets/d1dd4c93-8b13-43eb-b7f7-9790d9adf08d" />



Assetto Corsa EVO builds its interface out of web pages. The ACE UI App Loader lets custom ui apps live in there alongside the game's own screens, and gives you one place to switch them on and off.


---

## Why this exists

AC EVO currently has no mod support for its UI, so the only way in is to replace one of its files — and **only one mod can hold a file**. Two mods that both want the HUD overwrite each other, and installing the second one silently breaks the first.

This UI App Loader is that one mod. It does the replacing once and then loads **apps** on top, so apps are added alongside each other instead of fighting over the same file.

---

## Installing the mod

<table>
<tr><td width="40" align="center"><h3>1</h3></td><td>

Download the **`ACEUIAppLoader-….zip`** from the [latest release](../../releases/latest) and open it.

Inside is one folder, `mods`. (The release also has an `…-alternate.zip`. Ignore it unless the help section below sends you to it.)

</td></tr>
<tr><td align="center"><h3>2</h3></td><td>

Press <kbd>Win</kbd> + <kbd>R</kbd>, paste this in, press <kbd>Enter</kbd>:

```
%USERPROFILE%\Saved Games\ACE
```
<p align="center">
<img width="399" height="206" alt="image" src="https://github.com/user-attachments/assets/3ded7537-4eb9-4c01-8fd2-ed1339e90814" />
</p>

</td></tr>
<tr><td align="center"><h3>3</h3></td><td>

Drag the `mods` folder out of the zip into that window. If Windows asks, choose to
**merge** with the `mods` folder already there. No installer, nothing to run.

You end up with `mods\ACEUIAppLoader.kspkg` and an empty `mods\uiresources\ACEUIAppLoader`
folder, which is where apps will go. Every app is installed the same way: extract its zip
into `Saved Games\ACE`, merge.

<img width="1041" height="458" alt="image" src="https://github.com/user-attachments/assets/9d9efbc3-9731-4a40-bd18-7df5fa1dab4a" />

</td></tr>
</table>

---

## The app drawer

<p align="center">
<img width="800" height="450" alt="The mouse reaches the right edge, the drawer slides in, and an app is switched on" src="https://github.com/user-attachments/assets/738a4162-7706-41bf-9f63-2aa679b32273" />
</p>

Move your mouse to the **right edge of the screen** and the drawer slides in. Every ui app you
have installed is listed there with its own switch — flick one on and it appears straight
away, flick it off and it's gone.

---

## Apps

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

<p align="center"><img src="docs/images/settings.png" width="70%" alt="An app's settings page"></p>

---

## If something isn't right

> [!IMPORTANT]
> Each release is built for **one version of the game** — this one for `0.9.1+release.6`.
> After the game updates, come back here for the matching release.

<details>
<summary><b>The game updated and the HUD is blank, missing, or the menus misbehave</b></summary><br>

The file carries two of the game's own pages from the version it was built for. After an
update those are the *old* game's, and if they still get used the HUD can come up empty or
wrong. The loader tells you when this has happened: a red strip across the top of the HUD
reading *ACE UI App Loader was built for game … but this is …*.

**Delete `ACEUIAppLoader.kspkg`** from the `mods` folder, start the game once to confirm it
is back to normal, then install the release built for the new version. Whenever the game
misbehaves right after an update, removing this file is the first thing to try.

</details>

<details>
<summary><b>The drawer doesn't appear</b></summary><br>

First, open the newest file in `%USERPROFILE%\Saved Games\ACE\Logs` and search it for
`ACEUIAppLoader`. **Lines found** means the loader ran and the problem is with an app: see the
next section. **No lines at all** means the game never used the file, for one of these reasons:

1. **The game updated.** By far the most common cause. See above.
2. **The file is in the wrong place.** It must be exactly `Saved Games\ACE\mods\ACEUIAppLoader.kspkg`,
   with that name. The usual way this goes wrong is Windows' *Extract All*, which puts
   everything in a folder named after the zip (`ACE\ACEUIAppLoader-0.24.0-…\mods\…`); drag the
   `mods` folder itself into `Saved Games\ACE` instead.
3. **Two copies.** Exactly one `ACEUIAppLoader…kspkg` in `mods` — an older copy left beside
   the new one (`ACEUIAppLoader (1).kspkg`, say) can win instead of it.
4. **Your other mods.** With several other `.kspkg` mods installed, the game very occasionally
   picks its own file over ours; which folders that happens in is a coin toss we cannot see
   from outside. That is what the **`…-alternate.zip`** on the release page is for: it is the
   same loader packed so that the toss lands differently. Delete `ACEUIAppLoader.kspkg` and
   install the alternate zip the same way. If installing another mod later brings the problem
   back, swap again.

</details>

<details>
<summary><b>An app isn't in the drawer</b></summary><br>

Check that app's own instructions. Most are two pieces — a folder and a small marker file —
and it's easy to install one and miss the other. The marker file must be **completely
empty** (0 bytes): the game tries to read every file in that folder as a preset, and one
it cannot read stops the whole list from arriving.

</details>

<details>
<summary><b>Anything else</b></summary><br>

Open an [issue](../../issues) and say what you saw. If you can, attach the newest file from
`%USERPROFILE%\Saved Games\ACE\Logs` — it records what loaded and usually answers the
question on its own.

</details>

---

## Uninstalling

Delete `ACEUIAppLoader.kspkg`. That's the whole procedure — nothing runs, nothing to undo.
The only trace left is a few small settings records (which apps were switched on, where you
put them) inside the game's own UI settings file, which the game ignores.

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

An app is one folder and a JavaScript file. No build step, no registration, and a shared
library for the parts that are genuinely hard in this engine.

```js
const me = ACEUIAppLoader.app("myapp");

me.mount(attach, detach);                              // the drawer starts and stops you
me.toggle(function () { return options.toggleKey; });  // a hotkey that respects typing
```

Start with **[`docs/writing-an-app.md`](docs/writing-an-app.md)**.

<details>
<summary><b>All documentation</b></summary><br>

| | |
|---|---|
| [`docs/writing-an-app.md`](docs/writing-an-app.md) | the app lifecycle and `app.json` |
| [`docs/library.md`](docs/library.md) | `ACEUIAppLoader.*`: storage, hotkeys, the frame loop |
| [`docs/ui.md`](docs/ui.md) | the drawer, windows, and settings pages |
| [`docs/building.md`](docs/building.md) | building the package, the tools, the tests |
| [`docs/how-it-works.md`](docs/how-it-works.md) | how one file overrides a game file, and why that is hard |
| [`docs/testing.md`](docs/testing.md) | the test kit and the browser harnesses |
| [`docs/style.md`](docs/style.md) | the JavaScript rules and why each one is there |
| [`docs/design.md`](docs/design.md) | the investigation behind the loader |
| [`docs/developer-apps.md`](docs/developer-apps.md) | why the developer tools ship inside the package |
| [`docs/naming.md`](docs/naming.md) | mod or app: which word means what, and why |
| [`docs/roadmap.md`](docs/roadmap.md) | what is missing |

Three developer apps ship inside the package — a capabilities probe, a console and a
profiler — behind a **developer apps** switch at the bottom of the drawer, off by default.

The game mechanics all of this rests on are documented in
[ACEGameInternals](https://github.com/dreasgrech/ACEGameInternals).

</details>

---

<div align="center">
<sub>Loader 0.24.0 · built for Assetto Corsa EVO <b>0.9.1+release.6</b></sub>
</div>
