# How it works

The game serves every UI page — menu, in-game, HUD — from `content.kspkg`, and loads `uiresources/js/cohtml.js` first on each of them. This repo ships one package containing our copy of that file: the untouched stock script with the library appended. That is the whole injection mechanism. Everything else is a consequence of it.

## Getting the library into the page

The package holds **two** copies of the library, reached two different ways:

| what the package overrides | how the library gets in |
|---|---|
| `uiresources\js\cohtml.js` | the stock script with the library appended; runs on all 13 pages |
| `uiresources\hud.html` | Kunos' page byte for byte with one `<script>` tag added, pointing at `ACEUIAppLoaderBuiltIn/loader.js` |

The second exists because an override is not guaranteed to win (below), and two are far better than one. The script it adds sits at a **new** path, which always resolves whatever the merged package layout turns out to be, so winning the page is enough on its own — proven in game with the `cohtml.js` override deliberately left out.

Both can win at once, so the standalone copy is wrapped in `if (window.ACEUIAppLoader) { return; }`. `cohtml.js` runs first, above our tag, so when that route works the second file does nothing at all.

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

## How reliable it actually is

**Two packages, differing only in how many records each override carries, lose on
different folders.** Measured 2026-09-18 over the first 2,000 folders of the validation's
seeded stream (`tools/validate_override.py`'s scenarios, 0 to 30 other mods, the four
published car mods in the population), for the release build's exact files:

| records per override | lost both entry points | `cohtml.js` lost alone | `hud.html` lost alone |
|---|---|---|---|
| 16 | 4 of 2,000 (0.20%) | 98 | 60 |
| 32 | 0 of 2,000 | 33 | 26 |
| 64 | 0 of 2,000 | 18 | 13 |
| 128 | 0 of 2,000 | 67 | 8 |

No folder was lost by two of the four, and even the single-tie losses overlap on at most
3 folders in 2,000. Three other levers were tried on the same folders and rejected: **one
extra path** in the package changed nothing -- the same folders lost at the same step;
**a file name that sorts first** (`!ACEUIAppLoader.kspkg`) cut `cohtml.js` losses but lost
two folders outright where the current name lost none; **a name that sorts last** lost 12%
of folders, because the base package's record has the lower index and the sort favours it.
Tracing the losing folders add by add showed the loss is decided by the packages added
*after* ours -- ours is in front for twenty-five additions and pushed behind by the
twenty-seventh -- so a folder that wins today can lose after the next car mod.

Hence the release is **two packages**: the primary with the count `tune_dups.py --release
--stream=200` chooses -- scored against 600 of those same folders rather than the tuner's
easy built-in sets, which cannot tell these counts apart, and tie-broken by single ties --
and an alternate (`--alternate`) with the best *other* count. For 0.24.0 that is **64 and
32**. A player whose folder beats the primary is handed the alternate, one swap, and the
loader's boot line says which one is installed (`loader 0.24.0 on /hud.html (64 records)`).

**The two shipped 0.24.0 packages, pulled out of their release zips, over all 7,987 folders
of the stream** (2026-09-19, about five hours):

| | lost both entry points | `cohtml.js` alone | `hud.html` alone |
|---|---|---|---|
| primary (64 records) | **1 of 7,987, 0.013%** | 70 | 69 |
| alternate (32 records) | 2 of 7,987, 0.025% | 135 | 109 |
| both on the same folder | **0** | | |

| other mods installed | folders | primary lost | alternate lost |
|---|---|---|---|
| none | 495 | 0 | 0 |
| 1-2 | 1,895 | 0 | 0 |
| 3-5 | 1,867 | 1 | 0 |
| 6-10 | 1,406 | 0 | 1 |
| 11-20 | 1,421 | 0 | 0 |
| 21-30 | 903 | 0 | 1 |

So the primary alone is about eight times more reliable than the package this replaced, and
a player who loses it and swaps is, on this evidence, never lost twice. The stream is a
model of other people's mod folders, not a census of them; the numbers say how the packages
behave against it, and a folder nobody simulated can still lose. Installing both at once is not two
draws -- both sets of records land in one vector and one sort -- so the README says swap,
never stack.

The earlier, larger measurement below was taken under the package's **previous name**
(`ACEUIModLoader.kspkg`, see `override-runs.jsonl.meta.json`); the rename changed the hash
set and the scan position, so its figures describe a different package. It is kept for what
it established about the two entry points:

