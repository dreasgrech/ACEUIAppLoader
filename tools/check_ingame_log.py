#!/usr/bin/env python3
"""
check_ingame_log.py - in-game smoke test for the ACEUIAppLoader and its apps.

The game writes the UI's console.log output into its own log as [gameface] lines,
so after one launch + session we can tell whether the loader ran, which apps it
loaded, and whether anything crashed, without a debugger. Run this after playing:

  python tools/check_ingame_log.py            # newest log
  python tools/check_ingame_log.py <logfile>  # a specific log

Exit codes: 0 loader ran on the HUD and everything it started finished loading, 1 loader never
ran (package not applied), 2 crash/exception or an app failed, 3 no log / HUD never
loaded.
"""
import glob
import os
import re
import sys

LOG_DIR = os.path.join(os.path.expanduser("~"), "Saved Games", "ACE", "Logs")
LOADER = "[ACEUIAppLoader]"
# per-app lines worth echoing (any "[Xyz]" prefixed UI line that is not the loader)
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


PROBLEM_KEYS = (" FAILED", "failed to load", "invalid JSON", "skipped", "could not wrap", "\" ignored: ", "asking again",
                "(attempt ", "but running on")
# What the game actually writes when its handler catches something: a "[crash] [error]"
# block starting with this, then a stack. The two strings this looked for before --
# "CRASH DETECTED" and "Exception thrown:" -- appear in no log this game has ever written,
# so every run reported "no crashes" without ever having looked.
CRASH_MARK = "Exception Detected:"
# 0xE06D7363 through the display driver is the NVIDIA/D3D12 exception this game throws by
# the dozen on every launch, in every session recorded since 2026-09, with or without any
# mod installed. The game catches it and carries on, so it is noise -- but counted noise:
# a jump in the count, or a stack through anything else, is worth seeing.
DRIVER_MODULES = ("nvwgf2umx", "D3D12Core", "nvoglv", "amdxc")
# how far past a crash line to look for the stack that says which module it came from
CRASH_STACK_LINES = 30


def classify_crashes(lines):
    """(real, driver): exception blocks the game logged, split by what threw them.

    The display-driver ones are constant background on this machine; anything else, or one
    the log simply stops after, is what a reader needs to be shown.
    """
    real, driver = [], []
    for i, line in enumerate(lines):
        if CRASH_MARK not in line:
            continue
        stack = chr(10).join(lines[i:i + CRASH_STACK_LINES])
        (driver if any(m in stack for m in DRIVER_MODULES) else real).append(line)
    return real, driver


def scan(loader_lines):
    """
    What the loader did, per page. The loader runs once per page and says so first, so
    everything after a "loader X on /page" line belongs to that page until the next one.

    Per page: how many apps the game's preset list named, how many apps came bundled in
    the package, which apps it started loading and which finished, which bundled app an
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
        for pattern, key in ((r"presets: (\d+) app", "presets"), (r"bundled: (\d+) app", "bundled")):
            m = re.search(pattern, line)
            if m:
                page[key] = int(m.group(1))
        for pattern, key in ((r"app (\S+) \S+: loading", "attempted"), (r"app (\S+) loaded", "loaded"),
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
        # a page with nothing to load is normal (driverlabels.html has no apps); on the
        # HUD it means the apps are not reaching the game at all
        if page["empty"] and name == "/hud.html":
            print("      nothing loaded on the HUD: no bundled apps and no installed apps found")
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

    crashes, driver_crashes = classify_crashes(lines)
    loader = [l for l in lines if LOADER in l]
    version = first_match(r"loader ([\d.]+) on /", loader)
    pages = scan(loader)

    print(f"loader: {'v' + version.group(1) if version else 'never ran'} on {len(pages)} page(s)")
    failed = report(pages)

    # any bracketed prefix that is not the loader's: an app's own logger uses its title,
    # which can be several words ("[ACE UI Capabilities Probe] ...")
    app_lines = [l for l in lines if "[gameface]" in l and LOADER not in l and re.search(r"\[[A-Z][^\]]*\] ", l)]
    echoed = [l for l in app_lines if any(k in l for k in INTERESTING)]
    for l in echoed[:MAX_ECHO]:
        print("  " + l[:170])
    if len(echoed) > MAX_ECHO:
        print(f"  ... {len(echoed) - MAX_ECHO} more app lines")

    if driver_crashes:
        print(f"display-driver exceptions: {len(driver_crashes)} (0xE06D7363 through the graphics "
              "driver; the game catches these and every session has them)")
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
          f"{', '.join(hud['loaded']) if hud['loaded'] else 'nothing'}, "
          f"no crashes beyond the usual {len(driver_crashes)} driver exception(s)"
          if driver_crashes else
          f"RESULT: OK - loader on {len(pages)} page(s), on the HUD: "
          f"{', '.join(hud['loaded']) if hud['loaded'] else 'nothing'}, no crashes")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
