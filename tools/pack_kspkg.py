#!/usr/bin/env python3
"""
pack_kspkg.py - build an Assetto Corsa EVO .kspkg mod package from a folder.

Format (reverse-engineered by the community, verified against Kunos' sample mod
ks_modded_car.kspkg from the official SDK documentation):

  [0x100000 bytes zero header]
  [file blobs, packed back to back]
  [padding so the blob area ends on a 1 MB boundary]
  [file table: 0x4000000 bytes (64 MB), 0x100 bytes per entry, XOR-obfuscated]

Table entry (little endian):
  0x00  char[0xE0]  path, lower case, backslash separators, NUL padded
  0xE0  int32       always 0
  0xE4  uint16      flags: 1 = directory, 0x100 = blob XOR-obfuscated
  0xE6  int16       path length
  0xE8  uint64      FNV-1a 64 of the path encoded as UTF-16LE (game does bsearch on this)
  0xF0  int64       file size
  0xF8  int64       blob offset

Entries are sorted by hash ascending; the game stops reading at the first entry
whose hash is 0. The whole table is XOR'd with the 8-byte key 0x9F9721A97D1135C1.

Override resolution: the game appends every package's entries to one vector,
re-sorts it with an unstable std::sort and takes the first equal hash. Which
copy of an overridden file wins therefore depends on the package's whole set of
hashes. lookup_sim.py replays that exactly against the installed content.kspkg,
and the packer adds dummy directory entries ("padding") until every override
resolves to this package. Without the game installed it cannot predict and
warns instead.

Usage:
  python pack_kspkg.py <source_dir> <output.kspkg> [--encrypt] [--install] [--no-verify]
                       [--no-pad] [--game-dir=<install folder>]

  --encrypt    XOR the file blobs as well (official content does; mods need not)
  --install    copy the result to %USERPROFILE%\\Saved Games\\ACE\\mods\\
  --no-verify  skip re-reading the package to check every entry
  --no-pad     do not compute/add padding (builds a package the game may ignore)
  --game-dir   where content.kspkg lives (default: Steam path, or ACE_GAME_DIR)
  --mods-dir   the installed mod packages to keep working (default: Saved Games\\ACE\\mods);
               every other *.kspkg there joins the simulated lookup, and their overrides
               must still win with this package added
  --dups=N     write N table records for each --dup file instead of one (default 1)
  --dup=<path> a packaged file to duplicate, relative to <source_dir>, repeatable

Padding decides where ONE record of an override lands; duplicates decide how many
records it has. The base package is added first, so its record starts at a lower index
than ours, and the partition that settles equal hashes moves lower-indexed equals to the
front -- which is what lower_bound returns. That bias is why a single override wins only
about half the time once another package is installed. N records give N chances at the
front of the equal run. N is not a dial: measured against a simulated population, 32, 64
and 96 behave well while 48 and 256 are markedly worse, so a value must be measured
rather than assumed.

Every file below <source_dir> is stored with its path relative to <source_dir>,
so <source_dir>/uiresources/hud.html becomes "uiresources\\hud.html" in the package.
"""
import hashlib
import os
import shutil
import struct
import sys



def _internals_tools():
    """tools/ folder of the ACEGameInternals repo: $ACE_INTERNALS_DIR or a sibling checkout."""
    here = os.path.dirname(os.path.abspath(__file__))
    candidates = [os.environ.get("ACE_INTERNALS_DIR"),
                  os.path.join(os.path.dirname(os.path.dirname(here)), "ACEGameInternals")]
    for c in candidates:
        if c and os.path.isfile(os.path.join(c, "tools", "lookup_sim.py")):
            return os.path.join(c, "tools")
    raise SystemExit("ACEGameInternals not found: clone it next to this repo or set ACE_INTERNALS_DIR")


sys.path.insert(0, _internals_tools())
import lookup_sim  # noqa: E402  (replays the game's lookup to make overrides win)

# How hard to search for a padding layout: the quick pass is lookup_sim's own default,
# the wide one is the fallback (see plan_padding).
QUICK_PAD = 64
QUICK_SALT = 8
WIDE_PAD = 160
WIDE_SALT = 40

KEY = 0x9F9721A97D1135C1
KEY_BYTES = KEY.to_bytes(8, "little")
HEADER_SIZE = 0x100000
TABLE_SIZE = 0x4000000
ENTRY_SIZE = 0x100
MAX_ENTRIES = TABLE_SIZE // ENTRY_SIZE
PATH_FIELD = 0xE0
BLOB_ALIGN = 0x100000
FLAG_DIR = 0x1
FLAG_XOR = 0x100

