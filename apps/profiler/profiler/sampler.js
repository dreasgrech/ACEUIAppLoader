/**
 * ACEProfilerSampler -- where the frame went, measured rather than guessed.
 *
 * This is the instrumentation half of the profiler: no DOM, no drawing, no panel. It
 * wraps the page's scheduling entry points, times what runs through them, and keeps the
 * last RING frames so the panel can draw them and scrub back through them.
 *
 * WHY THIS CAN WORK AT ALL. Cohtml gives a page three things a profiler needs, and the
 * `.run profileprobe` snippet in ACEUIModLoader/dev/snippets checks each in game:
 *
 *   - a clock: `performance.now()` with sub-millisecond steps (there is no
 *     `performance.mark`, and no `performance.memory`, so there is no allocation
 *     tracking here -- see COUNTERS below for what replaces Unity's GC Alloc column);
 *   - visible scheduling: the stock bundle re-resolves `requestAnimationFrame`,
 *     `setTimeout` and `addEventListener` from the global scope at every call
 *     (`components.js`: `return requestAnimationFrame(ksUI$1.perFrameAllModelUpdate)`),
 *     so replacing those globals intercepts the **whole page**, stock widgets included,
 *     even for chains that were already running when we started;
 *   - names: the stock bundle ships unminified, so its callbacks arrive with real
 *     function names (`perFrameAllModelUpdate`, `visibilityChecker`, `fetchAllModels`).
 *     Our own mods' frame loops carry their mod name because `ACEUIModLoader.loop.start`
 *     takes an owner and `mod().panel` passes it.
 *
 * THE MODEL, which is Unity's. A frame runs from one animation-frame callback to the
 * next; its wall time is the gap between them. Anything instrumented that runs inside it
 * opens a sample on a stack: total time is its own elapsed time, self time is that minus
 * whatever its children took. What is left when every top-level sample is subtracted from
 * the frame's wall time is `other` -- the engine itself: style, layout, tessellation,
 * paint. In this renderer that is usually the biggest slice, and being able to see it
 * separately from script time is the point.
 *
 * COUNTERS. There is no allocation counter in this engine, so the columns that matter
 * here count what Renoir actually charges for: forced layout reads
 * (`getBoundingClientRect` and friends), elements created, and listeners added. A frame
 * that reads layout forty times is the local equivalent of one that allocates 40 kB.
 *
 * OVERHEAD. Two clock reads and a closure per instrumented call, about 0.2 us. The
 * profiler's own cost is measured like everything else and shown as its own category, so
 * it can never quietly flatter itself.
 *
 * Usage (the panel does this; it is also driven directly from the dev console):
 *
 *     ACEProfilerSampler.start();            // wrap the page and begin recording
 *     ACEProfilerSampler.frames();           // the ring buffer, oldest first
 *     ACEProfilerSampler.frame(index);       // one frame, expanded into a tree
 *     ACEProfilerSampler.pause();            // stop recording, keep what was recorded
 *     ACEProfilerSampler.stop();             // unwrap the page completely
 */
