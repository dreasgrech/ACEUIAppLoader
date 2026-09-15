/**
 * ACE UI Profiler -- the panel: where the frame went, live, in the HUD.
 *
 * The measuring is `sampler.js`'s job; this draws it. Two views, as a profiler should
 * have: a graph of the last frames, and a table of what cost what.
 *
 * THE GRAPH is an oscilloscope rather than a scrolling strip. Unity scrolls its chart,
 * which here would mean either blitting the canvas onto itself every frame (unproven in
 * Renoir) or redrawing three hundred stacked columns at 58 fps -- about six thousand fills
 * a second, which is exactly the per-frame work this project has a rule against. Writing
 * one new column per frame and wiping the one ahead of it costs a handful of fills, needs
 * nothing unproven, and reads the same once you know the sweep wraps.
 *
 * THE TABLE is the honest half. The engine freezes `performance.now()` for the duration of
 * a frame (measured in game; see sampler.js), so the sampler times with `Date.now` and its
 * 1 ms steps: one frame's reading of a sub-millisecond callback is 0 or 1 and means nothing
 * on its own. The table therefore shows the *window* -- calls per frame, ms per frame and
 * share of the frame across every recorded frame -- which is both what survives the clock
 * and what you act on. The per-frame line above it is for spikes, where 1 ms of
 * quantisation does not matter because the spike is twenty.
 *
 * What it can see: our own mods by name (ACEUIModLoader.loop carries the owner), the stock
 * bundle's per-frame work by function name (`perFrameAllModelUpdate` and friends -- the
 * bundle ships unminified), `engine.on` model events, DOM events and timers. And `other`:
 * frame time no script accounted for, which is the engine itself -- style, layout,
 * tessellation, paint. On this HUD that is usually the biggest slice.
 */
