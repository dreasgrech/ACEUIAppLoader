#!/usr/bin/env python3
"""
check_ingame_log.py - in-game smoke test for the ACEUIModLoader and its mods.

The game writes the UI's console.log output into its own log as [gameface] lines,
so after one launch + session we can tell whether the loader ran, which mods it
loaded, and whether anything crashed, without a debugger. Run this after playing:

  python tools/check_ingame_log.py            # newest log
  python tools/check_ingame_log.py <logfile>  # a specific log

Exit codes: 0 loader ran on the HUD and everything it started finished loading, 1 loader never
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


PROBLEM_KEYS = (" FAILED", "failed to load", "invalid JSON", "skipped", "could not wrap")


def scan(loader_lines):
    """
    What the loader did, per page. The loader runs once per page and says so first, so
    everything after a "loader X on /page" line belongs to that page until the next one.

    Per page: how many mods the game's preset list named, how many apps came bundled in
    the package, which mods it started loading and which finished, which bundled app an
    installed copy replaced, and any line that reports a problem.
    """
    pages = {}
    current = None
    for line in loader_lines:
        m = re.search(r"loader [\d.]+ on (/\S+)", line)
        if m:
            current = m.group(1)
            pages.setdefault(current, {"presets": None, "bundled": 0, "attempted": [], "loaded": [],
                                       "overridden": [], "empty": False, "problems": []})
            continue
        if current is None:
            continue
        page = pages[current]
        for pattern, key in ((r"presets: (\d+) mod", "presets"), (r"bundled: (\d+) app", "bundled")):
            m = re.search(pattern, line)
            if m:
                page[key] = int(m.group(1))
        for pattern, key in ((r"mod (\S+) \S+: loading", "attempted"), (r"mod (\S+) loaded", "loaded"),
                             (r"(\S+): installed copy overrides the bundled", "overridden")):
            m = re.search(pattern, line)
            if m:
                page[key].append(m.group(1))
        if re.search(r"\bnothing to load\b", line):
            page["empty"] = True
        if any(k in line for k in PROBLEM_KEYS):
            page["problems"].append(line)
    return pages


def report(pages):
    """Print a line per page and return the problems worth failing over."""
    bad = []
    for name in sorted(pages):
        page = pages[name]
        counts = []
        if page["presets"] is not None:
            counts.append(f"{page['presets']} installed")
        if page["bundled"]:
            counts.append(f"{page['bundled']} bundled")
        missing = [m for m in page["attempted"] if m not in page["loaded"]]
        state = ", ".join(page["loaded"]) if page["loaded"] else "nothing for this page"
        print(f"  {name}: {' + '.join(counts) if counts else 'no sources'} -> {state}")
        if page["overridden"]:
            print(f"      installed copies replaced the bundled: {', '.join(page['overridden'])}")
        for line in page["problems"]:
            print("      " + line[:180])
        bad += page["problems"]
        if missing:
            print(f"      started loading but never finished: {', '.join(missing)}")
            bad.append(f"{name}: {', '.join(missing)} never finished loading")
        # a page with nothing to load is normal (driverlabels.html has no mods); on the
        # HUD it means the mods are not reaching the game at all
        if page["empty"] and name == "/hud.html":
            print("      nothing loaded on the HUD: no bundled apps and no installed mods found")
            bad.append("nothing loaded on the HUD")
    return bad


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
    version = first_match(r"loader ([\d.]+) on /", loader)
    pages = scan(loader)

    print(f"loader: {'v' + version.group(1) if version else 'never ran'} on {len(pages)} page(s)")
    failed = report(pages)

    # any bracketed prefix that is not the loader's: a mod's own logger uses its title,
    # which can be several words ("[ACE UI Capabilities Probe] ...")
    mod_lines = [l for l in lines if "[gameface]" in l and LOADER not in l and re.search(r"\[[A-Z][^\]]*\] ", l)]
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
    hud = pages["/hud.html"]
    print(f"RESULT: OK - loader on {len(pages)} page(s), on the HUD: "
          f"{', '.join(hud['loaded']) if hud['loaded'] else 'nothing'}, no crashes")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