# Extra table records for an overridden file, so the game's merged vector holds several of
# ours against the base package's one (see `decoy_path`). They live under this folder, which
# must stay out of every folder the game preloads at startup (uiresources/js, /branding,
# /images, /fonts, content/cars/common_assets/displays) -- the preload walks the directory
# listing, and a decoy there would make it read the same blob once per record.
DECOY_PARENT = "uiresources\\dup"

# files that must never end up in a package
IGNORED_NAMES = {".gitkeep", ".gitignore", "desktop.ini", "thumbs.db", ".ds_store"}
IGNORED_SUFFIXES = (".pyc", ".swp", ".tmp", "~")


def normalize(path: str) -> str:
    return lookup_sim.normalize_path(path)


def path_hash(path: str) -> int:
    return lookup_sim.path_hash(path)


def xor_buffer(buf: bytearray) -> None:
    n = len(buf)
    full = n - (n % 8)
    words = memoryview(buf)[:full].cast("Q")
    for i in range(len(words)):
        words[i] ^= KEY
    for i in range(full, n):
        buf[i] ^= KEY_BYTES[i % 8]


def collect(source_dir: str):
    files = []
    dirs = set()
    for root, dirnames, filenames in os.walk(source_dir):
        dirnames[:] = [d for d in dirnames if not d.startswith(".") and d != "__pycache__"]
        rel_root = os.path.relpath(root, source_dir)
        if rel_root != ".":
            dirs.add(normalize(rel_root))
        for name in filenames:
            lname = name.lower()
            if lname in IGNORED_NAMES or lname.endswith(IGNORED_SUFFIXES):
                print(f"  (skipping {os.path.join(rel_root, name)})")
                continue
            full = os.path.join(root, name)
            files.append((normalize(os.path.relpath(full, source_dir)), full))
    return sorted(files), sorted(dirs)


def make_entry(path: str, flags: int, size: int, offset: int) -> bytes:
    try:
        raw = path.encode("ascii")
    except UnicodeEncodeError:
        raise SystemExit(f"non-ASCII characters in path are not supported: {path!r}")
    if len(raw) >= PATH_FIELD:
        raise SystemExit(f"path too long for table entry ({len(raw)} >= {PATH_FIELD}): {path}")
    return (raw.ljust(PATH_FIELD, b"\0")
            + struct.pack("<ihh", 0, flags, len(raw))
            + struct.pack("<Q", path_hash(path))
            + struct.pack("<qq", size, offset))


def paths_fingerprint(mod_paths, targets) -> str:
    """
    Identifies a package's hash set. Which duplicate counts and padding layouts win
    depends on every path in the package, so a tuning is only valid for the file set it
    was measured against; this is what a build compares to notice the set has moved on.
    """
    blob = "\n".join(sorted(normalize(p) for p in mod_paths) + ["->"] + sorted(normalize(t) for t in targets))
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()[:16]


def decoy_path(rel: str, index: int) -> str:
    """A unique path for an extra record of `rel`, under DECOY_PARENT."""
    stem = rel.rsplit("\\", 1)[-1].split(".", 1)[0][:8]
    return f"{DECOY_PARENT}\\{stem}{index:04d}"


def make_decoy(rel: str, index: int, flags: int, size: int, offset: int) -> bytes:
    """
    An extra table record for `rel`: its hash, its blob, but a path of its own.

    The game reads the lookup hash straight out of the entry's 0xE8 field and never
    recomputes it from the path (AddPackage, 0x1427aed30), and the 32-byte record it
    keeps in memory holds only {hash, size, offset, flags, package index} -- no path at
    all. So a decoy that wins a lookup is indistinguishable from the real record, while
    the path it carries keeps it out of the directory listing for the real file.
    """
    entry = bytearray(make_entry(decoy_path(rel, index), flags, size, offset))
    struct.pack_into("<Q", entry, 0xE8, path_hash(rel))
    return bytes(entry)


def default_mods_dir():
    return os.path.join(os.path.expanduser("~"), "Saved Games", "ACE", "mods")


