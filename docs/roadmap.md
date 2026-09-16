# What is missing

**A wider validation of the override.** The duplicate-record counts are chosen against sixty package sets nothing was selected on, which puts the failure rate under a few percent rather than at zero. A few thousand sets would turn that into a number worth printing, and scoring against real published car mods rather than synthetic ones would make the population representative instead of merely plausible. See [`how-it-works.md`](how-it-works.md).

**Repadding.** `pack_kspkg.py` searches against the packages installed at build time, but there is no command that rebuilds every installed package in one go. Needed when someone has several package mods and one of them moves.

**Carrying the console buffer across the HUD reload.** The console hook runs on every page, so capture on menu pages already works; what is missing is keeping the buffer across the reload that Escape and resume cause.

**Checking the package listing order against Coherent's documentation.** The order the game adds `mods\*.kspkg` in is the filesystem's, which on NTFS is the case-insensitive uppercase collation. That is observed rather than documented, and it is the one assumption in the lookup model that has never been verified against a source other than the game's own behaviour.

**A reproducible release artifact across checkouts.** The build is byte-for-byte reproducible on one machine, but there is no `.gitattributes`, so the line endings of `src/*.js` follow each developer's `core.autocrlf` and the packaged bytes differ between checkouts. Nothing about the lookup changes — the paths, and therefore the padding and the record counts, are identical either way — but a published hash could not be verified by someone else rebuilding. Pinning the packaged sources to LF fixes it, at the cost of one renormalising commit.

**A licence.** There isn't one, which means all rights reserved by default and nobody may legally fork or redistribute.