const ACEUIProfiler = (function () {

    const me = ACEUIModLoader.mod("profiler");
    const S = ACEProfilerSampler;

    /** Class names shared with profiler.css. */
    const CLASS = {
        root: "ace-profiler",
        header: "pr-header",
        title: "pr-title",
        stat: "pr-stat",
        tools: "pr-tools",
        btn: "pr-btn",
        on: "on",
        graph: "pr-graph",
        canvas: "pr-canvas",
        scaleTop: "pr-scale-top",
        scaleMid: "pr-scale-mid",
        legend: "pr-legend",
        key: "pr-key",
        swatch: "pr-swatch",
        frameLine: "pr-frame",
        head: "pr-head",
        rows: "pr-rows",
        row: "pr-row",
        name: "pr-name",
        calls: "pr-calls",
        ms: "pr-ms",
        layout: "pr-layout",
        share: "pr-share",
        bar: "pr-bar",
        hidden: "pr-hidden",
        palette: "pr-palette",
        scroll: "pr-scroll",
        scrollbar: "pr-scrollbar",
        thumb: "pr-thumb",
        nofit: "pr-nofit"
    };

    const ACT_ATTR = "data-act";
    const ACT_RECORD = "record";
    const ACT_TREE = "tree";
    const ACT_WORST = "worst";
    const ACT_LOG = "log";
    const ACT_CLEAR = "clear";
    const ACT_CLOSE = "close";

    /** What the table is showing: the window's averages, its call tree, or one bad frame. */
    const MODE_WINDOW = "window";
    const MODE_TREE = "tree";
    const MODE_WORST = "worst";
    /** Indent per level in the tree view. Text, not padding: no style writes per row. */
    const INDENT = "     ";
    const NODRAG_ATTR = ACEUIModLoader.panel.NO_DRAG_ATTR;

    /** Graph geometry. One pixel column per frame; 33 ms is full height, as Unity's is. */
    const GRAPH_W = 300;
    const GRAPH_H = 64;
    const FULL_MS = 33;
    const GUIDE_MS = 16.7;
    const WIPE_W = 3;

    /**
     * The graph's bands, bottom-up, with the ink the canvas paints them in.
     *
     * These were read out of profiler.css with `getComputedStyle` so the colours would
     * live in one place. That does not work here: in this engine `getComputedStyle`
     * reports inline styles and initial values rather than the cascade, so every band came
     * back `rgba(0, 0, 0, 0)` and the graph painted a careful stack of transparent
     * rectangles. A canvas is painted rather than styled, so the ink belongs here; the
     * legend swatches are still CSS, and a test keeps the two lists in step.
     */
    const BANDS = [
        { key: "mod", label: "mods", ink: "#44ea78" },
        { key: "stock", label: "stock HUD", ink: "#3aa6ff" },
        { key: "event", label: "events", ink: "#ffd23a" },
        { key: "timer", label: "timers", ink: "#c07cff" },
        { key: "profiler", label: "profiler", ink: "#ff8a3a" },
        { key: "other", label: "engine", ink: "rgba(255, 255, 255, 0.22)" }
    ];
    const BAND_ATTR = "data-band";
    const GUIDE_BAND = "guide";
    const SWEEP_BAND = "sweep";
    const INK_GUIDE = "rgba(255, 255, 255, 0.38)";
    const INK_SWEEP = "rgba(255, 255, 255, 0.5)";

    /** The table is redrawn a few times a second, not every frame. */
    const REFRESH_MS = 400;
    /** Which frame to measure the panel on: late enough that layout has happened. */
    const SURFACE_FRAME = 30;
    /** What the stylesheet asks for, so the script can tell whether it arrived. */
    const PANEL_EM = 30;
    const REM_PX = 16;
    const ROWS = 14;
    const SCALE_DEFAULT = 1;
    const SCALE_MIN = 0.7;
    const SCALE_MAX = 2;
    const SCALE_STEP = 0.1;
    const SCALE_DIGITS = 1;
    const DECIMALS = 2;
    const SHARE_DECIMALS = 1;
    /** Enough precision that a 0.1% share still moves the bar behind its row. */
    const BAR_DIGITS = 3;
    const PERCENT = 100;
    const MS_PER_S = 1000;

    /** Kept in step with profiler.css's own `.ace-profiler` background. */
    const PANEL_BG = "rgba(0, 0, 0, 0.88)";

    const TITLE_TEXT = "PROFILER";
    const REC_TEXT = "REC";
    const TREE_TEXT = "TREE";
    const WORST_TEXT = "WORST";
    const LOG_TEXT = "LOG";
    const CLEAR_TEXT = "CLEAR";
    const CLOSE_TEXT = "x";
    const LOG_ROWS = 15;

    const el = ACEUIModLoader.el;
    const close = ACEUIModLoader.close;
    const toArray = ACEUIModLoader.toArray;
    const clamp = ACEUIModLoader.clamp;
    const keys = ACEUIModLoader.keys;
    const dom = ACEUIModLoader.dom;
    const setClass = dom.setClass;
    const log = me.log;

    /**
     * Settings. Recording is off by default: a profiler that instruments the page the
     * moment the HUD loads would be measuring every session whether asked to or not.
     */
    const options = ACEUIModLoader.settings.define(me.name, [
        {
            key: "toggleKey",
            type: "key",
            label: "Show/hide key",
            value: "F9",
            hint: "Click, then press the key you want"
        },
        {
            key: "autoRecord",
            type: "toggle",
            label: "Record on load",
            value: false,
            hint: "instrumenting costs about 0.26 us per call"
        },
        {
            key: "scale",
            type: "range",
            label: "Panel scale",
            value: SCALE_DEFAULT,
            min: SCALE_MIN,
            max: SCALE_MAX,
            step: SCALE_STEP,
            digits: SCALE_DIGITS
        },
        {
            key: "spikeMs",
            type: "range",
            label: "Stop on a frame over",
            value: 0,
            min: 0,
            max: 100,
            step: 10,
            digits: 0,
            hint: "ms; 0 is off. Stops recording and shows that frame, since you cannot watch this while driving"
        },
        {
            key: "window",
            type: "range",
            label: "Window (frames)",
            value: 300,
            min: 60,
            max: 300,
            step: 60,
            digits: 0
        },
        {
            key: "widgets",
            type: "toggle",
            label: "Profile stock widgets",
            value: false,
            hint: "wraps ~150 stock HUD methods; takes effect on the next REC"
        },
        {
            key: "clock",
            type: "info",
            label: "Clock",
            text: function () {
                return S.CLOCK.name + ", " + S.CLOCK.resolutionMs + " ms steps";
            }
        }
    ]);

    // ---- markup --------------------------------------------------------------------

    const noDrag = function (attrs) {
        const out = attrs || {};

        out[NODRAG_ATTR] = "";

        return out;
    };

    const buttonMarkup = function (act, text) {
        const attrs = noDrag({});

        attrs[ACT_ATTR] = act;

        return el("div", CLASS.btn, attrs) + text + close("div");
    };

    const bandAttrs = function (key) {
        const attrs = {};

        attrs[BAND_ATTR] = key;

        return attrs;
    };

    const legendMarkup = function () {
        return BANDS.map(function (band) {
            return el("div", CLASS.key)
                + el("div", CLASS.swatch, bandAttrs(band.key)) + close("div")
                + band.label
                + close("div");
        }).join("");
    };

    const rowsMarkup = function () {
        const rows = [];
        let i;

        for (i = 0; i < ROWS; i += 1) {
            rows.push(el("div", CLASS.row + " " + CLASS.hidden)
                + el("div", CLASS.bar) + close("div")
                + el("div", CLASS.name) + close("div")
                + el("div", CLASS.calls) + close("div")
                + el("div", CLASS.ms) + close("div")
                + el("div", CLASS.layout) + close("div")
                + el("div", CLASS.share) + close("div")
                + close("div"));
        }

        return rows.join("");
    };

    const markup = function () {
        return el("div", CLASS.header)
            + el("div", CLASS.title) + TITLE_TEXT + close("div")
            + el("div", CLASS.stat) + close("div")
            + el("div", CLASS.tools)
            + buttonMarkup(ACT_RECORD, REC_TEXT)
            + buttonMarkup(ACT_TREE, TREE_TEXT)
            + buttonMarkup(ACT_WORST, WORST_TEXT)
            + buttonMarkup(ACT_LOG, LOG_TEXT)
            + buttonMarkup(ACT_CLEAR, CLEAR_TEXT)
            + buttonMarkup(ACT_CLOSE, CLOSE_TEXT)
            + close("div")
            + close("div")
            + el("div", CLASS.graph)
            + el("div", CLASS.scaleTop) + FULL_MS + " ms" + close("div")
            + el("div", CLASS.scaleMid) + GUIDE_MS + close("div")
            + close("div")
            + el("div", CLASS.legend) + legendMarkup() + close("div")
            + el("div", CLASS.frameLine) + close("div")
            + el("div", CLASS.head)
            + el("div", CLASS.bar) + close("div")
            + el("div", CLASS.name) + "app" + close("div")
            + el("div", CLASS.calls) + "calls/f" + close("div")
            + el("div", CLASS.ms) + "ms/f" + close("div")
            + el("div", CLASS.layout) + "layout" + close("div")
            + el("div", CLASS.share) + "share" + close("div")
            + close("div")
            + el("div", CLASS.scroll)
            + el("div", CLASS.rows) + rowsMarkup() + close("div")
            + el("div", CLASS.scrollbar, noDrag({})) + el("div", CLASS.thumb) + close("div") + close("div")
            + close("div");
    };

    /**
     * The canvas is built here rather than in the markup string: a canvas that arrives
     * through `innerHTML` is not certain to be a working canvas in this engine, and a
     * graph that silently never draws is indistinguishable from one with nothing to show.
     * Created, sized and appended, it either has a 2d context or says so in the log.
     */
    const makeCanvas = function (root) {
        const graph = root.querySelector("." + CLASS.graph);
        const found = root.querySelector("." + CLASS.canvas);

        if (found || !graph) { return found; }

        const canvas = document.createElement("canvas");

        canvas.className = CLASS.canvas;
        canvas.width = GRAPH_W;
        canvas.height = GRAPH_H;
        graph.insertBefore(canvas, graph.firstChild);

        return canvas;
    };

    const create = function (root) {
        root.classList.add(CLASS.root);

        if (!root.querySelector("." + CLASS.rows)) { root.innerHTML = markup(); }

        const canvas = makeCanvas(root);
        const ink = {};

        BANDS.forEach(function (band) { ink[band.key] = band.ink; });
        ink[GUIDE_BAND] = INK_GUIDE;
        ink[SWEEP_BAND] = INK_SWEEP;

        return {
            root: root,
            ink: ink,
            stat: root.querySelector("." + CLASS.stat),
            frameLine: root.querySelector("." + CLASS.frameLine),
            canvas: canvas,
            ctx: canvas && canvas.getContext ? canvas.getContext("2d") : null,
            recordButton: root.querySelector("[" + ACT_ATTR + "=\"" + ACT_RECORD + "\"]"),
            worstButton: root.querySelector("[" + ACT_ATTR + "=\"" + ACT_WORST + "\"]"),
            treeButton: root.querySelector("[" + ACT_ATTR + "=\"" + ACT_TREE + "\"]"),
            mode: MODE_WINDOW,
            body: root.querySelector("." + CLASS.rows),
            track: root.querySelector("." + CLASS.scrollbar),
            thumb: root.querySelector("." + CLASS.thumb),
            rows: toArray(root.querySelectorAll("." + CLASS.row)).map(function (node) {
                return {
                    el: node,
                    bar: node.querySelector("." + CLASS.bar),
                    name: node.querySelector("." + CLASS.name),
                    calls: node.querySelector("." + CLASS.calls),
                    ms: node.querySelector("." + CLASS.ms),
                    layout: node.querySelector("." + CLASS.layout),
                    share: node.querySelector("." + CLASS.share),
                    lastName: "",
                    lastShare: -1
                };
            }),
            scale: SCALE_DEFAULT,
            frames: 0,                  // frames this panel has ticked, for the one-off report
            sweep: 0,                   // the column the oscilloscope writes next
            drawn: 0,
            lastDrawn: null,            // the frame last plotted, so none is plotted twice
            lastRefresh: 0,
            lastStat: "",
            lastFrameText: "",
            scroller: null,
            unbindToggle: null,
            unsubscribeSettings: null,
            bag: null,
            ui: null
        };
    };

    // ---- the graph -----------------------------------------------------------------

    const columnHeight = function (ms) {
        return Math.round(clamp(ms / FULL_MS, 0, 1) * GRAPH_H);
    };

    /**
     * One frame, one pixel column, stacked bottom-up. The few columns ahead of the sweep
     * are wiped so the old trace cannot be mistaken for the new one, as a heart monitor
     * does it.
     */
    /** The 60 fps line, across the full width: a scale to read the columns against. */
    const drawGuide = function (state) {
        const ctx = state.ctx;

        if (!ctx) { return; }

        ctx.fillStyle = state.ink[GUIDE_BAND];
        ctx.fillRect(0, GRAPH_H - columnHeight(GUIDE_MS), GRAPH_W, 1);
    };

    const drawColumn = function (state, frame) {
        const ctx = state.ctx;
        const x = state.sweep;
        const totals = S.totals(frame);
        let y = GRAPH_H;
        let i;

        if (!ctx) { return; }

        ctx.clearRect(x, 0, 1, GRAPH_H);

        for (i = 0; i < BANDS.length; i += 1) {
            const height = columnHeight(totals[BANDS[i].key]);

            if (height > 0) {
                ctx.fillStyle = state.ink[BANDS[i].key];
                ctx.fillRect(x, y - height, 1, height);
                y -= height;
            }
        }

        // the guide belongs on top of the column, not under it
        ctx.fillStyle = state.ink[GUIDE_BAND];
        ctx.fillRect(x, GRAPH_H - columnHeight(GUIDE_MS), 1, 1);
        ctx.clearRect((x + 1) % GRAPH_W, 0, WIPE_W, GRAPH_H);
        ctx.fillRect((x + 1) % GRAPH_W, GRAPH_H - columnHeight(GUIDE_MS), WIPE_W, 1);
        ctx.fillStyle = state.ink[SWEEP_BAND];
        ctx.fillRect((x + 1) % GRAPH_W, 0, 1, GRAPH_H);
        state.sweep = (x + 1) % GRAPH_W;
        state.drawn += 1;
    };

    // ---- the table -----------------------------------------------------------------

    const windowFrames = function () {
        const all = S.frames();
        const wanted = Number(options.window) || S.RING;

        return all.length > wanted ? all.slice(all.length - wanted) : all;
    };

    /** Indenting the tree in the text itself keeps the hot path free of style writes. */
    const repeat = function (text, times) {
        let out = "";
        let i;

        for (i = 0; i < times; i += 1) { out += text; }

        return out;
    };

    const fillRow = function (row, entry) {
        const share = entry ? entry.share : 0;

        setClass(row.el, CLASS.hidden, !entry);

        if (!entry) {
            row.lastName = "";

            return;
        }

        const label = entry.depth ? repeat(INDENT, entry.depth) + entry.name : entry.name;

        if (row.lastName !== label) {
            row.lastName = label;
            row.name.textContent = label;
            row.bar.setAttribute(BAND_ATTR, entry.category);
        }

        row.calls.textContent = entry.callsPerFrame.toFixed(1);
        row.ms.textContent = entry.msPerFrame.toFixed(DECIMALS);
        row.layout.textContent = (entry.layoutPerFrame || 0).toFixed(1);

        if (row.lastShare !== share) {
            row.lastShare = share;
            row.share.textContent = (share * PERCENT).toFixed(SHARE_DECIMALS) + "%";
            row.bar.style.transform = "scaleX(" + clamp(share, 0, 1).toFixed(BAR_DIGITS) + ")";
        }
    };

    /** The frame that took longest in the window: where a spike actually lives. */
    const worstFrame = function () {
        const list = windowFrames();
        let worst = null;
        let i;

        for (i = 0; i < list.length; i += 1) {
            if (!worst || list[i].wallMs > worst.wallMs) { worst = list[i]; }
        }

        return worst;
    };

    /**
     * One frame's samples as table rows, biggest first. Only worth looking at for a spike:
     * at 1 ms of clock resolution, an ordinary frame's rows are mostly zeroes, which is why
     * this is a button rather than the default view.
     */
    const worstRows = function (frame) {
        const rows = [];
        let i;

        if (!frame) { return { wallMs: 0, frames: 0, rows: rows }; }

        for (i = 0; i < frame.count; i += 1) {
            if (frame.parent[i] === -1) {
                rows.push({
                    name: S.state.names[frame.name[i]],
                    category: frame.category[i],
                    callsPerFrame: 1,
                    msPerFrame: frame.totalMs[i],
                    layoutPerFrame: frame.layout[i] || 0,
                    totalMs: frame.totalMs[i],
                    share: frame.wallMs > 0 ? frame.totalMs[i] / frame.wallMs : 0
                });
            }
        }

        rows.push({
            name: "engine (style, layout, paint)",
            category: "other",
            callsPerFrame: 1,
            msPerFrame: S.otherMs(frame),
            layoutPerFrame: 0,
            totalMs: S.otherMs(frame),
            share: frame.wallMs > 0 ? S.otherMs(frame) / frame.wallMs : 0
        });
        rows.sort(function (a, b) { return b.totalMs - a.totalMs; });

        return { wallMs: frame.wallMs, frames: 1, rows: rows, frame: frame };
    };

    /** Rows for the mode on show: the window's averages, its call tree, or one bad frame. */
    const reportFor = function (mode) {
        if (mode === MODE_WORST) { return worstRows(worstFrame()); }

        if (mode === MODE_TREE) { return S.aggregateTree(windowFrames()); }

        return S.aggregate(windowFrames());
    };

    /** The window's costs, which is the reading a 1 ms clock can honestly support. */
    const refreshTable = function (state) {
        const report = reportFor(state.mode);
        let i;

        for (i = 0; i < state.rows.length; i += 1) { fillRow(state.rows[i], report.rows[i]); }

        if (state.scroller) { state.scroller.sync(); }

        return report;
    };

    const statText = function (report, mode) {
        const avgWall = report.frames ? report.wallMs / report.frames : 0;

        if (!report.frames) { return S.recording() ? "recording..." : "not recording"; }

        if (mode === MODE_WORST) {
            return "worst frame " + report.wallMs.toFixed(DECIMALS) + " ms of "
                + windowFrames().length + " frames";
        }

        if (mode === MODE_TREE) {
            return "call tree over " + report.frames + " frames, " + report.rows.length + " nodes";
        }

        return (avgWall > 0 ? (MS_PER_S / avgWall).toFixed(1) : "0") + " fps  "
            + avgWall.toFixed(DECIMALS) + " ms  " + report.frames + " f";
    };

    const frameText = function (frame) {
        if (!frame) { return "no frame yet"; }

        return "frame " + frame.wallMs.toFixed(DECIMALS) + " ms  ~  script "
            + frame.scriptMs.toFixed(DECIMALS) + "  ~  " + frame.count + " samples  ~  "
            + frame.layoutReads + " layout  ~  " + frame.elementsMade + " new"
            + (frame.truncated ? "  ~  truncated" : "");
    };

    // ---- rendering -----------------------------------------------------------------

    const tick = function (state, now) {
        const all = S.frames();
        const frame = all[all.length - 1];

        // once, after the engine has had frames to lay the panel out
        if (state.frames === SURFACE_FRAME) { reportSurface(state); }

        state.frames += 1;

        if (ACEUIModLoader.hudHidden() || !S.recording()) { return; }

        if (frame && frame !== state.lastDrawn) {
            state.lastDrawn = frame;
            ACEUIModLoader.section("draw graph", function () { drawColumn(state, frame); });

            if (caughtSpike(state, frame)) { return; }
        }

        if (now - state.lastRefresh < REFRESH_MS) { return; }

        state.lastRefresh = now;

        const report = ACEUIModLoader.section("refresh table", function () { return refreshTable(state); });
        const stat = statText(report, state.mode);
        const line = frameText(frame);

        if (stat !== state.lastStat) {
            state.lastStat = stat;
            state.stat.textContent = stat;
        }

        if (line !== state.lastFrameText) {
            state.lastFrameText = line;
            state.frameLine.textContent = line;
        }
    };

    /**
     * A frame over the threshold stops the recording and shows that frame. Pausing is the
     * point: the ring holds about five seconds, so without it the evidence is overwritten
     * before you have parked.
     */
    const caughtSpike = function (state, frame) {
        const limit = Number(options.spikeMs) || 0;

        if (limit <= 0 || frame.wallMs < limit) { return false; }

        log("frame of " + frame.wallMs.toFixed(DECIMALS) + " ms is over the "
            + limit + " ms threshold: recording stopped, showing that frame");
        setRecording(state, false);
        setMode(state, MODE_WORST);

        return true;
    };

    // ---- controls ------------------------------------------------------------------

    const setMode = function (state, mode) {
        state.mode = mode;
        setClass(state.worstButton, CLASS.on, mode === MODE_WORST);
        setClass(state.treeButton, CLASS.on, mode === MODE_TREE);

        const report = refreshTable(state);

        state.lastStat = statText(report, mode);
        state.stat.textContent = state.lastStat;

        if (mode === MODE_WORST && report.frame) {
            state.lastFrameText = frameText(report.frame);
            state.frameLine.textContent = state.lastFrameText;
        }

        return mode;
    };

    /**
     * The table, into the game log. Reading a panel while driving is hopeless, and the log
     * is where this project does its debugging.
     */
    const dump = function (state) {
        const report = reportFor(state.mode);
        const avgWall = report.frames ? report.wallMs / report.frames : 0;

        log("---- " + state.mode + ": " + report.frames + " frame(s), " + avgWall.toFixed(DECIMALS)
            + " ms/frame, clock " + S.CLOCK.name + " (" + S.CLOCK.resolutionMs + " ms steps)"
            + (S.widgets().length ? ", " + S.widgets().length + " stock widget methods wrapped" : ""));
        log("     share    ms/f  calls/f  layout/f   app");
        report.rows.slice(0, LOG_ROWS).forEach(function (row) {
            log("     " + (row.share * PERCENT).toFixed(SHARE_DECIMALS) + "%   "
                + row.msPerFrame.toFixed(DECIMALS) + "     "
                + row.callsPerFrame.toFixed(1) + "      "
                + (row.layoutPerFrame || 0).toFixed(1) + "      ["
                + row.category + "] " + (row.depth ? repeat(INDENT, row.depth) : "") + row.name);
        });
        log("---- end (" + report.rows.length + " rows, " + LOG_ROWS + " shown)");

        return report;
    };

    const setRecording = function (state, on) {
        if (on) {
            S.start({ widgets: Boolean(options.widgets) });
            log("recording started: animation frames, timers, DOM events, engine events and"
                + " layout reads are instrumented; mods' own named sections are live"
                + (S.widgets().length ? "; " + S.widgets().length + " stock widget methods wrapped" : "")
                + " (clock " + S.CLOCK.name + ", " + S.CLOCK.resolutionMs + " ms steps, window "
                + options.window + " frames)");
        } else {
            S.pause();

            const kept = refreshTable(state);

            log("paused: " + S.frames().length + " frames kept, "
                + (kept.frames ? (kept.wallMs / kept.frames).toFixed(DECIMALS) : "0")
                + " ms/frame average over the window. Press LOG for the table.");
        }

        setClass(state.recordButton, CLASS.on, on);

        return on;
    };

    const clearAll = function (state) {
        S.clear();

        if (state.ctx) {
            state.ctx.clearRect(0, 0, GRAPH_W, GRAPH_H);
            drawGuide(state);
        }

        state.sweep = 0;
        state.drawn = 0;
        state.lastDrawn = null;
        state.lastStat = "";
        state.lastFrameText = "";
        state.mode = MODE_WINDOW;
        setClass(state.worstButton, CLASS.on, false);
        refreshTable(state);
    };

    /** The root's font-size in rem; everything inside is em, so one value sizes it all. */
    const setScale = function (state, scale) {
        const value = Number(clamp(scale, SCALE_MIN, SCALE_MAX).toFixed(SCALE_DIGITS));

        state.scale = value;
        state.root.style.fontSize = value + "rem";

        if (state.scroller) { state.scroller.invalidate(); }

        return value;
    };

    const setOpen = function (state, open) {
        setClass(state.root, CLASS.hidden, !open);
        me.remember("open", open);

        return open;
    };

    const onClick = function (state, e) {
        const node = ACEUIModLoader.closestWithAttribute(e.target, ACT_ATTR, state.root);
        const act = node ? node.getAttribute(ACT_ATTR) : "";

        if (act === ACT_RECORD) { setRecording(state, !S.recording()); }

        if (act === ACT_TREE) { setMode(state, state.mode === MODE_TREE ? MODE_WINDOW : MODE_TREE); }

        if (act === ACT_WORST) { setMode(state, state.mode === MODE_WORST ? MODE_WINDOW : MODE_WORST); }

        if (act === ACT_LOG) { dump(state); }

        if (act === ACT_CLEAR) { clearAll(state); }

        if (act === ACT_CLOSE) { setOpen(state, false); }
    };

    // ---- lifecycle -----------------------------------------------------------------

    const attach = function (root) {
        const state = create(root);

        state.bag = dom.listeners();
        state.bag.on(root, "click", function (e) { onClick(state, e); });
        state.scroller = ACEUIModLoader.scroll.attach({
            body: state.body,
            track: state.track,
            thumb: state.thumb,
            nofitClass: CLASS.nofit,
            draggingClass: ACEUIModLoader.panel.DRAGGING_CLASS,
            log: log
        });
        state.unbindToggle = keys.bind(function () { return options.toggleKey; }, function (e) {
            setOpen(state, state.root.classList.contains(CLASS.hidden));
            e.preventDefault();
        });
        state.unsubscribeSettings = ACEUIModLoader.settings.onChange(me.name, function (key, value) {
            if (key === "window") { refreshTable(state); }

            if (key === "scale" && value !== state.scale) { setScale(state, value); }
        });
        setScale(state, options.scale);
        drawGuide(state);

        // the stylesheet's own background did not paint in game (the scene showed through the
        // table), while the app drawer -- which sets its background inline -- is solid. Until
        // that is understood, say it both ways; the stylesheet keeps it for the preview.
        root.style.background = PANEL_BG;
        setOpen(state, Boolean(me.recall("open", true)));

        if (options.autoRecord) { setRecording(state, true); }

        state.ui = me.panel(root, function (now) { tick(state, now); });
        log("panel attached, clock " + S.CLOCK.name + " (" + S.CLOCK.resolutionMs + " ms steps)");

        return state;
    };

    /**
     * What the panel actually got from the engine. Measured on a later frame, not at
     * attach: the first reading said "canvas on screen 0x0", which was my measurement,
     * not the engine's -- nothing has been laid out yet when a mod's script runs, and a
     * client* read here does not force layout the way a browser's does.
     *
     * `getComputedStyle` is no use for the other half of the question. In this engine it
     * reports inline styles and initial values, not the cascade: the first run had it
     * claiming `rgba(0, 0, 0, 0)` for a header that is plainly painted `#1c1e1f` on
     * screen, and `font-size: 1rem` -- the inline value, where a browser would resolve
     * px. So whether the stylesheet applied is answered by measuring something only the
     * stylesheet can cause: the panel is 30em wide, which nothing else sets.
     */
    const reportSurface = function (state) {
        const canvas = state.canvas;
        const graph = state.root.querySelector("." + CLASS.graph);
        const rootWidth = state.root.clientWidth;
        const expected = Math.round(PANEL_EM * parseFloat(state.root.style.fontSize || "1") * REM_PX);

        log("surface: canvas buffer " + (canvas ? canvas.width + "x" + canvas.height : "MISSING")
            + ", 2d context " + (state.ctx ? "ok" : "NOT AVAILABLE -- the graph cannot draw")
            + ", canvas on screen " + (canvas ? canvas.clientWidth + "x" + canvas.clientHeight : "?")
            + ", graph box " + (graph ? graph.clientWidth + "x" + graph.clientHeight : "?"));
        log("surface: panel " + rootWidth + "x" + state.root.clientHeight + " on screen; the stylesheet asks"
            + " for about " + expected + " wide, so profiler.css "
            + (rootWidth > expected / 2 ? "applied" : "did NOT apply -- the panel is unstyled")
            + " (rows " + state.rows.length + ", scroll box "
            + (state.body ? state.body.clientWidth + "x" + state.body.clientHeight : "?") + ")");
    };

    const detach = function (state) {
        state.ui.stop();

        if (state.unbindToggle) {
            state.unbindToggle();
            state.unbindToggle = null;
        }

        if (state.unsubscribeSettings) {
            state.unsubscribeSettings();
            state.unsubscribeSettings = null;
        }

        if (state.scroller) { state.scroller.detach(); }

        if (state.bag) {
            state.bag.off();
            state.bag = null;
        }

        // never leave the page instrumented by a mod that is no longer running
        S.stop();
    };

    return {
        CLASS: CLASS,
        BANDS: BANDS,
        GRAPH_W: GRAPH_W,
        GRAPH_H: GRAPH_H,
        ROWS: ROWS,
        create: create,
        tick: tick,
        refreshTable: refreshTable,
        setRecording: setRecording,
        setMode: setMode,
        reportFor: reportFor,
        MODE_TREE: MODE_TREE,
        caughtSpike: caughtSpike,
        setScale: setScale,
        SCALE_MIN: SCALE_MIN,
        SCALE_MAX: SCALE_MAX,
        worstFrame: worstFrame,
        dump: dump,
        MODE_WINDOW: MODE_WINDOW,
        MODE_WORST: MODE_WORST,
        clearAll: clearAll,
        setOpen: setOpen,
        drawColumn: drawColumn,
        statText: statText,
        attach: attach,
        detach: detach
    };
}());

/*
 * Classic scripts: a top-level `const` is a page-wide binding but not a window property,
 * so anything reaching for `window.ACEUIProfiler` -- a dev-console snippet, another
 * mod -- would find nothing. The library's core does the same for the same reason.
 */
window.ACEUIProfiler = ACEUIProfiler;

/* Attach to #profiler: the loader creates it in game, the preview page carries it. */
ACEUIModLoader.mod("profiler").mount(ACEUIProfiler.attach, ACEUIProfiler.detach);
