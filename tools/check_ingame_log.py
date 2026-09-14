#!/usr/bin/env python3
"""
check_ingame_log.py - in-game smoke test for the ACEUIModLoader and its mods.

The game writes the UI's console.log output into its own log as [gameface] lines,
so after one launch + session we can tell whether the loader ran, which mods it
loaded, and whether anything crashed, without a debugger. Run this after playing:

  python tools/check_ingame_log.py            # newest log
  python tools/check_ingame_log.py <logfile>  # a specific log

Exit codes: 0 loader ran on the HUD and every manifest mod loaded, 1 loader never
ran (package not applied), 2 crash/exception or a mod failed, 3 no log / HUD never
loaded.
"""
import glob
import os
import re
import sys

LOG_DIR = os.path.join(os.path.expanduser("~"), "Saved Games", "ACE", "Logs")
LOADER = "[ACEUIModLoader]"
# per-mod lines worth echoing (any "[Xyz]" prefixed UI line that is not the loader)
INTERESTING = ("script loaded", "widget attached", "position ", "script error", "sampling ok", "not attaching")
MAX_ECHO = 12


def newest_log():
    logs = sorted(glob.glob(os.path.join(LOG_DIR, "log-*.txt")), key=os.path.getmtime)
    return logs[-1] if logs else None


def first_match(pattern, lines):
    for l in lines:
        m = re.search(pattern, l)
        if m:
            return m
    return None


def main(argv):
    path = argv[1] if len(argv) > 1 else newest_log()
    if not path or not os.path.exists(path):
        print("no game log found")
        return 3
    with open(path, encoding="utf-8", errors="replace") as f:
        lines = [l.rstrip("\r\n") for l in f]

    print(f"log: {path} ({len(lines)} lines)")
    m = first_match(r"Build release.*?version ([^,]+)", lines)
    print(f"game version: {m.group(1) if m else 'unknown'}")
    hud_loads = sum("Loading page hud.html" in l for l in lines)
    print(f"HUD page loads: {hud_loads}")

    crashes = [l for l in lines if "CRASH DETECTED" in l or "Exception thrown:" in l]
    loader = [l for l in lines if LOADER in l]
    pages = sorted({m.group(1) for m in (re.search(r"loader [\d.]+ on (/\S+)", l) for l in loader) if m})
    version = first_match(r"loader ([\d.]+) on /", loader)
    loaded = sorted({m.group(1) for m in (re.search(r"mod (\S+) loaded", l) for l in loader) if m})
    failed = [l for l in loader if any(k in l for k in (" FAILED", "failed to load", "invalid JSON", "skipped", "no manifest"))]
    manifest = first_match(r"manifest: (\d+) mod", loader)

    print(f"loader: {'v' + version.group(1) if version else 'never ran'}; pages: {', '.join(pages) if pages else 'none'}")
    if manifest:
        print(f"manifest mods: {manifest.group(1)}; loaded: {', '.join(loaded) if loaded else 'none'}")
    for l in failed[:6]:
        print("  " + l[:200])

    mod_lines = [l for l in lines if "[gameface]" in l and LOADER not in l and re.search(r"\[[A-Z][A-Za-z]+\] ", l)]
    echoed = [l for l in mod_lines if any(k in l for k in INTERESTING)]
    for l in echoed[:MAX_ECHO]:
        print("  " + l[:170])
    if len(echoed) > MAX_ECHO:
        print(f"  ... {len(echoed) - MAX_ECHO} more mod lines")

    if crashes:
        print("CRASH / EXCEPTION lines:")
        for l in crashes[:5]:
            print("  " + l[:200])

    if hud_loads == 0:
        print("RESULT: HUD never loaded in this session (join a session first)")
        return 3
    if "/hud.html" not in pages:
        print("RESULT: LOADER NOT APPLIED on hud.html (cohtml.js override lost or package missing)")
        return 1
    if crashes or failed:
        print("RESULT: loader ran but something failed (see above)")
        return 2
    if manifest and int(manifest.group(1)) != len(loaded):
        print("RESULT: loader ran but not every manifest mod reported loaded")
        return 2
    print(f"RESULT: OK - loader on {len(pages)} page(s), mods loaded: {', '.join(loaded) if loaded else 'none'}, no crashes")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
