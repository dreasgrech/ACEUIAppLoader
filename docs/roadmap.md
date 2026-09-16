# What is missing

**A wider validation of the override.** The duplicate-record counts are chosen against sixty package sets nothing was selected on, which puts the failure rate under a few percent rather than at zero. A few thousand sets would turn that into a number worth printing, and scoring against real published car mods rather than synthetic ones would make the population representative instead of merely plausible. See [`how-it-works.md`](how-it-works.md).

**Repadding.** `pack_kspkg.py` searches against the packages installed at build time, but there is no command that rebuilds every installed package in one go. Needed when someone has several package mods and one of them moves.

**Carrying the console buffer across the HUD reload.** The console hook runs on every page, so capture on menu pages already works; what is missing is keeping the buffer across the reload that Escape and resume cause.

**Checking the package listing order against Coherent's documentation.** The order the game adds `mods\*.kspkg` in is the filesystem's, which on NTFS is the case-insensitive uppercase collation. That is observed rather than documented, and it is the one assumption in the lookup model that has never been verified against a source other than the game's own behaviour.

**A licence.** There isn't one, which means all rights reserved by default and nobody may legally fork or redistribute.
