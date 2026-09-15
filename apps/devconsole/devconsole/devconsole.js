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

    /**
     * Identity from the loader: name, version (mod.json), title, root, a prefixed
     * logger and the storage keys, so none of it is repeated here.
     */
    const me = ACEUIModLoader.mod("devconsole");
    const OPEN_KEY = me.key("open");
    const FILTER_KEY = me.key("filters");

    /**
     * Keyboard. Names are `e.key` / `e.code` values; the numbers are the legacy
     * `e.keyCode` the stock bundle relies on exclusively (it never reads `key` or
     * `code`), so every check accepts either form.
     */
    const TOGGLE_CODE = "Backquote";
    const TOGGLE_KEY = "`";
    const RUN_KEY = "Enter";
    /** `.word ...` typed into the prompt is a console command, not JavaScript. */
    const COMMAND_PREFIX = ".";
    const COMMAND_RE = /^\.[a-z]+(\s|$)/;
    const WHITESPACE_RE = /\s+/;
    const RUN_COMMAND = "run";
    const FIELDS_COMMAND = "fields";
    const LOGTEST_COMMAND = "logtest";

    /**
     * The recovered protobuf schemas, generated into a data file beside the mod by
     * tools/gen_protofields.py and loaded the first time `.fields` is used, so the HUD
     * never pays for them unless someone asks.
     */
    const PROTO_FILE = "protofields.js";
    const PROTO_GLOBAL = "ACEProtoFields";
    const FIELD_NAME_WIDTH = 34;
    const FIELD_TYPE_WIDTH = 24;
    const FIELD_TAG_WIDTH = 8;

    /** Every console method worth testing for capture; `.logtest` reports on each. */
    const LOG_METHODS = ["log", "info", "debug", "warn", "error", "trace", "dir", "table", "assert"];
    const LOGTEST_SETTLE_MS = 200;
    /** Snippets live next to the mod folders, outside any mod, so reinstalling a mod never removes them. */
    const SNIPPET_DIR = ACEUIModLoader.ROOT + "snippets/";
    const SNIPPET_EXT = ".js";
    const SNIPPET_NAME_RE = /^[A-Za-z0-9_.-]+$/;
    const HISTORY_PREV_KEY = "ArrowUp";
    const HISTORY_NEXT_KEY = "ArrowDown";
    const BLUR_KEY = "Escape";
    const COMPLETE_KEY = "Tab";


    /**
     * Printing a value. A game model is a wall of fields, so a result is expanded over
     * many lines -- one property per line, indented -- rather than squashed onto one the
     * way ACEUIModLoader.console.format does for log lines. Depth and counts are capped so
     * a careless `window` cannot flood the buffer.
     */
    const TREE_INDENT = "  ";
    const TREE_MAX_DEPTH = 3;
    const TREE_MAX_KEYS = 80;
    const TREE_MAX_ITEMS = 80;
    const TREE_MAX_LINES = 300;
    const MORE_TEXT = "...";

    /**
     * Tab completion. The completer only ever *reads* properties by name, walking from
     * `window` -- it never compiles or calls anything, so completing a path can have no
     * side effects on the game.
     */
    const PATH_TAIL_RE = /[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*\.?$/;
    const PLAIN_NAME_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
    const MAX_COMPLETIONS = 40;
    const SHOWN_COMPLETIONS = 10;
    const PROTO_DEPTH = 4;

    /** Row elements created once and recycled; the buffer itself is ACEUIModLoader.console's. */
    const MAX_ROWS = 200;
    const HISTORY_MAX = 50;
    const TIME_DIGITS = 2;

    const TITLE_TEXT = "ACE Dev Console";
    const CLEAR_TEXT = "CLEAR";
    const CLOSE_TEXT = "×";
    const FOLLOW_TEXT = "LATEST";
    const PROMPT_GLYPH = ">";
    const PROMPT_TEXT = "js expression, Enter to run";
    const ECHO_PREFIX = "> ";

    /**
     * Scrolling is ACEUIModLoader.scroll's job. Cohtml does not scroll an overflowing box
     * by itself, so this panel has to move the body and draw its own thumb -- and the
     * capabilities probe needed exactly the same behaviour, so it lives in the library
     * rather than in two mods. The wheel's inverted sign and the "follow the newest line
     * until you scroll away" rule are both in there.
     */
    const scrolling = ACEUIModLoader.scroll;

    /** Text filter: rows whose text does not contain the query (case-insensitive) are hidden. */
    const SEARCH_TEXT = "filter text";

    /** Panel scale: the root's font-size in rem; everything inside is sized in em. */
    const SCALE_KEY = me.key("scale");
    /**
     * The scale lived under its own key before it was a setting. Seed the setting's
     * default from it so upgrading does not silently reset a panel someone had sized.
     */
    const scaleWas = function () {
        const was = ACEUIModLoader.persist.readLocal(SCALE_KEY);

        return typeof was === "number" ? was : SCALE_DEFAULT;
    };
    const SCALE_DEFAULT = 1;
    const SCALE_MIN = 0.6;
    const SCALE_MAX = 2;
    const SCALE_STEP = 0.1;
    const SCALE_DIGITS = 2;
    const SMALLER_TEXT = "−";
    const LARGER_TEXT = "+";

    /**
     * Settings, drawn by the loader in the app drawer's options pane. The toggle key is
     * here because a hardcoded hotkey collides with whatever the player has bound in the
     * game; this lets them move ours rather than lose theirs.
     */
    const options = ACEUIModLoader.settings
        ? ACEUIModLoader.settings.define("devconsole", [
            {
                key: "toggleKey",
                type: "key",
                label: "Toggle key",
                value: TOGGLE_CODE,
                hint: "Click, then press the key you want"
            },
            {
                key: "scale",
                type: "range",
                label: "Panel scale",
                value: scaleWas(),
                min: SCALE_MIN,
                max: SCALE_MAX,
                step: SCALE_STEP,
                digits: SCALE_DIGITS
            }
        ])
        : { toggleKey: TOGGLE_CODE, scale: scaleWas() };

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
        glyph: "dc-glyph",
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
        input: "dc-input",
        suggest: "dc-suggest",
        suggestItem: "dc-suggest-item",
        suggestOn: "dc-suggest-on"
    };

    /** Attributes: the row's level (colour key in the CSS), filter and action buttons. */
    const LEVEL_ATTR = "data-level";
    const FILTER_ATTR = "data-filter";
    const ACTION_ATTR = "data-action";
    const ACTION_CLEAR = "clear";
    const ACTION_CLOSE = "close";
    const ACTION_FOLLOW = "follow";
    const ACTION_SMALLER = "smaller";
    const ACTION_LARGER = "larger";
    /** Index of a completion chip, so clicking one inserts it. */
    const COMPLETE_ATTR = "data-complete";

    /** Filter toggles and the entry levels each covers; echo/result lines are always shown. */
    const FILTERS = [
        { id: "log", label: "LOG", levels: ["log", "info", "debug", "trace", "dir", "table"] },
        { id: "warn", label: "WARN", levels: ["warn"] },
        { id: "error", label: "ERR", levels: ["error"] }
    ];

    /** Levels of the prompt's own lines, captured into the shared buffer. */
    const ECHO_LEVEL = "input";
    const RESULT_LEVEL = "result";
    const ERROR_LEVEL = "error";

    const NO_DRAG_ATTR = ACEUIModLoader.panel.NO_DRAG_ATTR;
    /** Key names arrive three ways in this engine; ACEUIModLoader.keys knows all three. */
    const keys = ACEUIModLoader.keys;
    const dom = ACEUIModLoader.dom;
    const setClass = dom.setClass;
    const clamp = ACEUIModLoader.clamp;
    const el = ACEUIModLoader.el;
    const close = ACEUIModLoader.close;
    const toArray = ACEUIModLoader.toArray;
    const log = me.log;
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
            + el("div", CLASS.title) + TITLE_TEXT + el("span", CLASS.version) + me.version + close("span") + close("div")
            + el("div", CLASS.filters) + FILTERS.map(filterMarkup).join("") + close("div")
            + el("input", CLASS.search, noDrag({ type: "text", placeholder: SEARCH_TEXT }))
            + el("div", CLASS.tools)
            + actionMarkup(ACTION_SMALLER, SMALLER_TEXT, CLASS.glyph) + actionMarkup(ACTION_LARGER, LARGER_TEXT, CLASS.glyph)
            + actionMarkup(ACTION_CLEAR, CLEAR_TEXT) + actionMarkup(ACTION_CLOSE, CLOSE_TEXT, CLASS.glyph + " " + CLASS.closeButton)
            + close("div")
            + close("div")
            + el("div", CLASS.scroll)
            + el("div", CLASS.body) + rows.join("") + close("div")
            + el("div", CLASS.scrollbar, noDrag({})) + el("div", CLASS.thumb) + close("div") + close("div")
            + followMarkup()
            + close("div")
            + suggestMarkup()
            + el("div", CLASS.footer)
            + el("span", CLASS.prompt) + PROMPT_GLYPH + close("span")
            + el("input", CLASS.input, noDrag({ type: "text", placeholder: PROMPT_TEXT }))
            + close("div");
    };

    /** Completion chips, built once and filled by name; hidden until Tab finds something. */
    const suggestMarkup = function () {
        const chips = [];
        let i;

        for (i = 0; i < SHOWN_COMPLETIONS; i += 1) {
            const attrs = noDrag({});

            attrs[COMPLETE_ATTR] = i;
            chips.push(el("span", CLASS.suggestItem + " " + CLASS.hidden, attrs) + close("span"));
        }

        return el("div", CLASS.suggest + " " + CLASS.hidden, noDrag({})) + chips.join("") + close("div");
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
            scale: SCALE_DEFAULT,       // root font-size in rem, see setScale
            follow: true,               // mirrors the scroller, for the LATEST chip and the tests
            scroller: null,             // ACEUIModLoader.scroll handle (wheel, thumb, follow)
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
            suggest: root.querySelector("." + CLASS.suggest),
            suggestEls: toArray(root.querySelectorAll("." + CLASS.suggestItem)),
            completeItems: [],          // current Tab completions, cycled by repeated Tab
            completeIndex: -1,
            completePartial: "",        // the text the next completion replaces
            completeSource: "",         // the prompt text we last produced, to spot edits
            unsubscribe: null,
            unsubscribeSettings: null,
            unbindToggle: null,
            bag: null,                  // every listener this console added, for detach
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

        if (state.follow) {
            state.scroller.toBottom();
        } else {
            state.scroller.sync();
        }
    };

    /** One animation frame: settle the position, then redraw if anything changed. */
    const tick = function (state, now) {
        ACEUIModLoader.panel.update(state.panel, now);

        if (!state.open || !state.dirty || ACEUIModLoader.hudHidden()) { return; }

        state.dirty = false;
        render(state);
    };

    // ---- state changes -----------------------------------------------------------------

    /**
     * While a text box here has focus the game must stop reading keystrokes as car
     * controls, or typing an expression toggles headlights, wipers and everything else
     * bound to a letter.
     *
     * The mechanism lives in ACEUIModLoader.input, shared with any mod that needs it --
     * it sets both of the engine's flags (`is_chat_active` for letters and
     * `ignore_gameplay_input_actions` for bound actions such as the arrow keys) and
     * counts holders so two mods can want the keyboard at once.
     *
     * Releasing matters more than taking: a console left holding the capture would leave
     * the car deaf to its own controls, so blur, close and detach all release it.
     */
    /**
     * Hold or release the keyboard through the shared library, under this mod's name.
     * ACEUIModLoader.input counts holders, so releasing here cannot take the keyboard
     * away from another mod that still wants it (DOOM holds it while it is open).
     */
    const captureKeyboard = function (on) {
        const input = ACEUIModLoader.input;

        if (!input) { return false; }

        if (on) { input.capture(me.name); } else { input.release(me.name); }

        return input.available();
    };

    const setOpen = function (state, open) {
        state.open = open;
        setClass(state.root, CLASS.closed, !open);
        persist.writeLocal(OPEN_KEY, open);

        if (open) {
            state.dirty = true;

            return;
        }

        // closing while typing must not leave the game unable to read its own controls
        state.input.blur();
        state.search.blur();
        captureKeyboard(false);
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

    /** Scale the whole panel: the root's font-size in rem, everything inside is em. Persisted. */
    const setScale = function (state, scale) {
        const value = Number(clamp(scale, SCALE_MIN, SCALE_MAX).toFixed(SCALE_DIGITS));

        state.scale = value;
        state.root.style.fontSize = value + "rem";

        if (ACEUIModLoader.settings) {
            ACEUIModLoader.settings.set(me.name, "scale", value);
        } else {
            persist.writeLocal(SCALE_KEY, value);
        }

        // the panel's size changed, so the thumb's cached geometry is stale
        if (state.scroller) { state.scroller.invalidate(); }

        state.dirty = true;
    };

    // ---- scrolling ------------------------------------------------------------------

    /** Follow the newest line (true) or hold the current scroll position (false). */
    const setFollow = function (state, on) {
        state.scroller.setFollow(on);
    };

    /** Scroll the body by `dy` pixels; following resumes when the bottom is reached. */
    const scrollBy = function (state, dy) {
        state.scroller.scrollBy(dy);
    };

    /** The scroller tells us when following starts or stops; the LATEST chip follows it. */
    const onFollowChanged = function (state, on) {
        state.follow = on;
        setClass(state.followButton, CLASS.hidden, on);

        if (on) { state.dirty = true; }
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
        if (keys.is(e, BLUR_KEY)) {
            state.search.value = "";
            setQuery(state, "");
            state.search.blur();
        }
    };

    // ---- printing a value ---------------------------------------------------------------

    /** Reading a property can throw (a getter, a dead binding); never let that kill a print. */
    const safeGet = function (obj, key) {
        try {
            return obj[key];
        } catch (e) {
            return "[throws: " + (e && e.message ? e.message : e) + "]";
        }
    };

    const safeKeys = function (obj) {
        try {
            return Object.keys(obj);
        } catch (ignore) {
            return [];
        }
    };

    const isPrimitive = function (value) {
        const t = typeof value;

        return value === null || value === undefined || t === "number" || t === "boolean" || t === "string";
    };

    const primitiveText = function (value) {
        return typeof value === "string" ? "\"" + value + "\"" : String(value);
    };

    /** The one-line summary Firefox puts before the brace: Array(4), Object, CarOnTrack. */
    const headline = function (value) {
        let name = "";

        if (Array.isArray(value)) { return "Array(" + value.length + ")"; }

        if (typeof value === "function") { return "function " + (value.name || "anonymous") + "()"; }

        if (value instanceof Error) { return value.name + ": " + value.message; }

        try {
            name = value.constructor && value.constructor.name ? value.constructor.name : "";
        } catch (ignore) { /* exotic object without a usable constructor */ }

        return name && name !== "Object" ? name : "Object";
    };

    const indentOf = function (depth) {
        let text = "";
        let i;

        for (i = 0; i < depth; i += 1) { text += TREE_INDENT; }

        return text;
    };

    /**
     * Expand a value into indented lines. Cycles are marked rather than followed, depth
     * and counts are capped, and the whole print stops at TREE_MAX_LINES.
     */
    const treeLines = function (value, label, depth, out, seen) {
        const head = indentOf(depth) + (label ? label + ": " : "");

        if (out.length >= TREE_MAX_LINES) { return; }

        if (isPrimitive(value)) { out.push(head + primitiveText(value)); return; }

        if (typeof value === "function") { out.push(head + headline(value)); return; }

        if (seen.indexOf(value) >= 0) { out.push(head + headline(value) + " [circular]"); return; }

        if (depth >= TREE_MAX_DEPTH) {
            out.push(head + headline(value) + (Array.isArray(value) ? " [" + MORE_TEXT + "]" : " {" + MORE_TEXT + "}"));
            return;
        }

        seen.push(value);

        if (Array.isArray(value)) {
            out.push(head + headline(value) + " [");
            value.slice(0, TREE_MAX_ITEMS).forEach(function (item, i) { treeLines(item, String(i), depth + 1, out, seen); });

            if (value.length > TREE_MAX_ITEMS) { out.push(indentOf(depth + 1) + MORE_TEXT); }

            out.push(indentOf(depth) + "]");
        } else {
            const keys = safeKeys(value);

            out.push(head + headline(value) + " {");
            keys.slice(0, TREE_MAX_KEYS).forEach(function (key) { treeLines(safeGet(value, key), key, depth + 1, out, seen); });

            if (keys.length > TREE_MAX_KEYS) { out.push(indentOf(depth + 1) + MORE_TEXT); }

            out.push(indentOf(depth) + "}");
        }

        seen.pop();
    };

    /** Print a result: one line for a primitive, an indented tree for anything else. */
    const showValue = function (value) {
        const out = [];

        treeLines(value, "", 0, out, []);
        out.forEach(function (line) { lines.capture(RESULT_LEVEL, line); });
    };

    // ---- tab completion -------------------------------------------------------------

    /** Walk a dotted path from `window`, reading only -- never calling anything. */
    const resolvePath = function (parts) {
        let current = window;
        let i;

        for (i = 0; i < parts.length; i += 1) {
            if (current === null || current === undefined) { return undefined; }

            current = safeGet(current, parts[i]);
        }

        return current;
    };

    /** Property names of an object and its prototypes, so methods complete too. */
    const namesOf = function (obj) {
        const seen = {};
        const out = [];
        let cursor = obj;
        let depth = 0;

        while (cursor !== null && cursor !== undefined && depth < PROTO_DEPTH) {
            try {
                Object.getOwnPropertyNames(cursor).forEach(function (name) {
                    if (!seen[name]) { seen[name] = 1; out.push(name); }
                });
            } catch (ignore) { /* some hosts refuse; whatever we already have will do */ }

            try {
                cursor = Object.getPrototypeOf(cursor);
            } catch (ignore) {
                cursor = null;
            }

            depth += 1;
        }

        return out;
    };

    /** What could follow the text typed so far: { partial, items }. */
    const completionsFor = function (text) {
        const match = String(text).match(PATH_TAIL_RE);
        const token = match ? match[0] : "";
        const dot = token.lastIndexOf(".");
        const partial = dot >= 0 ? token.slice(dot + 1) : token;
        const basePath = dot >= 0 ? token.slice(0, dot) : "";
        const base = basePath ? resolvePath(basePath.split(".")) : window;
        let names;

        if (!token) { return { partial: "", items: [] }; }

        if (base === null || base === undefined) { return { partial: partial, items: [] }; }

        names = namesOf(base).filter(function (name) {
            return PLAIN_NAME_RE.test(name) && name.indexOf(partial) === 0;
        });
        names.sort();

        return { partial: partial, items: names.slice(0, MAX_COMPLETIONS) };
    };

    /** Fill the completion chips; the active one is highlighted, the strip hides when empty. */
    const renderSuggestions = function (state) {
        const items = state.completeItems;
        const shown = Math.min(items.length, SHOWN_COMPLETIONS);

        setClass(state.suggest, CLASS.hidden, items.length === 0);

        state.suggestEls.forEach(function (chip, i) {
            const last = i === SHOWN_COMPLETIONS - 1 && items.length > SHOWN_COMPLETIONS;
            const visible = i < shown;

            setClass(chip, CLASS.hidden, !visible);
            setClass(chip, CLASS.suggestOn, visible && i === state.completeIndex && !last);

            if (!visible) { return; }

            chip.textContent = last ? "+" + (items.length - SHOWN_COMPLETIONS + 1) + " more" : items[i];
        });
    };

    const resetCompletion = function (state) {
        if (!state.completeItems.length) { return; }

        state.completeItems = [];
        state.completeIndex = -1;
        state.completePartial = "";
        state.completeSource = "";
        renderSuggestions(state);
    };

    /** Swap the partial at the end of the prompt for the chosen completion. */
    const applyCompletion = function (state, index) {
        const item = state.completeItems[index];
        const value = state.input.value;

        if (!item) { return; }

        state.completeIndex = index;
        state.input.value = value.slice(0, value.length - state.completePartial.length) + item;
        state.completePartial = item;
        // remember exactly what we produced: if the text changes behind our back (a paste,
        // or a caller setting .value), cycling would splice the completion into the wrong
        // place, so the next Tab has to start over instead
        state.completeSource = state.input.value;
        renderSuggestions(state);
    };

    /** Tab: complete, then cycle through the alternatives on each further press. */
    const completeNext = function (state) {
        if (state.completeItems.length && state.input.value === state.completeSource) {
            applyCompletion(state, (state.completeIndex + 1) % state.completeItems.length);

            return;
        }

        const found = completionsFor(state.input.value);

        state.completeItems = found.items;
        state.completePartial = found.partial;
        state.completeIndex = -1;

        if (!found.items.length) {
            renderSuggestions(state);

            return;
        }

        applyCompletion(state, 0);
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
    /**
     * `.run <name>` loads `ACEUIModLoaderMods/snippets/<name>.js` as a script: write it in
     * an editor, run it in game, no reinstall and no pasting. Only plain file names are
     * accepted (a folder URL crashes the game); a missing file is one warning in the log.
     */
    const runSnippet = function (name) {
        if (!SNIPPET_NAME_RE.test(name)) {
            lines.capture(ERROR_LEVEL, "run: plain file names only, e.g. .run probe");
            return;
        }

        const file = name.slice(-SNIPPET_EXT.length) === SNIPPET_EXT ? name : name + SNIPPET_EXT;
        const url = SNIPPET_DIR + file;

        lines.capture(RESULT_LEVEL, "run: loading " + url);
        ACEUIModLoader.addScript(url, function (ok) {
            if (ok) {
                lines.capture(RESULT_LEVEL, "run: " + file + " done");
            } else {
                lines.capture(ERROR_LEVEL, "run: " + file + " failed to load; it belongs in mods/uiresources/" + SNIPPET_DIR);
            }
        });
    };

    /**
     * `.fields <name>` -- what a message can carry, against what the game actually
     * published. The live `Model*` objects only show the fields this build fills in; the
     * recovered schemas (ACEGameInternals/proto, shipped beside the mod by
     * tools/gen_protofields.py) say what else is defined. The difference is the point.
     */
    const withProtos = function (onReady) {
        const ready = window[PROTO_GLOBAL];

        if (ready) { onReady(ready); return; }

        lines.capture(RESULT_LEVEL, "fields: loading schemas...");
        ACEUIModLoader.addScript(me.base + PROTO_FILE, function (ok) {
            const loaded = window[PROTO_GLOBAL];

            if (!ok || !loaded) {
                lines.capture(ERROR_LEVEL, "fields: cannot load " + PROTO_FILE + " -- run tools/gen_protofields.py, then reinstall the mod");

                return;
            }

            onReady(loaded);
        });
    };

    const padRight = function (text, width) {
        let out = String(text);

        while (out.length < width) { out += " "; }

        return out;
    };

    /** A live value in one token: primitives literally, objects by shape. */
    const shortValue = function (value) {
        return isPrimitive(value) ? primitiveText(value) : headline(value);
    };

    /** List what the console knows about when `.fields` is given nothing to look up. */
    const listMessages = function (protos) {
        const models = Object.keys(protos.models).sort();

        lines.capture(RESULT_LEVEL, "schemas from proto " + protos.version + ": "
            + Object.keys(protos.messages).length + " messages, " + models.length + " mapped to globals");
        models.forEach(function (name) {
            const live = safeGet(window, name);
            const mark = live === null || live === undefined ? "  (not on this page)" : "";

            lines.capture(RESULT_LEVEL, "  " + padRight(name, FIELD_NAME_WIDTH) + protos.models[name] + mark);
        });
        lines.capture(RESULT_LEVEL, "  .fields <global|MessageName> for the field list");
    };

    const showFields = function (protos, wanted) {
        const message = protos.models[wanted] || wanted;
        const fields = protos.messages[message];
        const live = safeGet(window, wanted);
        const hasLive = live !== null && live !== undefined && typeof live === "object";
        const seen = {};
        let published = 0;

        if (!fields) {
            lines.capture(ERROR_LEVEL, "fields: no schema called " + wanted + " -- .fields with no name lists what there is");

            return;
        }

        fields.forEach(function (field) {
            const name = field[0];
            const known = hasLive && Object.prototype.hasOwnProperty.call(live, name);
            const label = field[3] ? field[3] + " " : "";

            seen[name] = 1;

            if (known) { published += 1; }

            lines.capture(RESULT_LEVEL, "  " + padRight(name, FIELD_NAME_WIDTH)
                + padRight(label + field[1], FIELD_TYPE_WIDTH)
                + padRight("#" + field[2], FIELD_TAG_WIDTH)
                + (known ? "= " + shortValue(safeGet(live, name)) : "(not published)"));
        });

        lines.capture(RESULT_LEVEL, message + (message === wanted ? "" : " <- " + wanted)
            + "  " + (protos.origin[message] || "")
            + "  " + fields.length + " defined"
            + (hasLive ? ", " + published + " live" : ", no live object on this page"));

        if (!hasLive) { return; }

        const extra = safeKeys(live).filter(function (key) { return !seen[key]; });

        if (extra.length) { lines.capture(RESULT_LEVEL, "  live but not in the schema: " + extra.join(", ")); }
    };

    /**
     * `.logtest` -- proves what actually reaches this console. The library wraps
     * console.log/info/debug/warn/error plus uncaught errors and rejections; anything
     * else the engine offers (trace, dir, table, assert) is not wrapped, and this says
     * so from the inside rather than from an assumption.
     */
    const logTest = function () {
        const marker = "logtest" + Date.now();
        const available = [];
        const absent = [];
        const captured = [];
        const lost = [];
        let seen = "";

        LOG_METHODS.forEach(function (name) {
            if (typeof console[name] !== "function") { absent.push(name); return; }

            available.push(name);

            try {
                if (name === "assert") {
                    console.assert(false, marker + " " + name);
                } else {
                    console[name](marker + " " + name);
                }
            } catch (ignore) { /* an engine may refuse an argument shape; it still counted as available */ }
        });

        seen = lines.entries().map(function (entry) { return entry.text; }).join("\n");
        available.forEach(function (name) {
            if (seen.indexOf(marker + " " + name) >= 0) { captured.push(name); } else { lost.push(name); }
        });

        lines.capture(RESULT_LEVEL, "logtest: " + captured.length + " of " + available.length + " available console methods reach this console");
        lines.capture(RESULT_LEVEL, "  captured: " + (captured.join(", ") || "none"));

        if (lost.length) { lines.capture(RESULT_LEVEL, "  NOT captured: " + lost.join(", ") + "  (they still reach the game log)"); }

        if (absent.length) { lines.capture(RESULT_LEVEL, "  absent in this engine: " + absent.join(", ")); }

        if (typeof Promise !== "function") { return; }

        // an unhandled rejection is reported asynchronously, so check back for it
        Promise.reject(new Error(marker + " rejection"));
        window.setTimeout(function () {
            const later = lines.entries().map(function (entry) { return entry.text; }).join("\n");

            lines.capture(RESULT_LEVEL, "  unhandled rejection: "
                + (later.indexOf(marker + " rejection") >= 0 ? "captured" : "NOT captured"));
        }, LOGTEST_SETTLE_MS);
    };

    /** Console commands: a dot and a word, so they never collide with JavaScript. */
    const command = function (trimmed) {
        const parts = trimmed.slice(COMMAND_PREFIX.length).split(WHITESPACE_RE);

        if (parts[0] === RUN_COMMAND && parts[1]) {
            runSnippet(parts[1]);
            return;
        }

        if (parts[0] === FIELDS_COMMAND) {
            withProtos(function (protos) {
                if (parts[1]) { showFields(protos, parts[1]); } else { listMessages(protos); }
            });

            return;
        }

        if (parts[0] === LOGTEST_COMMAND) {
            logTest();
            return;
        }

        lines.capture(ERROR_LEVEL, "commands: .run <name>  loads " + SNIPPET_DIR + "<name>" + SNIPPET_EXT + " as a script");
        lines.capture(ERROR_LEVEL, "          .fields [name]  schema fields of a Model* global or message, vs what is live");
        lines.capture(ERROR_LEVEL, "          .logtest  which console methods actually reach this console");
    };

    const evaluate = function (state, code) {
        const trimmed = code.trim();

        if (!trimmed) { return; }

        lines.capture(ECHO_LEVEL, ECHO_PREFIX + trimmed);
        remember(state, trimmed);

        if (COMMAND_RE.test(trimmed)) {
            command(trimmed);
            return;
        }

        try {
            showValue(compile(trimmed)());
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

    const onInputKey = function (state, e) {
        if (keys.is(e, COMPLETE_KEY)) {
            // Tab would move focus out of the prompt, so it never reaches the browser
            completeNext(state);
            e.preventDefault();

            return;
        }

        if (keys.is(e, RUN_KEY)) {
            resetCompletion(state);
            evaluate(state, state.input.value);
            state.input.value = "";
            e.preventDefault();
        } else if (keys.is(e, HISTORY_PREV_KEY)) {
            resetCompletion(state);
            recall(state, -1);
            e.preventDefault();
        } else if (keys.is(e, HISTORY_NEXT_KEY)) {
            resetCompletion(state);
            recall(state, 1);
            e.preventDefault();
        } else if (keys.is(e, BLUR_KEY)) {
            resetCompletion(state);
            state.input.blur();
        } else {
            // any other keystroke invalidates the completion list the user was cycling
            resetCompletion(state);
        }
    };

    // ---- input -----------------------------------------------------------------------

    /**
     * The toggle key is a setting, not a constant: a hardcoded backquote collides with
     * whatever the player has bound in the game, and their bindings are not ours to
     * shadow. The default stays `Backquote`; the settings pane in the app drawer moves it.
     *
     * `keys.bind` takes a function rather than a name, so moving the setting moves the
     * hotkey with no rebinding, and it never fires while the player is typing -- which is
     * what the prompt and the filter box used to need their own guard for.
     */
    const toggleKey = function () {
        return options.toggleKey || TOGGLE_CODE;
    };

    const onClick = function (state, e) {
        const chip = ACEUIModLoader.closestWithAttribute(e.target, COMPLETE_ATTR, state.root);

        if (chip) {
            applyCompletion(state, Number(chip.getAttribute(COMPLETE_ATTR)));
            state.input.focus();

            return;
        }

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

        if (name === ACTION_SMALLER) { setScale(state, state.scale - SCALE_STEP); }

        if (name === ACTION_LARGER) { setScale(state, state.scale + SCALE_STEP); }
    };

    // ---- lifecycle ---------------------------------------------------------------

    /**
     * Build the console inside `root`, make it a persistent draggable panel, follow
     * the shared line buffer and start the frame loop. Returns the state `detach` needs.
     */
    const attach = function (root) {
        const state = create(root);
        const storedOpen = persist.readLocal(OPEN_KEY);
        const storedScale = ACEUIModLoader.settings
            ? ACEUIModLoader.settings.get(me.name, "scale")
            : persist.readLocal(SCALE_KEY);

        const grab = function () { captureKeyboard(true); };
        const release = function () { captureKeyboard(false); };

        state.scroller = scrolling.attach({
            body: state.body,
            track: state.track,
            thumb: state.thumb,
            follow: true,
            nofitClass: CLASS.nofit,
            draggingClass: CLASS.dragging,
            onFollow: function (on) { onFollowChanged(state, on); },
            log: log
        });

        // one bag rather than fourteen add/remove pairs kept in step by hand
        state.bag = dom.listeners();
        state.bag.on(state.input, "keydown", function (e) { onInputKey(state, e); });
        state.bag.on(root, "click", function (e) { onClick(state, e); });
        state.bag.on(state.search, "input", function () { onSearchChange(state); });
        state.bag.on(state.search, "keyup", function () { onSearchChange(state); });
        state.bag.on(state.search, "keydown", function (e) { onSearchKey(state, e); });
        state.bag.on(state.input, "focus", grab);
        state.bag.on(state.input, "blur", release);
        state.bag.on(state.search, "focus", grab);
        state.bag.on(state.search, "blur", release);
        state.unbindToggle = keys.bind(toggleKey, function (e) {
            setOpen(state, !state.open);
            e.preventDefault();
        });

        state.open = storedOpen === null ? true : Boolean(storedOpen);
        setClass(root, CLASS.closed, !state.open);
        setScale(state, typeof storedScale === "number" ? storedScale : SCALE_DEFAULT);

        if (ACEUIModLoader.settings) {
            state.unsubscribeSettings = ACEUIModLoader.settings.onChange(me.name, function (key, value) {
                if (key === "scale" && value !== state.scale) { setScale(state, value); }
            });
        }

        state.panel = ACEUIModLoader.panel.attach(root, { hudId: me.hudId, storageKey: me.storageKey, log: log });
        state.unsubscribe = lines.subscribe(function () { state.dirty = true; });
        state.loop = ACEUIModLoader.loop.start(function (now) { tick(state, now); });
        log("console attached, " + lines.entries().length + " buffered line(s), " + (state.open ? "open" : "closed")
            + ", scale " + state.scale + ", toggle key " + TOGGLE_CODE);

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

        if (state.unsubscribeSettings) {
            state.unsubscribeSettings();
            state.unsubscribeSettings = null;
        }

        if (state.unbindToggle) {
            state.unbindToggle();
            state.unbindToggle = null;
        }

        // kept, not nulled: anything still in flight finds a scroller that does nothing
        if (state.scroller) { state.scroller.detach(); }

        if (state.bag) {
            state.bag.off();
            captureKeyboard(false);          // never leave the game's controls captured
            state.bag = null;
        }
    };

    log("script loaded, version=" + me.version + ", lib=" + ACEUIModLoader.VERSION + ", url=" + location.href);

    return {
        SCALE_MIN: SCALE_MIN,
        SCALE_MAX: SCALE_MAX,
        SCALE_STEP: SCALE_STEP,
        TOGGLE_CODE: TOGGLE_CODE,
        TOGGLE_KEY: TOGGLE_KEY,
        /* the library's, re-exported: the console no longer keeps its own copies */
        KEY_CODES: keys.CODES,
        MAX_ROWS: MAX_ROWS,
        WHEEL_STEP: scrolling.WHEEL_STEP,
        WHEEL_SIGN: scrolling.WHEEL_SIGN,
        MIN_THUMB_PX: scrolling.MIN_THUMB_PX,
        CLASS: CLASS,
        FILTERS: FILTERS,
        SHOWN_COMPLETIONS: SHOWN_COMPLETIONS,
        TREE_MAX_DEPTH: TREE_MAX_DEPTH,
        treeLines: treeLines,
        completionsFor: completionsFor,
        completeNext: completeNext,
        showFields: showFields,
        logTest: logTest,
        LOG_METHODS: LOG_METHODS,
        resetCompletion: resetCompletion,
        create: create,
        render: render,
        evaluate: evaluate,
        captureKeyboard: captureKeyboard,
        setOpen: setOpen,
        setFilter: setFilter,
        setFollow: setFollow,
        setQuery: setQuery,
        setScale: setScale,
        scrollBy: scrollBy,
        tick: tick,
        attach: attach,
        detach: detach
    };
}());

/* Attach to #devconsole: the loader creates it in game, the preview page carries it. */
ACEUIModLoader.mod("devconsole").mount(DevConsole.attach, DevConsole.detach);
