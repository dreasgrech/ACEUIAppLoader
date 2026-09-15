/**
 * ACEUIModLoader.console -- captures everything the UI logs, for in-game display.
 *
 * Wraps every console method the engine offers as soon as this file runs (before
 * the stock bundle, which calls them hundreds of times), keeps the last MAX_ENTRIES
 * lines in a ring buffer and notifies subscribers. The originals are still
 * called, so the game log is unchanged; nothing is echoed twice. Uncaught errors
 * and unhandled promise rejections are captured as "error" entries.
 *
 * `console.trace`, `dir` and `table` are wrapped too. The stock bundle wraps
 * `console.trace` itself, but it does so *after* this file runs, so its wrapper
 * calls ours and the line is still captured. `console.assert` is wrapped
 * separately, since it must only record when its condition is falsy.
 * Methods this engine does not provide are skipped; the debug console's `.logtest`
 * command reports what actually arrives, from the inside.
 *
 * Entries are { seq, t, level, text }; `capture(level, text)` adds one without
 * going through console (used by the debug console for its own echo/result lines).
 */
ACEUIModLoader.console = (function () {

    const MAX_ENTRIES = 500;
    const LEVELS = ["log", "info", "debug", "warn", "error", "trace", "dir", "table"];
    /** console.assert only says anything when its condition is false. */
    const ASSERT_LEVEL = "error";
    const ASSERT_PREFIX = "assertion failed: ";
    /** Limits when turning objects into text: depth, keys per object, items per array, characters. */
    const MAX_DEPTH = 2;
    const MAX_KEYS = 20;
    const MAX_ITEMS = 20;
    const MAX_TEXT = 400;
    const ELLIPSIS = "...";

    const state = {
        entries: [],
        seq: 0,
        listeners: [],
        original: {},
        hooked: false,
        notifying: false
    };

    const truncate = function (text) {
        return text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) + ELLIPSIS : text;
    };

    /** Compact, bounded rendering of any value; strings pass through at the top level. */
    const formatValue = function (value, depth) {
        const level = depth || 0;

        if (typeof value === "string") { return level === 0 ? value : JSON.stringify(value); }

        if (value === null || value === undefined || typeof value === "number" || typeof value === "boolean") { return String(value); }

        if (typeof value === "function") { return "[function " + (value.name || "anonymous") + "]"; }

        if (value instanceof Error) { return value.name + ": " + value.message; }

        if (level >= MAX_DEPTH) { return Array.isArray(value) ? "[" + ELLIPSIS + "]" : "{" + ELLIPSIS + "}"; }

        if (Array.isArray(value)) {
            const items = value.slice(0, MAX_ITEMS).map(function (item) { return formatValue(item, level + 1); });

            if (value.length > MAX_ITEMS) { items.push(ELLIPSIS); }

            return "[" + items.join(", ") + "]";
        }

        const keys = Object.keys(value);
        const parts = keys.slice(0, MAX_KEYS).map(function (key) { return key + ": " + formatValue(value[key], level + 1); });

        if (keys.length > MAX_KEYS) { parts.push(ELLIPSIS); }

        return "{" + parts.join(", ") + "}";
    };

    const formatArgs = function (args) {
        return args.map(function (arg) { return formatValue(arg, 0); }).join(" ");
    };

    const notify = function (entry) {
        // a listener that logs would recurse forever; entries are stored regardless
        if (state.notifying) { return; }

        state.notifying = true;
        state.listeners.forEach(function (listener) { listener(entry); });
        state.notifying = false;
    };

    const push = function (level, text) {
        const entry = { seq: state.seq, t: Date.now(), level: level, text: truncate(text) };

        state.seq += 1;
        state.entries.push(entry);

        if (state.entries.length > MAX_ENTRIES) { state.entries.shift(); }

        notify(entry);

        return entry;
    };

    /** Add an entry without calling console (it does not reach the game log). */
    const capture = function (level, text) {
        return push(level, text);
    };

    const wrap = function (level) {
        const original = console[level];

        if (typeof original !== "function") { return; }

        state.original[level] = original;
        console[level] = function () {
            const args = ACEUIModLoader.toArray(arguments);

            push(level, formatArgs(args));
            original.apply(console, args);
        };
    };

    const onError = function (e) {
        const where = e.filename ? " at " + e.filename + ":" + e.lineno : "";

        push("error", "uncaught: " + (e.message || formatValue(e.error, 0)) + where);
    };

    const onRejection = function (e) {
        push("error", "unhandled rejection: " + formatValue(e.reason, 0));
    };

    /** console.assert(cond, ...rest): record only the failures, as errors. */
    const wrapAssert = function () {
        const original = console.assert;

        if (typeof original !== "function") { return; }

        state.original.assert = original;
        console.assert = function (condition) {
            const args = ACEUIModLoader.toArray(arguments).slice(1);

            if (!condition) { push(ASSERT_LEVEL, ASSERT_PREFIX + formatArgs(args)); }

            original.apply(console, arguments);
        };
    };

    const hook = function () {
        if (state.hooked) { return; }

        state.hooked = true;
        LEVELS.forEach(wrap);
        wrapAssert();
        window.addEventListener("error", onError);
        window.addEventListener("unhandledrejection", onRejection);
    };

    /** Returns the function that unsubscribes. Listener gets the new entry. */
    const subscribe = function (listener) {
        state.listeners.push(listener);

        return function () {
            state.listeners = state.listeners.filter(function (l) { return l !== listener; });
        };
    };

    const entries = function () {
        return state.entries;
    };

    const clear = function () {
        state.entries = [];
    };

    const listenerCount = function () {
        return state.listeners.length;
    };

    hook();

    return {
        MAX_ENTRIES: MAX_ENTRIES,
        LEVELS: LEVELS,
        entries: entries,
        clear: clear,
        capture: capture,
        subscribe: subscribe,
        listenerCount: listenerCount,
        format: formatValue
    };
}());