Measured overnight on 2026-09-17 against **7,987 installed-package sets**, scoring the
built `.kspkg` files themselves rather than a reconstruction of them, with all four
published car mods in the population and synthetic ones sized to match
(`tools/validate_override.py`):

| other packages installed | loader | loader + ACEDOOM | ACEDOOM |
|---|---|---|---|
| none (495 sets) | 100% | 100% | 100% |
| 1-2 (1,895) | 100% | 100% | 100% |
| 3-5 (1,867) | 99.95% | 100% | 99.68% |
| 6-10 (1,406) | 99.86% | 99.93% | 98.58% |
| 11-20 (1,421) | 99.79% | 99.79% | 99.01% |
| 21-30 (903) | 99.78% | 99.78% | 97.90% |
| **all (7,987)** | **99.90%** | **99.92%** | **99.26%** |

**The two entry points are the whole reason that first column holds up**, and the numbers
are blunter than anyone guessed:

| | lost on its own |
|---|---|
| `uiresources/js/cohtml.js` | 4.34% |
| `uiresources/hud.html` | 4.66% |
| both at once | **0.100%** |

A single override is only about 95% reliable. Everything above that comes from having a
second, independent way in -- and the two are slightly *better* than independent, since an
independence model predicts 16.2 joint failures where 8 were measured. The earlier figure
of 99.908% was a model; this is the artifact.

**For a package that needs all of its overrides, a second one is a cost, not a gift.**
ACEDOOM's bank lost 0.36% of the time and its table 0.38%, and the two never failed
together -- so the package failed 0.74% of the time, the sum of the two. Needing *either*
halves the risk; needing *both* adds it. That is the whole difference between the two rows.

**None of it is a proof.** A package set nobody simulated can still lose, and the tail gets
worse as a folder fills: ACEDOOM at 21-30 other packages is the weakest number here, at 97.90%. A stock
install of the matching game version is the only case that is certain, because it can be
computed exactly before shipping.

## Finding the apps

A UI page cannot list folders, but the game lists one folder for it: the video settings presets in `Saved Games\ACE\Video\*.settingspreset`. On every page the loader sends the game's own `SettingsRequestVideoPresetList`, keeps the answers beginning `ACEUIAppLoader-`, and treats the rest of each name as an installed app. It then reads that app's `ACEUIAppLoader/<name>/app.json` and injects its stylesheets and scripts, in order, on the pages the app asked for.

So an app is two things and no registration step. The markers must stay **empty**: the game deserialises every listed file before naming it, and an empty file is a valid default message. The stock UI shows the same list in its video presets menu, so the loader wraps `engine.on` and hands stock handlers a copy of the answer with our markers removed.

The game's answer is the only source of app names. Without an engine, or without an answer within 1.5 s, the loader says why and loads nothing.

## Two roots, deliberately

