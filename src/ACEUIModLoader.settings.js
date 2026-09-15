/**
 * ACEUIModLoader.settings -- a settings page per mod, rendered by the loader.
 *
 * A mod declares what it has; the loader stores the values, draws the controls in the
 * app drawer's options pane, and tells the mod when something changes. The mod never
 * touches storage or builds a form.
 *
 *     const opts = ACEUIModLoader.settings.define("devconsole", [
 *         { key: "toggleKey", type: "key",    label: "Toggle key",   value: "Backquote" },
 *         { key: "scale",     type: "range",  label: "Panel scale",  value: 1, min: 0.6, max: 2, step: 0.1 },
 *         { key: "follow",    type: "toggle", label: "Follow newest", value: true },
 *         { key: "theme",     type: "choice", label: "Theme", value: "dark", options: ["dark", "light"] }
 *     ]);
 *
 *     opts.scale;                                   // the stored value, already applied
 *     ACEUIModLoader.settings.get("devconsole", "scale");
 *     ACEUIModLoader.settings.onChange("devconsole", function (key, value) { ... });
 *
 * Types are deliberately limited to controls this engine is known to render. Cohtml is
 * not a browser: `<input type="range">` and `<select>` are unproven here, so a range is
 * a pair of -/+ buttons and a choice cycles on click -- both patterns already proven in
 * the dev console and DOOM. Text uses a plain `<input>`, which is proven (the console
 * prompt), and takes the keyboard through ACEUIModLoader.input while focused so typing a
 * value cannot drive the car.
 *
 * The `key` type exists because mods hardcoding hotkeys collide with whatever the player
 * has bound; this lets them move ours.
 *
 * Declaring settings is all it takes for the drawer to offer a way in. Clicking it opens
 * that mod's own settings window -- an ACEUIModLoader.window, draggable, with an [X] --
 * rather than unfolding a pane inside the drawer, which would push every row below it
 * down the list. The window can also be driven directly:
 *
 *     ACEUIModLoader.settings.open("devconsole");
 *     ACEUIModLoader.settings.close("devconsole");
 *     ACEUIModLoader.settings.toggle("devconsole");
 *     ACEUIModLoader.settings.isOpen("devconsole");
 *
 * Values are written to both stores (see ACEUIModLoader.persist): the HUD layout
 * container, which the game writes to disk and is the only thing that survives a restart,
 * and localStorage, which is read synchronously so a value is there the moment a mod asks.
 */
