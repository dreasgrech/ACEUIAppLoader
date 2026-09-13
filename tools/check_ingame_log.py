#!/usr/bin/env python3
"""
check_ingame_log.py - in-game smoke test for the PedalGraph mod.

The game writes the UI's console.log output into its own log as [gameface] lines,
so after one launch + session we can tell whether the mod was applied and stayed
healthy without any debugger. Run this after playing:

  python tools/check_ingame_log.py            # newest log
  python tools/check_ingame_log.py <logfile>  # a specific log

Exit code 0 = applied and healthy, 1 = not applied, 2 = crash/exception seen,
3 = no log / HUD never loaded.
"""
import glob
import os
import re
import sys

LOG_DIR = os.path.join(os.path.expanduser("~"), "Saved Games", "ACE", "Logs")


def newest_log():
    logs = sorted(glob.glob(os.path.join(LOG_DIR, "log-*.txt")), key=os.path.getmtime)
    return logs[-1] if logs else None


def main(argv):
    path = argv[1] if len(argv) > 1 else newest_log()
    if not path or not os.path.exists(path):
        print("no game log found")
        return 3
    with open(path, encoding="utf-8", errors="replace") as f:
        lines = f.readlines()

    print(f"log: {path} ({len(lines)} lines)")
    hud_loads = sum("Loading page hud.html" in l for l in lines)
    pg = [l.rstrip() for l in lines if "[PedalGraph]" in l]
    crashes = [l.rstrip() for l in lines if "CRASH DETECTED" in l or "Exception thrown:" in l]
    build = next((l for l in lines if "Build release" in l), "")
    m = re.search(r"version ([^,]+)", build)
    print(f"game version: {m.group(1) if m else 'unknown'}")
    print(f"HUD page loads: {hud_loads}")

    for l in pg[:6]:
        print("  " + l[:160])
    if len(pg) > 6:
        print(f"  ... {len(pg) - 6} more [PedalGraph] lines")
    positions = [l for l in pg if "position " in l]
    if positions:
        print("position save/restore:")
        for l in positions[:8]:
            print("  " + l.strip()[:160])

    if crashes:
        print("CRASH / EXCEPTION lines:")
        for l in crashes[:5]:
            print("  " + l[:200])

    loaded = [l for l in pg if "script loaded" in l]
    sampling = [l for l in pg if "sampling ok" in l]
    hud_marker = [l for l in pg if "hud.html override active" in l]
    script_errors = [l for l in pg if "script error:" in l]
    if hud_marker and not loaded:
        print("hud.html WAS served from the package but the widget script never logged:")
        for l in script_errors[:5] or ["  (no script error was reported either)"]:
            print("  " + l.strip()[:200])
        print("RESULT: APPLIED, WIDGET SCRIPT FAILED")
        return 2
    src = re.search(r"source=(\w+)", loaded[0]).group(1) if loaded else None
    ver = re.search(r"version=([\w.\-]+)", loaded[0]) if loaded else None
    if loaded:
        print(f"mod version: {ver.group(1) if ver else 'pre-0.2.0 (no version in log)'}")

    if hud_loads == 0:
        print("RESULT: HUD never loaded in this session (join a session first)")
        return 3
    if not loaded:
        print("RESULT: NOT APPLIED - hud.html came from the base package")
        return 1
    if crashes:
        print(f"RESULT: applied (source={src}) but the session crashed")
        return 2
    print(f"RESULT: OK - applied from {src}, {len(sampling)} sampling reports, no crashes")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
