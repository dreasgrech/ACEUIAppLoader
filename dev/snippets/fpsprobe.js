/*
 * fpsprobe.js -- why does the app drawer feel choppy? Dev console, in a session:
 *
 *     .run fpsprobe
 *
 * Sit still while it runs (about 25 s): moving the mouse or the car changes what it
 * measures. Every line is logged with the [fpsprobe] prefix, so check_ingame_log.py
 * picks the whole run out of the game log.
 *
 * It answers the three questions that decide where the choppiness comes from:
 *
 *   1. How fast is the UI page actually advancing? `requestAnimationFrame` fires once
 *      per view advance, so the rAF rate *is* the HUD's frame rate. Compared against
 *      the game's own `ModelUISessionState.player_fps`: if the page is at 30 while the
 *      game is at 90, the view is advanced less often than the game renders and no CSS
 *      transition can ever look smooth.
 *   2. How many frames does the drawer's 180 ms slide actually get, and is the
 *      transform interpolated per frame or jumped in a couple of steps?
 *   3. Does per-frame app work cost the page frames? Each running app is stopped for
 *      two seconds in turn and the rate re-measured; then everything is started again.
 *
 * Nothing is saved and nothing is left switched off.
 */
(function () {
    const log = function (text) { console.log("[fpsprobe] " + text); };

    const SAMPLE_MS = 2500;
    const MOD_SAMPLE_MS = 2000;
    const SLIDE_WATCH_MS = 700;
    const SETTLE_MS = 400;
    const HITCH_MS = 33;
    const PERCENTILE = 0.95;

    const loader = window.ACEUIModLoader && ACEUIModLoader.loader;
    const drawer = window.ACEUIModLoader && ACEUIModLoader.drawer;
    const results = [];

    if (!loader || !drawer) {
        log("no loader on this page -- run this on the HUD");

        return;
    }

    const round = function (value, places) {
        const scale = Math.pow(10, places);

        return Math.round(value * scale) / scale;
    };

    const gameFps = function () {
        const session = window.ModelUISessionState;

        return session && session.player_fps ? round(session.player_fps, 0) : "n/a";
    };

    const stats = function (deltas) {
        const sorted = deltas.slice().sort(function (a, b) { return a - b; });
        let total = 0;
        let hitches = 0;

        deltas.forEach(function (d) {
            total += d;

            if (d > HITCH_MS) { hitches += 1; }
        });

        return {
            frames: deltas.length,
            fps: deltas.length ? round(deltas.length * 1000 / total, 1) : 0,
            median: sorted.length ? round(sorted[Math.floor(sorted.length / 2)], 1) : 0,
            p95: sorted.length ? round(sorted[Math.floor(sorted.length * PERCENTILE)], 1) : 0,
            max: sorted.length ? round(sorted[sorted.length - 1], 1) : 0,
            hitches: hitches
        };
    };

    /** Run rAF for `ms` and hand the frame-interval statistics to `done`. */
    const measure = function (ms, done) {
        const deltas = [];
        let last = 0;
        let until = 0;
        const step = function (now) {
            if (!until) { until = now + ms; }

            if (last) { deltas.push(now - last); }

            last = now;

            if (now < until) {
                requestAnimationFrame(step);

                return;
            }

            done(stats(deltas));
        };

        requestAnimationFrame(step);
    };

    const report = function (label, s) {
        results.push({ label: label, fps: s.fps });
        log(label + ": " + s.fps + " fps over " + s.frames + " frames"
            + " | median " + s.median + " ms, p95 " + s.p95 + " ms, worst " + s.max + " ms"
            + " | " + s.hitches + " frames over " + HITCH_MS + " ms"
            + " | game " + gameFps() + " fps");
    };

    const phase = function (label, ms, then) {
        measure(ms, function (s) {
            report(label, s);
            then();
        });
    };

    // ---- the slide itself ----------------------------------------------------------

    /** The x of a computed `matrix(a, b, c, d, x, y)`, or the raw string when it is not one. */
    const translateX = function (node) {
        const value = window.getComputedStyle(node).transform;
        const inside = value && value.indexOf("(") >= 0
            ? value.slice(value.indexOf("(") + 1, value.lastIndexOf(")")).split(",")
            : null;

        if (!inside || inside.length < 6) { return value || "none"; }

        return round(parseFloat(inside[4]), 1);
    };

    /**
     * Open the drawer and record the panel's computed transform on every frame of the
     * slide. Two different faults look different here: too few frames means the page is
     * slow, few distinct positions over enough frames means the engine is stepping the
     * transition rather than interpolating it.
     */
    const watchSlide = function (then) {
        const panel = drawer.state.panel;

        if (!panel) {
            log("slide: no drawer panel on this page, skipping");
            then();

            return;
        }

        drawer.close();

        window.setTimeout(function () {
            const seen = [];
            const distinct = {};
            let count = 0;
            let started = 0;
            const step = function (now) {
                if (!started) { started = now; }

                const x = translateX(panel);

                seen.push(Math.round(now - started) + "ms=" + x);

                if (!distinct[x]) {
                    distinct[x] = true;
                    count += 1;
                }

                if (now - started < SLIDE_WATCH_MS) {
                    requestAnimationFrame(step);

                    return;
                }

                log("slide: " + seen.length + " frames in " + SLIDE_WATCH_MS + " ms, "
                    + count + " distinct positions");
                log("slide trace: " + seen.join(" "));
                drawer.close();
                then();
            };

            drawer.open();
            requestAnimationFrame(step);
        }, SETTLE_MS);
    };

    // ---- per-app cost --------------------------------------------------------------

    const running = function () {
        return (ACEUIModLoader.apps || []).filter(function (entry) {
            return entry.status === "loaded" && drawer.isVisible(entry.name);
        });
    };

    /** Stop each app in turn, measure without it, start it again. */
    const eachApp = function (apps, index, then) {
        if (index >= apps.length) {
            then();

            return;
        }

        const name = apps[index].name;
        const stopped = loader.deactivate(name);

        if (!stopped) {
            log("without " + name + ": it has no detach, cannot stop it -- skipped");
            eachApp(apps, index + 1, then);

            return;
        }

        phase("without " + name, MOD_SAMPLE_MS, function () {
            loader.activate(name);
            eachApp(apps, index + 1, then);
        });
    };

    const allOff = function (apps, then) {
        const stopped = [];

        apps.forEach(function (entry) {
            if (loader.deactivate(entry.name)) { stopped.push(entry.name); }
        });

        phase("all apps stopped (" + stopped.length + ")", SAMPLE_MS, function () {
            stopped.forEach(function (name) { loader.activate(name); });
            then();
        });
    };

    // ---- the run -------------------------------------------------------------------

    const apps = running();

    log("start: page " + ACEUIModLoader.page + ", loader " + ACEUIModLoader.VERSION
        + ", " + apps.length + " apps running (" + apps.map(function (e) { return e.name; }).join(", ")
        + "), game " + gameFps() + " fps -- sit still for about 25 s");

    phase("baseline, drawer closed", SAMPLE_MS, function () {
        watchSlide(function () {
            drawer.open();

            phase("drawer open and idle", SAMPLE_MS, function () {
                drawer.close();

                eachApp(apps, 0, function () {
                    allOff(apps, function () {
                        log("summary: " + results.map(function (r) {
                            return r.label + " " + r.fps;
                        }).join(" | "));
                        log("done -- every app is running again");
                    });
                });
            });
        });
    });
}());
