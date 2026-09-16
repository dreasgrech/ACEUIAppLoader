/**
 * ACEProfilerSampler -- where the frame went, measured rather than guessed.
 *
 * This is the instrumentation half of the profiler: no DOM, no drawing, no panel. It
 * wraps the page's scheduling entry points, times what runs through them, and keeps the
 * last RING frames so the panel can draw them and scrub back through them.
 *
 * WHY THIS CAN WORK AT ALL. Cohtml gives a page two of the three things a profiler needs,
 * and the `.run profileprobe` snippet in ACEUIModLoader/dev/snippets measured each in game:
 *
 *   - a clock, but a poor one. **`performance.now()` does not advance within a frame**:
 *     200,000 reads across 29 ms of real time returned one single value, because the
 *     engine hands the page its frame timestamp and freezes it until the next frame. A
 *     profiler built on it would report 0.00 ms for everything while looking like it
 *     worked. `Date.now()` does advance, in 1 ms steps, so that is the clock here -- see
 *     THE CLOCK below for what that costs us. There is no `performance.mark` and no
 *     `performance.memory`, so there is no allocation tracking either (see COUNTERS);
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
 * THE CLOCK, and what it means. Frame wall time is exact: the animation-frame timestamp
 * is precise and does advance between frames. Call counts are exact. Per-call *time* is
 * quantised to 1 ms, so a 0.2 ms callback reads 0 ms on four frames out of five and 1 ms
 * on the fifth. That error is unbiased, which is the saving grace: summed over a few
 * hundred calls it converges on the true cost. So single-frame times are noisy and the
 * numbers worth reading are `aggregate()`'s -- calls, ms per frame and share of the frame
 * over the whole recording window. The panel leads with those, not with one frame.
 *
 * THE MODEL, which is Unity's. A frame runs from one animation-frame callback to the
 * next; its wall time is the gap between them. Anything instrumented that runs inside it
 * opens a sample on a stack: total time is its own elapsed time, self time is that minus
 * whatever its children took. What is left when every top-level sample is subtracted from
 * the frame's wall time is `other` -- the engine itself: style, layout, tessellation,
 * paint. In this renderer that is usually the biggest slice, and being able to see it
 * separately from script time is the point.
 *
 * COUNTERS. There is no allocation counter in this engine, so the columns that matter here
 * count what Renoir actually charges for: forced layout reads (`getBoundingClientRect`)
 * and elements created. A frame that reads layout forty times is the local equivalent of
 * one that allocates 40 kB -- and the count is kept against the sample that caused it, so
 * the table can say *which* app is doing the reading rather than only that someone is.
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
    /**
     * The clock. `Date.now` rather than `performance.now`, which is frozen for the
     * duration of a frame in this engine (measured, in game). 1 ms steps.
     */
    const CLOCK = { name: "Date.now", resolutionMs: 1, framePrecise: true };

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
        widgetUndo: [],         // and the widget methods, separately: they can be toggled
        widgets: [],            // stock widget methods wrapped, by name
        modelSync: false,       // whether ksUI.fetchAllModels was found and wrapped
        selfMs: 0               // the profiler's own time inside this frame
    };

    /** The only clock here that moves inside a frame. See CLOCK. */
    const now = function () {
        return Date.now();
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
            layout: [],         // per sample: layout reads it caused, children included
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
        frame.layout[index] = 0;
        state.stack[state.depth] = { index: index, start: now(), childMs: 0, layout: 0 };
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
        frame.layout[entry.index] = entry.layout;

        if (state.depth > 0) {
            state.stack[state.depth - 1].childMs += total;
            state.stack[state.depth - 1].layout += entry.layout;
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

    /**
     * What the hierarchy view should actually show: every name's cost across a window of
     * frames, not in one frame. With a 1 ms clock a single frame's reading is noise; a few
     * hundred frames of it is not.
     *
     * Rows are `{ name, category, calls, totalMs, selfMs, frames, callsPerFrame,
     * msPerFrame, msPerCall, share }`, sorted by total time. `share` is of the summed wall
     * time, so it answers "what fraction of the frame does this app cost me".
     */
    const aggregate = function (window) {
        const list = window || frames();
        const rows = {};
        const out = [];
        let wallMs = 0;
        let i;
        let j;

        list.forEach(function (frame) {
            const seenHere = {};

            wallMs += frame.wallMs;

            for (j = 0; j < frame.count; j += 1) {
                const key = state.names[frame.name[j]];
                const row = rows[key] || {
                    name: key,
                    category: frame.category[j],
                    calls: 0,
                    totalMs: 0,
                    selfMs: 0,
                    layout: 0,
                    frames: 0
                };

                row.calls += 1;
                row.totalMs += frame.totalMs[j];
                row.selfMs += frame.selfMs[j];
                row.layout += frame.layout[j] || 0;

                if (!seenHere[key]) {
                    seenHere[key] = true;
                    row.frames += 1;
                }

                rows[key] = row;
            }
        });

        Object.keys(rows).forEach(function (key) {
            const row = rows[key];

            row.callsPerFrame = list.length ? row.calls / list.length : 0;
            row.msPerFrame = list.length ? row.totalMs / list.length : 0;
            row.selfPerFrame = list.length ? row.selfMs / list.length : 0;
            row.layoutPerFrame = list.length ? row.layout / list.length : 0;
            row.msPerCall = row.calls ? row.totalMs / row.calls : 0;
            row.share = wallMs > 0 ? row.totalMs / wallMs : 0;
            out.push(row);
        });

        out.sort(function (a, b) { return b.totalMs - a.totalMs; });

        for (i = 0; i < out.length; i += 1) { out[i].rank = i; }

        return { wallMs: wallMs, frames: list.length, rows: out };
    };

    /**
     * The call tree across a window of frames, merged by path: every frame's "pedalgraph >
     * render > commit" becomes one node carrying the totals of all of them. This is the
     * view that answers "what inside this mod is taking the time", and it only means
     * anything across many frames -- one frame's reading of a 0.2 ms section is 0 or 1.
     *
     * Rows come back depth-first, each with `depth` for indenting, sorted by cost within
     * each level.
     */
    const aggregateTree = function (window) {
        const list = window || frames();
        const byPath = {};
        const roots = [];
        const out = [];
        let wallMs = 0;

        const node = function (path, name, category, depth, parent) {
            if (byPath[path]) { return byPath[path]; }

            const made = {
                name: name,
                category: category,
                depth: depth,
                calls: 0,
                totalMs: 0,
                selfMs: 0,
                layout: 0,
                children: []
            };

            byPath[path] = made;

            if (parent) {
                parent.children.push(made);
            } else {
                roots.push(made);
            }

            return made;
        };

        list.forEach(function (frame) {
            const paths = [];
            let i;

            wallMs += frame.wallMs;

            for (i = 0; i < frame.count; i += 1) {
                const parentIndex = frame.parent[i];
                const parentNode = parentIndex >= 0 ? byPath[paths[parentIndex]] : null;
                const name = state.names[frame.name[i]];
                const path = (parentIndex >= 0 ? paths[parentIndex] : "") + "/" + name;
                const here = node(path, name, frame.category[i], parentIndex >= 0 ? parentNode.depth + 1 : 0,
                    parentNode);

                paths[i] = path;
                here.calls += 1;
                here.totalMs += frame.totalMs[i];
                here.selfMs += frame.selfMs[i];
                here.layout += frame.layout[i] || 0;
            }
        });

        const finish = function (entry) {
            entry.callsPerFrame = list.length ? entry.calls / list.length : 0;
            entry.msPerFrame = list.length ? entry.totalMs / list.length : 0;
            entry.selfPerFrame = list.length ? entry.selfMs / list.length : 0;
            entry.layoutPerFrame = list.length ? entry.layout / list.length : 0;
            entry.share = wallMs > 0 ? entry.totalMs / wallMs : 0;
            out.push(entry);
            entry.children.sort(function (a, b) { return b.totalMs - a.totalMs; });
            entry.children.forEach(finish);
        };

        roots.sort(function (a, b) { return b.totalMs - a.totalMs; });
        roots.forEach(finish);

        // `roots` as well as the flattened rows: the panel re-sorts within each parent when
        // a column header is clicked, which needs the shape, not the flattening
        return { wallMs: wallMs, frames: list.length, rows: out, roots: roots };
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

    /** Every custom element actually on the page, commonest first. */
    const widgetTags = function () {
        const counts = {};
        const all = document.getElementsByTagName("*");
        let i;

        for (i = 0; i < all.length; i += 1) {
            const tag = all[i].tagName.toLowerCase();

            if (tag.indexOf("-") > 0) { counts[tag] = (counts[tag] || 0) + 1; }
        }

        return Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; });
    };

    /**
     * Wrap the methods of the stock widgets on this page, so `ks-huddamage.process` shows
     * up in the table beside our own mods.
     *
     * Descriptors only: reading a property off one of these prototypes runs its accessors
     * with the prototype as the receiver, and the stock widgets have accessors that throw
     * when that happens.
     */
    const wrapWidgets = function () {
        const wrapped = [];

        if (typeof customElements === "undefined" || !customElements || !customElements.get) { return wrapped; }

        widgetTags().forEach(function (tag) {
            const ctor = customElements.get(tag);
            const proto = ctor ? ctor.prototype : null;

            if (!proto) { return; }

            Object.getOwnPropertyNames(proto).forEach(function (key) {
                const descriptor = Object.getOwnPropertyDescriptor(proto, key);

                if (key === "constructor" || !descriptor || typeof descriptor.value !== "function") { return; }

                if (!descriptor.writable && !descriptor.configurable) { return; }

                const original = descriptor.value;
                const label = tag + "." + key;

                proto[key] = function () {
                    return measure(label, CATEGORY.stock, original, this, arguments);
                };
                wrapped.push(label);
                state.widgetUndo.push(function () { proto[key] = original; });
            });
        });

        return wrapped;
    };

    const unwrapWidgets = function () {
        const had = state.widgets.length;

        state.widgetUndo.slice().reverse().forEach(function (fn) { fn(); });
        state.widgetUndo = [];
        state.widgets = [];

        return had;
    };

    /** The stock bundle's own per-frame model sync, which every widget's data comes from. */
    const wrapModelSync = function () {
        const ks = window.ksUI;

        if (!ks || typeof ks.fetchAllModels !== "function") { return false; }

        const original = ks.fetchAllModels;

        ks.fetchAllModels = function () {
            return measure("stock: fetchAllModels", CATEGORY.stock, original, ks, arguments);
        };
        state.undo.push(function () { ks.fetchAllModels = original; });

        return true;
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

            // and against whoever is running right now, so the table can name them
            if (state.depth > 0) { state.stack[state.depth - 1].layout += 1; }

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

    /**
     * `options.widgets` (default off) also wraps every stock widget method on the page --
     * about 150 of them, which is worth asking for rather than assuming.
     */
    const wrap = function (options) {
        const opts = options || {};
        const wantWidgets = Boolean(opts.widgets);

        // already instrumented (a pause keeps the wrapping, so resuming is instant): the
        // one thing that can still change between recordings is whether the stock widgets
        // are included, so honour that rather than silently ignoring the setting
        if (state.wrapped) {
            if (wantWidgets && !state.widgets.length) { state.widgets = wrapWidgets(); }

            if (!wantWidgets && state.widgets.length) { unwrapWidgets(); }

            return false;
        }

        state.wrapped = true;
        wrapFrames();
        wrapTimers();
        wrapEvents();
        wrapCounters();
        state.modelSync = wrapModelSync();
        state.widgets = wantWidgets ? wrapWidgets() : [];

        return true;
    };

    const unwrap = function () {
        if (!state.wrapped) { return false; }

        unwrapWidgets();
        state.undo.slice().reverse().forEach(function (fn) { fn(); });
        state.undo = [];
        state.modelSync = false;
        state.wrapped = false;

        return true;
    };

    const clear = function () {
        state.frames = [];
        state.first = 0;
        state.current = null;
        state.depth = 0;
    };

    /**
     * Mods name their own work through `ACEUIModLoader.section`, which does nothing until
     * something fills this slot. Filling it only while recording means a mod pays a
     * property read and a call for being profilable, and nothing more.
     */
    const bindSections = function (on) {
        if (!window.ACEUIModLoader) { return false; }

        ACEUIModLoader.profiler = on
            ? { section: function (name, fn) { return measure(name, CATEGORY.mod, fn, null, []); } }
            : null;

        return on;
    };

    const start = function (options) {
        wrap(options);
        bindSections(true);
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
        bindSections(false);

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
        CLOCK: CLOCK,
        state: state,
        start: start,
        pause: pause,
        stop: stop,
        clear: clear,
        recording: function () { return state.recording; },
        wrapped: function () { return state.wrapped; },
        frames: frames,
        tree: tree,
        aggregate: aggregate,
        aggregateTree: aggregateTree,
        widgetTags: widgetTags,
        /** Stock widget methods currently wrapped, for the panel to report. */
        widgets: function () { return state.widgets; },
        totals: totals,
        otherMs: otherMs,
        /** For a mod that wants its own named section inside a frame. */
        measure: function (name, fn) { return measure(name, CATEGORY.mod, fn, null, []); }
    };
}());


/*
 * Classic scripts: a top-level `const` is a page-wide binding but not a window property,
 * so anything reaching for `window.ACEProfilerSampler` -- a dev-console snippet, another
 * mod -- would find nothing. The library's core does the same for the same reason.
 */
window.ACEProfilerSampler = ACEProfilerSampler;
