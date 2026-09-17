/*
 * hiddencost.js -- does a switched-off app still cost frames? Dev console, in a session:
 *
 *     .run hiddencost
 *
 * Sit still while it runs (about 40 s): moving the mouse or the car changes what it
 * measures. Every line is logged with the [hiddencost] prefix, so check_ingame_log.py
 * picks the whole run out of the game log.
 *
 * Why. Switching an app off in the app drawer stops its frame loop and removes its
 * listeners -- measured, nothing survives -- but it leaves the markup in the page at
 * `display: none`, because attach builds it once and reuses it. PedalGraph parks 2,035
 * elements that way, the dev console 635, the capabilities probe 550. The open question
 * this answers is whether the renderer charges anything for a subtree it is not drawing.
 *
 * If hidden elements are free, a switched-off app costs only its script parse and the
 * drawer stays honest. If they are not, `detach` should be emptying the root, and the
 * numbers below say how much it would buy.
 *
 * What it does. Measures the page's frame rate four times over the same idle scene:
 * once as it is, once with a pile of hidden elements added, once with the same pile
 * made visible, and once after they are gone again. The last reading is the control:
 * it should land back on the first, and if it does not, something else moved during the
 * run and the whole result should be thrown away.
 *
 * Nothing is saved and every element it adds is removed, including on an early exit.
 */
