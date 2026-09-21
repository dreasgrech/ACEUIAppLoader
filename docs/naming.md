# Mod or app

Two words that were used interchangeably and meant two different things the whole time.
They are settled here, and the test kit, the tools and every doc in these repositories
follow this page.

## The rule

> A **mod** is something the **game** loads.
> An **app** is something the **loader** loads.

That is the whole distinction, and the giveaway is always *who reads the files*.

A mod lives in `Saved Games\ACE\mods`, as a `.kspkg` package or a loose folder, and the
game finds it by itself. **ACEUIAppLoader is a mod** -- one package, one entry in that
folder. So is a car mod. So is ACEDOOM's audio package, which replaces two files in
`content.kspkg` and has nothing to do with the HUD.

An app lives in `uiresources\ACEUIAppLoader\<name>\` and is loaded onto the HUD page by the
loader, which is the only thing that ever looks there. The pedal graph, DOOM, the dev
console, the profiler and the capabilities probe are all apps. The
**app drawer** lists apps. `app.json` describes one.

The loader is a mod that loads apps. Both words are right about it, about different halves
of it, which is exactly why it kept going wrong.

## Two renames, one week

**0.21.0 -- what the loader loads became an *app*.** `mod.json` became `app.json`, the
install tool and the test kit followed, and the loose root and marker prefix changed with
them.

**0.22.0 -- the loader itself became `ACEUIAppLoader`.** Calling everything it loads an app
and then calling it a *Mod* Loader put the contradiction in the one name a player reads
first. The namespace, the package, the source files, the repository and the log prefix all
moved together.

Neither version was released, so no player has ever had the old names -- but this machine
ran both, which is why `install_app.py` clears every old layout it finds.

## What changed

| was | is |
|---|---|
| `ACEUIModLoader` (namespace, package, repository) | `ACEUIAppLoader` |
| `src/ACEUIModLoader.*.js` | `src/ACEUIAppLoader.*.js` |
| `[ACEUIModLoader]` in the game log | `[ACEUIAppLoader]` |
| `mod.json` | `app.json` |
| `ACEUIModLoader.mod(name)` | `ACEUIAppLoader.app(name)` |
| `ACEUIModLoader.mods` | `ACEUIAppLoader.apps` |
| `ACEUIModLoader.apps` (the registry) | `ACEUIAppLoader.shared` |
| `mods\uiresources\ACEUIModLoaderMods\<name>\` | `mods\uiresources\ACEUIAppLoader\<name>\` |
| `Video\ACEUIModLoaderMods-<name>.settingspreset` | `Video\ACEUIAppLoader-<name>.settingspreset` |
| packaged `uiresources\ACEUIModLoaderApps\` | packaged `uiresources\ACEUIAppLoaderBuiltIn\` |
| `data-mod="<name>"` | `data-app="<name>"` |
| `tools/install_mod.py` | `tools/install_app.py` |
| `tools/new_mod.py` | `tools/new_app.py` |
| `tools/modkit.py`, `ModTests` | `tools/appkit.py`, `AppTests` |
| `tests/test_mod.py` | `tests/test_app.py` |
| `docs/writing-a-mod.md` | `docs/writing-an-app.md` |

The registry had to move out of the way: `ACEUIAppLoader.apps` is now the list of loaded
apps, which is what anyone typing it into the dev console expects, so what one app offers
another is `ACEUIAppLoader.shared`.

The loose root dropped a word rather than gaining one. A mechanical rename would have made
it `ACEUIAppLoaderApps\`, and the marker `Video\ACEUIAppLoaderApps-doom.settingspreset` --
two file names a player has to read and type, each saying "app" twice.
`ACEUIAppLoader\<name>\` says it once.

**The two roots must never be merged.** Bundled apps ship inside the loader's package at
`ACEUIAppLoaderBuiltIn\`; installed apps sit at the loose path `ACEUIAppLoader\`. **Loose
files never beat packed files**
([ACEGameInternals](https://github.com/dreasgrech/ACEGameInternals) section 3), so a
bundled app sitting at the loose path could never be overridden and `install_app.py
profiler` would silently do nothing. Apart, the opposite holds and is useful: an installed
app of the same name wins over the bundled copy, which is how a bundled app is worked on.

## What is still called a mod, correctly

Not every "mod" in this code was wrong, and a search-and-replace would have broken these:

- **`mods_dir`**, `default_mods_dir`, `release_mods_dir`, `ACE_MODS_DIR` -- the game's own
  `Saved Games\ACE\mods` folder. The game named it; we do not get to rename it.
  (`mods_root_dir` was the exception and did move: it pointed at the loose app root inside
  that folder, so it is `apps_root_dir` now.)
- **car mods**, `stock_mods`, `load_real_car_mods` -- other people's packages, which the
  override validation installs by the thousand.
- **`tools/pack_kspkg.py`**, `tune_dups.py`, `post_update.py`, `repad.py`,
  `validate_override.py` -- all about packages in that folder, none about apps.
- **`ACEUIModLoaderMods\`** and **`ACEUIModLoaderApps\`** inside `install_app.py` and its
  tests: those are names on disk, not names in the code. They have to keep matching what
  an old install actually left behind.
- **`docs/how-it-works.md`** and everything in ACEGameInternals describing how the game
  merges packages: that is mod territory throughout.
- **`ACEGameInternals/docs/investigation-log.md`** and the dated reports beside it, which
  record what the files were called on the day. A log that gets retro-edited stops being
  one; the note at its top maps those names to these.

## Migrating an app

An app installed under any earlier name sits at a path the loader no longer reads, so it
is invisible rather than broken -- which is worse, because nothing says why it is missing.
`tools/install_app.py` deletes every such folder and marker when it installs, `--remove`
clears them too, and `--list` says so if it finds any. The only thing needed is to install
each app once more.

In an app repo outside this organisation: rename `mod.json` to `app.json`, and
`ACEUIModLoader.mod("x")` to `ACEUIAppLoader.app("x")`. The loader logs
`app <name>: no app.json, skipped` for an app that still has the old file name, and the
old namespace is simply undefined.
