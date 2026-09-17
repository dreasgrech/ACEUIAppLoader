/*
 * loadtest.js -- where is the cliff? Dev console, in a session:
 *
 *     .run loadtest
 *
 * Sit still for about 40 s. It builds synthetic apps shaped like real ones -- a root in
 * the HUD container, ~60 elements each, an ACEUIModLoader.panel (so they add the same
 * global listeners and per-frame position work), and a frame loop doing a typical app's
 * writes -- then measures the page's frame rate as their number grows, and takes them all
 * away again.
 *
 * Two questions, one run:
 *
 *   1. How many apps can the HUD carry? 0, 4, 8, 16 and 24 in turn. The measured page
 *      rate is 58.5 fps with today's four apps (dev/snippets/fpsprobe.js), and none of
 *      them costs a measurable frame, so the interesting number is where that stops
 *      being true.
 *   2. Does one shared frame loop beat one loop per app? The 16-app step is measured
 *      twice, once with 16 separate requestAnimationFrame loops and once with a single
 *      loop calling the same 16 callbacks. That decides whether the library should own
 *      the frame loop rather than handing each app its own.
 *
 * Everything it creates is removed at the end, including the panels' listeners.
 */
(function () {
    const log = function (text) { console.log("[loadtest] " + text); };

    const STEPS = [0, 4, 8, 16, 24];
    const SHARED_AT = 16;
    const NODES_PER_APP = 60;
    const SAMPLE_MS = 2500;
    const SETTLE_MS = 300;
    const HITCH_MS = 33;
    const PERCENTILE = 0.95;
    const ID_PREFIX = "loadtest_";

    const loader = window.ACEUIModLoader;
    const apps = [];
    const results = [];
    let sharedLoop = null;

    if (!loader || !loader.panel || !loader.loop) {
        log("no loader on this page -- run this on the HUD");

        return;
    }

    const round = function (value, places) {
        const scale = Math.pow(10, places);

        return Math.round(value * scale) / scale;
    };

    const gameFps = function () {
        const session = window.ModelUISessionState;

        return session && session.player_fps ? Math.round(session.player_fps) : "n/a";
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
            p95: sorted.length ? round(sorted[Math.floor(sorted.length * PERCENTILE)], 1) : 0,
            max: sorted.length ? round(sorted[sorted.length - 1], 1) : 0,
            hitches: hitches
        };
    };

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

    // ---- a synthetic app -----------------------------------------------------------

    const container = function () {
        const selector = loader.loader ? loader.loader.CONTAINER_SELECTOR : "";

        return (selector && document.querySelector(selector)) || document.body;
    };

    /**
     * Shaped like a real app rather than an empty div: a fixed set of elements built once,
     * of which a few are written every frame. The writes are the cheap kind the project's
     * own rules ask for -- transforms and textContent, never geometry -- so this measures
     * the floor cost of *having* an app, not the cost of a badly written one.
     */
    const makeApp = function (index) {
        const root = document.createElement("div");
        const nodes = [];
        let i;

        root.id = ID_PREFIX + index;
        root.style.position = "absolute";
        root.style.left = (2 + (index % 8) * 11) + "%";
        root.style.top = (4 + Math.floor(index / 8) * 9) + "%";
        root.style.width = "10%";
        root.style.fontSize = "0.5rem";
        root.style.color = "rgba(255, 255, 255, 0.35)";
        root.style.background = "rgba(0, 0, 0, 0.35)";

        for (i = 0; i < NODES_PER_APP; i += 1) {
            const node = document.createElement("div");

            node.style.height = "2px";
            node.style.background = "rgba(255, 255, 255, 0.12)";
            node.style.transformOrigin = "left center";
            root.appendChild(node);
            nodes.push(node);
        }

        container().appendChild(root);

        const app = {
            root: root,
            nodes: nodes,
            label: nodes[0],
            last: "",
            panel: loader.panel.attach(root, {
                hudId: "hud_" + ID_PREFIX + index,
                storageKey: "ace" + ID_PREFIX + index,
                log: function () { return null; }
            }),
            loop: null
        };

        app.frame = function (now) {
            const car = window.ModelCurrentCar;
            const v = car && typeof car.gas_percent === "number" ? car.gas_percent : (now % 1000) / 1000;
            const text = Math.round(v * 100) + "%";
            let j;

            loader.panel.update(app.panel, now);

            for (j = 0; j < 3; j += 1) {
                app.nodes[j].style.transform = "scaleX(" + v.toFixed(3) + ")";
            }

            if (text !== app.last) {
                app.last = text;
                app.label.textContent = text;
            }
        };

        return app;
    };

    const addApps = function (count, shared) {
        while (apps.length < count) {
            const app = makeApp(apps.length);

            if (!shared) { app.loop = loader.loop.start(app.frame); }

            apps.push(app);
        }

        if (!shared) { return; }

        sharedLoop = loader.loop.start(function (now) {
            let i;

            for (i = 0; i < apps.length; i += 1) { apps[i].frame(now); }
        });
    };

    const removeApps = function () {
        apps.forEach(function (app) {
            if (app.loop) { loader.loop.stop(app.loop); }

            loader.panel.detach(app.panel);

            if (app.root.parentNode) { app.root.parentNode.removeChild(app.root); }
        });
        apps.length = 0;

        if (sharedLoop) {
            loader.loop.stop(sharedLoop);
            sharedLoop = null;
        }
    };

    // ---- the run -------------------------------------------------------------------

    const report = function (label, s) {
        results.push(label + " " + s.fps);
        log(label + ": " + s.fps + " fps over " + s.frames + " frames | p95 " + s.p95
            + " ms, worst " + s.max + " ms | " + s.hitches + " over " + HITCH_MS + " ms"
            + " | elements " + document.getElementsByTagName("div").length
            + " | game " + gameFps() + " fps");
    };

    const runStep = function (index, then) {
        if (index >= STEPS.length) {
            then();

            return;
        }

        const count = STEPS[index];

        addApps(count, false);
        window.setTimeout(function () {
            measure(SAMPLE_MS, function (s) {
                report(count + " synthetic apps, one loop each", s);
                runStep(index + 1, then);
            });
        }, SETTLE_MS);
    };

    /** The same apps, driven by a single frame loop: is N loops per frame worth avoiding? */
    const runShared = function (then) {
        removeApps();
        addApps(SHARED_AT, true);
        window.setTimeout(function () {
            measure(SAMPLE_MS, function (s) {
                report(SHARED_AT + " synthetic apps, ONE shared loop", s);
                then();
            });
        }, SETTLE_MS);
    };

    log("start: " + document.getElementsByTagName("div").length + " divs on the page, game "
        + gameFps() + " fps -- building up to " + STEPS[STEPS.length - 1] + " synthetic apps, sit still");

    runStep(0, function () {
        runShared(function () {
            removeApps();
            window.setTimeout(function () {
                measure(SAMPLE_MS, function (s) {
                    report("back to none", s);
                    log("summary: " + results.join(" | "));
                    log("done -- every synthetic app removed");
                });
            }, SETTLE_MS);
        });
    });
}());