def installed_packages(mods_dir, exclude_name):
    """
    [(file name, all hashes, file hashes)] of the other *.kspkg in the mods folder (the
    one being rebuilt excluded). Only their FILE overrides must keep winning.
    """
    if not mods_dir or not os.path.isdir(mods_dir):
        return []
    found = []
    for name in sorted(os.listdir(mods_dir)):
        if not name.lower().endswith(".kspkg") or name.lower() == (exclude_name or "").lower():
            continue
        path = os.path.join(mods_dir, name)
        found.append((name, lookup_sim.read_base_hashes(path), lookup_sim.file_hashes(path)))
    return found


def plan_padding(files, dirs, game_dir=None, mods_dir=None, package_name="mod", dups=1, dup_targets=()):
    """
    Decide which dummy directory entries to add so that every file that also
    exists in the game's base package resolves to OUR copy (see lookup_sim), with
    every other installed package's overrides still winning too.
    Returns (pad_paths, report_lines). Raises SystemExit if no layout wins.

    `dups`/`dup_targets` must describe the duplicate records the package will actually
    carry: they are part of its hash set, so a layout searched without them predicts a
    package that is never built. Repeating a path in `mod_paths` is how the extra records
    reach the simulation -- each one hashes to the same value, which is exactly what the
    decoy records put in the game's vector.
    """
    base_pkg = lookup_sim.find_base_package(game_dir)
    if not base_pkg:
        return [], ["WARNING: content.kspkg not found; cannot predict override resolution "
                    "(set --game-dir=<install folder> or ACE_GAME_DIR)"]
    base = lookup_sim.read_base_hashes(base_pkg)
    base_set = set(base)
    mod_paths = [rel for rel, _ in files] + list(dirs)
    for target in dup_targets:
        mod_paths += [target] * (dups - 1)
    overrides = [rel for rel, _ in files if path_hash(rel) in base_set]
    if not overrides:
        return [], ["no base-package files are overridden; no padding needed"]
    lines = [f"base package: {base_pkg} ({len(base)} entries)",
             f"overrides of base files: {', '.join(overrides)}"]
    our_hashes = {path_hash(rel) for rel in overrides}
    others = []
    for name, hashes, file_list in installed_packages(mods_dir, package_name):
        if our_hashes & set(file_list):
            # the same file overridden twice can only be the same mod being rebuilt under another name
            lines.append(f"installed alongside: {name} overrides the same file(s); treated as the package being replaced")
            continue
        others.append((name, hashes, file_list))
    # Two passes: the quick search first, and a much wider one only if it comes up empty.
    # Which layouts win depends on the package's whole hash set, so a package that gains
    # files -- the loader gaining its bundled apps did exactly this -- can need a padding
    # count the quick search never reaches. The wide pass costs a minute or so and is far
    # better than shipping a package the game ignores.
    pad, win = lookup_sim.find_padding(base, mod_paths, overrides, path_hash, others=others, mod_name=package_name)
    if pad is None:
        lines.append(f"no layout in the quick search ({QUICK_PAD} x {QUICK_SALT + 1}); searching wider")
        pad, win = lookup_sim.find_padding(base, mod_paths, overrides, path_hash, others=others,
                                           mod_name=package_name, max_pad=WIDE_PAD, max_salt=WIDE_SALT)
    for name, hashes, file_list in others:
        # Distinct hashes, not records: a package that carries duplicate records for its
        # override has many records for one file, and counting records would report a mod
        # that overrides one file as overriding thirty-two.
        theirs = {h for h in file_list if h in base_set}
        lines.append(f"installed alongside: {name} ({len(hashes)} entries, {len(theirs)} file override(s) of base files)")
    if pad is None:
        lines.append("NO padding layout found that makes every override win (ours and the installed packages')")
        for rel in overrides:
            lines.append(f"  {rel}: resolves to {win[path_hash(rel)]}")
        raise SystemExit("\n".join(lines) + "\nRefusing to build a package the game would ignore. "
                         "Rename/add a file to change the layout, or pass --no-pad to build anyway.")
    lines.append(f"padding: {len(pad)} directory entries under {pad[0] if pad else lookup_sim.PAD_PARENT}\\")
    for rel, _ in files:
        lines.append(f"  {rel}: resolves to {win[path_hash(rel)]}")
    for name, hashes, file_list in others:
        theirs = {h for h in file_list if h in base_set}
        if theirs:
            lines.append(f"  {name}: its {len(theirs)} file override(s) still resolve to it")
    return pad, lines