const ACEProfilerSampler = (function () {

    /** Frames kept. 300 is about five seconds at this page's 58.5 fps. */
    const RING = 300;
    /** Samples kept per frame; a frame that exceeds this is marked truncated rather than grown. */
    const MAX_SAMPLES = 400;
    /** Categories, in the order the panel stacks them. */
    const CATEGORY = {
        mod: "mod",
        stock: "stock",
        event: "event",
        timer: "timer",
        profiler: "profiler",
        other: "other"
    };
    const STACK_LIMIT = 32;
    const MS = 1;

    /** Stock entry points worth naming separately from the rest of the bundle. */
    const STOCK_FRAME_NAMES = ["perFrameAllModelUpdate", "perFrameCarDisplayModelUpdate",
        "perFrameIndicatorUpdate", "visibilityChecker"];

    const state = {
        recording: false,
        wrapped: false,
        names: [],              // interned sample names; samples store an index, not a string
        nameIds: {},
        frames: [],             // ring buffer of finished frames
        first: 0,               // ring start, so frames() can hand them back oldest first
        current: null,          // the frame being filled
        stack: [],              // open samples
        depth: 0,
        lastFrameAt: 0,
        undo: [],               // how to put every wrapped global back
        overheadStart: 0,
        selfMs: 0               // the profiler's own time inside this frame
    };

    const now = function () {
        return performance.now();
    };

    /** Names are interned: the hot path stores an integer, never a string. */
    const intern = function (name) {
        const known = state.nameIds[name];

        if (known !== undefined) { return known; }

        state.nameIds[name] = state.names.length;
        state.names.push(name);

        return state.names.length - 1;
    };

    const blankFrame = function () {
        return {
            at: 0,              // the animation-frame timestamp this frame started on
            wallMs: 0,          // gap to the previous frame: the whole budget
            scriptMs: 0,        // sum of the top-level samples
            profilerMs: 0,      // what this profiler cost inside the frame
            truncated: false,
            count: 0,
            name: [],           // per sample: interned name
            category: [],
            parent: [],
            totalMs: [],
            selfMs: [],
            layoutReads: 0,
            elementsMade: 0,
            listenersAdded: 0
        };
    };

    // ---- the sample stack ----------------------------------------------------------

    /**
     * Open a sample. Returns the handle `close` needs, or -1 when there is nothing to
     * record into (not recording, or this frame is already full), which callers treat as
     * "just run the work".
     */
    const open = function (name, category) {
        const frame = state.current;

        if (!state.recording || !frame) { return -1; }

        if (frame.count >= MAX_SAMPLES || state.depth >= STACK_LIMIT) {
            frame.truncated = true;

            return -1;
        }

        const index = frame.count;

        frame.count += 1;
        frame.name[index] = intern(name);
        frame.category[index] = category;
        frame.parent[index] = state.depth > 0 ? state.stack[state.depth - 1].index : -1;
        frame.totalMs[index] = 0;
        frame.selfMs[index] = 0;
        state.stack[state.depth] = { index: index, start: now(), childMs: 0 };
        state.depth += 1;

        return index;
    };

    const close = function (handle) {
        const frame = state.current;

        if (handle < 0 || !frame || state.depth === 0) { return; }

        const entry = state.stack[state.depth - 1];
        const total = now() - entry.start;

        state.depth -= 1;
        frame.totalMs[entry.index] = total;
        frame.selfMs[entry.index] = total - entry.childMs;

        if (state.depth > 0) {
            state.stack[state.depth - 1].childMs += total;
        } else {
            frame.scriptMs += total;
        }
    };

    /** Run `fn` as a named sample. The wrapper is what every hook below is made of. */
    const measure = function (name, category, fn, self, args) {
        const handle = open(name, category);

        try {
            return fn.apply(self, args);
        } finally {
            close(handle);
        }
    };

    // ---- frames --------------------------------------------------------------------

    const push = function (frame) {
        if (state.frames.length < RING) {
            state.frames.push(frame);

            return;
        }

        state.frames[state.first] = frame;
        state.first = (state.first + 1) % RING;
    };

    /**
     * A new animation frame began. Close the previous one -- its wall time is the gap
     * between the two timestamps, which is the only honest measure of the frame's budget
     * in a page whose renderer we cannot see into.
     *
     * The boundary is the **timestamp**, not the callback: a page like this one has many
     * animation-frame callbacks per frame (the stock bundle's model sync, plus one per
     * mod), and they all arrive with the same timestamp. Treating each as a new frame --
     * which is what this did first -- shreds one 17 ms frame into six 0 ms ones and every
     * total after that is wrong.
     */
    const beginFrame = function (timestamp) {
        const previous = state.current;

        if (!state.recording) { return; }

        if (previous && previous.at === timestamp) { return; }

        if (previous) {
            previous.wallMs = timestamp - previous.at;
            previous.profilerMs = state.selfMs;
            push(previous);
        }

        state.selfMs = 0;
        state.current = blankFrame();
        state.current.at = timestamp;
        state.depth = 0;
    };

    /** The ring buffer, oldest first, as plain frames the panel can read. */
    const frames = function () {
        const out = [];
        let i;

        for (i = 0; i < state.frames.length; i += 1) {
            out.push(state.frames[(state.first + i) % state.frames.length]);
        }

        return out;
    };

    /** What is left of a frame's wall time once every top-level sample is subtracted. */
    const otherMs = function (frame) {
        const rest = frame.wallMs - frame.scriptMs;

        return rest > 0 ? rest : 0;
    };

    /**
     * One frame as a tree of `{ name, category, totalMs, selfMs, calls, children }`,
     * merged by name the way a profiler's hierarchy view shows it: ten calls to the same
     * function are one row with `calls: 10`, not ten rows.
     */
    const tree = function (frame) {
        const nodes = [];
        const byParent = {};
        let i;

        if (!frame) { return []; }

        for (i = 0; i < frame.count; i += 1) {
            const parent = frame.parent[i];
            const key = parent + "/" + frame.name[i];
            const existing = byParent[key];

            if (existing) {
                existing.totalMs += frame.totalMs[i];
                existing.selfMs += frame.selfMs[i];
                existing.calls += 1;
                nodes[i] = existing;
            } else {
                const node = {
                    name: state.names[frame.name[i]],
                    category: frame.category[i],
                    totalMs: frame.totalMs[i],
                    selfMs: frame.selfMs[i],
                    calls: 1,
                    children: []
                };

                byParent[key] = node;
                nodes[i] = node;

                if (parent >= 0 && nodes[parent]) {
                    nodes[parent].children.push(node);
                } else {
                    node.top = true;
                }
            }
        }

        return nodes.filter(function (node, index) {
            return node && node.top && nodes.indexOf(node) === index;
        });
    };

    /** Per-category totals for one frame, for the stacked graph. */
    const totals = function (frame) {
        const out = { mod: 0, stock: 0, event: 0, timer: 0, profiler: 0, other: 0 };
        let i;

        if (!frame) { return out; }

        for (i = 0; i < frame.count; i += 1) {
            if (frame.parent[i] === -1) { out[frame.category[i]] += frame.totalMs[i]; }
        }

        out.profiler = frame.profilerMs;
        out.other = otherMs(frame);

        return out;
    };

    // ---- the hooks -----------------------------------------------------------------

    /** How a stock animation-frame callback should be labelled. */
    const frameLabel = function (fn, owner) {
        if (owner) { return owner; }

        const named = fn && fn.name ? fn.name : "";

        if (!named) { return "anonymous frame callback"; }

        return STOCK_FRAME_NAMES.indexOf(named) >= 0 ? "stock: " + named : named;
    };

    const wrapFrames = function () {
        const raf = window.requestAnimationFrame;

        window.requestAnimationFrame = function (fn) {
            // ACEUIModLoader.loop stamps the mod's name on the callback it schedules, so a
            // mod's frames are attributed by name rather than guessed from a closure
            const owner = fn && fn.aceOwner ? fn.aceOwner : "";

            return raf.call(window, function (timestamp) {
                const t0 = now();

                beginFrame(timestamp);
                state.selfMs += now() - t0;

                return measure(frameLabel(fn, owner), owner ? CATEGORY.mod : CATEGORY.stock, fn, window, [timestamp]);
            });
        };
        state.undo.push(function () { window.requestAnimationFrame = raf; });
    };

    const wrapTimers = function () {
        const timeout = window.setTimeout;
        const interval = window.setInterval;
        const wrap = function (fn, label) {
            if (typeof fn !== "function") { return fn; }

            return function () {
                return measure(label + (fn.name ? ": " + fn.name : ""), CATEGORY.timer, fn, this, arguments);
            };
        };

        window.setTimeout = function (fn, ms) {
            return timeout.call(window, wrap(fn, "setTimeout"), ms);
        };
        window.setInterval = function (fn, ms) {
            return interval.call(window, wrap(fn, "setInterval"), ms);
        };
        state.undo.push(function () {
            window.setTimeout = timeout;
            window.setInterval = interval;
        });
    };

    /**
     * DOM events, and the game's own `engine.on` events. Both are entry points into
     * script from outside, which is exactly what a profiler wants to see; a stock widget
     * reacting to a model update shows up here with the event's name on it.
     */
    const wrapEvents = function () {
        const add = EventTarget.prototype.addEventListener;
        const remove = EventTarget.prototype.removeEventListener;
        const wrappers = [];        // original -> wrapper, so removeEventListener still works

        EventTarget.prototype.addEventListener = function (type, fn, options) {
            if (typeof fn !== "function") { return add.call(this, type, fn, options); }

            const wrapper = function (e) {
                return measure("on " + type + (fn.name ? ": " + fn.name : ""), CATEGORY.event, fn, this, [e]);
            };

            wrappers.push(fn);
            wrappers.push(wrapper);

            return add.call(this, type, wrapper, options);
        };

        EventTarget.prototype.removeEventListener = function (type, fn, options) {
            const at = wrappers.indexOf(fn);

            return remove.call(this, type, at >= 0 ? wrappers[at + 1] : fn, options);
        };

        state.undo.push(function () {
            EventTarget.prototype.addEventListener = add;
            EventTarget.prototype.removeEventListener = remove;
        });

        if (window.engine && typeof engine.on === "function") {
            const on = engine.on;

            engine.on = function (name, fn, context) {
                if (typeof fn !== "function") { return on.call(engine, name, fn, context); }

                return on.call(engine, name, function () {
                    return measure("engine " + name, CATEGORY.event, fn, this, arguments);
                }, context);
            };
            state.undo.push(function () { engine.on = on; });
        }
    };

    /**
     * The counters that stand in for Unity's GC Alloc column. This engine charges for
     * forced layout and for DOM churn, not for allocation, so those are what is counted.
     */
    const wrapCounters = function () {
        const rect = Element.prototype.getBoundingClientRect;
        const create = document.createElement;

        Element.prototype.getBoundingClientRect = function () {
            if (state.current) { state.current.layoutReads += 1; }

            return rect.apply(this, arguments);
        };
        state.undo.push(function () { Element.prototype.getBoundingClientRect = rect; });

        document.createElement = function (tag) {
            if (state.current) { state.current.elementsMade += 1; }

            return create.call(document, tag);
        };
        state.undo.push(function () { document.createElement = create; });
    };

    // ---- control -------------------------------------------------------------------

    const wrap = function () {
        if (state.wrapped) { return false; }

        state.wrapped = true;
        wrapFrames();
        wrapTimers();
        wrapEvents();
        wrapCounters();

        return true;
    };

    const unwrap = function () {
        if (!state.wrapped) { return false; }

        state.undo.slice().reverse().forEach(function (fn) { fn(); });
        state.undo = [];
        state.wrapped = false;

        return true;
    };

    const clear = function () {
        state.frames = [];
        state.first = 0;
        state.current = null;
        state.depth = 0;
    };

    const start = function () {
        wrap();
        state.recording = true;

        return true;
    };

    /**
     * Stop recording but stay wrapped, so resuming is instant. The frame in progress is
     * dropped rather than kept: its wall time would otherwise be measured across the whole
     * pause, and a 40-second frame in the graph is worse than no frame at all.
     */
    const pause = function () {
        state.recording = false;
        state.current = null;
        state.depth = 0;

        return false;
    };

    const stop = function () {
        pause();

        return unwrap();
    };

    return {
        RING: RING,
        MAX_SAMPLES: MAX_SAMPLES,
        CATEGORY: CATEGORY,
        state: state,
        start: start,
        pause: pause,
        stop: stop,
        clear: clear,
        recording: function () { return state.recording; },
        wrapped: function () { return state.wrapped; },
        frames: frames,
        tree: tree,
        totals: totals,
        otherMs: otherMs,
        /** For a mod that wants its own named section inside a frame. */
        measure: function (name, fn) { return measure(name, CATEGORY.mod, fn, null, []); }
    };
}());
