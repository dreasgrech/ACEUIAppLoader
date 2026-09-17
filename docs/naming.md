# Mod or app

Two words that were used interchangeably for two years and meant two different things the
whole time. They are settled here, and the test kit, the tools and every doc in these
repositories follow this page.

## The rule

> A **mod** is something the **game** loads.
> An **app** is something the **loader** loads.

That is the whole distinction, and the giveaway is always *who reads the files*.

A mod lives in `Saved Games\ACE\mods`, as a `.kspkg` package or a loose folder, and the
game finds it by itself. **ACEUIModLoader is a mod** -- one package, one entry in that
folder. So is a car mod. So is ACEDOOM's audio package, which replaces two files in
`content.kspkg` and has nothing to do with the HUD.

An app lives in `uiresources\ACEUIModLoaderApps\<name>\` and is loaded onto the HUD page
by the loader, which is the only thing that ever looks there. The pedal graph, the
telemetry readout, DOOM, the dev console, the profiler and the capabilities probe are all
apps. The **app drawer** lists apps. `app.json` describes one.

The loader is a mod that loads apps. Both words are right about it, about different halves
of it, which is exactly why it kept going wrong.

> [!NOTE]
> By this rule the mod would be better named **ACEUIAppLoader**, and it is not being
> renamed: the name is on the package, the marker files, the namespace, the storage keys
> and every repository. The cost of that rename is real and the confusion it removes is
> small, because "UI Mod Loader" is a true description of a mod that loads things.

## What changed

| was | is |
|---|---|
| `mod.json` | `app.json` |
| `ACEUIModLoader.mod(name)` | `ACEUIModLoader.app(name)` |
| `ACEUIModLoader.mods` | `ACEUIModLoader.apps` |
| `ACEUIModLoader.apps` (the registry) | `ACEUIModLoader.shared` |
| `mods\uiresources\ACEUIModLoaderMods\<name>\` | `mods\uiresources\ACEUIModLoaderApps\<name>\` |
| `Video\ACEUIModLoaderMods-<name>.settingspreset` | `Video\ACEUIModLoaderApps-<name>.settingspreset` |
| packaged `uiresources\ACEUIModLoaderApps\` | packaged `uiresources\ACEUIModLoaderBuiltIn\` |
| `data-mod="<name>"` | `data-app="<name>"` |
| `tools/install_mod.py` | `tools/install_app.py` |
| `tools/new_mod.py` | `tools/new_app.py` |
| `tools/modkit.py`, `ModTests` | `tools/appkit.py`, `AppTests` |
| `tests/test_mod.py` | `tests/test_app.py` |
| `docs/writing-a-mod.md` | `docs/writing-an-app.md` |

The registry had to move out of the way: `ACEUIModLoader.apps` is now the list of loaded
apps, which is what anyone typing it into the dev console expects, so what one app offers
another is `ACEUIModLoader.shared`.

The two roots swapped rather than merged, and they must never be merged. Bundled apps ship
inside the loader's package at `ACEUIModLoaderBuiltIn\`; installed apps sit at the loose
path `ACEUIModLoaderApps\`. **Loose files never beat packed files**
([ACEGameInternals](https://github.com/dreasgrech/ACEGameInternals) section 3), so a bundled app
sitting at the loose path could never be overridden and `install_app.py profiler` would
silently do nothing. Apart, the opposite holds and is useful: an installed app of the same
name wins over the bundled copy, which is how a bundled app is worked on.

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
- **ACEUIModLoader** itself, its namespace, its storage key prefix and its marker prefix.
- **`docs/how-it-works.md`** and everything in ACEGameInternals describing how the game
  merges packages: that is mod territory throughout.

## Migrating an app

An app installed before this change sits at the old path with an old marker, and the loader
no longer looks at either. `tools/install_app.py` removes both when it installs, and
`--remove` clears the old pair as well as the new, so the only thing needed is to install
each app once more. Rename `mod.json` to `app.json` in any app repo not in this
organisation; the loader logs `no app.json, skipped` for one that still has the old name.
