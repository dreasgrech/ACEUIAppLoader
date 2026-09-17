# How it works

The game serves every UI page — menu, in-game, HUD — from `content.kspkg`, and loads `uiresources/js/cohtml.js` first on each of them. This repo ships one package containing our copy of that file: the untouched stock script with the library appended. That is the whole injection mechanism. Everything else is a consequence of it.

## Getting the library into the page

The package holds **two** copies of the library, reached two different ways:

| what the package overrides | how the library gets in |
|---|---|
| `uiresources\js\cohtml.js` | the stock script with the library appended; runs on all 13 pages |
| `uiresources\hud.html` | Kunos' page byte for byte with one `<script>` tag added, pointing at `ACEUIModLoaderApps/loader.js` |

The second exists because an override is not guaranteed to win (below), and two are far better than one. The script it adds sits at a **new** path, which always resolves whatever the merged package layout turns out to be, so winning the page is enough on its own — proven in game with the `cohtml.js` override deliberately left out.

Both can win at once, so the standalone copy is wrapped in `if (window.ACEUIModLoader) { return; }`. `cohtml.js` runs first, above our tag, so when that route works the second file does nothing at all.

Our copy of `hud.html` is Kunos' page with one line added, which means it has to be re-extracted for **every game version**. If the stock page changes and we serve last version's copy, the whole HUD breaks rather than merely failing to load us. The build checks for the anchor it edits and fails rather than guess.

## Why an override is a coin toss

This is the part that shapes everything.

The game keeps **one shared file table** for every package. `AddPackage` appends each package's entries to that vector and re-sorts the whole thing with MSVC's `std::sort` — an introsort, which is **unstable**. A lookup hashes the path (FNV-1a 64 over the lower-cased path as UTF-16LE) and does a `std::lower_bound` on that vector, taking the first record it lands on.

Ship a file the base package also has, and there are now two records with the identical hash sitting adjacent. Which one comes first is decided by where introsort happened to leave them, which depends on the position of every other record in the vector. Unpadded, of 40 candidate layouts of our package, **5 won**.

And the bias is not neutral. `content.kspkg` is added first, so its record starts at a lower index than ours; the partition that gathers equal hashes moves lower-indexed equals to the **front**, and the front is exactly what `lower_bound` returns. **The game is structurally tilted toward the stock file.**

The resolution depends on three things and nothing else:

