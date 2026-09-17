/*
 * profileprobe.js -- can we build a real profiler for this UI? Dev console, in a session:
 *
 *     .run profileprobe
 *
 * A profiler needs three things from its host: a clock worth reading, a way to see work as
 * it is scheduled, and a name to attribute it to. This measures whether Cohtml gives us
 * each, in about 8 s, and puts everything back the way it was.
 *
 * THE CLOCK IS THE WHOLE QUESTION. The first run of this probe reported "smallest non-zero
 * step = 0.000000 ms over 20000 reads", which is not a resolution -- it means
 * `performance.now()` never changed at all while we read it 20,000 times. Either the loop
 * was shorter than one tick of a coarse clock, or the clock does not advance within a
 * frame at all (a plausible thing for an engine that hands the page its frame time). Those
 * two have very different consequences:
 *
 *   - if it advances, the profiler can time individual calls, as Unity does;
 *   - if it is frozen per frame, nothing inside a frame can be timed, and the profiler has
 *     to fall back to per-frame wall time (from the animation-frame timestamp, which does
 *     advance) plus exact call counts, with per-app cost recovered by averaging over many
 *     frames instead of measuring one.
 *
 * So the clock test now spins for a known stretch of *wall* time, inside a single animation
 * frame, and reports how many distinct values each clock took while it did.
 */
