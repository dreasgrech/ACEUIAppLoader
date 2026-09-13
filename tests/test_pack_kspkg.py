"""Regression tests for tools/pack_kspkg.py.

Run:  python -m unittest discover -s tests -v
"""
import os
import struct
import sys
import tempfile
import unittest
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tools"))

import pack_kspkg as pk  # noqa: E402  (also puts ACEGameInternals/tools on sys.path)
import lookup_sim  # noqa: E402

PEDALGRAPH_SRC = os.path.join(os.environ.get("ACE_PEDALGRAPH_DIR") or os.path.join(os.path.dirname(ROOT), "ACEPedalGraph"), "src")

# (path, FNV-1a-64 of lower-case UTF-16LE path) pairs taken from packages the game
# accepted: Kunos' sample mod and the working PedalGraph build of 2026-09-13.
KNOWN_HASHES = {
    "content\\cars\\ks_modded_car\\materials\\ext_disc.material": 0x62C8DEBE5C3DA,
    "uiresources\\js": 0x63FFC0801177D5FD,
    "uiresources\\hud.html": 0x7700B1ABAB4127BE,
    "uiresources": 0x895214693E38CC80,
    "uiresources\\js\\pedalgraph.js": 0xACE2C8788A1CAC3E,
    "content\\cars": 0xA914DD54706887DB,
    "content": 0xB867BC33525EFEC4,
}


def read_table(path):
    """Parse a package the way the game does: 64 MB table at the end, XOR'd, sorted."""
    with open(path, "rb") as f:
        f.seek(0, 2)
        size = f.tell()
        f.seek(size - pk.TABLE_SIZE)
        table = bytearray(f.read(pk.TABLE_SIZE))
    pk.xor_buffer(table)
    entries = []
    for i in range(pk.MAX_ENTRIES):
        e = table[i * pk.ENTRY_SIZE:(i + 1) * pk.ENTRY_SIZE]
        h = struct.unpack_from("<Q", e, 0xE8)[0]
        if h == 0:
            break
        plen = struct.unpack_from("<h", e, 0xE6)[0]
        align, flags = struct.unpack_from("<iH", e, 0xE0)
        fsize, foff = struct.unpack_from("<qq", e, 0xF0)
        entries.append({"path": bytes(e[:plen]).decode("ascii"), "hash": h, "flags": flags,
                        "size": fsize, "offset": foff, "align": align, "index": i,
                        "padding": bytes(e[plen:0xE0])})
    return size, table, entries


class HashTests(unittest.TestCase):
    def test_known_hashes(self):
        for path, expected in KNOWN_HASHES.items():
            self.assertEqual(pk.path_hash(path), expected, path)

    def test_hash_is_case_and_separator_insensitive(self):
        a = pk.path_hash("UIResources/JS/PedalGraph.JS")
        b = pk.path_hash("uiresources\\js\\pedalgraph.js")
        self.assertEqual(a, b)

    def test_selftest_passes(self):
        pk.selftest()


class XorTests(unittest.TestCase):
    def test_xor_roundtrip_any_length(self):
        for n in (0, 1, 7, 8, 9, 15, 16, 1000, 1001):
            data = bytearray((i * 37 + 11) & 0xFF for i in range(n))
            buf = bytearray(data)
            pk.xor_buffer(buf)
            if n:
                self.assertNotEqual(buf, data)
            pk.xor_buffer(buf)
            self.assertEqual(buf, data)

    def test_xor_of_zeros_is_key_pattern(self):
        buf = bytearray(24)
        pk.xor_buffer(buf)
        self.assertEqual(bytes(buf), pk.KEY_BYTES * 3)


class PackTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.src = os.path.join(self.tmp.name, "src")
        os.makedirs(os.path.join(self.src, "uiresources", "js"))
        os.makedirs(os.path.join(self.src, "content", "cars", "somecar", "displays"))
        self.files = {
            "uiresources/hud.html": b"<html>hud</html>",
            "uiresources/js/pedalgraph.js": bytes(range(256)) * 40,
            "content/cars/somecar/displays/display.html": b"<html>display</html>\r\n",
        }
        for rel, data in self.files.items():
            with open(os.path.join(self.src, rel), "wb") as f:
                f.write(data)
        self.out = os.path.join(self.tmp.name, "out", "test.kspkg")

    def tearDown(self):
        self.tmp.cleanup()

    def test_structure_matches_format(self):
        written = pk.pack(self.src, self.out, pad=False)
        size, table, entries = read_table(self.out)

        self.assertEqual(size % pk.BLOB_ALIGN, 0, "package size must be 1 MB aligned")
        with open(self.out, "rb") as f:
            self.assertEqual(f.read(pk.HEADER_SIZE), b"\0" * pk.HEADER_SIZE, "1 MB zero header")

        hashes = [e["hash"] for e in entries]
        self.assertEqual(hashes, sorted(hashes), "entries sorted by hash")
        self.assertEqual(len(hashes), len(set(hashes)), "no duplicate hashes")
        self.assertEqual(struct.unpack_from("<Q", table, len(entries) * pk.ENTRY_SIZE)[0], 0,
                         "zero terminator right after the last entry")
        # remainder of the table is XOR'd zeros, i.e. the raw file holds the key pattern
        with open(self.out, "rb") as f:
            f.seek(size - pk.TABLE_SIZE + (len(entries) + 1) * pk.ENTRY_SIZE)
            self.assertEqual(f.read(64), pk.KEY_BYTES * 8)

        for e in entries:
            self.assertEqual(e["align"], 0)
            self.assertEqual(e["padding"], b"\0" * len(e["padding"]), "path field NUL padded")
            self.assertEqual(e["path"], e["path"].lower(), "paths stored lower case")
            self.assertNotIn("/", e["path"])
            self.assertEqual(pk.path_hash(e["path"]), e["hash"])

        dirs = {e["path"] for e in entries if e["flags"] & pk.FLAG_DIR}
        files = {e["path"]: e for e in entries if not e["flags"] & pk.FLAG_DIR}
        self.assertEqual(dirs, {"uiresources", "uiresources\\js", "content", "content\\cars",
                                "content\\cars\\somecar", "content\\cars\\somecar\\displays"})
        self.assertEqual(set(files), {rel.replace("/", "\\") for rel in self.files})
        for e in entries:
            if e["flags"] & pk.FLAG_DIR:
                self.assertEqual((e["size"], e["offset"]), (0, 0))

        # blobs start right after the header and are packed back to back
        blobs = sorted((e["offset"], e["size"]) for e in files.values())
        self.assertEqual(blobs[0][0], pk.HEADER_SIZE)
        for (o, s), (o2, _) in zip(blobs, blobs[1:]):
            self.assertEqual(o + s, o2)
        self.assertLessEqual(blobs[-1][0] + blobs[-1][1], size - pk.TABLE_SIZE)

        # blob content is the source, unmodified (no --encrypt)
        with open(self.out, "rb") as f:
            for rel, data in self.files.items():
                e = files[rel.replace("/", "\\")]
                self.assertEqual(e["flags"], 0)
                f.seek(e["offset"])
                self.assertEqual(f.read(e["size"]), data)

        self.assertEqual(len(written), len(self.files))
        pk.verify(self.out, written)

    def test_encrypt_flag_xors_blobs(self):
        written = pk.pack(self.src, self.out, encrypt=True, pad=False)
        _, _, entries = read_table(self.out)
        files = {e["path"]: e for e in entries if not e["flags"] & pk.FLAG_DIR}
        with open(self.out, "rb") as f:
            for rel, data in self.files.items():
                e = files[rel.replace("/", "\\")]
                self.assertEqual(e["flags"], pk.FLAG_XOR)
                f.seek(e["offset"])
                blob = bytearray(f.read(e["size"]))
                self.assertNotEqual(bytes(blob), data)
                pk.xor_buffer(blob)
                self.assertEqual(bytes(blob), data)
        pk.verify(self.out, written)

    def test_ignores_junk_files(self):
        for junk in ("desktop.ini", "Thumbs.db", ".gitkeep", "notes.tmp", "x.pyc"):
            with open(os.path.join(self.src, "uiresources", junk), "wb") as f:
                f.write(b"junk")
        os.makedirs(os.path.join(self.src, ".git"))
        with open(os.path.join(self.src, ".git", "HEAD"), "wb") as f:
            f.write(b"ref")
        pk.pack(self.src, self.out, pad=False)
        _, _, entries = read_table(self.out)
        paths = {e["path"] for e in entries}
        for p in paths:
            self.assertNotIn("junk", p)
            self.assertFalse(p.startswith(".git"))
            self.assertFalse(p.endswith((".ini", ".db", ".gitkeep", ".tmp", ".pyc")), p)

    def test_rejects_long_and_non_ascii_paths(self):
        with self.assertRaises(SystemExit):
            pk.make_entry("a" * pk.PATH_FIELD, 0, 0, 0)
        with self.assertRaises(SystemExit):
            pk.make_entry("uiresources\\caf\u00e9.js", 0, 0, 0)

    def test_empty_source_is_an_error(self):
        empty = os.path.join(self.tmp.name, "empty")
        os.makedirs(empty)
        with self.assertRaises(SystemExit):
            pk.pack(empty, self.out, pad=False)

    def test_verify_detects_corruption(self):
        written = pk.pack(self.src, self.out, pad=False)
        e = [w for w in written if w[0].endswith("hud.html")][0]
        with open(self.out, "r+b") as f:
            f.seek(e[2])
            f.write(b"X")
        with self.assertRaises(SystemExit):
            pk.verify(self.out, written)

    def test_pack_is_deterministic(self):
        pk.pack(self.src, self.out, pad=False)
        with open(self.out, "rb") as f:
            first = f.read()
        pk.pack(self.src, self.out, pad=False)
        with open(self.out, "rb") as f:
            self.assertEqual(f.read(), first)


