/**
 * ACEUIAppLoader.settings -- a settings page per app, rendered by the loader.
 *
 * An app declares what it has; the loader stores the values, draws the controls in the
 * app drawer's options pane, and tells the app when something changes. The app never
 * touches storage or builds a form.
 *
 *     const opts = ACEUIAppLoader.settings.define("devconsole", [
 *         { key: "toggleKey", type: "key",    label: "Toggle key",   value: "Backquote" },
 *         { key: "scale",     type: "range",  label: "Panel scale",  value: 1, min: 0.6, max: 2, step: 0.1 },
 *         { key: "follow",    type: "toggle", label: "Follow newest", value: true },
 *         { key: "theme",     type: "choice", label: "Theme", value: "dark", options: ["dark", "light"] }
 *     ]);
 *
 *     opts.scale;                                   // the stored value, already applied
 *     ACEUIAppLoader.settings.get("devconsole", "scale");
 *     ACEUIAppLoader.settings.onChange("devconsole", function (key, value) { ... });
 *
 * Types are deliberately limited to controls this engine is known to render. Cohtml is
 * not a browser: `<input type="range">` and `<select>` are unproven here, so a range is
 * a pair of -/+ buttons and a choice cycles on click -- both patterns already proven in
 * the dev console and DOOM. Text uses a plain `<input>`, which is proven (the console
 * prompt), and takes the keyboard through ACEUIAppLoader.input while focused so typing a
 * value cannot drive the car.
 *
 * The `key` type exists because apps hardcoding hotkeys collide with whatever the player
 * has bound; this lets them move ours.
 *
 * Declaring settings is all it takes for the drawer to offer a way in. Clicking it opens
 * that app's own settings window -- an ACEUIAppLoader.window, draggable, with an [X] --
 * rather than unfolding a pane inside the drawer, which would push every row below it
 * down the list. The window can also be driven directly:
 *
 *     ACEUIAppLoader.settings.open("devconsole");
 *     ACEUIAppLoader.settings.close("devconsole");
 *     ACEUIAppLoader.settings.toggle("devconsole");
 *     ACEUIAppLoader.settings.isOpen("devconsole");
 *
 * A page with more than a handful of rows is a wall; `section` breaks it up. A section
 * spec is a header that every spec after it belongs to, until the next one. Clicking
 * the header folds the section and the loader remembers which are folded, per app. A
 * section can lay its rows out in two columns, which halves a run of toggles:
 *
 *     { key: "inputs", type: "section", label: "Inputs", columns: 2, collapsed: false },
 *
 * Values are written to both stores (see ACEUIAppLoader.persist): the HUD layout
 * container, which the game writes to disk and is the only thing that survives a restart,
 * and localStorage, which is read synchronously so a value is there the moment an app asks.
 */
