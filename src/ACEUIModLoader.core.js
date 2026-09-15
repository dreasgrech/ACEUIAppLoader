/**
 * ACEUIModLoader.core -- the root namespace and the small helpers every mod uses.
 *
 * First of the library files appended to the stock `uiresources/js/cohtml.js`
 * (see tools/build_loader.py for the order), so it runs on every Gameface page
 * before Kunos' bundle. Later files add one namespace each (`ACEUIModLoader.console`,
 * `.persist`, `.panel`, `.loop`, `.loader`); mods only ever talk to `ACEUIModLoader.*`.
 *
 * Classic scripts: a top-level `const` is a page-wide binding but not a window
 * property, so the module is also assigned to `window.ACEUIModLoader` for mods that
 * detect the loader that way.
 */
const ACEUIModLoader = (function () {

    /** Loader/library version -- keep in step with the VERSION file at the repo root. */
    const VERSION = "0.12.1";

    /** Prefix of every loader log line; the game log and check_ingame_log.py grep for it. */
    const LOG_PREFIX = "[ACEUIModLoader]";

    /** The stock HUD toggles this class on <body> when the HUD is hidden. */
    const HUD_HIDDEN_CLASS = "hide-hud";

    const PERCENT_SCALE = 100;

    const log = function (message) {
        console.log(LOG_PREFIX + " " + message);
    };

    /** Prefixed logger for mods: ACEUIModLoader.logger("[PedalGraph]")("hello"). */
    const logger = function (prefix) {
        return function (message) {
            console.log(prefix + " " + message);
        };
    };

    const clamp = function (x, lo, hi) {
        if (x < lo) { return lo; }

        if (x > hi) { return hi; }

        return x;
    };

    /** Opening tag with a class and optional attributes, for building markup strings. */
    const el = function (tag, className, attrs) {
        let html = "<" + tag + " class=\"" + className + "\"";

        Object.keys(attrs || {}).forEach(function (name) {
            html += " " + name + "=\"" + attrs[name] + "\"";
        });

        return html + ">";
    };

    const close = function (tag) {
        return "</" + tag + ">";
    };

    const toArray = function (nodeList) {
        return Array.prototype.slice.call(nodeList);
    };

    const percentText = function (value) {
        return Math.round(value * PERCENT_SCALE) + "%";
    };

    /**
     * What to print when something throws. `(e && e.message ? e.message : e)` was written
     * out in eight places across the library before this existed, and a caught error that
     * is not an Error at all (a string, a DOMException) still has to read sensibly.
     */
    const errorText = function (e) {
        if (!e) { return String(e); }

        if (e.message) { return e.name ? e.name + ": " + e.message : e.message; }

        return String(e);
    };

    /**
     * Run someone else's callback without letting it take the caller down: a mod's
     * settings listener, a window's onClose, a drawer options pane. Returns what the
     * function returned, or undefined when it threw -- and says where in the log.
     */
    const safely = function (what, fn) {
        try {
            return fn();
        } catch (e) {
            log(what + " failed: " + errorText(e));
        }

        return undefined;
    };

    /** True while the stock HUD is toggled off; mods keep recording but stop drawing. */
    const hudHidden = function () {
        return Boolean(document.body) && document.body.classList.contains(HUD_HIDDEN_CLASS);
    };

    /** File name of the current page, e.g. "hud.html". */
    const pageName = function () {
        return location.pathname.split("/").pop() || "";
    };

    /** Walk up from `node` to `root` looking for an attribute; null when absent. */
    const closestWithAttribute = function (node, attribute, root) {
        let current = node;

        while (current && current !== root) {
            if (current.hasAttribute && current.hasAttribute(attribute)) { return current; }

            current = current.parentElement;
        }

        return null;
    };

    return {
        VERSION: VERSION,
        LOG_PREFIX: LOG_PREFIX,
        HUD_HIDDEN_CLASS: HUD_HIDDEN_CLASS,
        page: pageName(),
        log: log,
        logger: logger,
        clamp: clamp,
        el: el,
        close: close,
        toArray: toArray,
        percentText: percentText,
        errorText: errorText,
        safely: safely,
        hudHidden: hudHidden,
        closestWithAttribute: closestWithAttribute
    };
}());

window.ACEUIModLoader = ACEUIModLoader;
