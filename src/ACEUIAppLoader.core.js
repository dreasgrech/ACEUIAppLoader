/**
 * ACEUIAppLoader.core -- the root namespace and the small helpers every app uses.
 *
 * First of the library files appended to the stock `uiresources/js/cohtml.js`
 * (see tools/build_loader.py for the order), so it runs on every Gameface page
 * before Kunos' bundle. Later files add one namespace each (`ACEUIAppLoader.console`,
 * `.persist`, `.panel`, `.loop`, `.loader`); apps only ever talk to `ACEUIAppLoader.*`.
 *
 * Classic scripts: a top-level `const` is a page-wide binding but not a window
 * property, so the module is also assigned to `window.ACEUIAppLoader` for apps that
 * detect the loader that way.
 */
const ACEUIAppLoader = (function () {

    /** Loader/library version -- keep in step with the VERSION file at the repo root. */
    const VERSION = "0.27.0";

    /** Prefix of every loader log line; the game log and check_ingame_log.py grep for it. */
    const LOG_PREFIX = "[ACEUIAppLoader]";

    /** The stock HUD toggles this class on <body> when the HUD is hidden. */
    const HUD_HIDDEN_CLASS = "hide-hud";

    /** The page the stock HUD layout store lives on; other pages never get one. */
    const HUD_PAGE = "hud.html";

    /** MouseEvent.button for the middle and the right button. The stock UI never reads it; DOOM's right-click "use" does. */
    const MIDDLE_BUTTON = 1;
    const RIGHT_BUTTON = 2;

    const PERCENT_SCALE = 100;

    const log = function (message) {
        console.log(LOG_PREFIX + " " + message);
    };

    /** Prefixed logger for apps: ACEUIAppLoader.logger("[PedalGraph]")("hello"). */
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

    /** What errorText says of a thrown value that cannot be printed. */
    const UNPRINTABLE_ERROR = "(an error that cannot be printed)";

    /**
     * What to print when something throws. `(e && e.message ? e.message : e)` was written
     * out in eight places across the library before this existed, and a caught error that
     * is not an Error at all (a string, a DOMException) still has to read sensibly.
     */
    const errorText = function (e) {
        // called inside catch blocks: a thrown value that cannot be printed must not throw again from there
        try {
            if (!e) { return String(e); }

            if (e.message) { return e.name ? e.name + ": " + e.message : String(e.message); }

            return String(e);
        } catch (ignore) { /* an object with no string form, a getter that throws */ }

        return UNPRINTABLE_ERROR;
    };

    /**
     * Run someone else's callback without letting it take the caller down: an app's
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

    /**
     * Name a piece of work, so a profiler can say how long *that* took rather than only
     * how long the app took. A profiler fills `ACEUIAppLoader.profiler` with something
     * that has a `section(name, fn)`; with nothing there this is a property read and a
     * call through, which is what an app pays for being profilable when nobody is.
     *
     *     ACEUIAppLoader.section("render", function () { renderFrame(state, v, frac); });
     *
     * Sections nest: one inside another shows up as its child, which is what turns a flat
     * "this app costs 2 ms" into a tree of where the 2 ms went.
     */
    const section = function (name, fn) {
        const sink = ACEUIAppLoader.profiler;

        if (!sink || typeof sink.section !== "function") { return fn(); }

        return sink.section(name, fn);
    };

    /** True while the stock HUD is toggled off; apps keep recording but stop drawing. */
    const hudHidden = function () {
        return Boolean(document.body) && document.body.classList.contains(HUD_HIDDEN_CLASS);
    };

    /** File name of the current page, e.g. "hud.html". */
    const pageName = function () {
        return location.pathname.split("/").pop() || "";
    };

    /**
     * An event (a press or a release) of the middle or the right button. Anything else counts as the left one: what
     * the engine reports for the left button is unmeasured, and a press with no button field
     * at all must still drag and click as it always did.
     */
    const otherButton = function (e) {
        return Boolean(e) && (e.button === MIDDLE_BUTTON || e.button === RIGHT_BUTTON);
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
        HUD_PAGE: HUD_PAGE,
        RIGHT_BUTTON: RIGHT_BUTTON,
        page: pageName(),
        log: log,
        logger: logger,
        clamp: clamp,
        el: el,
        close: close,
        toArray: toArray,
        percentText: percentText,
        section: section,
        /**
         * The sink `section` above calls into, filled by a profiler while it is recording
         * and nulled when it stops. Not the profiler app: that is
         * `ACEUIAppLoader.shared.get("profiler")`, which is its panel. This is one method,
         * and apps never touch it directly.
         */
        profiler: null,
        errorText: errorText,
        safely: safely,
        hudHidden: hudHidden,
        otherButton: otherButton,
        closestWithAttribute: closestWithAttribute
    };
}());

window.ACEUIAppLoader = ACEUIAppLoader;