@unittest.skipUnless(os.path.isdir(PEDALGRAPH_SRC), "ACEPedalGraph checkout not found next to this repo")
class RepoBuildTests(unittest.TestCase):
    """Packs a real mod source tree (ACEPedalGraph) and checks the game will honour it."""

    def test_repo_source_builds_with_required_entries(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = os.path.join(tmp, "pedalgraph.kspkg")
            written = pk.pack(PEDALGRAPH_SRC, out)
            pk.verify(out, written)
            _, _, entries = read_table(out)
            files = {e["path"] for e in entries if not e["flags"] & pk.FLAG_DIR}
            self.assertIn("uiresources\\hud.html", files)
            self.assertIn("uiresources\\js\\pedalgraph.js", files)
            self.assertIn("uiresources\\assets\\pedalgraph.css", files)
            # The game resolves duplicates by an unstable sort (see lookup_sim.py). With the
            # game installed, the packer must have added padding and hud.html must win.
            base_pkg = lookup_sim.find_base_package()
            if base_pkg:
                pads = [p for p in {e["path"] for e in entries} if p.startswith("uiresources\\pad")]
                self.assertTrue(pads, "packer did not add padding entries")
                base = lookup_sim.read_base_hashes(base_pkg)
                w = lookup_sim.winners(base, [e["hash"] for e in entries])
                self.assertEqual(w[pk.path_hash("uiresources\\hud.html")], "mod",
                                 "hud.html override would lose to the base package")


@unittest.skipUnless(os.environ.get("ACE_SDK_SAMPLE"), "set ACE_SDK_SAMPLE=1 to check against the SDK sample package")
class SdkSampleCompatTests(unittest.TestCase):
    """Cross-checks our reader/hash against Kunos' own ks_modded_car.kspkg (531 MB)."""

    ZIP = r"C:\AssettoEvoSDKDocumentation\Sample Mod\ks_modded_car_kspkg.zip"

    def test_sample_package_parses_with_our_rules(self):
        if not os.path.exists(self.ZIP):
            self.skipTest("SDK sample zip not found")
        with tempfile.TemporaryDirectory() as tmp:
            with zipfile.ZipFile(self.ZIP) as z:
                z.extract("ks_modded_car.kspkg", tmp)
            size, _, entries = read_table(os.path.join(tmp, "ks_modded_car.kspkg"))
            self.assertEqual(size % pk.BLOB_ALIGN, 0)
            self.assertGreater(len(entries), 400)
            hashes = [e["hash"] for e in entries]
            self.assertEqual(hashes, sorted(hashes))
            for e in entries:
                self.assertEqual(pk.path_hash(e["path"]), e["hash"], e["path"])
                self.assertEqual(e["align"], 0)
            self.assertEqual(min(e["offset"] for e in entries if not e["flags"] & pk.FLAG_DIR), pk.HEADER_SIZE)


if __name__ == "__main__":
    unittest.main()
