/*
 * profile.js -- record a profile and put it in the game log. Dev console, in a session:
 *
 *     .run profile
 *
 * Ten seconds of recording, then the table, then the page is put back exactly as it was.
 * The ACEUIProfiler panel does the same job with a graph attached; this is for when you
 * want a number while driving and cannot look at a panel to get it -- the log is readable
 * afterwards, and `tools/check_ingame_log.py` already knows how to find these lines.
 *
 * It needs the profiler mod installed (it borrows its sampler), but not its panel open,
 * and it leaves recording off when it finishes.
 *
 * What the columns mean, and why they are what they are: this engine freezes
 * `performance.now()` for the duration of a frame, so per-call times come from `Date.now`
 * and its 1 ms steps. One frame's reading of a small callback is 0 or 1 and worthless;
 * summed over a few hundred frames it converges. So every number here is per frame, across
 * the whole recording, and `layout/f` -- forced layout reads -- is the one this renderer
 * actually charges for.
 */
(function () {
    const log = function (text) { console.log("[profile] " + text); };

    const SECONDS = 10;
    const TOP_ROWS = 18;
    const MS_PER_S = 1000;
    const DECIMALS = 2;
    const SHARE_DECIMALS = 1;
    const PERCENT = 100;
    const PAD = 34;

    const S = window.ACEProfilerSampler;

    if (!S) {
        log("the profiler mod is not loaded on this page, so there is no sampler to borrow");

        return;
    }

    if (S.recording()) {
        log("already recording (the panel has it); leaving it alone");

        return;
    }

    const padded = function (text) {
        let out = String(text);

        while (out.length < PAD) { out += " "; }

        return out;
    };

    const report = function () {
        const result = S.aggregate();
        const avg = result.frames ? result.wallMs / result.frames : 0;

        log("---- " + result.frames + " frames, " + avg.toFixed(DECIMALS) + " ms/frame ("
            + (avg > 0 ? (MS_PER_S / avg).toFixed(1) : "0") + " fps), clock " + S.CLOCK.name
            + " " + S.CLOCK.resolutionMs + " ms");
        log("     " + padded("app") + "  share   ms/f  calls/f  layout/f");
        result.rows.slice(0, TOP_ROWS).forEach(function (row) {
            log("     " + padded(row.name)
                + " " + (row.share * PERCENT).toFixed(SHARE_DECIMALS) + "%"
                + "  " + row.msPerFrame.toFixed(DECIMALS)
                + "   " + row.callsPerFrame.toFixed(1)
                + "      " + (row.layoutPerFrame || 0).toFixed(1)
                + "   [" + row.category + "]");
        });
        log("---- end. Everything script did not account for is the engine: style, layout, paint.");
    };

    log("recording for " + SECONDS + " s -- drive normally");
    S.clear();
    S.start();

    window.setTimeout(function () {
        S.pause();
        report();
        S.stop();
        log("done: the page is no longer instrumented");
    }, SECONDS * MS_PER_S);
}());