(function () {
    const log = function (text) { console.log("[hiddencost] " + text); };

    const SAMPLE_MS = 8000;
    const SETTLE_MS = 600;
    /** Roughly PedalGraph (2,035) plus the dev console (635): a realistic two apps' worth. */
    const ELEMENTS = 2700;
    /** Nesting matters as much as the count: a flat list is not what an app builds. */
    const PER_ROW = 9;
    const HITCH_MS = 33;
    const PERCENTILE = 0.95;
    const MS_PER_S = 1000;
    const DECIMALS = 1;
    /**
     * Below this the rate is not moving: at 58.5 fps over 8 s one frame more or less is
     * 0.125 fps, so a change of a frame or two is quantisation, not a cost.
     */
    const NOISE_FPS = 0.5;
    /** Above this the scene itself moved and the middle two numbers cannot be trusted. */
    const MAX_DRIFT_FPS = 2;

    const host = document.querySelector(".absolutecenter") || document.body;

    if (!host) {
        log("no page to measure -- run this on the HUD");

        return;
    }

    /**
     * One pile of elements shaped like an app's panel: rows of spans inside a wrapper,
     * with text in them, because empty divs are not what the renderer is being asked to
     * keep. Returns the wrapper so the caller can hide, show and drop it.
     */
    const build = function (count, hidden) {
        const wrap = document.createElement("div");
        let row = null;
        let i = 0;

        wrap.setAttribute("data-hiddencost", "");
        wrap.style.position = "absolute";
        wrap.style.left = "0";
        wrap.style.top = "0";
        wrap.style.display = hidden ? "none" : "";

        while (i < count) {
            if (i % PER_ROW === 0) {
                row = document.createElement("div");
                wrap.appendChild(row);
            }

            const cell = document.createElement("span");

            cell.textContent = String(i % 10);
            row.appendChild(cell);
            i += 1;
        }

        host.appendChild(wrap);

        return wrap;
    };

    /** Frame gaps over `ms`, then the numbers that say whether the page kept up. */
    const sample = function (ms, done) {
        const gaps = [];
        let last = 0;
        let stop = 0;

        const tick = function (now) {
            if (last > 0) { gaps.push(now - last); }

            last = now;

            if (now < stop) {
                requestAnimationFrame(tick);

                return;
            }

            done(summarise(gaps));
        };

        requestAnimationFrame(function (now) {
            last = now;
            stop = now + ms;
            requestAnimationFrame(tick);
        });
    };

    const summarise = function (gaps) {
        const sorted = gaps.slice().sort(function (a, b) { return a - b; });
        let total = 0;
        let hitches = 0;
        let i = 0;

        while (i < gaps.length) {
            total += gaps[i];

            if (gaps[i] > HITCH_MS) { hitches += 1; }

            i += 1;
        }

        const mean = gaps.length > 0 ? total / gaps.length : 0;

        return {
            frames: gaps.length,
            fps: mean > 0 ? MS_PER_S / mean : 0,
            median: sorted.length > 0 ? sorted[Math.floor(sorted.length / 2)] : 0,
            p95: sorted.length > 0 ? sorted[Math.floor(sorted.length * PERCENTILE)] : 0,
            hitches: hitches
        };
    };

    const report = function (label, s) {
        log(label + ": " + s.fps.toFixed(DECIMALS) + " fps over " + s.frames
            + " frames (median " + s.median.toFixed(DECIMALS) + " ms, p95 "
            + s.p95.toFixed(DECIMALS) + " ms, " + s.hitches + " over " + HITCH_MS + " ms)");
    };

    const cleanup = function () {
        const left = document.querySelectorAll("[data-hiddencost]");
        let i = 0;

        while (i < left.length) {
            if (left[i].parentNode) { left[i].parentNode.removeChild(left[i]); }

            i += 1;
        }
    };

    const after = function (ms, fn) { setTimeout(fn, ms); };

    /**
     * Three readings decide it. The control (phase 4 against phase 1) says whether the
     * scene held still; the visible pile says whether the measurement can detect a cost at
     * all; and only then does the hidden pile's number mean anything. The first version of
     * this compared the hidden cost against the drift alone, which called a clean 0.0 fps
     * result "inconclusive" (any drift beats zero) and a 0.1 fps one "NOT free".
     */
    const verdict = function (r, back) {
        const drift = Math.abs(back.fps - r.base.fps);
        const hiddenCost = r.base.fps - r.hidden.fps;
        const shownCost = r.base.fps - r.shown.fps;
        const noise = Math.max(drift, NOISE_FPS);

        log("---");
        log("control drift: " + drift.toFixed(DECIMALS) + " fps between phase 1 and phase 4 (noise floor "
            + noise.toFixed(DECIMALS) + " fps)");
        log("hidden cost:   " + hiddenCost.toFixed(DECIMALS) + " fps for " + ELEMENTS + " elements at display:none");
        log("visible cost:  " + shownCost.toFixed(DECIMALS) + " fps for the same elements drawn");

        if (drift > MAX_DRIFT_FPS) {
            log("VERDICT: inconclusive -- the page moved " + drift.toFixed(DECIMALS)
                + " fps between the first and last phase. Run it again sitting still.");

            return;
        }

        if (shownCost <= noise) {
            log("VERDICT: inconclusive -- even the VISIBLE pile cost nothing measurable, so this run");
            log("cannot tell a free hidden pile from a cheap one. Raise ELEMENTS and run again.");

            return;
        }

        if (Math.abs(hiddenCost) <= noise) {
            log("VERDICT: hidden elements are free. The same " + ELEMENTS + " elements cost "
                + shownCost.toFixed(DECIMALS) + " fps drawn and nothing hidden, so a switched-off");
            log("app's markup costs no frames, and detach is right to leave it in the page.");

            return;
        }

        const share = Math.round((hiddenCost / shownCost) * 100);

        log("VERDICT: hidden elements are NOT free -- " + hiddenCost.toFixed(DECIMALS) + " fps, about "
            + share + "% of what they cost drawn. detach should empty the root instead.");
    };

    log("measuring " + ELEMENTS + " elements, " + (SAMPLE_MS / MS_PER_S) + " s per phase; sit still");
    cleanup();

    let wrap = null;
    const results = {};

    sample(SAMPLE_MS, function (base) {
        results.base = base;
        report("1. page as it is", base);

        wrap = build(ELEMENTS, true);
        after(SETTLE_MS, function () {
            sample(SAMPLE_MS, function (hidden) {
                results.hidden = hidden;
                report("2. +" + ELEMENTS + " hidden (display:none)", hidden);

                wrap.style.display = "";
                after(SETTLE_MS, function () {
                    sample(SAMPLE_MS, function (shown) {
                        results.shown = shown;
                        report("3. the same " + ELEMENTS + " visible", shown);

                        cleanup();
                        wrap = null;
                        after(SETTLE_MS, function () {
                            sample(SAMPLE_MS, function (back) {
                                report("4. removed again (control)", back);
                                verdict(results, back);
                            });
                        });
                    });
                });
            });
        });
    });

}());