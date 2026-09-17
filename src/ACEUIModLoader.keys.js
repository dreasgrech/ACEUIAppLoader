/**
 * ACEUIModLoader.keys -- recognising a key, and binding one without stealing it.
 *
 * Reading a keystroke in this engine takes more care than `e.key === "x"`, and both
 * DOOM and the dev console had grown their own copy of the same care:
 *
 *   - **three spellings.** The stock bundle reads the legacy `e.keyCode` exclusively and
 *     never looks at `key` or `code`, so anything that wants to agree with it has to
 *     accept all three. CODES maps the names we use to the legacy numbers.
 *   - **`key` is the character, `code` is the position.** The backquote arrives as "`"
 *     under `key` and "Backquote" under `code`; space as " " and "Space". ALIASES folds
 *     the characters back onto the names.
 *   - **not while someone is typing.** A hotkey that fires while the player is in a text
 *     box eats their keystroke. `isTyping(e)` is the check every app needs and two of
 *     them had inlined.
 *
 *     const unbind = ACEUIModLoader.keys.bind(function () { return options.toggleKey; },
 *         function (e) { toggle(); e.preventDefault(); });
 *
 * The first argument is a key name or a function returning one, so a hotkey that lives in
 * ACEUIModLoader.settings follows the player's choice without rebinding. `bind` skips
 * events aimed at a text box, and returns the function that unbinds it.
 *
 * An app's hotkey is the app's to move; the player's game bindings are not ours to shadow,
 * which is why every hotkey in this project is a setting rather than a constant.
 */
ACEUIModLoader.keys = (function () {

    /** Name -> legacy keyCode, for the keys apps actually bind. */
    const CODES = {
        Backquote: 192, Backspace: 8, Tab: 9, Enter: 13, Shift: 16, Control: 17, Alt: 18,
        Escape: 27, Space: 32, PageUp: 33, PageDown: 34, End: 35, Home: 36,
        ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40,
        Insert: 45, Delete: 46, Comma: 188, Period: 190, Slash: 191, Minus: 189, Equal: 187,
        ShiftLeft: 160, ShiftRight: 161, ControlLeft: 162, ControlRight: 163,
        AltLeft: 164, AltRight: 165,
        F1: 112, F2: 113, F3: 114, F4: 115, F5: 116, F6: 117,
        F7: 118, F8: 119, F9: 120, F10: 121, F11: 122, F12: 123
    };

    /** `e.key` values that are characters rather than names. */
    const ALIASES = {
        "`": "Backquote", " ": "Space", ",": "Comma", ".": "Period", "/": "Slash",
        "-": "Minus", "=": "Equal"
    };

    /** Elements that own the keyboard while they have focus. */
    const EDITABLE = ["INPUT", "TEXTAREA", "SELECT"];

    /** The name for an event, preferring `code` (position) over `key` (character). */
    const nameOf = function (e) {
        if (!e) { return ""; }

        if (e.code) { return e.code; }

        return ALIASES[e.key] || e.key || "";
    };

    /** True when `e` is the named key by any of the three spellings the engine uses. */
    const is = function (e, name) {
        if (!e || !name) { return false; }

        if (e.code === name || e.key === name) { return true; }

        if (ALIASES[e.key] === name) { return true; }

        return CODES[name] !== undefined && e.keyCode === CODES[name];
    };

    /** True while the event is aimed at something the player is typing into. */
    const isTyping = function (e) {
        const target = e ? e.target : null;

        if (!target) { return false; }

        if (target.isContentEditable) { return true; }

        return EDITABLE.indexOf(target.tagName) >= 0;
    };

    /**
     * Bind a hotkey on the window. `key` is a name or a function returning one (so a key
     * kept in settings is followed, not snapshotted). Returns the unbind function.
     *
     * Options: `capture` (default false), `typing` (default false -- set true only for a
     * binding that must fire inside a text box, such as the console's own prompt keys).
     */
    const bind = function (key, handler, options) {
        const opts = options || {};
        const wanted = function () { return typeof key === "function" ? key() : key; };
        const onKey = function (e) {
            if (!opts.typing && isTyping(e)) { return; }

            if (!is(e, wanted())) { return; }

            handler(e);
        };

        return ACEUIModLoader.dom.on(window, opts.event || "keydown", onKey, opts.capture);
    };

    return {
        CODES: CODES,
        ALIASES: ALIASES,
        nameOf: nameOf,
        is: is,
        isTyping: isTyping,
        bind: bind
    };
}());