Bundled apps live inside the package at `uiresources\ACEUIAppLoaderBuiltIn\<name>\`. Installed apps live loose at `mods\uiresources\ACEUIAppLoader\<name>\`.

They must differ, because **loose files never beat packed files**. A bundled app sitting at the installed apps' path could never be overridden, and `install_app.py` would silently stop working on it. Kept apart, the opposite holds and is the point: an installed app of the same name **wins** over the bundled copy, so working on a bundled app is still install, reload, look.

Those app files are *new* paths, which always resolve. Only the two entry points are overrides.

## Rules that cost a launch to learn

**Never request a URL that could be a folder.** The loose-file lookup only checks that the path exists, so a folder passes; a Resource Manager worker then throws opening it and the game dies. The loader only ever requests plain file names listed in an `app.json`.

**Everything the loader logs** starts with `[ACEUIAppLoader]` and lands in the game log as `[gameface]` lines; each app's own lines start with its title. `check_ingame_log.py` reads the newest log and reports what loaded, what failed, and whether the game crashed.

**A missing file is harmless** — one warning line, about 5 ms. A folder is fatal. The difference is worth remembering when adding anything that fetches.

## What Kunos actually provide

Nothing that helps or hinders, which is worth knowing before looking for a better way in.
The mod scan opens `content.kspkg`, lists `mods\*.kspkg` in the filesystem's order (the game
does no sorting of its own), adds each through the identical `AddPackage`, and then registers
`mods\` as a loose search directory. Records are appended with no deduplication and no
validation that a record's hash matches its path.

There is no manifest, no load order file, no enable/disable list, no dependency system and no
version check.

**The SDK documentation says the same thing by omission** (read 2026-09-17; the full notes
are in [ACEGameInternals](https://github.com/dreasgrech/ACEGameInternals) section 6). It
documents cars, driver animation, liveries, audio and physics, and across all of it there is
no mention of load order, package conflicts, replacing a file the game ships, or enabling and
disabling a mod. Two things in it are worth quoting:

- **A `.kspkg` is an optional encrypted container, not a loading mechanism.** The official
  route is to copy a mod folder into `mods\content\cars\` as-is; the editor's *encrypt*
  function then turns that same folder into a `.kspkg` for `mods\`. The sample mod ships
  both forms of identical content. Encryption protects the author's work — the game treats
  the two the same way, which is what the package table and the loose search directory
  amount to.
- **The only official `uiresources` hook is `.loc` localisation text** for a car mod. Text,
  not scripts, not pages.

So overriding a file the game already ships is not an unsupported use of a supported
feature: **the feature does not exist.** Additive content is what the format is for, which is
exactly why car mods scale without limit — they only ever add new paths, so nothing ever
collides. Every part of this project follows that model except the two entry points, which
cannot, because to run on a page you have to be referenced by it.

## When the game updates

A patch breaks this in two ways, neither of which says anything. The package carries copies of two of Kunos' files -- `cohtml.js` and `hud.html` -- which the patch has moved on from; and which record the lookup finds is decided against `content.kspkg`'s whole hash set, which the patch has changed, so the padding and the record counts were measured for a game that no longer exists. The symptom of either is the same: nothing appears.

What the build does about it:

- **It refuses a stock page it does not recognise.** `hud.html` is Kunos' file plus one script tag; if the rest of it has changed, `assemble_page` stops rather than shipping the previous version's copy of their page over their new one.
- **It stamps the game build it was made for.** `ACEUIAppLoader.builtFor` goes into the package, and at start-up the loader compares it with `ModelUIState.game_version` -- on the release only (`0.9.1`), because that is all the game publishes to the UI; a hotfix that changes just the build number (`+release.7`) cannot be told apart from inside the page. When they differ it logs a line, so a log from a player on a newer build says so -- and on the HUD it draws a red strip across the top saying which build the package was made for and telling the player to delete the file and get the matching release. That strip is the one thing a stale package can still do for the player: its two stock files are the old game's, and if the HUD around the strip looks wrong, that is why. Apps still load; they do not depend on those two files.
- **It refuses a measurement taken for a different file set.** `dups.json` records the count behind a fingerprint of the package's paths and the game build it was measured on.

`tools/post_update.py` is the recovery: it rebuilds (re-reading the stock files), re-measures when the fingerprint or the game build has moved, reinstalls, and then replays the lookup over the packages actually in the mods folder to say whether both ways in still resolve to ours.

**What a patch cannot break.** Everything here rests on the sort being *unstable* -- not on our replay of MSVC's introsort being right. Score the same package assuming nothing at all about the algorithm, only that a run of equal hashes ends up in some arbitrary order, and 32 records across two entry points still wins 99.908% of the time -- close to the 99.91% actually measured, which is a good sign for the model but not what makes the construction work. The one change that would be fatal is a *stable* sort, and that would take every override mod in the game with it.

## Reproducible across checkouts

`.gitattributes` pins the working tree to LF (`* text=auto eol=lf`), because some of the
packaged bytes are copied from the checkout verbatim and would otherwise follow each
developer's `core.autocrlf`.

It is worth being exact about which, because the obvious answer is wrong. `cohtml.js`,
`hud.html` and the bootstrap are *written* by the build from text-mode reads, so they are
normalised whatever the sources look like and never varied. The bundled apps under
`apps/` are copied with `shutil.copyfile`, byte for byte -- and those did vary. Converting
the repo on 2026-09-17 shrank four packaged files: `sampler.js` by 845 bytes,
`profiler.css` by 650, `capabilities.css` by 249, and `protofields.js` by 3, that last one
being a file with only three CRLF lines in it, which is the kind of thing nobody notices.

The roadmap expected this to cost "one renormalising commit". It did not: with
`core.autocrlf=true` git already stored LF in the index and converted on checkout, so
only the *working tree* was ever CRLF -- which is precisely what leaked into the copied
files. `git ls-files --eol` reports `i/lf w/lf` afterwards and the diff is empty for
every file that was only converted. `.gitattributes` is what stops the working tree from
going back to CRLF, here and on anyone else's clone.

Nothing about the lookup changes either way -- the paths, and therefore the padding and the
record counts, are identical -- so this is only about a published checksum being verifiable
by someone rebuilding from source. `ReproducibleBytesTests` pins it.