def pack(source_dir: str, out_path: str, encrypt: bool = False, pad: bool = True, game_dir=None, mods_dir=None,
         dups: int = 1, dup_targets=()) -> list:
    files, dirs = collect(source_dir)
    if not files:
        raise SystemExit(f"no files found under {source_dir}")

    dup_targets = {normalize(t) for t in dup_targets}
    if dups > 1:
        missing = dup_targets - {rel for rel, _ in files}
        if missing:
            raise SystemExit(f"--dup names a file that is not in the package: {', '.join(sorted(missing))}")
        if not dup_targets:
            raise SystemExit("--dups needs at least one --dup=<path> to duplicate")
        dirs = sorted(set(dirs) | {DECOY_PARENT})

    pad_paths = []
    if pad:
        if mods_dir is None:
            mods_dir = default_mods_dir()
        pad_paths, report = plan_padding(files, dirs, game_dir, mods_dir, os.path.basename(out_path),
                                         dups=dups, dup_targets=dup_targets)
        for line in report:
            print("  " + line)

    entries = [(path_hash(d), make_entry(d, FLAG_DIR, 0, 0)) for d in list(dirs) + pad_paths]
    written = []   # (rel, full, offset, size, flags) for verification

    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    with open(out_path, "wb") as out:
        out.write(b"\0" * HEADER_SIZE)
        offset = HEADER_SIZE
        for rel, full in files:
            with open(full, "rb") as fh:
                data = bytearray(fh.read())
            flags = 0
            if encrypt:
                xor_buffer(data)
                flags |= FLAG_XOR
            out.write(data)
            entries.append((path_hash(rel), make_entry(rel, flags, len(data), offset)))
            written.append((rel, full, offset, len(data), flags))
            extra = ""
            if rel in dup_targets:
                for i in range(dups - 1):
                    entries.append((path_hash(rel), make_decoy(rel, i, flags, len(data), offset)))
                extra = f"  + {dups - 1} decoy record(s)"
            print(f"  {rel}  ({len(data)} bytes @ 0x{offset:X}){extra}")
            offset += len(data)

        pad = (-offset) % BLOB_ALIGN
        out.write(b"\0" * pad)

        if len(entries) >= MAX_ENTRIES:
            raise SystemExit(f"too many entries for the file table ({len(entries)} >= {MAX_ENTRIES})")
        entries.sort(key=lambda e: e[0])
        # Every hash must appear once, except a declared duplicate target, which must appear
        # exactly `dups` times. An accidental collision is still a build failure.
        expected = {path_hash(t): dups for t in dup_targets} if dups > 1 else {}
        counts = {}
        for h, _ in entries:
            counts[h] = counts.get(h, 0) + 1
        for h, n in sorted(counts.items()):
            if n != expected.get(h, 1):
                raise SystemExit(f"hash collision between entries: {h:#x} appears {n} time(s)")

        # Only the used prefix of the table needs real XOR work; the zero-padded
        # remainder XORs to the repeated key, which we can emit directly.
        used = bytearray().join(ent for _, ent in entries)
        xor_buffer(used)
        out.write(used)
        remaining = TABLE_SIZE - len(used)
        out.write(KEY_BYTES * (remaining // 8))

    total = offset + pad + TABLE_SIZE
    print(f"wrote {out_path}: {len(files)} files, {len(dirs)} dirs, {len(pad_paths)} padding entries, {total} bytes")
    return written


def verify(out_path: str, written: list, dups: int = 1, dup_targets=()) -> None:
    """Re-read the package the way the game would and compare against the sources."""
    dup_hashes = {path_hash(normalize(t)): normalize(t) for t in dup_targets} if dups > 1 else {}
    decoys = {}
    with open(out_path, "rb") as f:
        f.seek(0, 2)
        size = f.tell()
        if size % BLOB_ALIGN != 0:
            raise SystemExit(f"verify: package size {size} is not 1 MB aligned")
        f.seek(size - TABLE_SIZE)
        table = bytearray(f.read(TABLE_SIZE))
        xor_buffer(table)

        entries = {}
        prev = -1
        for i in range(MAX_ENTRIES):
            e = table[i * ENTRY_SIZE:(i + 1) * ENTRY_SIZE]
            h = struct.unpack_from("<Q", e, 0xE8)[0]
            if h == 0:
                break
            if h < prev or (h == prev and h not in dup_hashes):
                raise SystemExit("verify: table is not sorted by hash")
            prev = h
            plen = struct.unpack_from("<h", e, 0xE6)[0]
            path = bytes(e[:plen]).decode("ascii")
            if path_hash(path) != h:
                # The only entry allowed to carry someone else's hash is a decoy: an extra
                # record for a declared duplicate target (see make_decoy).
                if h not in dup_hashes or not path.startswith(DECOY_PARENT + "\\"):
                    raise SystemExit(f"verify: hash mismatch for {path}")
                dflags, = struct.unpack_from("<H", e, 0xE4)
                dsize, doff = struct.unpack_from("<qq", e, 0xF0)
                decoys.setdefault(h, []).append((path, dflags, dsize, doff))
                continue
            flags, = struct.unpack_from("<H", e, 0xE4)
            fsize, foff = struct.unpack_from("<qq", e, 0xF0)
            entries[path] = (flags, fsize, foff)

        for rel, full, offset, fsize, flags in written:
            if rel not in entries:
                raise SystemExit(f"verify: {rel} missing from table")
            tflags, tsize, toff = entries[rel]
            if (tflags, tsize, toff) != (flags, fsize, offset):
                raise SystemExit(f"verify: table entry mismatch for {rel}")
            f.seek(toff)
            data = bytearray(f.read(tsize))
            if tflags & FLAG_XOR:
                xor_buffer(data)
            with open(full, "rb") as src:
                if bytes(data) != src.read():
                    raise SystemExit(f"verify: blob content mismatch for {rel}")

        # Each decoy must be the real record in everything the game keeps in memory: same
        # hash (checked above), same flags, size and offset. Only its path differs.
        for h, rel in sorted(dup_hashes.items()):
            found = decoys.get(h, [])
            if len(found) != dups - 1:
                raise SystemExit(f"verify: {rel} has {len(found)} decoy(s), expected {dups - 1}")
            if rel not in entries:
                raise SystemExit(f"verify: duplicate target {rel} missing from table")
            for path, dflags, dsize, doff in found:
                if (dflags, dsize, doff) != entries[rel]:
                    raise SystemExit(f"verify: decoy {path} does not match {rel}")
        seen = {path for records in decoys.values() for path, _, _, _ in records}
        if len(seen) != sum(len(r) for r in decoys.values()):
            raise SystemExit("verify: two decoys share a path")
    extra = f", {len(seen)} decoy records" if dup_hashes else ""
    print(f"verified {len(written)} files, {len(entries)} table entries{extra} OK")


def install(out_path: str) -> None:
    mods = os.path.join(os.path.expanduser("~"), "Saved Games", "ACE", "mods")
    os.makedirs(mods, exist_ok=True)
    dest = os.path.join(mods, os.path.basename(out_path))
    shutil.copyfile(out_path, dest)
    print(f"installed {dest}")


def selftest() -> None:
    # Known entry from Kunos' sample mod package.
    expect = 0x62C8DEBE5C3DA
    got = path_hash("content\\cars\\ks_modded_car\\materials\\ext_disc.material")
    assert got == expect, f"hash self-test failed: {got:#x} != {expect:#x}"


def read_version(source_dir: str) -> str:
    """The mod's version: the VERSION file next to its source folder (i.e. the mod repo root)."""
    path = os.path.join(os.path.dirname(os.path.abspath(source_dir)), "VERSION")
    try:
        with open(path, encoding="utf-8") as f:
            return f.read().strip()
    except OSError:
        return "unknown"


if __name__ == "__main__":
    selftest()
    flags = {a for a in sys.argv[1:] if a.startswith("--")}
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    game_dir = next((a.split("=", 1)[1] for a in flags if a.startswith("--game-dir=")), None)
    mods_dir = next((a.split("=", 1)[1] for a in flags if a.startswith("--mods-dir=")), None)
    dups = int(next((a.split("=", 1)[1] for a in flags if a.startswith("--dups=")), 1))
    dup_targets = [a.split("=", 1)[1] for a in flags if a.startswith("--dup=")]
    valued = ("--game-dir=", "--mods-dir=", "--dups=", "--dup=")
    unknown = {a for a in flags if not a.startswith(valued)} - {"--encrypt", "--install", "--no-verify", "--no-pad"}
    if len(args) != 2 or unknown:
        print(__doc__)
        sys.exit(1)
    print(f"mod version {read_version(args[0])} (from VERSION next to {args[0]})")
    written = pack(args[0], args[1], encrypt="--encrypt" in flags, pad="--no-pad" not in flags, game_dir=game_dir,
                   mods_dir=mods_dir, dups=dups, dup_targets=dup_targets)
    if "--no-verify" not in flags:
        verify(args[1], written, dups=dups, dup_targets=dup_targets)
    if "--install" in flags:
        install(args[1])
