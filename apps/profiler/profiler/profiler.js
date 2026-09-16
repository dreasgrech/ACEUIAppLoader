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

    /** The mounted panel's handle; see `panel()` at the bottom of this file. */
    let live = null;

    /** Class names shared with profiler.css. */
    const CLASS = {
        root: "ace-profiler",
        ground: "pr-ground",
        header: "pr-header",
        title: "pr-title",
        stat: "pr-stat",
        tools: "pr-tools",
        btn: "pr-btn",
        on: "on",
        modes: "pr-modes",
        mode: "pr-mode",
        rec: "pr-rec",
        glyph: "pr-glyph",
        closeBtn: "pr-close",
        off: "off",
        graph: "pr-graph",
        canvas: "pr-canvas",
        scaleTop: "pr-scale-top",
        scale: "pr-scale",
        tick: "pr-tick",
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
        self: "pr-self",
        layout: "pr-layout",
        sorted: "sorted",
        asc: "asc",
        dot: "pr-dot",
        sep: "pr-sep",
        arrow: "pr-arrow",
        alt: "alt",
        share: "pr-share",
        bar: "pr-bar",
        hidden: "pr-hidden",
        scroll: "pr-scroll",
        scrollbar: "pr-scrollbar",
        thumb: "pr-thumb",
        nofit: "pr-nofit"
    };

    const ACT_ATTR = "data-act";
    const ACT_RECORD = "record";
    const ACT_MODE = "mode";
    const ACT_LOG = "log";
    const ACT_CLEAR = "clear";
    const ACT_CLOSE = "close";
    const ACT_BAND = "band";
    const ACT_SORT = "sort";
    const SORT_ATTR = "data-sort";

    /**
     * The table's columns. `key` is what a row carries, `sort` what the header sorts by:
     * they differ for the name column, which sorts alphabetically rather than by a number.
     */
    const COLUMNS = [
        { key: "calls", label: "Calls", field: "callsPerFrame" },
        { key: "ms", label: "Total", field: "msPerFrame" },
        { key: "self", label: "Self", field: "selfPerFrame" },
        { key: "layout", label: "Layout", field: "layoutPerFrame" },
        { key: "share", label: "Share", field: "share" }
    ];
    const ACT_SMALLER = "smaller";
    const ACT_LARGER = "larger";

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
    const WIPE_W = 3;
    /**
     * Full scale, in steps. The smallest one the window fits in is used, so a quiet HUD fills
     * the graph with its 17 ms frames instead of drawing them all at half height, and a HUD
     * in trouble still shows the spike rather than clipping it at the top.
     *
     * Fixed steps rather than a scale that follows the peak exactly: two pictures of the same
     * HUD have to be comparable, and a graph whose height means something different every
     * frame cannot tell you that this frame was worse than the last.
     */
    const SCALES = [
        { key: "0.5", ms: 0.5 },
        { key: "1", ms: 1 },
        { key: "2", ms: 2 },
        { key: "4", ms: 4 },
        { key: "8.5", ms: 8.5 },
        { key: "17", ms: 17.1 },
        { key: "33", ms: 33 },
        { key: "66", ms: 66 },
        { key: "133", ms: 133 }
    ];
    /** Where a fresh panel starts: one frame of the HUD page, full height. */
    const SCALE_START = 5;
    const FULL_MS = SCALES[SCALE_START].ms;
    const FULL_ATTR = "data-full";
    const TICK_ATTR = "data-ms";
    /** Headroom over the window's peak, so the tallest column is not flush with the ceiling. */
    const SCALE_HEADROOM = 1.12;
    /**
     * How fast the remembered peak forgets, per frame. A spike should hold the scale open long
     * enough to look at -- this halves in about 140 frames, some two and a half seconds.
     */
    const PEAK_DECAY = 0.995;
    /**
     * Where to rule the graph. 8.5 ms is one of the game's frames at 117 fps; 17.1 ms is one
     * of the HUD page's, which the engine advances at exactly half the game's rate. A column
     * taller than the upper line took longer than the page's whole frame.
     */
    const GUIDES = [
        { ms: 8.5, label: "8.5", band: "guideDim" },
        { ms: 17.1, label: "17.1", band: "guide" }
    ];

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
    const VALUE_ATTR = "data-value";
    /** How deep a row sits in the tree; the stylesheet turns it into an indent. */
    const DEPTH_ATTR = "data-depth";
    const MAX_DEPTH = 4;
    const GUIDE_BAND = "guide";
    const GUIDE_DIM_BAND = "guideDim";
    const SWEEP_BAND = "sweep";
    const INK_GUIDE = "rgba(255, 255, 255, 0.38)";
    const INK_GUIDE_DIM = "rgba(255, 255, 255, 0.16)";
    const INK_SWEEP = "rgba(255, 255, 255, 0.5)";
    /** The graph's own ground. Opaque, because it is painted over rather than erased. */
    const INK_GROUND = "#0c0e10";

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
    const LOG_TEXT = "LOG";
    const CLEAR_TEXT = "CLEAR";
    const CLOSE_TEXT = "\u00d7";
    const SMALLER_TEXT = "\u2212";
    const LARGER_TEXT = "+";
    const LOG_ROWS = 15;
    /** The three views are one choice, so they are one control. */
    const MODES = [
        { key: "window", label: "WINDOW" },
        { key: "tree", label: "TREE" },
        { key: "worst", label: "WORST" }
    ];

    const el = ACEUIModLoader.el;
    const close = ACEUIModLoader.close;
    const toArray = ACEUIModLoader.toArray;
    const clamp = ACEUIModLoader.clamp;
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
        me.scaleSpec({ min: SCALE_MIN, max: SCALE_MAX, step: SCALE_STEP }),
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

    const buttonMarkup = function (act, text, extraClass, value) {
        const attrs = noDrag({});

        attrs[ACT_ATTR] = act;

        if (value !== undefined) { attrs[VALUE_ATTR] = value; }

        return el("div", CLASS.btn + (extraClass ? " " + extraClass : ""), attrs) + text + close("div");
    };

    /**
     * Record, with the dot that says what it is. The dot is an element rather than a
     * character for the same reason the sort arrow is: a glyph is at the mercy of the font.
     */
    const recMarkup = function () {
        const attrs = noDrag({});

        attrs[ACT_ATTR] = ACT_RECORD;

        return el("div", CLASS.btn + " " + CLASS.rec, attrs)
            + el("span", CLASS.dot) + close("span")
            + REC_TEXT
            + close("div");
    };

    /** The view picker: one of three, so the pressed one stays pressed. */
    const modesMarkup = function () {
        return el("div", CLASS.modes) + MODES.map(function (mode) {
            return buttonMarkup(ACT_MODE, mode.label, CLASS.mode, mode.key);
        }).join("") + close("div");
    };

    const bandAttrs = function (key) {
        const attrs = {};

        attrs[BAND_ATTR] = key;

        return attrs;
    };

    /**
     * The legend is also the switch: on a real HUD the engine's slice is most of the frame,
     * so being able to drop it out of the graph is the difference between a grey wall and a
     * picture of what the scripts did.
     */
    const legendMarkup = function () {
        return BANDS.map(function (band) {
            const attrs = noDrag(bandAttrs(band.key));

            attrs[ACT_ATTR] = ACT_BAND;
            attrs[VALUE_ATTR] = band.key;

            return el("div", CLASS.key, attrs)
                + el("div", CLASS.swatch, bandAttrs(band.key)) + close("div")
                + band.label
                + close("div");
        }).join("");
    };

    /** The graph's box says which scale it is drawn at; the stylesheet reads it. */
    const graphAttrs = function () {
        const attrs = {};

        attrs[FULL_ATTR] = SCALES[SCALE_START].key;

        return attrs;
    };

    /**
     * A column header that sorts the table when clicked. The arrow is its own element so
     * that `setSort` can move it by writing one string, rather than rebuilding the header.
     */
    const headCell = function (className, label, key) {
        const attrs = noDrag({});

        attrs[ACT_ATTR] = ACT_SORT;
        attrs[SORT_ATTR] = key;

        return el("div", className, attrs)
            + label
            + el("span", CLASS.arrow) + close("span")
            + close("div");
    };

    /**
     * A label per guide. Where it sits depends on the scale in force, which changes, and a
     * mod may not write styles in its per-frame path -- so the label says which line it is
     * and the graph says which scale is in force, and the stylesheet does the positioning.
     */
    const guidesMarkup = function () {
        return GUIDES.map(function (guide) {
            const attrs = {};

            attrs[TICK_ATTR] = guide.label;

            return el("div", CLASS.tick, attrs) + guide.label + close("div");
        }).join("");
    };

    const rowsMarkup = function () {
        const rows = [];
        let i;

        for (i = 0; i < ROWS; i += 1) {
            rows.push(el("div", CLASS.row + " " + CLASS.hidden + (i % 2 ? " " + CLASS.alt : ""))
                + el("div", CLASS.bar) + close("div")
                + el("div", CLASS.name) + close("div")
                + el("div", CLASS.calls) + close("div")
                + el("div", CLASS.ms) + close("div")
                + el("div", CLASS.self) + close("div")
                + el("div", CLASS.layout) + close("div")
                + el("div", CLASS.share) + close("div")
                + close("div"));
        }

        return rows.join("");
    };

    const markup = function () {
        // the panel's background lives on this, not on the root: the root's own background
        // does not paint in game, from the stylesheet or inline, while its children's do
        return el("div", CLASS.ground) + close("div")
            + el("div", CLASS.header)
            + el("div", CLASS.title) + TITLE_TEXT + close("div")
            + el("div", CLASS.tools)
            + recMarkup()
            + modesMarkup()
            + buttonMarkup(ACT_LOG, LOG_TEXT)
            + buttonMarkup(ACT_CLEAR, CLEAR_TEXT)
            + el("div", CLASS.sep) + close("div")
            + buttonMarkup(ACT_SMALLER, SMALLER_TEXT, CLASS.glyph)
            + buttonMarkup(ACT_LARGER, LARGER_TEXT, CLASS.glyph)
            + buttonMarkup(ACT_CLOSE, CLOSE_TEXT, CLASS.glyph + " " + CLASS.closeBtn)
            + close("div")
            + close("div")
            + el("div", CLASS.graph, graphAttrs())
            + el("div", CLASS.scaleTop) + FULL_MS + " ms" + close("div")
            + el("div", CLASS.scale) + guidesMarkup() + close("div")
            + close("div")
            + el("div", CLASS.legend) + legendMarkup() + close("div")
            + el("div", CLASS.stat) + close("div")
            + el("div", CLASS.frameLine) + close("div")
            + el("div", CLASS.head)
            + el("div", CLASS.bar) + close("div")
            + headCell(CLASS.name, "App", "name")
            + COLUMNS.map(function (column) {
                return headCell(CLASS[column.key], column.label, column.key);
            }).join("")
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

    /** Remembered band switches, defaulting to all on. */
    const bandsOn = function () {
        const stored = me.recall("bands", null);
        const on = {};

        BANDS.forEach(function (band) {
            on[band.key] = !stored || stored[band.key] !== false;
        });

        return on;
    };

    const create = function (root) {
        root.classList.add(CLASS.root);

        if (!root.querySelector("." + CLASS.rows)) { root.innerHTML = markup(); }

        const canvas = makeCanvas(root);
        const ink = {};

        BANDS.forEach(function (band) { ink[band.key] = band.ink; });
        ink[GUIDE_BAND] = INK_GUIDE;
        ink[GUIDE_DIM_BAND] = INK_GUIDE_DIM;
        ink[SWEEP_BAND] = INK_SWEEP;

        return {
            root: root,
            ink: ink,
            stat: root.querySelector("." + CLASS.stat),
            frameLine: root.querySelector("." + CLASS.frameLine),
            canvas: canvas,
            ctx: canvas && canvas.getContext ? canvas.getContext("2d") : null,
            recordButton: root.querySelector("[" + ACT_ATTR + "=\"" + ACT_RECORD + "\"]"),
            modeButtons: toArray(root.querySelectorAll("." + CLASS.mode)),
            mode: MODE_WINDOW,
            fullMs: FULL_MS,            // the graph's full height in ms; see rescale
            fullKey: SCALES[SCALE_START].key,
            peakMs: 0,                  // the window's worst frame, forgotten slowly
            graphEl: root.querySelector("." + CLASS.graph),
            scaleTop: root.querySelector("." + CLASS.scaleTop),
            sort: { key: "ms", dir: -1 },
            headCells: toArray(root.querySelectorAll("." + CLASS.head + " [" + SORT_ATTR + "]")),
            scaler: null,               // me.scale handle: the loader owns panel scaling
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
                    self: node.querySelector("." + CLASS.self),
                    layout: node.querySelector("." + CLASS.layout),
                    share: node.querySelector("." + CLASS.share),
                    lastName: "",
                    lastDepth: -1,
                    lastShare: -1
                };
            }),
            scale: SCALE_DEFAULT,
            bands: bandsOn(),           // which categories the graph and table show
            graphW: GRAPH_W,            // the canvas buffer, until layout says how big it really is
            graphH: GRAPH_H,
            frames: 0,                  // frames this panel has ticked, for the one-off report
            sweep: 0,                   // the column the oscilloscope writes next
            drawn: 0,
            lastDrawn: null,            // the frame last plotted, so none is plotted twice
            lastRefresh: 0,
            lastStat: "",
            lastFrameText: "",
            scroller: null,
            unsubscribeSettings: null,
            bag: null,
            ui: null
        };
    };

    // ---- the graph -----------------------------------------------------------------

    const columnHeight = function (state, ms) {
        return Math.round(clamp(ms / state.fullMs, 0, 1) * state.graphH);
    };

    /** The smallest step that holds this peak, with a little air above it. */
    const scaleFor = function (peakMs) {
        const wanted = peakMs * SCALE_HEADROOM;
        let i;

        for (i = 0; i < SCALES.length; i += 1) {
            if (SCALES[i].ms >= wanted) { return SCALES[i]; }
        }

        return SCALES[SCALES.length - 1];
    };

    /** The whole canvas, ground and guide. Used at attach, on CLEAR and after a resize. */
    const groundFill = function (state) {
        const ctx = state.ctx;

        if (!ctx) { return; }

        ctx.fillStyle = INK_GROUND;
        ctx.fillRect(0, 0, state.graphW, state.graphH);
        GUIDES.forEach(function (guide) {
            // a guide at or above full scale is the ceiling, which the top label already says
            if (guide.ms >= state.fullMs) { return; }

            ctx.fillStyle = state.ink[guide.band];
            ctx.fillRect(0, state.graphH - columnHeight(state, guide.ms), state.graphW, 1);
        });
    };

    /**
     * The engine lays the canvas out at whatever size the panel's width gives it, which is
     * not the buffer's size: 300x64 stretched to 623x107 in game, smearing every column.
     * Sizing the buffer to the box makes a column one pixel again. It can only be done once
     * layout has happened, which is why it waits for a frame.
     */
    const fitCanvas = function (state) {
        const canvas = state.canvas;
        const width = canvas ? canvas.clientWidth : 0;
        const height = canvas ? canvas.clientHeight : 0;

        if (!canvas || width <= 0 || height <= 0) { return false; }

        if (canvas.width === width && canvas.height === height) { return false; }

        canvas.width = width;
        canvas.height = height;
        state.graphW = width;
        state.graphH = height;
        state.sweep = 0;
        groundFill(state);

        return true;
    };

    /**
     * One frame, one pixel column, stacked bottom-up. The few columns ahead of the sweep
     * are wiped so the old trace cannot be mistaken for the new one, as a heart monitor
     * does it.
     */
    /**
     * Change full scale and redraw what is on screen at the new one. Half a graph drawn at
     * one scale and half at another would be a lie about which frame was worse, so the ring
     * is replayed -- a few hundred fills, on a change that happens seconds apart at most.
     */
    const rescale = function (state, scale) {
        const all = S.frames();
        const start = Math.max(0, all.length - state.graphW);
        let i;

        state.fullMs = scale.ms;
        state.fullKey = scale.key;
        state.graphEl.setAttribute(FULL_ATTR, scale.key);
        state.scaleTop.textContent = scale.ms + " ms";
        state.sweep = 0;
        groundFill(state);

        for (i = start; i < all.length; i += 1) { drawColumn(state, all[i], S.totals(all[i])); }

        log("graph scale now " + scale.ms + " ms full height ("
            + (all.length - start) + " frames redrawn)");
    };

    /** What this frame puts on the graph: the bands that are switched on, and no others. */
    const shownMs = function (state, totals) {
        let sum = 0;
        let i;

        for (i = 0; i < BANDS.length; i += 1) {
            if (state.bands[BANDS[i].key]) { sum += totals[BANDS[i].key]; }
        }

        return sum;
    };

    /**
     * Follow the worst of what is being drawn, forgetting it slowly. The peak is of the
     * *shown* bands rather than the whole frame: switching the engine off is a request to
     * see what is left, and scaling to a frame time that is no longer on the graph would
     * answer it with a flat line along the bottom.
     *
     * Without the decay one spike would hold the scale open for as long as the panel stayed
     * up; without the peak the scale would flap every time a frame crossed a step.
     */
    const trackScale = function (state, frame, totals) {
        const shown = shownMs(state, totals);
        const peak = state.peakMs * PEAK_DECAY;
        const scale = scaleFor(shown > peak ? shown : peak);

        state.peakMs = shown > peak ? shown : peak;

        if (scale.key === state.fullKey) { return false; }

        rescale(state, scale);

        // the replay ends with the frame the caller was about to draw, so it is already on
        // screen; drawing it again would leave the sweep a column ahead of the truth
        return true;
    };

    /**
     * Re-pick the scale from the history on screen and redraw it. This is what a band switch
     * needs: the columns already drawn were drawn with that band in them, so leaving them
     * alone would make half the graph mean one thing and half another.
     */
    const refit = function (state) {
        const all = S.frames();
        const start = Math.max(0, all.length - state.graphW);
        let peak = 0;
        let i;

        for (i = start; i < all.length; i += 1) {
            const ms = shownMs(state, S.totals(all[i]));

            if (ms > peak) { peak = ms; }
        }

        state.peakMs = peak;
        rescale(state, scaleFor(peak));
    };

    const drawColumn = function (state, frame, totals) {
        const ctx = state.ctx;
        const x = state.sweep;
        const ahead = (x + 1) % state.graphW;
        let y = state.graphH;
        let i;

        if (!ctx) { return; }

        // an opaque ground rather than clearRect: a wipe that quietly does nothing turns
        // this into an accumulation of 22%-alpha white, which is what the graph became
        ctx.fillStyle = INK_GROUND;
        ctx.fillRect(x, 0, 1, state.graphH);

        for (i = 0; i < BANDS.length; i += 1) {
            const height = state.bands[BANDS[i].key] ? columnHeight(state, totals[BANDS[i].key]) : 0;

            if (height > 0) {
                ctx.fillStyle = state.ink[BANDS[i].key];
                ctx.fillRect(x, y - height, 1, height);
                y -= height;
            }
        }

        for (i = 0; i < GUIDES.length; i += 1) {
            if (GUIDES[i].ms < state.fullMs) {
                ctx.fillStyle = state.ink[GUIDES[i].band];
                ctx.fillRect(x, state.graphH - columnHeight(state, GUIDES[i].ms), 1, 1);
            }
        }

        ctx.fillStyle = INK_GROUND;
        ctx.fillRect(ahead, 0, WIPE_W, state.graphH);
        ctx.fillStyle = state.ink[SWEEP_BAND];
        ctx.fillRect(ahead, 0, 1, state.graphH);
        state.sweep = ahead;
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

        const depth = Math.min(entry.depth || 0, MAX_DEPTH);

        if (row.lastName !== entry.name || row.lastDepth !== depth) {
            row.lastName = entry.name;
            row.lastDepth = depth;
            row.name.textContent = entry.name;
            row.bar.setAttribute(BAND_ATTR, entry.category);
            // an attribute, not padding written from here: the stylesheet owns the indent,
            // and leading spaces in text are collapsed away by the layout
            row.el.setAttribute(DEPTH_ATTR, depth);
        }

        row.calls.textContent = entry.callsPerFrame.toFixed(1);
        row.ms.textContent = entry.msPerFrame.toFixed(DECIMALS);
        row.self.textContent = (entry.selfPerFrame || 0).toFixed(DECIMALS);
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
                    selfPerFrame: frame.selfMs[i],
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
            selfPerFrame: S.otherMs(frame),
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

    /** Order rows by the column the header last asked for. */
    const comparator = function (sort) {
        const column = COLUMNS.filter(function (entry) { return entry.key === sort.key; })[0];

        if (!column) {
            return function (a, b) {
                return sort.dir * (a.name < b.name ? -1 : (a.name > b.name ? 1 : 0));
            };
        }

        return function (a, b) {
            return sort.dir * ((a[column.field] || 0) - (b[column.field] || 0));
        };
    };

    /**
     * The tree, flattened depth-first, sorting each parent's children by the chosen column.
     * Sorting the flat list instead would scatter children away from their parents, which
     * is the one thing the tree view is for.
     */
    const flattenTree = function (roots, cmp, bands, out, depth) {
        const list = roots.filter(function (node) { return bands[node.category] !== false; }).slice();

        list.sort(cmp);
        list.forEach(function (node) {
            node.depth = depth;
            out.push(node);
            flattenTree(node.children, cmp, bands, out, depth + 1);
        });

        return out;
    };

    /** The window's costs, which is the reading a 1 ms clock can honestly support. */
    const refreshTable = function (state) {
        const report = reportFor(state.mode);
        const cmp = comparator(state.sort);
        const shown = state.mode === MODE_TREE && report.roots
            ? flattenTree(report.roots, cmp, state.bands, [], 0)
            : report.rows.filter(function (row) {
                return state.bands[row.category] !== false;
            }).sort(cmp);
        let i;

        for (i = 0; i < state.rows.length; i += 1) { fillRow(state.rows[i], shown[i]); }

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
        if (state.frames === SURFACE_FRAME) {
            fitCanvas(state);
            reportSurface(state);
        }

        state.frames += 1;

        if (ACEUIModLoader.hudHidden() || !S.recording()) { return; }

        if (frame && frame !== state.lastDrawn) {
            state.lastDrawn = frame;
            ACEUIModLoader.section("draw graph", function () {
                const totals = S.totals(frame);

                if (!trackScale(state, frame, totals)) { drawColumn(state, frame, totals); }
            });

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
        state.modeButtons.forEach(function (node) {
            setClass(node, CLASS.on, node.getAttribute(VALUE_ATTR) === mode);
        });

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
        log("     share   total    self  calls/f  layout/f   app");
        report.rows.slice(0, LOG_ROWS).forEach(function (row) {
            log("     " + (row.share * PERCENT).toFixed(SHARE_DECIMALS) + "%   "
                + row.msPerFrame.toFixed(DECIMALS) + "    "
                + (row.selfPerFrame || 0).toFixed(DECIMALS) + "     "
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

        state.sweep = 0;
        state.drawn = 0;
        state.lastDrawn = null;
        state.lastStat = "";
        state.lastFrameText = "";
        state.peakMs = 0;
        // an empty graph kept at the scale of a spike that is no longer in it would draw
        // the next quiet minute along the bottom; rescale paints the ground as it goes
        rescale(state, SCALES[SCALE_START]);
        setMode(state, MODE_WINDOW);
    };

    /**
     * Closing is switching the app off, not hiding its root: a hidden panel that is still
     * running leaves the drawer saying the profiler is on, and the drawer is where you would
     * go to get it back. `me.show` is the same call the drawer's own switch makes.
     */
    const setOpen = function (state, open) {
        return me.show(open);
    };

    /** Show the sort that is in force and re-order the table under it. */
    const markSort = function (state) {
        state.headCells.forEach(function (cell) {
            const active = cell.getAttribute(SORT_ATTR) === state.sort.key;

            // a class rather than a glyph: the arrow is drawn out of borders, because the
            // font put a typed one on its own line and knocked the column out of alignment
            setClass(cell, CLASS.sorted, active);
            setClass(cell, CLASS.asc, active && state.sort.dir > 0);
        });
        refreshTable(state);

        return state.sort;
    };

    /** Sort by a column; clicking the one already sorted turns it round. */
    const setSort = function (state, key) {
        state.sort = {
            key: key,
            dir: state.sort.key === key ? -state.sort.dir : -1
        };

        return markSort(state);
    };

    /** Turn a category off, in the graph and the table at once, and remember it. */
    const setBand = function (state, key, on) {
        const node = state.root.querySelector("." + CLASS.key + "[" + VALUE_ATTR + "=\"" + key + "\"]");

        state.bands[key] = Boolean(on);
        setClass(node, CLASS.off, !on);
        me.remember("bands", state.bands);
        refreshTable(state);
        refit(state);
        log((on ? "showing " : "hiding ") + key + ", graph now "
            + state.fullMs + " ms full height");

        return state.bands[key];
    };

    const onClick = function (state, e) {
        const node = ACEUIModLoader.closestWithAttribute(e.target, ACT_ATTR, state.root);
        const act = node ? node.getAttribute(ACT_ATTR) : "";
        const value = node ? node.getAttribute(VALUE_ATTR) : "";

        if (act === ACT_RECORD) { setRecording(state, !S.recording()); }

        if (act === ACT_MODE) { setMode(state, value); }

        if (act === ACT_BAND) { setBand(state, value, !state.bands[value]); }

        if (act === ACT_SORT) { setSort(state, node.getAttribute(SORT_ATTR)); }

        if (act === ACT_LOG) { dump(state); }

        if (act === ACT_CLEAR) { clearAll(state); }

        if (act === ACT_SMALLER) { state.scaler.nudge(-1); }

        if (act === ACT_LARGER) { state.scaler.nudge(1); }

        if (act === ACT_CLOSE) { setOpen(state, false); }
    };

    // ---- lifecycle -----------------------------------------------------------------

    /**
     * The live panel, as something to hold. Every verb here is the one behind the matching
     * button, so a snippet and a click cannot drift apart, and the getters return the state
     * they just set: `panel().record(true)` answers with whether it is recording.
     */
    const handleFor = function (state) {
        return {
            /** Start or stop measuring; with no argument, say whether it is on. */
            record: function (on) {
                if (on !== undefined) { setRecording(state, Boolean(on)); }

                return S.recording();
            },
            /** WINDOW, TREE or WORST -- see `ACEUIProfiler.MODES`. */
            mode: function (name) {
                if (name !== undefined) { setMode(state, name); }

                return state.mode;
            },
            /** Show or hide one category, in the graph and the table together. */
            band: function (key, on) {
                if (on !== undefined) { setBand(state, key, Boolean(on)); }

                return state.bands[key] !== false;
            },
            /** Order the table by a column; the same key again turns it round. */
            sort: function (key) {
                if (key !== undefined) { setSort(state, key); }

                return state.sort;
            },
            /** Panel size, as a multiplier; the loader owns the mechanics. */
            scale: function (value) {
                if (value !== undefined) { state.scaler.set(value); }

                return state.scale;
            },
            /** Show or hide the app, which is the drawer's switch under another name. */
            open: function (on) {
                if (on !== undefined) { setOpen(state, Boolean(on)); }

                return me.shown();
            },
            /** The numbers behind a view, for a caller that wants to read rather than look. */
            report: function (mode) { return reportFor(mode || state.mode); },
            /** The slowest recorded frame, which is usually the one worth explaining. */
            worst: function () { return worstFrame(); },
            /** Throw away everything recorded so far. */
            clear: function () { clearAll(state); return state; },
            /** Print the current view to the game log. */
            dump: function () { dump(state); return state; },
            /** The measuring half, for anyone who wants it without the panel. */
            sampler: S,
            state: state
        };
    };

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
        state.unsubscribeSettings = ACEUIModLoader.settings.onChange(me.name, function (key) {
            if (key === "window") { refreshTable(state); }
        });
        // panel scale belongs to the loader now: this was the third copy of the same lines
        state.scaler = me.scale(root, {
            min: SCALE_MIN,
            max: SCALE_MAX,
            step: SCALE_STEP,
            onScale: function (value) {
                state.scale = value;

                if (state.scroller) { state.scroller.invalidate(); }

                if (state.canvas) { fitCanvas(state); }
            }
        });
        groundFill(state);

        // the stylesheet's own background did not paint in game (the scene showed through the
        // table), while the app drawer -- which sets its background inline -- is solid. Until
        // that is understood, say it both ways; the stylesheet keeps it for the preview.
        root.style.background = PANEL_BG;
        markSort(state);

        if (options.autoRecord) { setRecording(state, true); }

        state.ui = me.panel(root, function (now) { tick(state, now); });
        live = handleFor(state);

        // the same handle ACEUIProfiler.panel() hands back, offered to the other apps by
        // name: a mod that wants to start a recording or read the last window off does not
        // have to know the profiler's global exists. Withdrawn in detach, because the
        // handle is this panel's -- and a stopped profiler has nothing to report.
        ACEUIModLoader.apps.register(me.name, live);
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
            + " (fitted to its box, so one column is one pixel)"
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
        ACEUIModLoader.apps.unregister(me.name);
        state.ui.stop();

        if (state.unsubscribeSettings) {
            state.unsubscribeSettings();
            state.unsubscribeSettings = null;
        }

        live = null;

        if (state.scaler) {
            state.scaler.stop();
            state.scaler = null;
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
        /**
         * The panel on screen, or null before the loader has mounted it.
         *
         *     const p = ACEUIProfiler.panel();
         *     p.record(true);              // start measuring
         *     p.band("other", false);      // drop the engine's slice from the graph
         *     p.sort("self");              // heaviest on its own hands first
         *     p.report().rows[0];          // and read the answer back
         */
        panel: function () { return live; },
        /** The measuring half on its own, for a caller with no use for a panel. */
        sampler: S,
        /** The categories the graph stacks and the legend switches, bottom-up. */
        BANDS: BANDS,
        /** The table's columns, in the order they are drawn; `key` is what `sort` takes. */
        COLUMNS: COLUMNS,
        /** The views, in the order the picker shows them; `key` is what `mode` takes. */
        MODES: MODES,
        VERSION: me.version,
        /** What the loader calls. Mounting twice is the loader's business, not a caller's. */
        attach: attach,
        detach: detach,
        /** The key that shows and hides the app; the loader binds it. */
        toggleKey: function () { return options.toggleKey; },
        /**
         * The inside, for the test harness and for a snippet that needs to reach past the
         * surface above. Named so that nobody depends on it by accident: anything here can
         * change without notice, and the panel handle is what is supported.
         */
        internals: {
            CLASS: CLASS,
            BANDS: BANDS,
            COLUMNS: COLUMNS,
            MODES: MODES,
            GRAPH_W: GRAPH_W,
            GRAPH_H: GRAPH_H,
            GUIDES: GUIDES,
            ROWS: ROWS,
            MODE_WINDOW: MODE_WINDOW,
            MODE_TREE: MODE_TREE,
            MODE_WORST: MODE_WORST,
            SCALE_MIN: SCALE_MIN,
            SCALE_MAX: SCALE_MAX,
            SCALES: SCALES,
            SCALE_START: SCALE_START,
            rescale: rescale,
            trackScale: trackScale,
            shownMs: shownMs,
            refit: refit,
            create: create,
            tick: tick,
            fitCanvas: fitCanvas,
            groundFill: groundFill,
            refreshTable: refreshTable,
            reportFor: reportFor,
            worstFrame: worstFrame,
            caughtSpike: caughtSpike,
            statText: statText,
            drawColumn: drawColumn,
            setRecording: setRecording,
            setMode: setMode,
            setBand: setBand,
            setSort: setSort,
            setOpen: setOpen,
            clearAll: clearAll,
            dump: dump,
            attach: attach,
            detach: detach
        }
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

/*
 * The show/hide key. The loader holds it rather than the panel, because a panel that has been
 * closed is not running to hold anything -- which is exactly when you want the key to work.
 */
ACEUIModLoader.mod("profiler").toggle(ACEUIProfiler.toggleKey);
