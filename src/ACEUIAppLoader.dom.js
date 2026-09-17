/**
 * ACEUIAppLoader.dom -- building elements, and letting go of them again.
 *
 * Three things every UI surface in this project had rewritten for itself:
 *
 *   - **making an element with inline styles.** The library ships as a single file
 *     appended to the stock bundle and carries no stylesheet (see the drawer), so its
 *     own surfaces are styled inline. `make`/`div` are what the drawer, the settings
 *     page and the window each had a private copy of.
 *   - **the palette.** Those three copies had already drifted apart -- the same dim ink
 *     was 0.45 in one and 0.5 in the others -- so the colours live here once, as THEME.
 *   - **taking listeners off again.** An app's detach has to mirror its attach exactly,
 *     and the dev console had fourteen pairs to keep in step by hand. `listeners()` is a
 *     bag that remembers what it added:
 *
 *         const bag = ACEUIAppLoader.dom.listeners();
 *         bag.on(window, "keydown", onKey);
 *         bag.on(root, "click", onClick);
 *         ...
 *         bag.off();                      // every one of them, in one call
 *
 * Nothing here is required: an app with its own stylesheet should keep using classes.
 * This is for the surfaces that cannot have one, and for detach paths that must not
 * leak a listener into a HUD that reloads on every Escape.
 */
ACEUIAppLoader.dom = (function () {

    /**
     * The library's own palette. Apps are free to ignore it, but anything the loader
     * draws -- drawer, window frames, settings controls -- uses these so the surfaces
     * look like one product rather than three.
     */
    const THEME = {
        ink: "rgba(255, 255, 255, 0.85)",
        inkDim: "rgba(255, 255, 255, 0.5)",
        inkOff: "rgba(255, 255, 255, 0.3)",
        white: "#fff",
        accent: "#bd0000",
        on: "#44ea78",
        panelBg: "rgba(0, 0, 0, 0.92)",
        headerBg: "#1c1e1f",
        controlBg: "rgba(255, 255, 255, 0.08)",
        hoverBg: "rgba(255, 255, 255, 0.08)",
        border: "1px solid rgba(255, 255, 255, 0.1)",
        controlBorder: "1px solid rgba(255, 255, 255, 0.18)",
        font: "var(--font-family-main)"
    };

    const css = function (node, props) {
        Object.keys(props || {}).forEach(function (name) { node.style[name] = props[name]; });

        return node;
    };

    /** `make("span", { color: THEME.ink }, "hello")` -- styles and text are both optional. */
    const make = function (tag, props, text) {
        const node = css(document.createElement(tag), props);

        if (text !== undefined) { node.textContent = text; }

        return node;
    };

    const div = function (props, text) {
        return make("div", props, text);
    };

    const setClass = function (node, className, on) {
        if (!node) { return node; }

        if (on) {
            node.classList.add(className);
        } else {
            node.classList.remove(className);
        }

        return node;
    };

    /**
     * Fractions this small count as a whole pixel: Chromium lays out in 1/64 px units, so
     * a snapped edge can come back at n + 1/64, which blends 1.5 % and is invisible, and
     * chasing it would grow the margin by a full pixel.
     */
    const SNAP_EPSILON = 1 / 32;
    const SNAP_DECIMALS = 3;

    const fraction = function (x) {
        const f = x - Math.floor(x);

        return f < SNAP_EPSILON || f > 1 - SNAP_EPSILON ? 0 : f;
    };

    const pxOf = function (value) {
        return parseFloat(value) || 0;
    };

    /**
     * Nudge a box so all four edges fall on whole pixels. A box that clips animated
     * content -- a graph, a screen -- and sits at a fractional position gets its edge
     * columns and rows antialiased: the last pixel is a blend of content and background,
     * which reads as a hairline the whole height of the box, in the content's colour.
     * Layout in em puts almost every edge at a fraction. This measures the box and grows
     * its margins by the fractions, so it shrinks to start and end on whole pixels. Call
     * it once layout exists and again after anything that moves or resizes the box; it
     * is idempotent, a snapped box gets corrections of 0. The box's size must be free to
     * give (a flex item, or auto-sized), not a fixed height or width. Returns the
     * corrections applied in px, or null before the box has a size.
     */
    const snapToPixels = function (node) {
        const r = node.getBoundingClientRect();

        if (r.width === 0 || r.height === 0) { return null; }

        const fix = {
            left: fraction(r.left) === 0 ? 0 : 1 - fraction(r.left),
            top: fraction(r.top) === 0 ? 0 : 1 - fraction(r.top),
            right: fraction(r.right),
            bottom: fraction(r.bottom)
        };

        Object.keys(fix).forEach(function (side) {
            if (fix[side] === 0) { return; }

            const prop = "margin" + side.charAt(0).toUpperCase() + side.slice(1);

            node.style[prop] = (pxOf(node.style[prop]) + fix[side]).toFixed(SNAP_DECIMALS) + "px";
        });

        return fix;
    };

    /** Remove every child, for a surface that is rebuilt rather than updated. */
    const clear = function (node) {
        while (node && node.firstChild) { node.removeChild(node.firstChild); }

        return node;
    };

    /** One listener, with its own undo: `const off = dom.on(window, "blur", fn);` */
    const on = function (target, type, handler, capture) {
        if (!target || typeof target.addEventListener !== "function") {
            return function () { return false; };
        }

        target.addEventListener(type, handler, Boolean(capture));

        return function () {
            target.removeEventListener(type, handler, Boolean(capture));

            return true;
        };
    };

    /**
     * A bag of listeners that can be dropped in one call. `off()` is safe to call twice
     * and returns how many it removed, which is what a detach test can assert on.
     */
    const listeners = function () {
        const undo = [];

        return {
            on: function (target, type, handler, capture) {
                const remove = on(target, type, handler, capture);

                undo.push(remove);

                return remove;
            },
            count: function () { return undo.length; },
            off: function () {
                const removed = undo.length;

                undo.forEach(function (remove) { remove(); });
                undo.length = 0;

                return removed;
            }
        };
    };

    return {
        THEME: THEME,
        css: css,
        make: make,
        div: div,
        setClass: setClass,
        snapToPixels: snapToPixels,
        clear: clear,
        on: on,
        listeners: listeners
    };
}());