(function () {
    const log = function (text) { console.log("[profileprobe] " + text); };

    const SPIN_MS = 30;
    const WATCH_MS = 4000;
    const OVERHEAD_CALLS = 50000;
    const TOP_NAMES = 12;
    const SAMPLE_CAP = 200000;

    const undo = [];
    const seen = { raf: {}, timeout: 0, interval: 0, listeners: {} };
    let rafCalls = 0;
    let anonymous = 0;

    const nameOf = function (fn) {
        if (typeof fn !== "function") { return "(not a function)"; }

        return fn.name || "(anonymous)";
    };

    const count = function (bag, key) {
        bag[key] = (bag[key] || 0) + 1;
    };

    // ---- 1. the clock, measured inside one frame -----------------------------------

    /**
     * Spin for `SPIN_MS` of wall time and count how often each clock changes while we do.
     * `Date.now` is the reference: it is the one clock we know advances in real time.
     */
    const clockReport = function () {
        const startDate = Date.now();
        const startPerf = performance.now();
        let perfChanges = 0;
        let dateChanges = 0;
        let smallestPerf = Infinity;
        let smallestDate = Infinity;
        let lastPerf = startPerf;
        let lastDate = startDate;
        let reads = 0;

        while (Date.now() - startDate < SPIN_MS && reads < SAMPLE_CAP) {
            const p = performance.now();
            const d = Date.now();

            reads += 1;

            if (p !== lastPerf) {
                perfChanges += 1;

                if (p - lastPerf > 0 && p - lastPerf < smallestPerf) { smallestPerf = p - lastPerf; }

                lastPerf = p;
            }

            if (d !== lastDate) {
                dateChanges += 1;

                if (d - lastDate > 0 && d - lastDate < smallestDate) { smallestDate = d - lastDate; }

                lastDate = d;
            }
        }

        log("clock: over " + SPIN_MS + " ms of wall time and " + reads + " reads -- performance.now() changed "
            + perfChanges + " times (smallest step "
            + (smallestPerf === Infinity ? "never moved" : smallestPerf.toFixed(4) + " ms")
            + "), Date.now() changed " + dateChanges + " times (smallest step "
            + (smallestDate === Infinity ? "never moved" : smallestDate + " ms") + ")");
        log("clock: elapsed by performance.now = " + (performance.now() - startPerf).toFixed(4)
            + " ms, by Date.now = " + (Date.now() - startDate) + " ms");

        if (perfChanges === 0) {
            log("clock: VERDICT performance.now() does not advance within a frame here."
                + " Per-call timing is impossible; a profiler must use per-frame wall time from the"
                + " animation-frame timestamp, exact call counts, and averages over many frames.");

            return;
        }

        log("clock: VERDICT performance.now() advances "
            + (smallestPerf < 1 ? "with sub-millisecond steps -- individual calls can be timed"
                : "in steps of " + smallestPerf.toFixed(3) + " ms -- only work longer than that can be timed directly"));
    };

    // ---- 2. what the engine charges for --------------------------------------------

    const layoutReport = function () {
        const proto = window.HTMLElement ? HTMLElement.prototype : null;
        const rectOwner = window.Element ? Element.prototype : null;
        const probe = document.createElement("div");
        let rectWrapped = false;
        let widthWrapped = false;
        let rectCalls = 0;
        let widthReads = 0;

        document.body.appendChild(probe);

        if (rectOwner && typeof rectOwner.getBoundingClientRect === "function") {
            const original = rectOwner.getBoundingClientRect;

            rectOwner.getBoundingClientRect = function () {
                rectCalls += 1;

                return original.apply(this, arguments);
            };
            probe.getBoundingClientRect();
            rectWrapped = rectCalls > 0;
            rectOwner.getBoundingClientRect = original;
        }

        if (proto) {
            const descriptor = Object.getOwnPropertyDescriptor(proto, "offsetWidth");

            if (descriptor && descriptor.get) {
                try {
                    Object.defineProperty(proto, "offsetWidth", {
                        configurable: true,
                        get: function () {
                            widthReads += 1;

                            return descriptor.get.call(this);
                        }
                    });
                    widthWrapped = probe.offsetWidth >= 0 && widthReads > 0;
                    Object.defineProperty(proto, "offsetWidth", descriptor);
                } catch (e) {
                    log("layout: offsetWidth cannot be redefined: " + ACEUIAppLoader.errorText(e));
                }
            } else {
                log("layout: no offsetWidth descriptor on HTMLElement.prototype");
            }
        }

        probe.parentNode.removeChild(probe);
        log("layout: getBoundingClientRect wrappable = " + rectWrapped
            + ", offsetWidth getter wrappable = " + widthWrapped
            + " -- these replace Unity's GC Alloc column, since performance.memory is "
            + (window.performance && performance.memory ? "present" : "absent"));
    };

    // ---- 3. the stock bundle --------------------------------------------------------

    /**
     * Never read a property off a prototype to find out what it is: the stock widgets have
     * accessors (`get mode() { return this.dataset.mode; }`) that throw "Illegal invocation"
     * when the receiver is the prototype rather than an element. That is what the first run
     * of this probe did, and it took the probe down with it. Descriptors only.
     */
    const methodsOf = function (ctor) {
        const out = [];

        Object.getOwnPropertyNames(ctor.prototype).forEach(function (key) {
            const descriptor = Object.getOwnPropertyDescriptor(ctor.prototype, key);

            if (key === "constructor" || !descriptor) { return; }

            if (typeof descriptor.value === "function") { out.push(key); }
        });

        return out;
    };

    /** Every custom element actually on this page, rather than a guessed list of tags. */
    const widgetTags = function () {
        const tags = {};
        const all = document.getElementsByTagName("*");
        let i;

        for (i = 0; i < all.length; i += 1) {
            const tag = all[i].tagName.toLowerCase();

            if (tag.indexOf("-") > 0) { tags[tag] = (tags[tag] || 0) + 1; }
        }

        return Object.keys(tags).sort(function (a, b) { return tags[b] - tags[a]; }).map(function (tag) {
            return { tag: tag, count: tags[tag] };
        });
    };

    const stockReport = function () {
        const ks = window.ksUI;
        const present = widgetTags();
        const tags = present.map(function (entry) { return entry.tag; });
        const reachable = [];
        const missing = [];

        log("stock: " + present.length + " kinds of custom element on the page -- "
            + present.slice(0, 10).map(function (e) { return e.tag + " x" + e.count; }).join(", "));

        if (!ks) {
            log("stock: no ksUI on this page");
        } else {
            log("stock: ksUI.fetchAllModels is " + typeof ks.fetchAllModels
                + ", perFrameAllModelUpdate is " + typeof ks.perFrameAllModelUpdate + " (both wrappable)");
        }

        if (typeof customElements === "undefined" || !customElements.get) {
            log("stock: no customElements registry, so widget methods cannot be wrapped by tag");

            return;
        }

        tags.forEach(function (tag) {
            const ctor = customElements.get(tag);

            if (!ctor) {
                missing.push(tag);

                return;
            }

            const methods = methodsOf(ctor);

            reachable.push(tag + " [" + methods.slice(0, 6).join(", ") + (methods.length > 6 ? ", ..." : "") + "]");
        });
        log("stock widgets wrappable (" + reachable.length + " of " + tags.length + "): "
            + (reachable.slice(0, 8).join(" | ") || "none"));

        if (missing.length) {
            log("stock widgets present in the DOM but not in the registry: " + missing.slice(0, 12).join(", "));
        }
    };

    // ---- 4. what wrapping costs ----------------------------------------------------

    const overheadReport = function () {
        const plain = function (x) { return x + 1; };
        const wrapped = function (x) {
            const t0 = performance.now();
            const out = plain(x);

            return out + (performance.now() - t0) * 0;
        };
        let i;
        let acc = 0;
        let t0 = Date.now();

        for (i = 0; i < OVERHEAD_CALLS; i += 1) { acc += plain(i); }

        const bare = Date.now() - t0;

        t0 = Date.now();

        for (i = 0; i < OVERHEAD_CALLS; i += 1) { acc += wrapped(i); }

        const timed = Date.now() - t0;

        log("overhead: " + OVERHEAD_CALLS + " calls bare " + bare + " ms, instrumented " + timed
            + " ms -> " + ((timed - bare) * 1000 / OVERHEAD_CALLS).toFixed(3)
            + " us per instrumented call (acc " + (acc > 0) + ")");
    };

    // ---- 5. scheduling --------------------------------------------------------------

    const wrapScheduling = function () {
        const raf = window.requestAnimationFrame;
        const timeout = window.setTimeout;
        const interval = window.setInterval;
        const add = EventTarget.prototype.addEventListener;

        window.requestAnimationFrame = function (fn) {
            return raf.call(window, function (now) {
                rafCalls += 1;
                count(seen.raf, nameOf(fn));

                if (typeof fn === "function" && !fn.name) { anonymous += 1; }

                return fn(now);
            });
        };
        undo.push(function () { window.requestAnimationFrame = raf; });

        window.setTimeout = function (fn, ms) {
            seen.timeout += 1;

            return timeout.call(window, fn, ms);
        };
        undo.push(function () { window.setTimeout = timeout; });

        window.setInterval = function (fn, ms) {
            seen.interval += 1;

            return interval.call(window, fn, ms);
        };
        undo.push(function () { window.setInterval = interval; });

        EventTarget.prototype.addEventListener = function (type, fn, options) {
            count(seen.listeners, type);

            return add.call(this, type, fn, options);
        };
        undo.push(function () { EventTarget.prototype.addEventListener = add; });
    };

    // ---- the run -------------------------------------------------------------------

    log("start: " + document.getElementsByTagName("*").length + " elements on the page");
    layoutReport();
    stockReport();
    overheadReport();
    wrapScheduling();

    // the clock question is about one frame, so ask it inside one
    requestAnimationFrame(function () {
        clockReport();
    });

    window.setTimeout(function () {
        const names = Object.keys(seen.raf).sort(function (a, b) { return seen.raf[b] - seen.raf[a]; });
        const listeners = Object.keys(seen.listeners).sort(function (a, b) {
            return seen.listeners[b] - seen.listeners[a];
        });

        undo.forEach(function (fn) { fn(); });

        log("frames: " + rafCalls + " animation-frame callbacks in " + WATCH_MS + " ms ("
            + Math.round(rafCalls * 1000 / WATCH_MS) + "/s), " + anonymous + " anonymous");
        log("frames by callback: " + names.slice(0, TOP_NAMES).map(function (n) {
            return n + " x" + seen.raf[n];
        }).join(", "));
        log("timers scheduled while watching: setTimeout x" + seen.timeout + ", setInterval x" + seen.interval);
        log("listeners added while watching: " + (listeners.map(function (n) {
            return n + " x" + seen.listeners[n];
        }).join(", ") || "none"));
        log("done -- everything unwrapped");
    }, WATCH_MS);
}());
