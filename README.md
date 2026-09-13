# ACE UI Mod Loader

The single package that lets several UI mods coexist in Assetto Corsa EVO, plus
the shared library they build on and the packaging tools.

Why a loader is needed at all, and why it has this shape, is in
[`docs/design.md`](docs/design.md); the game mechanics it relies on are
documented in the `ACEGameInternals` repository.

## Status

Tooling stage. The packer and the in-game log checker are here and working
(they built every PedalGraph package). The loader package itself (the
`js/cohtml.js` host, the shared library, the slot probe) is the next step, in
this order:

1. `lib/` shared library extracted from PedalGraph (`AceMods.core`,
   `.persist`, `.panel`, `.loop`, `.console`).
2. `host/cohtml.js`: stock Cohtml SDK script + loader appended; probes mod
   slot scripts under `uiresources\acemods\`.
3. `tools/repad.py`: recompute the loader's padding against every package
   installed on a machine (needed when car-mod packages are present).
4. PedalGraph converted to a loose-folder slot mod; then the debug console.

## Layout

| Path | Contents |
|---|---|
| `tools/pack_kspkg.py` | build a `.kspkg` from a folder, add padding so overrides win, verify, `--install` |
| `tools/check_ingame_log.py` | after a launch: applied? which version? crashes? position save/restore |
| `docs/design.md` | the investigation and decisions behind the loader |
| `tests/` | packer tests; the real-source build test runs against a sibling `ACEPedalGraph` |

## Dependencies

`ACEGameInternals` checked out next to this repo (or `ACE_INTERNALS_DIR`
pointing at it): the packer imports `tools/lookup_sim.py` from there. Mod
repos next to this one are picked up by the tests (`ACE_PEDALGRAPH_DIR`
overrides).

```
python -m unittest discover -s tests -v
python tools/pack_kspkg.py <src> <out.kspkg> --install
```