1. `content.kspkg`'s complete hash set — i.e. the game version
2. our package's complete hash set
3. every other `.kspkg` in `mods\`, and the order they are added

Nothing machine-specific: no timestamps, no install path, no hardware. Two players on the same game version with the same package set get bit-identical vectors and the identical outcome. That is why a package can be shipped at all — and why it has to be built for the package set it will land in.

## What makes it reliable

**Padding.** `pack_kspkg.py` adds dummy directory entries to shift the sort until the override lands first, replaying MSVC's introsort exactly (`lookup_sim.py` in `ACEGameInternals`, which reproduced all seven layouts observed across 13 launches). This is what made a single override work at all.

**Duplicate records.** Padding decides where *one* record lands; duplicates decide how many the override has. The entry format stores the lookup hash in its own field, separate from the path, and the game reads it verbatim and keeps only `{hash, size, offset, flags, package index}` in memory — **no path**. So extra records can carry the target's hash and blob under a decoy path of their own, and a decoy that wins a lookup is indistinguishable from the real record. The decoys live under `uiresources\dup\`, outside every folder the startup preload walks, so the file is never read more than once.

The count is **not a dial**. Measured against a population of package sets, 32, 64 and 96 behave well while 48 and 256 are an order of magnitude worse — certain counts make our hash set couple the two entry points together so they fail on the same scenarios. The good values depend on the package's whole hash set, so they move whenever the package gains a file. `tune_dups.py` measures them and records the answer behind a fingerprint; the build refuses a measurement taken for a different file set.

`tune_dups.py` measures other people's packages too, and two of its arguments exist for that. `package_name` is the file name to measure under — load order is by name and load order decides who wins, so measuring ACEDOOM's package under the loader's file name measures a different package. `require` is what counts as a win: the loader has **two independent ways into the page** and needs either to land, so `"any"` is the truth for it, but a package whose overrides must *all* land wants `"all"` or the count is chosen against a success it does not have. ACEDOOM is the second kind — its bank without its table plays DOOM's samples on event types nothing fires, and its table without its bank fires types whose samples are still Kunos' — and measured that way it needs 128 records where one override needed 32.

Measured against sixty package sets nothing was selected on:

| | one record | tuned |
|---|---|---|
| Two entry points | 74% | **32 records — 60/60** |
| A single override (ACEDOOM's sound bank) | 40% | 32 records — 27/30 |

The ceiling differs because ACEDOOM's bank swap has only one file it can override. Two ways in is what buys the last few percent.

**None of it is a proof.** Sixty sets put the failure rate under a few percent, not at zero, and a package set nobody simulated can still lose. A stock install of the matching game version is the only case that is certain, because it can be computed exactly before shipping.

## Finding the mods

A UI page cannot list folders, but the game lists one folder for it: the video settings presets in `Saved Games\ACE\Video\*.settingspreset`. On every page the loader sends the game's own `SettingsRequestVideoPresetList`, keeps the answers beginning `ACEUIModLoaderMods-`, and treats the rest of each name as an installed mod. It then reads that mod's `ACEUIModLoaderMods/<name>/mod.json` and injects its stylesheets and scripts, in order, on the pages the mod asked for.

So a mod is two things and no registration step. The markers must stay **empty**: the game deserialises every listed file before naming it, and an empty file is a valid default message. The stock UI shows the same list in its video presets menu, so the loader wraps `engine.on` and hands stock handlers a copy of the answer with our markers removed.

The game's answer is the only source of mod names. Without an engine, or without an answer within 1.5 s, the loader says why and loads nothing.

## Two roots, deliberately

Bundled apps live inside the package at `uiresources\ACEUIModLoaderApps\<name>\`. Installed mods live loose at `mods\uiresources\ACEUIModLoaderMods\<name>\`.

They must differ, because **loose files never beat packed files**. A bundled app sitting at the installed mods' path could never be overridden, and `install_mod.py` would silently stop working on it. Kept apart, the opposite holds and is the point: an installed mod of the same name **wins** over the bundled copy, so working on a bundled app is still install, reload, look.

Those app files are *new* paths, which always resolve. Only the two entry points are overrides.

## Rules that cost a launch to learn

**Never request a URL that could be a folder.** The loose-file lookup only checks that the path exists, so a folder passes; a Resource Manager worker then throws opening it and the game dies. The loader only ever requests plain file names listed in a `mod.json`.

**Everything the loader logs** starts with `[ACEUIModLoader]` and lands in the game log as `[gameface]` lines; each mod's own lines start with its title. `check_ingame_log.py` reads the newest log and reports what loaded, what failed, and whether the game crashed.

**A missing file is harmless** — one warning line, about 5 ms. A folder is fatal. The difference is worth remembering when adding anything that fetches.

## What Kunos actually provide

Nothing that helps or hinders, which is worth knowing before looking for a better way in. The mod scan opens `content.kspkg`, lists `mods\*.kspkg` in the filesystem's order (the game does no sorting of its own), adds each through the identical `AddPackage`, and then registers `mods\` as a loose search directory. Records are appended with no deduplication and no validation that a record's hash matches its path.

There is no manifest, no load order file, no enable/disable list, no dependency system and no version check. That is the entirety of it — and it is exactly why car mods scale without limit: they only ever add new paths, so nothing ever collides. Every part of this project follows that model except the two entry points, which cannot, because to run on a page you have to be referenced by it.

## When the game updates

A patch breaks this in two ways, neither of which says anything. The package carries copies of two of Kunos' files -- `cohtml.js` and `hud.html` -- which the patch has moved on from; and which record the lookup finds is decided against `content.kspkg`'s whole hash set, which the patch has changed, so the padding and the record counts were measured for a game that no longer exists. The symptom of either is the same: nothing appears.

What the build does about it:

- **It refuses a stock page it does not recognise.** `hud.html` is Kunos' file plus one script tag; if the rest of it has changed, `assemble_page` stops rather than shipping the previous version's copy of their page over their new one.
- **It stamps the game build it was made for.** `ACEUIModLoader.builtFor` goes into the package, and at start-up the loader compares it with `ModelUIState.game_version` and logs a line when they differ, so a log from a player on a newer build says so.
- **It refuses a measurement taken for a different file set.** `dups.json` records the count behind a fingerprint of the package's paths and the game build it was measured on.

`tools/post_update.py` is the recovery: it rebuilds (re-reading the stock files), re-measures when the fingerprint or the game build has moved, reinstalls, and then replays the lookup over the packages actually in the mods folder to say whether both ways in still resolve to ours.

**What a patch cannot break.** Everything here rests on the sort being *unstable* -- not on our replay of MSVC's introsort being right. Score the same package assuming nothing at all about the algorithm, only that a run of equal hashes ends up in some arbitrary order, and 32 records across two entry points still wins 99.908% of the time; the replay is what makes the estimate precise, not what makes the construction work. The one change that would be fatal is a *stable* sort, and that would take every override mod in the game with it.