ACEUIAppLoader.settings = (function () {

    /**
     * `action` and `info` carry no value: an action is a button the app handles, an info
     * is a line of text the app computes. They are here because a settings page that can
     * only hold values forces an app back to hand-building a pane for one button.
     */
    const TYPES = ["toggle", "range", "choice", "text", "key", "action", "info", "section"];
    const VALUE_TYPES = ["toggle", "range", "choice", "text", "key"];
    const HUD_PREFIX = "hud_";
    const HUD_SUFFIX = "_settings";
    const LOCAL_PREFIX = "ace";
    const LOCAL_SUFFIX = ".settings";

    /** Waiting for the player to press the key they want; see the `key` control. */
    const CAPTURE_TEXT = "press a key...";
    /** Pressing this while a key control is waiting cancels it rather than binding it. */
    const CANCEL_KEY = "Escape";
    const CLEAR_TEXT = "Reset to defaults";

    /** Sections: the glyph on a header for open and folded, the widest layout, and where the folds are kept. */
    const OPEN_GLYPH = "\u2212";
    const FOLDED_GLYPH = "+";
    const COLUMNS_MAX = 2;
    const SECTIONS_SUFFIX = ".sections";

    /** The settings window is an ACEUIAppLoader.window; this is its id and width. */
    const WINDOW_ID_SUFFIX = ".settings";
    const WINDOW_WIDTH = "17rem";

    const THEME = ACEUIAppLoader.dom.THEME;

    const persist = ACEUIAppLoader.persist;

    /** name -> { specs, values, listeners, collapsed, repaint, undo } */
    const declared = {};

    const css = ACEUIAppLoader.dom.css;
    const make = ACEUIAppLoader.dom.make;

    const hudId = function (app) {
        return HUD_PREFIX + app + HUD_SUFFIX;
    };

    const localKey = function (app) {
        return LOCAL_PREFIX + app + LOCAL_SUFFIX;
    };

    const entry = function (app) {
        return declared[app] || null;
    };

    /**
     * What to call the app in its window title. Resolved when the window opens rather
     * than when settings are declared, so it does not depend on which ran first: the
     * drawer knows the title from app.json, and the loader's description is the fallback.
     */
    const titleFor = function (name) {
        const drawer = ACEUIAppLoader.drawer;
        const listed = drawer && drawer.state ? drawer.state.apps : [];
        const found = listed.filter(function (entry) { return entry.name === name; })[0];
        const described = ACEUIAppLoader.app ? ACEUIAppLoader.app(name) : null;

        if (found && found.title) { return found.title; }

        return described && described.title ? described.title : name;
    };

    const save = function (app) {
        const held = entry(app);

        if (!held) { return; }

        persist.save(hudId(app), localKey(app), held.values);
    };

    /** Stored values for an app, HUD store first because it outlives the session. */
    const stored = function (app) {
        return persist.readHud(hudId(app)) || persist.readLocal(localKey(app)) || {};
    };

    /**
     * Which sections the player folded, per app. localStorage only: it is a view
     * preference, not a setting, and localStorage is what the app drawer's own folds use.
     */
    const storedFolds = function (app) {
        const folds = persist.readLocal(localKey(app) + SECTIONS_SUFFIX);

        return folds && typeof folds === "object" ? folds : {};
    };

    const isCollapsed = function (app, key) {
        const held = entry(app);
        const spec = specFor(app, key);

        if (!held || !spec || spec.type !== "section") { return false; }

        if (typeof held.collapsed[key] === "boolean") { return held.collapsed[key]; }

        return Boolean(spec.collapsed);
    };

    const setCollapsed = function (app, key, on) {
        const held = entry(app);

        if (!held || !specFor(app, key)) { return false; }

        held.collapsed[key] = Boolean(on);
        persist.writeLocal(localKey(app) + SECTIONS_SUFFIX, held.collapsed);
        held.repaint.forEach(function (fn) { fn(); });

        return held.collapsed[key];
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

    const notify = function (app, key, value) {
        const held = entry(app);

        if (!held) { return; }

        held.listeners.forEach(function (listener) {
            ACEUIAppLoader.safely("[settings] " + app + " listener", function () {
                listener(key, value, held.values);
            });
        });
    };

    const get = function (app, key) {
        const held = entry(app);

        return held ? held.values[key] : undefined;
    };

    const all = function (app) {
        const held = entry(app);

        return held ? held.values : {};
    };

    const specsOf = function (app) {
        const held = entry(app);

        return held ? held.specs : [];
    };

    const specFor = function (app, key) {
        return specsOf(app).filter(function (spec) { return spec.key === key; })[0] || null;
    };

    const set = function (app, key, value) {
        const held = entry(app);
        const spec = specFor(app, key);

        if (!held || !spec || VALUE_TYPES.indexOf(spec.type) < 0) { return undefined; }

        const next = coerce(spec, value);

        if (held.values[key] === next) { return next; }

        held.values[key] = next;
        save(app);
        held.repaint.forEach(function (fn) { fn(); });
        notify(app, key, next);

        return next;
    };

    const reset = function (app) {
        const held = entry(app);

        if (!held) { return; }

        held.specs.forEach(function (spec) {
            if (VALUE_TYPES.indexOf(spec.type) >= 0) { held.values[spec.key] = spec.value; }
        });
        save(app);
        held.repaint.forEach(function (fn) { fn(); });
        held.specs.forEach(function (spec) {
            if (VALUE_TYPES.indexOf(spec.type) >= 0) { notify(app, spec.key, held.values[spec.key]); }
        });
    };

    /**
     * How many listeners an app has registered. An app's attach runs again every time the
     * app drawer switches it back on, so "did detach really unsubscribe" is a question its
     * tests need to be able to ask -- the console's buffer has had the same counter for
     * the same reason.
     */
    const listenerCount = function (app) {
        const held = entry(app);

        return held ? held.listeners.length : 0;
    };

    const onChange = function (app, listener) {
        const held = entry(app);

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
        color: THEME.ink
    };

    const buttonStyle = {
        padding: "0.1rem 0.4rem",
        marginLeft: "0.25rem",
        background: THEME.controlBg,
        border: THEME.controlBorder,
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

    const toggleControl = function (app, spec, repaint) {
        const box = make("span", {
            display: "inline-block",
            width: "0.6rem",
            height: "0.6rem",
            border: "1px solid " + THEME.inkOff,
            borderRadius: "0.15rem",
            cursor: "pointer"
        });

        repaint.push(function () {
            const on = Boolean(get(app, spec.key));

            box.style.background = on ? THEME.on : "transparent";
            box.style.borderColor = on ? THEME.on : THEME.inkOff;
        });

        box.addEventListener("click", function () { set(app, spec.key, !get(app, spec.key)); });

        return box;
    };

    /**
     * A pair of buttons rather than <input type="range">: range inputs are unproven in
     * this Cohtml build, and -/+ is already how the console and DOOM scale themselves.
     */
    const rangeControl = function (app, spec, repaint) {
        const wrap = make("span", { display: "flex", flexDirection: "row", alignItems: "center" });
        const value = make("span", { minWidth: "2.2rem", textAlign: "right", color: THEME.inkDim });
        const step = typeof spec.step === "number" ? spec.step : 1;
        const digits = typeof spec.digits === "number" ? spec.digits : 2;
        const nudge = function (by) {
            return function () { set(app, spec.key, Number((Number(get(app, spec.key)) + by).toFixed(digits))); };
        };

        repaint.push(function () { value.textContent = String(get(app, spec.key)); });

        wrap.appendChild(value);
        wrap.appendChild(button("−", nudge(-step)));
        wrap.appendChild(button("+", nudge(step)));

        return wrap;
    };

    /** Clicking cycles the options: <select> is unproven here, a cycle button is not. */
    const choiceControl = function (app, spec, repaint) {
        const options = spec.options || [];
        const node = button("", function () {
            const at = options.indexOf(get(app, spec.key));

            set(app, spec.key, options[(at + 1) % options.length]);
        });

        repaint.push(function () { node.textContent = String(get(app, spec.key)); });

        return node;
    };

    const textControl = function (app, spec, repaint) {
        const node = css(document.createElement("input"), {
            width: "6rem",
            padding: "0.1rem 0.3rem",
            background: THEME.controlBg,
            border: THEME.controlBorder,
            borderRadius: "0.2rem",
            color: "#fff",
            fontFamily: THEME.font,
            fontSize: "0.68rem"
        });

        node.type = "text";
        repaint.push(function () {
            if (node !== document.activeElement) { node.value = String(get(app, spec.key)); }
        });

        node.addEventListener("input", function () { set(app, spec.key, node.value); });

        // typing a value must not also drive the car. bindFocus listens on the window as
        // well as the element, so its undo is kept: a settings window opened and closed a
        // few times would otherwise leave a pile of them behind, each still releasing the
        // keyboard on every click anywhere.
        if (ACEUIAppLoader.input) {
            const held = entry(app);
            const unbind = ACEUIAppLoader.input.bindFocus(node, "settings:" + app);

            if (held) { held.undo.push(unbind); }
        }

        return node;
    };

    /**
     * Rebindable hotkey. The app's own key is ours to move, not the player's -- this is
     * how an app avoids colliding with whatever they have bound in the game.
     */
    const keyControl = function (app, spec, repaint) {
        const held = entry(app);
        /**
         * While `stop` is set, this control is waiting for a key and the window keydown
         * listener is live. It has to be cancellable: clicking it and then thinking better
         * of it used to leave that listener bound for the rest of the session, so the next
         * key pressed anywhere -- W, on the way out of the menu -- was silently swallowed
         * and became the app's hotkey.
         */
        const listening = { stop: null };
        const node = button("", function () {
            if (listening.stop) { return; }

            const finish = function () {
                window.removeEventListener("keydown", onKey, true);
                window.removeEventListener("mousedown", onElsewhere, true);
                listening.stop = null;
                repaint.forEach(function (fn) { fn(); });
            };
            const onKey = function (e) {
                e.preventDefault();
                e.stopPropagation();

                // Escape is the way out of a menu, not a hotkey worth binding
                if (!ACEUIAppLoader.keys.is(e, CANCEL_KEY)) { set(app, spec.key, e.code || e.key); }

                finish();
            };
            const onElsewhere = function (e) {
                if (e.target !== node) { finish(); }
            };

            node.textContent = CAPTURE_TEXT;
            listening.stop = finish;
            held.undo.push(function () { if (listening.stop) { listening.stop(); } });
            window.addEventListener("keydown", onKey, true);
            window.addEventListener("mousedown", onElsewhere, true);
        });

        // while it is waiting, the prompt is what the control says
        repaint.push(function () {
            if (!listening.stop) { node.textContent = String(get(app, spec.key)); }
        });

        return node;
    };

    /** A button the app handles: `{ type: "action", label, press: fn }`. */
    const actionControl = function (app, spec) {
        return button(spec.button || "Run", function () {
            if (typeof spec.press !== "function") { return; }

            ACEUIAppLoader.safely("[settings] " + app + " action " + spec.key, function () {
                spec.press(app);
            });
        });
    };

    /**
     * A line the app computes: `{ type: "info", label, text: fn }`. Recomputed whenever
     * anything on the page repaints, so it can show live state.
     */
    const infoControl = function (app, spec, repaint) {
        const node = make("span", { color: THEME.inkDim });

        repaint.push(function () {
            try {
                node.textContent = typeof spec.text === "function" ? String(spec.text(app)) : String(spec.text || "");
            } catch (e) {
                node.textContent = "?";
            }
        });

        return node;
    };

    /**
     * A section: a header row that folds and unfolds the rows after it. Returns the body
     * the following rows go into. Two-column bodies wrap their rows at half width.
     */
    const sectionControl = function (app, spec, repaint, container) {
        const header = make("div", {
            display: "flex",
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            marginTop: "0.45rem",
            padding: "0 0 0.12rem 0",
            borderBottom: THEME.border,
            fontSize: "0.58rem",
            fontWeight: "700",
            letterSpacing: "0.1em",
            textTransform: "uppercase",
            color: THEME.inkDim,
            cursor: "pointer",
            userSelect: "none"
        });
        const glyph = make("span", { color: THEME.inkOff, fontSize: "0.68rem", marginLeft: "0.5rem" });
        const body = make("div", spec.columns === COLUMNS_MAX
            ? { display: "flex", flexDirection: "row", flexWrap: "wrap" }
            : {});

        header.appendChild(make("span", {}, spec.label || spec.key));
        header.appendChild(glyph);
        header.addEventListener("click", function () { setCollapsed(app, spec.key, !isCollapsed(app, spec.key)); });

        repaint.push(function () {
            const folded = isCollapsed(app, spec.key);

            body.style.display = folded ? "none" : (spec.columns === COLUMNS_MAX ? "flex" : "block");
            glyph.textContent = folded ? FOLDED_GLYPH : OPEN_GLYPH;
        });

        container.appendChild(header);
        container.appendChild(body);

        return body;
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

    /**
     * Give back everything the drawn controls bound outside their own elements: window
     * listeners, and a key control still waiting for a key. Called before a pane is drawn
     * again and when its window closes, so neither piles up over a session.
     */
    const teardown = function (app) {
        const held = entry(app);

        if (!held) { return 0; }

        const count = held.undo.length;

        held.undo.forEach(function (fn) {
            ACEUIAppLoader.safely("[settings] " + app + " teardown", fn);
        });
        held.undo = [];
        held.repaint = [];

        return count;
    };

    /** Draw an app's settings into `container`; the drawer calls this for its options pane. */
    const render = function (app, container) {
        const held = entry(app);

        if (!held || !container) { return null; }

        teardown(app);

        // rows go into the current section's body, or straight into the container before
        // the first section; a two-column section lays them out at half width
        const target = { body: container, columns: 1 };

        held.specs.forEach(function (spec) {
            if (spec.type === "section") {
                target.body = sectionControl(app, spec, held.repaint, container);
                target.columns = spec.columns === COLUMNS_MAX ? COLUMNS_MAX : 1;

                return;
            }

            const row = make("div", rowStyle);
            const control = CONTROLS[spec.type];

            if (target.columns === COLUMNS_MAX) {
                css(row, { width: "50%", boxSizing: "border-box", paddingRight: "0.6rem" });
            }

            row.appendChild(make("span", { color: THEME.inkDim, marginRight: "0.5rem" }, spec.label || spec.key));

            if (control) { row.appendChild(control(app, spec, held.repaint)); }

            target.body.appendChild(row);

            if (spec.hint) {
                target.body.appendChild(make("div", { color: THEME.inkDim, fontSize: "0.6rem", paddingBottom: "0.2rem", width: "100%" }, spec.hint));
            }
        });

        container.appendChild(css(button(CLEAR_TEXT, function () { reset(app); }), { marginTop: "0.6rem", marginLeft: "0" }));
        held.repaint.forEach(function (fn) { fn(); });

        return container;
    };

    // ---- the settings window -------------------------------------------------------

    /**
     * Each app's settings open as their own window, not as a panel that unfolds inside
     * the drawer: with more than a couple of apps an inline pane pushes every row below
     * it down the list and the drawer becomes unusable. The window itself is
     * ACEUIAppLoader.window, so it looks and behaves like any other app window.
     */
    const windowId = function (app) {
        return app + WINDOW_ID_SUFFIX;
    };

    const isOpen = function (app) {
        return ACEUIAppLoader.window.isOpen(windowId(app));
    };

    const close = function (app) {
        return ACEUIAppLoader.window.close(windowId(app));
    };

    const open = function (app) {
        const held = entry(app);

        if (!held) { return null; }

        const win = ACEUIAppLoader.window.open(windowId(app), {
            title: titleFor(app) + " settings",
            width: WINDOW_WIDTH,
            onClose: function () { teardown(app); }
        });

        if (win && !win.body.childNodes.length) { render(app, win.body); }

        return win;
    };

    /** Open it if it is shut, shut it if it is open. Returns true when it ended up open. */
    const toggle = function (app) {
        if (isOpen(app)) {
            close(app);

            return false;
        }

        open(app);

        return true;
    };

    /**
     * Declare an app's settings. Returns the live values object: stored values are already
     * merged in, so an app can read it immediately. Calling again replaces the schema.
     */
    const define = function (app, specs) {
        // a mistyped `type` used to drop the control with nothing said, which reads in
        // game as "my setting did not appear" with no way to tell why
        const list = (specs || []).filter(function (spec) {
            const usable = Boolean(spec) && Boolean(spec.key) && TYPES.indexOf(spec.type) >= 0;

            if (!usable) {
                ACEUIAppLoader.log("[settings] " + app + ": ignoring "
                    + (spec && spec.key ? "\"" + spec.key + "\"" : "a spec with no key")
                    + " -- type must be one of " + TYPES.join(", ")
                    + (spec && spec.type ? " (got \"" + spec.type + "\")" : ""));
            }

            return usable;
        });
        const saved = stored(app);
        const values = {};

        list.forEach(function (spec) {
            if (VALUE_TYPES.indexOf(spec.type) >= 0) { values[spec.key] = coerce(spec, saved[spec.key]); }
        });

        declared[app] = {
            specs: list,
            values: values,
            listeners: (declared[app] && declared[app].listeners) || [],
            collapsed: storedFolds(app),
            repaint: [],
            undo: []            // what the drawn controls bound outside their own elements
        };

        // the drawer offers a way in for any app that has something to configure; clicking
        // it opens this app's own window rather than unfolding a pane inside the drawer
        if (ACEUIAppLoader.drawer && typeof ACEUIAppLoader.drawer.registerOpener === "function") {
            ACEUIAppLoader.drawer.registerOpener(app, function () { toggle(app); });
        }

        return values;
    };

    return {
        TYPES: TYPES,
        define: define,
        render: render,
        teardown: teardown,
        get: get,
        set: set,
        all: all,
        specs: specsOf,
        reset: reset,
        onChange: onChange,
        listenerCount: listenerCount,
        isCollapsed: isCollapsed,
        setCollapsed: setCollapsed,
        open: open,
        close: close,
        toggle: toggle,
        isOpen: isOpen,
        windowId: windowId,
        hudId: hudId,
        localKey: localKey
    };
}());
