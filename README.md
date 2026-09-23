<div align="center">

# Assetto Corsa EVO UI App Loader

**Support for custom UI Apps in Assetto Corsa EVO.**<br>

</div>

<p align="center">
<img width="2560" height="1440" alt="20260921200214_1" src="https://github.com/user-attachments/assets/7ac32bf7-a893-4e6d-a980-38b0a1de07ab" />
</p>


Assetto Corsa EVO builds its interface out of web pages. The ACE UI App Loader lets custom ui apps live in there alongside the game's own screens, and gives you one place to switch them on and off.


---

## Why this exists

AC EVO currently has no mod support for its UI, so the only way in is to replace one of its html files that's used the HUD — and **only one mod can hold a file**. Two mods that both want the HUD overwrite each other, and installing the second one silently breaks the first.

This UI App Loader is that one mod. It does the replacing once and then loads **apps** on top, so apps are added alongside each other instead of fighting over the same file.

<p align="center">
<img width="880" height="495" alt="full_cmp_E_880_10s_96" src="https://github.com/user-attachments/assets/a51b3b68-ee30-4ed8-9086-906aacecba7a" />
</p>

---

## Installing ACE UI App Loader

<table>
<tr><td width="40" align="center"><h3>1</h3></td><td>

Download the **`ACEUIAppLoader-….zip`** from the [latest release](../../releases/latest) and open it.

