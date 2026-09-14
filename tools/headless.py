"""
headless.py - run an HTML test harness in a headless Chromium and collect its report.

Shared by the loader's library tests and by the mod repos' widget tests. A harness
is a self-contained page that runs its cases synchronously and writes

    <pre id="results">PASS name\nFAIL name  -- message\n...\nSUMMARY 12/12</pre>
    <div id="done">DONE</div>

The page is loaded with --dump-dom after a virtual-time budget, so the report is
read from the dumped DOM. Nothing here proves Cohtml compatibility; it exercises
logic deterministically (the harnesses fake requestAnimationFrame, localStorage,
the game's model objects and the HUD store).

Process hygiene (a hard requirement of this project): the browser runs with its
own throwaway --user-data-dir, is killed as a whole process tree on timeout, and
after the run any *browser* process still referencing that profile directory is
terminated. Filtering by executable name matters: the shell that launched the
browser also has the profile path on its command line and must never be killed.
"""
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time

BROWSERS = [
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
]
BROWSER_EXES = ("msedge.exe", "chrome.exe", "chromium.exe")
PROFILE_PREFIX = "acemods-headless-"
TIMEOUT_S = 120
VIRTUAL_TIME_BUDGET_MS = 10000
KILL_RETRIES = 3
KILL_RETRY_S = 0.5


def find_browser():
    env = os.environ.get("ACE_BROWSER")
    if env and os.path.exists(env):
        return env
    for b in BROWSERS:
        if os.path.exists(b):
            return b
    return None


def pids_using_profile(profile_dir):
    """PIDs of browser processes whose command line references our profile dir."""
    if sys.platform != "win32":
        return []
    names = " -or ".join(f"$_.Name -eq '{n}'" for n in BROWSER_EXES)
    ps = (f"Get-CimInstance Win32_Process | Where-Object {{ ({names}) -and $_.CommandLine -and "
          f"$_.CommandLine.Contains('{profile_dir}') }} | Select-Object -ExpandProperty ProcessId")
    try:
        out = subprocess.run(["powershell", "-NoProfile", "-Command", ps],
                             capture_output=True, text=True, timeout=30).stdout
    except Exception:
        return []
    return [int(p) for p in out.split() if p.strip().isdigit()]


def kill_tree(pid):
    if sys.platform == "win32":
        subprocess.run(["taskkill", "/T", "/F", "/PID", str(pid)], capture_output=True)
    else:
        try:
            os.kill(pid, 9)
        except OSError:
            pass


def run_harness(harness_path, browser=None):
    """Load the harness and return the dumped DOM (empty string on failure)."""
    browser = browser or find_browser()
    if not browser:
        raise RuntimeError("no Chromium-based browser found (set ACE_BROWSER)")
    profile = tempfile.mkdtemp(prefix=PROFILE_PREFIX)
    url = "file:///" + os.path.abspath(harness_path).replace("\\", "/")
    # --do-not-de-elevate: when started from an elevated shell, Chromium otherwise
    # relaunches itself de-elevated via the shell and exits at once, which detaches
    # the process from our stdout pipe (empty --dump-dom) and from our supervision.
    cmd = [browser, "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
           "--disable-extensions", "--disable-background-networking", "--no-sandbox",
           "--do-not-de-elevate", f"--user-data-dir={profile}",
           "--allow-file-access-from-files", f"--virtual-time-budget={VIRTUAL_TIME_BUDGET_MS}",
           "--window-size=1920,1080", "--dump-dom", url]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                            encoding="utf-8", errors="replace")
    try:
        stdout, _ = proc.communicate(timeout=TIMEOUT_S)
    except subprocess.TimeoutExpired:
        kill_tree(proc.pid)
        stdout, _ = proc.communicate()
    finally:
        for _ in range(KILL_RETRIES):
            leftovers = [p for p in pids_using_profile(profile) if p != os.getpid()]
            if not leftovers:
                break
            for p in leftovers:
                kill_tree(p)
            time.sleep(KILL_RETRY_S)
        shutil.rmtree(profile, ignore_errors=True)
    return stdout or ""


def parse_report(dom):
    """(report_text, passed, total, finished) from a dumped harness DOM."""
    m = re.search(r'<pre id="results">(.*?)</pre>', dom, re.S)
    if not m:
        return None, 0, 0, False
    report = (m.group(1).replace("&lt;", "<").replace("&gt;", ">")
              .replace("&amp;", "&").replace("&quot;", '"'))
    summary = re.search(r"SUMMARY (\d+)/(\d+)", report)
    passed, total = (int(summary.group(1)), int(summary.group(2))) if summary else (0, 0)
    return report, passed, total, "DONE" in dom


def check_harness(testcase, harness_path, min_cases):
    """unittest helper: run, print the report, assert every case passed."""
    browser = find_browser()
    if not browser:
        testcase.skipTest("no Chromium-based browser found (set ACE_BROWSER)")
    dom = run_harness(harness_path, browser)
    report, passed, total, finished = parse_report(dom)
    testcase.assertIsNotNone(report, "harness produced no results block; DOM head:\n" + dom[:2000])
    print("\n" + report)
    testcase.assertTrue(finished, "harness did not finish")
    testcase.assertGreaterEqual(total, min_cases, "expected the full set of cases")
    testcase.assertEqual(passed, total, "cases failed:\n" + report)
