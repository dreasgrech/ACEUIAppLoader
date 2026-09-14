/**
 * DevConsole -- in-game debug console for Assetto Corsa EVO's HUD.
 *
 * Shows what the UI logs (everything `ACEUIModLoader.console` captured, including the
 * stock bundle's own console.* output and uncaught errors) in a draggable panel,
 * with per-level filters, and runs JavaScript typed into its prompt against the
 * HUD page (e.g. `ModelCurrentCar.speed`, `ACEUIModLoader.mods`). Toggle with the
 * backquote key.
 *
 * Built on the ACEUIModLoader library: `ACEUIModLoader.console` is the source of lines and
 * takes the prompt's echo/result lines, `ACEUIModLoader.panel` handles drag and position
 * persistence, `ACEUIModLoader.loop` the frame loop, `ACEUIModLoader.persist` the open state and
 * filter choices. Styling lives in devconsole.css.
 *
 * Rendering rules (Cohtml): a fixed pool of MAX_ROWS row elements is created once;
 * a frame only rewrites `textContent`, one attribute and a class on rows whose
 * entry changed, and only when something new arrived (dirty flag). No markup is
 * rebuilt after attach.
 *
 * The line buffer lives in the page: it starts fresh whenever the HUD page is
 * reloaded (Escape/resume), but lines the loader and other mods logged while the
 * page was loading are already in it when the console attaches.
 *
 * Usage: `DevConsole.attach(rootElement)` returns the console's state;
 * `DevConsole.detach(state)` stops it and releases its listeners.
 */