Inside is one folder, `mods`. Take the zip **without** `-alternate` in its name; [the other one](#why-there-are-two-zips) is a fallback.

<details>
<summary>Why there are two available zips for download? (normal and alternate)</summary>
   
Every release has `ACEUIAppLoader-….zip` and `ACEUIAppLoader-…-alternate.zip`. **Almost
everyone wants the first.** Here is what the second is for, in plain terms.

The loader works by giving the game a replacement for two of its own HUD files. When the game starts it gathers the files of every mod in `mods` into one list, and where two mods offer the same file, the order of that list decides which one is used. With only the loader installed, ours always comes first. 
With several other mods installed, once in a few thousand combinations the game's own file lands ahead of ours instead, and the loader silently does nothing: no drawer, no apps, and no `ACEUIAppLoader` lines in the game's log. Which combinations do this cannot be told from outside; it depends on the exact set of mod files on your machine.

The alternate zip contains the **same loader**, packed a different way, so that it sorts differently in that list. In testing over eight thousand mod folders, the two zips never both lost in the same folder. So the rule is simple: 

1. Install the normal zip.
2. If the drawer never appears **and** the newest log in `Saved Games\ACE\Logs` has no `ACEUIAppLoader` lines, delete `mods\ACEUIAppLoader.kspkg` and install the alternate zip the same way.
3. If the drawer disappears again after you install another mod, swap back.

The loader's first log line tells you which one you have: `loader 0.26.0 on /hud.html (64 records)` is the normal zip, `(32 records)` the alternate. Nothing else differs; apps, settings and everything on this page work the same with either.
</details>

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

Move your mouse to the **right edge of the screen** and the drawer slides in — or set a hotkey
for it in the drawer's own **OPTIONS**. Every ui app you have installed is listed there with
its own switch — flick one on and it appears straight away, flick it off and it's gone.

Three ways to open it, all in **OPTIONS** at the top of the drawer:

- **The edge.** The pointer coming within a zone of the edge opens it. The zone is about 2%
  of the screen's width by default (four times what the first release had) and can be made
  wider, limited to the top, middle or bottom third of the edge, or given a short dwell so
  passing the edge on the way to something else does not open it. A thin red line lights up
  on the edge as you get close, since the game hides the cursor when it has been still for a
  few seconds; while the options are open the whole zone is drawn, so you can see the area
  you are setting.
- **A hotkey.** Unbound until you set one, so it never clashes with a key you have bound in
  the game. Click the control, press the key; Delete while it waits unbinds it again.
- **A click at the edge**, for those who would rather nothing opened by itself.

The drawer can also live on the **left edge**, be **pinned** open, fade in instead of sliding
(if the slide stutters on your machine), and have its width, height, scale and opacity set. **Second monitor to the right?** If your pointer flies off the screen
before it reaches the edge, put the drawer on the left edge, widen the zone, or give it a
hotkey; once the pointer is on another screen the game hears nothing from it, so no edge can
catch it there. **Triple screens:** the *Triple screen* switch puts the drawer at the edge of
the centre screen rather than the far edge of the right one, and *Edge offset* moves it
further in from there. The drawer is mouse-driven; a gamepad-only setup has no way to open it
yet.

---

## Apps using the ACE UI App Loader

Each is a separate download with its own instructions.

### [Pedal Graph](https://github.com/dreasgrech/ACEPedalGraph)
<table>
<tr>
<td width="400" valign="top"><a href="https://github.com/dreasgrech/ACEPedalGraph"><img width="400" height="171" alt="The pedal graph scrolling on the HUD" src="https://github.com/user-attachments/assets/bdc6917a-0502-408a-9693-ea495d12f618" /></a></td>
<td valign="top">
   Throttle, brake, clutch and handbrake as a scrolling graph on the HUD, with live level bars beside it. Steering and the ABS, TC and ESC marks can be switched on too.
</td>
</tr>
</table>

### [DOOM](https://github.com/dreasgrech/ACEDOOM)
<table>
<tr>
<td width="400" valign="top"><a href="https://github.com/dreasgrech/ACEDOOM"><img width="400" alt="DOOM running on the HUD" src="https://github.com/user-attachments/assets/d723ea88-3f27-420a-bd88-3ebad1ed0351" /></a></td>
<td valign="top">
   DOOM (1993) running natively inside EVO's HUD: a real game engine rendered through the game's own UI, in a panel you can drag, scale and hide. Saved games survive quitting the sim.
</td>
</tr>
</table>

---

## Inbuilt Apps

### UI Profiler
<table>
<tr>
<td width="300" valign="top"><img width="534" height="424" alt="profiler_cmp_D_50fps_6s_96" src="https://github.com/user-attachments/assets/dcac9bed-6c51-4f1e-89f9-4045464cae2f" /></td>
<td valign="top">
   The UI Profiler is a tool for helping app authors measure their performance of the app in game and how it does compared to other apps.
</td>
</tr>
</table>

### Dev Console
<table>
<tr>
<td width="585" valign="top"><img width="985" height="480" alt="image" src="https://github.com/user-attachments/assets/7b74e3bd-d816-45e8-bae2-c8802d1a6394" /></td>
<td valign="top">
   The Dev Console is a tool for app authors which exposes an output stream for the log files and a way interacting directly with the JavaScript objects.
</td>
</tr>
</table>

### UI Capabilities Probe
<table>
<tr>
<td width="585" valign="top"><img width="566" height="735" alt="image" src="https://github.com/user-attachments/assets/1324479f-a5ae-416f-ab19-fadb0a6249b8" /></td>
<td valign="top">
   The UI Capabilities probe is also a tool for app authors which shows what is actually supported by the V8 JavaScript engine that's exposed by EVO's shipped Coherent Labs Gameface Cohtml engine.  
   <br/><br/>
   This helps app authors understand what specific capabilities are available for use in their apps.  For example, with the UI Capabilities Probe app, an app author can quickly see that WebAssembly is not supported or that not all canvas functions are available, and so on.
   <br/><br/>
   It also carries a <b>model recorder</b>: switched on from its Record button or its settings, it writes what the HUD's telemetry models do over a session to the game log (every change of the slow fields, a summary per lap, calibration pairs, leaderboard dumps), and keeps going through Escape and resume.
</td>
</tr>
</table>


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
   everything in a folder named after the zip (`ACE\ACEUIAppLoader-0.26.0-…\mods\…`); drag the
   `mods` folder itself into `Saved Games\ACE` instead.
3. **Two copies.** Exactly one `ACEUIAppLoader…kspkg` in `mods` — an older copy left beside
   the new one (`ACEUIAppLoader (1).kspkg`, say) can win instead of it.
4. **Your other mods.** With several other `.kspkg` mods installed, the game very occasionally
   uses its own file instead of ours. That is what the **`…-alternate.zip`** is for: delete
   `ACEUIAppLoader.kspkg`, install the alternate zip the same way, and read
   [why there are two zips](#why-there-are-two-zips) if you want to know what is going on.

</details>

<details>
<summary><b>The drawer is there but I can't open it</b></summary><br>

The loader ran (the log has `ACEUIAppLoader` lines, one of them `[drawer] built: right, zone
2rem ...`) but the edge does nothing. Check the HUD is not hidden — the drawer never opens
over a hidden HUD — and that no mouse button is held. If you changed the drawer's options,
they may be the cause: *Open with: hotkey only* needs a key bound (with none bound the edge
still works), and a large *Edge offset* moves the edge inwards. Pull the drawer in with its
hotkey if you set one and press *Reset to defaults* in OPTIONS; or, from the dev console
(a developer app), run `ACEUIAppLoader.drawer.resetSettings()`. Deleting `ACEUIAppLoader.kspkg`
and reinstalling does **not** reset them — they live in the game's own UI settings file with
your other HUD choices.

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
| **Works in multiplayer** | Everything is done client-side so nothing is related to the server. |
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
