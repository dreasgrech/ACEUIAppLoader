/**
 * ACEUIModLoader.dom -- building elements, and letting go of them again.
 *
 * Three things every UI surface in this project had rewritten for itself:
 *
 *   - **making an element with inline styles.** The library ships as a single file
 *     appended to the stock bundle and carries no stylesheet (see the drawer), so its
 *     own surfaces are styled inline. `make`/`div` are what the drawer, the settings
 *     page and the window each had a private copy of.
 *   - **the palette.** Those three copies had already drifted apart -- the same dim ink
 *     was 0.45 in one and 0.5 in the others -- so the colours live here once, as THEME.
 *   - **taking listeners off again.** A mod's detach has to mirror its attach exactly,
 *     and the dev console had fourteen pairs to keep in step by hand. `listeners()` is a
 *     bag that remembers what it added:
 *
 *         const bag = ACEUIModLoader.dom.listeners();
 *         bag.on(window, "keydown", onKey);
 *         bag.on(root, "click", onClick);
 *         ...
 *         bag.off();                      // every one of them, in one call
 *
 * Nothing here is required: a mod with its own stylesheet should keep using classes.
 * This is for the surfaces that cannot have one, and for detach paths that must not
 * leak a listener into a HUD that reloads on every Escape.
 */
ACEUIModLoader.dom = (function () {

    /**
     * The library's own palette. Mods are free to ignore it, but anything the loader
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
        clear: clear,
        on: on,
        listeners: listeners
    };
}());