ACEUIModLoader.settings = (function () {

    /**
     * `action` and `info` carry no value: an action is a button the mod handles, an info
     * is a line of text the mod computes. They are here because a settings page that can
     * only hold values forces a mod back to hand-building a pane for one button.
     */
    const TYPES = ["toggle", "range", "choice", "text", "key", "action", "info"];
    const VALUE_TYPES = ["toggle", "range", "choice", "text", "key"];
    const HUD_PREFIX = "hud_";
    const HUD_SUFFIX = "_settings";
    const LOCAL_PREFIX = "ace";
    const LOCAL_SUFFIX = ".settings";

    /** Waiting for the player to press the key they want; see the `key` control. */
    const CAPTURE_TEXT = "press a key...";
    const CLEAR_TEXT = "Reset to defaults";

    /** The settings window is an ACEUIModLoader.window; this is its id and width. */
    const WINDOW_ID_SUFFIX = ".settings";
    const WINDOW_WIDTH = "17rem";

    const INK = "rgba(255, 255, 255, 0.85)";
    const INK_DIM = "rgba(255, 255, 255, 0.5)";
    const ON_COLOUR = "#44ea78";
    const OFF_COLOUR = "rgba(255, 255, 255, 0.3)";
    const CONTROL_BG = "rgba(255, 255, 255, 0.08)";
    const CONTROL_BORDER = "1px solid rgba(255, 255, 255, 0.18)";

    const persist = ACEUIModLoader.persist;

    /** name -> { specs, values, listeners } */
    const mods = {};

    const css = function (node, props) {
        Object.keys(props).forEach(function (key) { node.style[key] = props[key]; });

        return node;
    };

    const make = function (tag, props, text) {
        const node = css(document.createElement(tag), props || {});

        if (text !== undefined) { node.textContent = text; }

        return node;
    };

    const hudId = function (mod) {
        return HUD_PREFIX + mod + HUD_SUFFIX;
    };

    const localKey = function (mod) {
        return LOCAL_PREFIX + mod + LOCAL_SUFFIX;
    };

    const entry = function (mod) {
        return mods[mod] || null;
    };

    /**
     * What to call the mod in its window title. Resolved when the window opens rather
     * than when settings are declared, so it does not depend on which ran first: the
     * drawer knows the title from mod.json, and the loader's description is the fallback.
     */
    const titleFor = function (mod) {
        const drawer = ACEUIModLoader.drawer;
        const apps = drawer && drawer.state ? drawer.state.apps : [];
        const found = apps.filter(function (app) { return app.name === mod; })[0];
        const described = ACEUIModLoader.mod ? ACEUIModLoader.mod(mod) : null;

        if (found && found.title) { return found.title; }

        return described && described.title ? described.title : mod;
    };

    const save = function (mod) {
        const held = entry(mod);

        if (!held) { return; }

        persist.save(hudId(mod), localKey(mod), held.values);
    };

    /** Stored values for a mod, HUD store first because it outlives the session. */
    const stored = function (mod) {
        return persist.readHud(hudId(mod)) || persist.readLocal(localKey(mod)) || {};
    };

    const clampNumber = function (spec, value) {
        let out = Number(value);

        if (!isFinite(out)) { out = Number(spec.value) || 0; }

        if (typeof spec.min === "number") { out = Math.max(spec.min, out); }

        if (typeof spec.max === "number") { out = Math.min(spec.max, out); }

        return out;
    };

    /** Force a stored value back into the shape its spec promises. */
    const coerce = function (spec, value) {
        if (value === undefined || value === null) { return spec.value; }

        if (spec.type === "toggle") { return Boolean(value); }

        if (spec.type === "range") { return clampNumber(spec, value); }

        if (spec.type === "choice") {
            return (spec.options || []).indexOf(value) >= 0 ? value : spec.value;
        }

        return String(value);
    };

    const notify = function (mod, key, value) {
        const held = entry(mod);

        if (!held) { return; }

        held.listeners.forEach(function (listener) {
            try {
                listener(key, value, held.values);
            } catch (e) {
                ACEUIModLoader.log("[settings] " + mod + " listener failed: " + (e && e.message ? e.message : e));
            }
        });
    };

    const get = function (mod, key) {
        const held = entry(mod);

        return held ? held.values[key] : undefined;
    };

    const all = function (mod) {
        const held = entry(mod);

        return held ? held.values : {};
    };

    const specsOf = function (mod) {
        const held = entry(mod);

        return held ? held.specs : [];
    };

    const specFor = function (mod, key) {
        return specsOf(mod).filter(function (spec) { return spec.key === key; })[0] || null;
    };

    const set = function (mod, key, value) {
        const held = entry(mod);
        const spec = specFor(mod, key);

        if (!held || !spec || VALUE_TYPES.indexOf(spec.type) < 0) { return undefined; }

        const next = coerce(spec, value);

        if (held.values[key] === next) { return next; }

        held.values[key] = next;
        save(mod);
        held.repaint.forEach(function (fn) { fn(); });
        notify(mod, key, next);

        return next;
    };

    const reset = function (mod) {
        const held = entry(mod);

        if (!held) { return; }

        held.specs.forEach(function (spec) {
            if (VALUE_TYPES.indexOf(spec.type) >= 0) { held.values[spec.key] = spec.value; }
        });
        save(mod);
        held.repaint.forEach(function (fn) { fn(); });
        held.specs.forEach(function (spec) {
            if (VALUE_TYPES.indexOf(spec.type) >= 0) { notify(mod, spec.key, held.values[spec.key]); }
        });
    };

    const onChange = function (mod, listener) {
        const held = entry(mod);

        if (!held || typeof listener !== "function") { return function () { return undefined; }; }

        held.listeners.push(listener);

        return function () {
            held.listeners = held.listeners.filter(function (l) { return l !== listener; });
        };
    };

    // ---- controls ------------------------------------------------------------------

    const rowStyle = {
        display: "flex",
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "0.2rem 0",
        fontSize: "0.68rem",
        color: INK
    };

    const buttonStyle = {
        padding: "0.1rem 0.4rem",
        marginLeft: "0.25rem",
        background: CONTROL_BG,
        border: CONTROL_BORDER,
        borderRadius: "0.2rem",
        color: "#fff",
        cursor: "pointer",
        userSelect: "none"
    };

    const button = function (text, onClick) {
        const node = make("span", buttonStyle, text);

        node.addEventListener("click", onClick);

        return node;
    };

    const toggleControl = function (mod, spec, repaint) {
        const box = make("span", {
            display: "inline-block",
            width: "0.6rem",
            height: "0.6rem",
            border: "1px solid " + OFF_COLOUR,
            borderRadius: "0.15rem",
            cursor: "pointer"
        });

        repaint.push(function () {
            const on = Boolean(get(mod, spec.key));

            box.style.background = on ? ON_COLOUR : "transparent";
            box.style.borderColor = on ? ON_COLOUR : OFF_COLOUR;
        });

        box.addEventListener("click", function () { set(mod, spec.key, !get(mod, spec.key)); });

        return box;
    };

    /**
     * A pair of buttons rather than <input type="range">: range inputs are unproven in
     * this Cohtml build, and -/+ is already how the console and DOOM scale themselves.
     */
    const rangeControl = function (mod, spec, repaint) {
        const wrap = make("span", { display: "flex", flexDirection: "row", alignItems: "center" });
        const value = make("span", { minWidth: "2.2rem", textAlign: "right", color: INK_DIM });
        const step = typeof spec.step === "number" ? spec.step : 1;
        const digits = typeof spec.digits === "number" ? spec.digits : 2;
        const nudge = function (by) {
            return function () { set(mod, spec.key, Number((Number(get(mod, spec.key)) + by).toFixed(digits))); };
        };

        repaint.push(function () { value.textContent = String(get(mod, spec.key)); });

        wrap.appendChild(value);
        wrap.appendChild(button("−", nudge(-step)));
        wrap.appendChild(button("+", nudge(step)));

        return wrap;
    };

    /** Clicking cycles the options: <select> is unproven here, a cycle button is not. */
    const choiceControl = function (mod, spec, repaint) {
        const options = spec.options || [];
        const node = button("", function () {
            const at = options.indexOf(get(mod, spec.key));

            set(mod, spec.key, options[(at + 1) % options.length]);
        });

        repaint.push(function () { node.textContent = String(get(mod, spec.key)); });

        return node;
    };

    const textControl = function (mod, spec, repaint) {
        const node = css(document.createElement("input"), {
            width: "6rem",
            padding: "0.1rem 0.3rem",
            background: CONTROL_BG,
            border: CONTROL_BORDER,
            borderRadius: "0.2rem",
            color: "#fff",
            fontFamily: "var(--font-family-main)",
            fontSize: "0.68rem"
        });

        node.type = "text";
        repaint.push(function () {
            if (node !== document.activeElement) { node.value = String(get(mod, spec.key)); }
        });

        node.addEventListener("input", function () { set(mod, spec.key, node.value); });

        // typing a value must not also drive the car
        if (ACEUIModLoader.input) { ACEUIModLoader.input.bindFocus(node, "settings:" + mod); }

        return node;
    };

    /**
     * Rebindable hotkey. The mod's own key is ours to move, not the player's -- this is
     * how a mod avoids colliding with whatever they have bound in the game.
     */
    const keyControl = function (mod, spec, repaint) {
        const node = button("", function () {
            node.textContent = CAPTURE_TEXT;

            const onKey = function (e) {
                window.removeEventListener("keydown", onKey, true);
                e.preventDefault();
                e.stopPropagation();
                set(mod, spec.key, e.code || e.key);
                repaint.forEach(function (fn) { fn(); });
            };

            window.addEventListener("keydown", onKey, true);
        });

        repaint.push(function () { node.textContent = String(get(mod, spec.key)); });

        return node;
    };

    /** A button the mod handles: `{ type: "action", label, press: fn }`. */
    const actionControl = function (mod, spec) {
        return button(spec.button || "Run", function () {
            if (typeof spec.press !== "function") { return; }

            try {
                spec.press(mod);
            } catch (e) {
                ACEUIModLoader.log("[settings] " + mod + " action " + spec.key + " failed: " + (e && e.message ? e.message : e));
            }
        });
    };

    /**
     * A line the mod computes: `{ type: "info", label, text: fn }`. Recomputed whenever
     * anything on the page repaints, so it can show live state.
     */
    const infoControl = function (mod, spec, repaint) {
        const node = make("span", { color: INK_DIM });

        repaint.push(function () {
            try {
                node.textContent = typeof spec.text === "function" ? String(spec.text(mod)) : String(spec.text || "");
            } catch (e) {
                node.textContent = "?";
            }
        });

        return node;
    };

    const CONTROLS = {
        action: actionControl,
        info: infoControl,
        toggle: toggleControl,
        range: rangeControl,
        choice: choiceControl,
        text: textControl,
        key: keyControl
    };

    /** Draw a mod's settings into `container`; the drawer calls this for its options pane. */
    const render = function (mod, container) {
        const held = entry(mod);

        if (!held || !container) { return null; }

        held.repaint = [];

        held.specs.forEach(function (spec) {
            const row = make("div", rowStyle);
            const control = CONTROLS[spec.type];

            row.appendChild(make("span", { color: INK_DIM, marginRight: "0.5rem" }, spec.label || spec.key));

            if (control) { row.appendChild(control(mod, spec, held.repaint)); }

            container.appendChild(row);

            if (spec.hint) {
                container.appendChild(make("div", { color: INK_DIM, fontSize: "0.6rem", paddingBottom: "0.2rem" }, spec.hint));
            }
        });

        container.appendChild(css(button(CLEAR_TEXT, function () { reset(mod); }), { marginTop: "0.3rem", marginLeft: "0" }));
        held.repaint.forEach(function (fn) { fn(); });

        return container;
    };

    // ---- the settings window -------------------------------------------------------

    /**
     * Each mod's settings open as their own window, not as a panel that unfolds inside
     * the drawer: with more than a couple of mods an inline pane pushes every row below
     * it down the list and the drawer becomes unusable. The window itself is
     * ACEUIModLoader.window, so it looks and behaves like any other mod window.
     */
    const windowId = function (mod) {
        return mod + WINDOW_ID_SUFFIX;
    };

    const isOpen = function (mod) {
        return ACEUIModLoader.window.isOpen(windowId(mod));
    };

    const close = function (mod) {
        return ACEUIModLoader.window.close(windowId(mod));
    };

    const open = function (mod) {
        const held = entry(mod);

        if (!held) { return null; }

        const win = ACEUIModLoader.window.open(windowId(mod), {
            title: titleFor(mod) + " settings",
            width: WINDOW_WIDTH
        });

        if (win && !win.body.childNodes.length) { render(mod, win.body); }

        return win;
    };

    /** Open it if it is shut, shut it if it is open. Returns true when it ended up open. */
    const toggle = function (mod) {
        if (isOpen(mod)) {
            close(mod);

            return false;
        }

        open(mod);

        return true;
    };

    /**
     * Declare a mod's settings. Returns the live values object: stored values are already
     * merged in, so a mod can read it immediately. Calling again replaces the schema.
     */
    const define = function (mod, specs) {
        const list = (specs || []).filter(function (spec) {
            return spec && spec.key && TYPES.indexOf(spec.type) >= 0;
        });
        const saved = stored(mod);
        const values = {};

        list.forEach(function (spec) {
            if (VALUE_TYPES.indexOf(spec.type) >= 0) { values[spec.key] = coerce(spec, saved[spec.key]); }
        });

        mods[mod] = {
            specs: list,
            values: values,
            listeners: (mods[mod] && mods[mod].listeners) || [],
            repaint: []
        };

        // the drawer offers a way in for any mod that has something to configure; clicking
        // it opens this mod's own window rather than unfolding a pane inside the drawer
        if (ACEUIModLoader.drawer && typeof ACEUIModLoader.drawer.registerOpener === "function") {
            ACEUIModLoader.drawer.registerOpener(mod, function () { toggle(mod); });
        }

        return values;
    };

    return {
        TYPES: TYPES,
        define: define,
        render: render,
        get: get,
        set: set,
        all: all,
        specs: specsOf,
        reset: reset,
        onChange: onChange,
        open: open,
        close: close,
        toggle: toggle,
        isOpen: isOpen,
        windowId: windowId,
        hudId: hudId,
        localKey: localKey
    };
}());