const DevConsole = (function () {

    /** Mod version -- keep in step with the VERSION file and mod.json. */
    const VERSION = "0.2.0";

    /** Prefix of every log line; the game log and the tests grep for it. */
    const LOG_PREFIX = "[DevConsole]";

    /** Keys under which the position, open state and filters persist. */
    const HUD_ELEMENT_ID = "hud_devconsole";
    const STORAGE_KEY = "acedevconsole.pos";
    const OPEN_KEY = "acedevconsole.open";
    const FILTER_KEY = "acedevconsole.filters";
    /** Element id of the console's root (mod.js creates it; the preview page carries one). */
    const ROOT_ID = "devconsole";

    /**
     * Keyboard. Names are `e.key` / `e.code` values; the numbers are the legacy
     * `e.keyCode` the stock bundle relies on exclusively (it never reads `key` or
     * `code`), so every check accepts either form.
     */
    const TOGGLE_CODE = "Backquote";
    const TOGGLE_KEY = "`";
    const RUN_KEY = "Enter";
    const HISTORY_PREV_KEY = "ArrowUp";
    const HISTORY_NEXT_KEY = "ArrowDown";
    const BLUR_KEY = "Escape";
    const KEY_CODES = { Backquote: 192, Enter: 13, ArrowUp: 38, ArrowDown: 40, Escape: 27 };

    /** Row elements created once and recycled; the buffer itself is ACEUIModLoader.console's. */
    const MAX_ROWS = 200;
    const HISTORY_MAX = 50;
    const TIME_DIGITS = 2;

    const TITLE_TEXT = "CONSOLE";
    const CLEAR_TEXT = "CLEAR";
    const CLOSE_TEXT = "×";
    const FOLLOW_TEXT = "LATEST";
    const PROMPT_GLYPH = ">";
    const PROMPT_TEXT = "js expression, Enter to run";
    const ECHO_PREFIX = "> ";

    /**
     * Scrolling. Cohtml does not scroll an overflowing box by itself, so the console
     * owns it: the wheel moves the body by a fraction of its visible height per
     * notch, a click on the track jumps, and the newest line is followed until the
     * user scrolls away (the LATEST chip brings them back).
     */
    const WHEEL_STEP = 0.25;
    const MIN_THUMB_PX = 12;
    /**
     * Cohtml reports the wheel with the opposite sign to a browser (the stock bundle
     * treats a positive deltaY as "up"), so the direction is flipped in game.
     */
    const COHTML = /Cohtml/.test(navigator.userAgent);
    const WHEEL_SIGN = COHTML ? -1 : 1;

    /** Text filter: rows whose text does not contain the query (case-insensitive) are hidden. */
    const SEARCH_TEXT = "filter text";

    /** Class names shared with devconsole.css. */
    const CLASS = {
        root: "ace-devconsole",
        dragging: "dragging",
        closed: "dc-closed",
        header: "dc-header",
        title: "dc-title",
        version: "dc-version",
        filters: "dc-filters",
        filter: "dc-filter",
        on: "on",
        count: "dc-count",
        search: "dc-search",
        tools: "dc-tools",
        button: "dc-btn",
        closeButton: "dc-close",
        scroll: "dc-scroll",
        body: "dc-body",
        row: "dc-row",
        time: "dc-time",
        text: "dc-text",
        hidden: "dc-hidden",
        scrollbar: "dc-scrollbar",
        thumb: "dc-thumb",
        nofit: "dc-nofit",
        follow: "dc-follow",
        footer: "dc-footer",
        prompt: "dc-prompt",
        input: "dc-input"
    };

    /** Attributes: the row's level (colour key in the CSS), filter and action buttons. */
    const LEVEL_ATTR = "data-level";
    const FILTER_ATTR = "data-filter";
    const ACTION_ATTR = "data-action";
    const ACTION_CLEAR = "clear";
    const ACTION_CLOSE = "close";
    const ACTION_FOLLOW = "follow";

    /** Filter toggles and the entry levels each covers; echo/result lines are always shown. */
    const FILTERS = [
        { id: "log", label: "LOG", levels: ["log", "info", "debug"] },
        { id: "warn", label: "WARN", levels: ["warn"] },
        { id: "error", label: "ERR", levels: ["error"] }
    ];

    /** Levels of the prompt's own lines, captured into the shared buffer. */
    const ECHO_LEVEL = "input";
    const RESULT_LEVEL = "result";
    const ERROR_LEVEL = "error";

    const NO_DRAG_ATTR = ACEUIModLoader.panel.NO_DRAG_ATTR;
    const clamp = ACEUIModLoader.clamp;
    const el = ACEUIModLoader.el;
    const close = ACEUIModLoader.close;
    const toArray = ACEUIModLoader.toArray;
    const log = ACEUIModLoader.logger(LOG_PREFIX);
    const lines = ACEUIModLoader.console;
    const persist = ACEUIModLoader.persist;

    // ---- small helpers -----------------------------------------------------------

    /** The filter id that governs a level, or null for lines that are always shown. */
    const filterOf = function (level) {
        let i;

        for (i = 0; i < FILTERS.length; i += 1) {
            if (FILTERS[i].levels.indexOf(level) >= 0) { return FILTERS[i].id; }
        }

        return null;
    };

    const padded = function (n) {
        let text = String(n);

        while (text.length < TIME_DIGITS) { text = "0" + text; }

        return text;
    };

    const timeText = function (t) {
        const d = new Date(t);

        return padded(d.getHours()) + ":" + padded(d.getMinutes()) + ":" + padded(d.getSeconds());
    };

    const noDrag = function (attrs) {
        const out = attrs || {};

        out[NO_DRAG_ATTR] = "";

        return out;
    };

    const setClass = function (node, className, on) {
        if (on) {
            node.classList.add(className);
        } else {
            node.classList.remove(className);
        }
    };

    // ---- markup ------------------------------------------------------------------

    const filterMarkup = function (filter) {
        const attrs = noDrag({});

        attrs[FILTER_ATTR] = filter.id;

        return el("div", CLASS.filter + " " + CLASS.on, attrs) + filter.label
            + el("span", CLASS.count) + "0" + close("span")
            + close("div");
    };

    const actionMarkup = function (action, text, extraClass) {
        const attrs = noDrag({});

        attrs[ACTION_ATTR] = action;

        return el("div", CLASS.button + (extraClass ? " " + extraClass : ""), attrs) + text + close("div");
    };

    const followMarkup = function () {
        const attrs = noDrag({});

        attrs[ACTION_ATTR] = ACTION_FOLLOW;

        return el("div", CLASS.follow + " " + CLASS.hidden, attrs) + FOLLOW_TEXT + close("div");
    };

    const markup = function () {
        const rows = [];
        let i;

        for (i = 0; i < MAX_ROWS; i += 1) {
            rows.push(el("div", CLASS.row + " " + CLASS.hidden)
                + el("span", CLASS.time) + close("span")
                + el("span", CLASS.text) + close("span")
                + close("div"));
        }

        return el("div", CLASS.header)
            + el("div", CLASS.title) + TITLE_TEXT + el("span", CLASS.version) + VERSION + close("span") + close("div")
            + el("div", CLASS.filters) + FILTERS.map(filterMarkup).join("") + close("div")
            + el("input", CLASS.search, noDrag({ type: "text", placeholder: SEARCH_TEXT }))
            + el("div", CLASS.tools)
            + actionMarkup(ACTION_CLEAR, CLEAR_TEXT) + actionMarkup(ACTION_CLOSE, CLOSE_TEXT, CLASS.closeButton)
            + close("div")
            + close("div")
            + el("div", CLASS.scroll)
            + el("div", CLASS.body) + rows.join("") + close("div")
            + el("div", CLASS.scrollbar, noDrag({})) + el("div", CLASS.thumb) + close("div") + close("div")
            + followMarkup()
            + close("div")
            + el("div", CLASS.footer)
            + el("span", CLASS.prompt) + PROMPT_GLYPH + close("span")
            + el("input", CLASS.input, noDrag({ type: "text", placeholder: PROMPT_TEXT }))
            + close("div");
    };

    /**
     * Build (or, on a root that already carries the markup, re-use) the DOM and
     * return the console's state. Everything the loop touches is looked up once.
     */
    const create = function (root) {
        const filters = {};
        const filterEls = {};
        const stored = persist.readLocal(FILTER_KEY);

        root.classList.add(CLASS.root);

        if (!root.querySelector("." + CLASS.body)) { root.innerHTML = markup(); }

        FILTERS.forEach(function (filter) {
            const node = root.querySelector("[" + FILTER_ATTR + "=\"" + filter.id + "\"]");

            filters[filter.id] = !(stored && stored[filter.id] === false);
            filterEls[filter.id] = { el: node, count: node.querySelector("." + CLASS.count), lastCount: "0" };
            setClass(node, CLASS.on, filters[filter.id]);
        });

        return {
            root: root,
            body: root.querySelector("." + CLASS.body),
            track: root.querySelector("." + CLASS.scrollbar),
            thumb: root.querySelector("." + CLASS.thumb),
            followButton: root.querySelector("." + CLASS.follow),
            input: root.querySelector("." + CLASS.input),
            search: root.querySelector("." + CLASS.search),
            query: "",                  // lower-cased text filter, "" for none
            drag: null,                 // thumb drag in progress: { startY, startTop }
            follow: true,               // keep the newest line in view
            thumbHeight: -1,            // last applied thumb geometry, so frames only touch it on change
            thumbY: -1,
            rows: toArray(root.querySelectorAll("." + CLASS.row)).map(function (row) {
                return { el: row, time: row.querySelector("." + CLASS.time), text: row.querySelector("." + CLASS.text), seq: -1, level: "" };
            }),
            filters: filters,
            filterEls: filterEls,
            open: true,
            dirty: true,                // something to render on the next frame
            history: [],
            historyIndex: 0,
            draft: "",
            unsubscribe: null,
            handlers: null,
            panel: null,                // ACEUIModLoader.panel state (drag + position)
            loop: null                  // ACEUIModLoader.loop handle
        };
    };

    // ---- rendering -----------------------------------------------------------------

    const isVisible = function (state, entry) {
        const filter = filterOf(entry.level);

        if (filter !== null && !state.filters[filter]) { return false; }

        return state.query === "" || entry.text.toLowerCase().indexOf(state.query) >= 0;
    };

    const hideRow = function (row) {
        if (row.seq === -1) { return; }

        row.seq = -1;
        row.el.classList.add(CLASS.hidden);
    };

    const showRow = function (row, entry) {
        if (row.seq === entry.seq) { return; }

        if (row.seq === -1) { row.el.classList.remove(CLASS.hidden); }

        row.seq = entry.seq;

        if (row.level !== entry.level) {
            row.level = entry.level;
            row.el.setAttribute(LEVEL_ATTR, entry.level);
        }

        row.time.textContent = timeText(entry.t);
        row.text.textContent = entry.text;
    };

    /** Rewrite only the rows whose entry changed; the newest line ends up at the bottom. */
    const render = function (state) {
        const all = lines.entries();
        const counts = {};
        const shown = [];

        FILTERS.forEach(function (filter) { counts[filter.id] = 0; });

        all.forEach(function (entry) {
            const filter = filterOf(entry.level);

            if (filter !== null) { counts[filter] += 1; }

            if (isVisible(state, entry)) { shown.push(entry); }
        });

        const first = Math.max(0, shown.length - MAX_ROWS);

        state.rows.forEach(function (row, i) {
            const entry = shown[first + i];

            if (entry) {
                showRow(row, entry);
            } else {
                hideRow(row);
            }
        });

        FILTERS.forEach(function (filter) {
            const node = state.filterEls[filter.id];
            const text = String(counts[filter.id]);

            if (node.lastCount !== text) {
                node.lastCount = text;
                node.count.textContent = text;
            }
        });

        if (state.follow) { state.body.scrollTop = state.body.scrollHeight; }

        syncScrollbar(state);
    };

    /** One animation frame: settle the position, then redraw if anything changed. */
    const tick = function (state, now) {
        ACEUIModLoader.panel.update(state.panel, now);

        if (!state.open || !state.dirty || ACEUIModLoader.hudHidden()) { return; }

        state.dirty = false;
        render(state);
    };

    // ---- state changes -----------------------------------------------------------------

    const setOpen = function (state, open) {
        state.open = open;
        setClass(state.root, CLASS.closed, !open);
        persist.writeLocal(OPEN_KEY, open);

        if (open) { state.dirty = true; }
    };

    const setFilter = function (state, id, on) {
        state.filters[id] = on;
        setClass(state.filterEls[id].el, CLASS.on, on);
        persist.writeLocal(FILTER_KEY, state.filters);
        state.dirty = true;
    };

    const clearLines = function (state) {
        lines.clear();
        setFollow(state, true);
        state.dirty = true;
    };

    // ---- scrollbar -----------------------------------------------------------------------

    /** Size and place the thumb from the body's scroll geometry; touches style only on change. */
    const syncScrollbar = function (state) {
        const body = state.body;
        const visible = body.clientHeight;
        const total = body.scrollHeight;
        const trackHeight = state.track.clientHeight;
        const fits = total <= visible || trackHeight === 0;
        let thumbHeight;
        let y;

        setClass(state.track, CLASS.nofit, fits);

        if (fits) { return; }

        thumbHeight = Math.min(trackHeight, Math.max(MIN_THUMB_PX, Math.round(trackHeight * visible / total)));
        y = Math.round((trackHeight - thumbHeight) * clamp(body.scrollTop / (total - visible), 0, 1));

        if (thumbHeight !== state.thumbHeight) {
            state.thumbHeight = thumbHeight;
            state.thumb.style.height = thumbHeight + "px";
        }

        if (y !== state.thumbY) {
            state.thumbY = y;
            state.thumb.style.transform = "translateY(" + y + "px)";
        }
    };

    /** Follow the newest line (true) or hold the current scroll position (false). */
    const setFollow = function (state, on) {
        state.follow = on;
        setClass(state.followButton, CLASS.hidden, on);

        if (on) { state.dirty = true; }
    };

    /** Scroll the body by `dy` pixels; following resumes when the bottom is reached. */
    const scrollBy = function (state, dy) {
        const body = state.body;
        const max = Math.max(0, body.scrollHeight - body.clientHeight);
        const top = clamp(body.scrollTop + dy, 0, max);

        body.scrollTop = top;
        setFollow(state, top >= max);
        syncScrollbar(state);
    };

    const onWheel = function (state, e) {
        const direction = e.deltaY > 0 ? 1 : (e.deltaY < 0 ? -1 : 0);

        if (direction === 0) { return; }

        scrollBy(state, direction * WHEEL_SIGN * state.body.clientHeight * WHEEL_STEP);
        e.preventDefault();
    };

    /** Drag start on the thumb: remember where, and follow the mouse on the window until release. */
    const onThumbDown = function (state, e) {
        state.drag = { startY: e.clientY, startTop: state.body.scrollTop };
        setClass(state.track, CLASS.dragging, true);
        window.addEventListener("mousemove", state.handlers.thumbMove);
        window.addEventListener("mouseup", state.handlers.thumbUp);
        e.preventDefault();
    };

    const onThumbMove = function (state, e) {
        const body = state.body;
        const travel = state.track.clientHeight - state.thumbHeight;
        const max = Math.max(0, body.scrollHeight - body.clientHeight);

        if (!state.drag || travel <= 0) { return; }

        scrollBy(state, state.drag.startTop + (e.clientY - state.drag.startY) * max / travel - body.scrollTop);
    };

    const onThumbUp = function (state) {
        if (!state.drag) { return; }

        state.drag = null;
        setClass(state.track, CLASS.dragging, false);
        window.removeEventListener("mousemove", state.handlers.thumbMove);
        window.removeEventListener("mouseup", state.handlers.thumbUp);
    };

    /** A click on the track centres the thumb on the click point; on the thumb it starts a drag. */
    const onTrackDown = function (state, e) {
        const body = state.body;
        const travel = state.track.clientHeight - state.thumbHeight;
        const max = Math.max(0, body.scrollHeight - body.clientHeight);
        let ratio = 1;

        if (e.target === state.thumb) {
            onThumbDown(state, e);

            return;
        }

        if (typeof e.offsetY === "number" && travel > 0) { ratio = clamp((e.offsetY - state.thumbHeight / 2) / travel, 0, 1); }

        scrollBy(state, ratio * max - body.scrollTop);
        e.preventDefault();
    };

    // ---- text filter ---------------------------------------------------------------------

    /** Apply a text filter; matching is case-insensitive on the line text. */
    const setQuery = function (state, text) {
        const query = String(text || "").trim().toLowerCase();

        if (query === state.query) { return; }

        state.query = query;
        state.dirty = true;
    };

    const onSearchChange = function (state) {
        setQuery(state, state.search.value);
    };

    const onSearchKey = function (state, e) {
        if (keyIs(e, BLUR_KEY)) {
            state.search.value = "";
            setQuery(state, "");
            state.search.blur();
        }
    };

    // ---- prompt -----------------------------------------------------------------------

    /** Compile as an expression when possible (so its value can be shown), else as statements. */
    const compile = function (code) {
        try {
            return new Function("return (" + code + "\n);");
        } catch (ignore) { /* not an expression: compile as statements below */ }

        return new Function(code);
    };

    const remember = function (state, code) {
        if (state.history[state.history.length - 1] !== code) { state.history.push(code); }

        if (state.history.length > HISTORY_MAX) { state.history.shift(); }

        state.historyIndex = state.history.length;
        state.draft = "";
    };

    /** Run `code` against the page; echo and result (or error) go into the shared buffer. */
    const evaluate = function (state, code) {
        const trimmed = code.trim();

        if (!trimmed) { return; }

        lines.capture(ECHO_LEVEL, ECHO_PREFIX + trimmed);
        remember(state, trimmed);

        try {
            lines.capture(RESULT_LEVEL, lines.format(compile(trimmed)()));
        } catch (e) {
            lines.capture(ERROR_LEVEL, e && e.name ? e.name + ": " + e.message : String(e));
        }
    };

    const recall = function (state, step) {
        const next = state.historyIndex + step;

        if (next < 0 || next > state.history.length) { return; }

        if (state.historyIndex === state.history.length) { state.draft = state.input.value; }

        state.historyIndex = next;
        state.input.value = next === state.history.length ? state.draft : state.history[next];
    };

    /** True when the event is the named key, by `key`, `code` or legacy `keyCode`. */
    const keyIs = function (e, name) {
        return e.key === name || e.code === name || e.keyCode === KEY_CODES[name];
    };

    const onInputKey = function (state, e) {
        if (keyIs(e, RUN_KEY)) {
            evaluate(state, state.input.value);
            state.input.value = "";
            e.preventDefault();
        } else if (keyIs(e, HISTORY_PREV_KEY)) {
            recall(state, -1);
            e.preventDefault();
        } else if (keyIs(e, HISTORY_NEXT_KEY)) {
            recall(state, 1);
            e.preventDefault();
        } else if (keyIs(e, BLUR_KEY)) {
            state.input.blur();
        }
    };

    // ---- input -----------------------------------------------------------------------

    const isToggleKey = function (e) {
        return keyIs(e, TOGGLE_CODE) || e.key === TOGGLE_KEY;
    };

    const onWindowKey = function (state, e) {
        if (e.target === state.input || e.target === state.search || !isToggleKey(e)) { return; }

        setOpen(state, !state.open);
        e.preventDefault();
    };

    const onClick = function (state, e) {
        const filter = ACEUIModLoader.closestWithAttribute(e.target, FILTER_ATTR, state.root);

        if (filter) {
            const id = filter.getAttribute(FILTER_ATTR);

            setFilter(state, id, !state.filters[id]);

            return;
        }

        const action = ACEUIModLoader.closestWithAttribute(e.target, ACTION_ATTR, state.root);
        const name = action ? action.getAttribute(ACTION_ATTR) : "";

        if (name === ACTION_CLEAR) { clearLines(state); }

        if (name === ACTION_CLOSE) { setOpen(state, false); }

        if (name === ACTION_FOLLOW) { setFollow(state, true); }
    };

    // ---- lifecycle ---------------------------------------------------------------

    /**
     * Build the console inside `root`, make it a persistent draggable panel, follow
     * the shared line buffer and start the frame loop. Returns the state `detach` needs.
     */
    const attach = function (root) {
        const state = create(root);
        const storedOpen = persist.readLocal(OPEN_KEY);

        state.handlers = {
            key: function (e) { onWindowKey(state, e); },
            inputKey: function (e) { onInputKey(state, e); },
            click: function (e) { onClick(state, e); },
            wheel: function (e) { onWheel(state, e); },
            trackDown: function (e) { onTrackDown(state, e); },
            thumbMove: function (e) { onThumbMove(state, e); },
            thumbUp: function () { onThumbUp(state); },
            searchChange: function () { onSearchChange(state); },
            searchKey: function (e) { onSearchKey(state, e); }
        };
        window.addEventListener("keydown", state.handlers.key);
        state.input.addEventListener("keydown", state.handlers.inputKey);
        root.addEventListener("click", state.handlers.click);
        state.body.addEventListener("wheel", state.handlers.wheel);
        state.track.addEventListener("mousedown", state.handlers.trackDown);
        state.search.addEventListener("input", state.handlers.searchChange);
        state.search.addEventListener("keyup", state.handlers.searchChange);
        state.search.addEventListener("keydown", state.handlers.searchKey);

        state.open = storedOpen === null ? true : Boolean(storedOpen);
        setClass(root, CLASS.closed, !state.open);

        state.panel = ACEUIModLoader.panel.attach(root, { hudId: HUD_ELEMENT_ID, storageKey: STORAGE_KEY, log: log });
        state.unsubscribe = lines.subscribe(function () { state.dirty = true; });
        state.loop = ACEUIModLoader.loop.start(function (now) { tick(state, now); });
        log("console attached, " + lines.entries().length + " buffered line(s), " + (state.open ? "open" : "closed") + ", toggle key " + TOGGLE_CODE);

        return state;
    };

    /** Stop the loop, stop following the buffer and release the listeners. The DOM is left in place. */
    const detach = function (state) {
        ACEUIModLoader.loop.stop(state.loop);
        ACEUIModLoader.panel.detach(state.panel);

        if (state.unsubscribe) {
            state.unsubscribe();
            state.unsubscribe = null;
        }

        if (state.handlers) {
            window.removeEventListener("keydown", state.handlers.key);
            state.input.removeEventListener("keydown", state.handlers.inputKey);
            state.root.removeEventListener("click", state.handlers.click);
            state.body.removeEventListener("wheel", state.handlers.wheel);
            state.track.removeEventListener("mousedown", state.handlers.trackDown);
            state.search.removeEventListener("input", state.handlers.searchChange);
            state.search.removeEventListener("keyup", state.handlers.searchChange);
            state.search.removeEventListener("keydown", state.handlers.searchKey);
            onThumbUp(state);
            state.handlers = null;
        }
    };

    log("script loaded, version=" + VERSION + ", source=" + (window.DEVCONSOLE_SOURCE || "ACEUIModLoader") + ", lib=" + ACEUIModLoader.VERSION + ", url=" + location.href);

    return {
        VERSION: VERSION,
        LOG_PREFIX: LOG_PREFIX,
        ROOT_ID: ROOT_ID,
        HUD_ELEMENT_ID: HUD_ELEMENT_ID,
        STORAGE_KEY: STORAGE_KEY,
        OPEN_KEY: OPEN_KEY,
        FILTER_KEY: FILTER_KEY,
        TOGGLE_CODE: TOGGLE_CODE,
        TOGGLE_KEY: TOGGLE_KEY,
        KEY_CODES: KEY_CODES,
        MAX_ROWS: MAX_ROWS,
        WHEEL_STEP: WHEEL_STEP,
        WHEEL_SIGN: WHEEL_SIGN,
        MIN_THUMB_PX: MIN_THUMB_PX,
        CLASS: CLASS,
        FILTERS: FILTERS,
        create: create,
        render: render,
        evaluate: evaluate,
        setOpen: setOpen,
        setFilter: setFilter,
        setFollow: setFollow,
        setQuery: setQuery,
        scrollBy: scrollBy,
        syncScrollbar: syncScrollbar,
        tick: tick,
        attach: attach,
        detach: detach
    };
}());

/** Boot for pages that carry `<div id="devconsole">` themselves (the preview page); in game mod.js attaches. */
(function () {
    const boot = function () {
        const root = document.getElementById(DevConsole.ROOT_ID);

        if (root) { DevConsole.attach(root); }
    };

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", boot);
    } else {
        boot();
    }
}());
