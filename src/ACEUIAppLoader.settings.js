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
 * A right-click on the app's own panel (anything made with `me.panel`) opens the window
 * beside it, and a right-click on the app or on the window shuts it again. An app turns
 * that off with `define(app, specs, { rightClick: false })`, keeps the right-click that opens
 * but not the one on the window that shuts with `{ rightClickCloses: false }`, and keeps a
 * part of its panel that uses the right button itself out of it with a `data-noright`
 * attribute on that element (on the panel's root, it covers the whole panel). The player can
 * switch it off for every app in the drawer's OPTIONS. A redefine whose layout does not name
 * the two switches keeps them as they were.
 *
 * A page with more than a handful of rows is a wall; `section` breaks it up. A section
 * spec is a header that every spec after it belongs to, until the next one. Clicking
 * the header folds the section and the loader remembers which are folded, per app. A
 * section can lay its rows out in two or three columns, which halves a run of toggles:
 *
 *     { key: "inputs", type: "section", label: "Inputs", columns: 2, collapsed: false },
 *
 * A pane that reads as a form rather than a wall wants three more things, all opt-in so
 * an app drawn the old way is unchanged: `define(app, specs, { width: "36rem", hints:
 * "footer" })` widens the window and moves every hint into one line at the foot (shown for
 * the row under the pointer); a choice with `segmented: true` shows all its options as a
 * row of pills with the current one lit (`labels: { full: "Full" }` names them; without it
 * the value gets a capital); and a section with `flow: "chips"` draws its toggles as chips
 * in a wrapping row, label inside, lit when on.
 *
 * Any spec, sections included, can carry `when: function (app) { ... }`: it is drawn only
 * while that returns true, judged again on every change, so an option that means nothing
 * in the current mode (a cell row in a layout that has no cells) is not on the page, and
 * changing the mode swaps the rows at once.
 *
 * `order` is a list the player reorders by dragging; its value is the array of item keys,
 * top first. Mouse events, not HTML5 drag-and-drop, which this engine is not known to
 * support: the panel drag proves mousedown/mousemove/mouseup are enough.
 *
 *     { key: "stack", type: "order", label: "Draw order", value: ["gas", "brake"],
 *       items: [{ key: "gas", label: "Throttle" }, { key: "brake", label: "Brake" }] }
 *
 * Any row, and any order item, can carry a `swatch` drawn before its label: a colour
 * (`swatch: "#44ea78"`) or, for an app whose colours live in its stylesheet, a class and
 * attributes for the stylesheet to key on (`swatch: { className, attrs }`). A row of
 * switches named after coloured things is skimmed by colour, not read.
 *
 * Values are written to both stores (see ACEUIAppLoader.persist): the HUD layout
 * container, which the game writes to disk and is the only thing that survives a restart,
 * and localStorage, which is read synchronously so a value is there the moment an app asks.
 * If the HUD store is not there yet when an app declares its settings, it is adopted when
 * it turns up (`adopt`, like the drawer's switches): stored values replace the defaults,
 * listeners hear about it, and a value the player changed in the meantime wins instead.
 */
ACEUIAppLoader.settings = (function () {

    /**
     * `action` and `info` carry no value: an action is a button the app handles, an info
     * is a line of text the app computes. They are here because a settings page that can
     * only hold values forces an app back to hand-building a pane for one button.
     */
    const TYPES = ["toggle", "range", "choice", "text", "key", "order", "action", "info", "section"];
    const VALUE_TYPES = ["toggle", "range", "choice", "text", "key", "order"];
    /** Controls drawn as a block under their label rather than beside it. */
    const BLOCK_TYPES = ["order"];
    const HUD_PREFIX = "hud_";
    const HUD_SUFFIX = "_settings";
    const LOCAL_PREFIX = "ace";
    const LOCAL_SUFFIX = ".settings";

    /** Waiting for the player to press the key they want; see the `key` control. */
    const CAPTURE_TEXT = "press a key...";
    /** Pressing this while a key control is waiting cancels it rather than binding it. */
    const CANCEL_KEY = "Escape";
    /** Pressing this while a key control is waiting unbinds it: the value becomes "" and the hotkey never fires. */
    const CLEAR_KEY = "Delete";
    /** What a key control shows for "" unless the spec names it (`empty`). */
    const EMPTY_KEY_TEXT = "unbound";
    const CLEAR_TEXT = "Reset to defaults";

    /** The order control: how a row looks while it is being dragged. */
    const DRAG_BG = "rgba(255, 255, 255, 0.22)";
    /** A chip that is on: a wash of the on-green behind it; off: a quieter border than a button's. */
    const CHIP_ON_BG = "rgba(68, 234, 120, 0.16)";
    const CHIP_OFF_BORDER = "rgba(255, 255, 255, 0.14)";

    /** Sections: the glyph on a header for open and folded, the widest layout, and where the folds are kept. */
    const OPEN_GLYPH = "\u2212";
    const FOLDED_GLYPH = "+";
    const COLUMNS_MAX = 3;
    const SECTIONS_SUFFIX = ".sections";
    const FOLDS_HUD_SUFFIX = "_folds";
    /** A section whose toggles are drawn as chips in a wrapping row rather than as label-and-box rows. */
    const FLOW_CHIPS = "chips";
    /** define(app, specs, { hints: "footer" }): hints go in one line at the foot of the pane, shown for the row under the pointer. */
    const HINTS_FOOTER = "footer";
    const HINT_IDLE_TEXT = "";
    /** Decimals of a column width in percent; three columns are 33.333%. */
    const COLUMN_DECIMALS = 3;
    const PERCENT = 100;

    /** The settings window is an ACEUIAppLoader.window; this is its id and default width (define's `width` overrides). */
    const WINDOW_ID_SUFFIX = ".settings";
    const WINDOW_WIDTH = "17rem";
    /** A window opened by a right-click sits this far from the app, on the side with room for it. */
    const BESIDE_GAP_REM = 0.5;
    const REM_SUFFIX = "rem";
    /** The layout keys that are behaviour, not looks: a redefine that leaves them out keeps them. */
    const RIGHT_CLICK_KEYS = ["rightClick", "rightClickCloses"];

    const THEME = ACEUIAppLoader.dom.THEME;

    const persist = ACEUIAppLoader.persist;

    /** name -> { specs, values, layout, listeners, collapsed, touched, touchedFolds, repaint, undo } */
    const declared = {};

    const css = ACEUIAppLoader.dom.css;
    const make = ACEUIAppLoader.dom.make;
    const clear = ACEUIAppLoader.dom.clear;

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
        const held = entry(name);

        // a surface that is not an app row (the drawer's own pane) names itself in define's layout
        if (held && held.layout.title) { return String(held.layout.title); }

        if (found && found.title) { return found.title; }

        return described && described.title ? described.title : name;
    };

    const save = function (app) {
        const held = entry(app);

        if (!held) { return; }

        persist.save(hudId(app), localKey(app), held.values);
    };

    /** A key a stored record may carry (a hand-edited store) that must not become a merged object's prototype. */
    const PROTO_KEY = "__proto__";

    /** A stored record, or an empty one for anything that is not a plain object. */
    const recordOf = function (value) {
        return value && typeof value === "object" && !Array.isArray(value) ? value : {};
    };

    /**
     * Two stores' records, key by key: the HUD store's where it has the key (it outlives the
     * session), localStorage's for a key it lacks (a record written before that key existed), so
     * what is read does not depend on which store turned up first. A copy, lists included: the
     * HUD one is the store's own record. A damaged record adds nothing.
     */
    const mergeStores = function (local, hud) {
        const merged = {};

        [recordOf(local), recordOf(hud)].forEach(function (record) {
            Object.keys(record).forEach(function (key) {
                if (key !== PROTO_KEY) { merged[key] = Array.isArray(record[key]) ? record[key].slice() : record[key]; }
            });
        });

        return merged;
    };

    /** Stored values for an app, both stores merged (see `mergeStores`). */
    const stored = function (app) {
        return mergeStores(persist.readLocal(localKey(app)), persist.readHud(hudId(app)));
    };

    /**
     * Which sections the player folded, per app. Kept in both stores like the values
     * (see ACEUIAppLoader.persist): only the HUD layout store survives a game restart, and
     * a fold that reopened itself every launch would be worse than no fold at all.
     */
    const foldsHudId = function (app) {
        return hudId(app) + FOLDS_HUD_SUFFIX;
    };

    const foldsLocalKey = function (app) {
        return localKey(app) + SECTIONS_SUFFIX;
    };

    /** The folds, both stores merged like the values (see `mergeStores`). */
    const storedFolds = function (app) {
        return mergeStores(persist.readLocal(foldsLocalKey(app)), persist.readHud(foldsHudId(app)));
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
        held.touchedFolds = true;
        persist.save(foldsHudId(app), foldsLocalKey(app), held.collapsed);
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

    /**
     * A stored order, made whole: unknown keys dropped, duplicates dropped, and any item
     * it lacks appended in the default order -- an update that adds a channel must not
     * make it vanish, and a stored list must always be a permutation of the items.
     */
    const coerceOrder = function (spec, value) {
        const keys = (spec.items || []).map(function (item) { return item.key; });
        const fallback = Array.isArray(spec.value) ? spec.value : keys;
        const kept = (Array.isArray(value) ? value : []).filter(function (key, at, list) {
            return keys.indexOf(key) >= 0 && list.indexOf(key) === at;
        });

        return kept.concat(fallback.concat(keys).filter(function (key, at, list) {
            return keys.indexOf(key) >= 0 && kept.indexOf(key) < 0 && list.indexOf(key) === at;
        }));
    };

    /** Equal as values: arrays (an order) by content, everything else by identity. */
    const same = function (a, b) {
        if (Array.isArray(a) && Array.isArray(b)) { return a.join(",") === b.join(","); }

        return a === b;
    };

    /** Force a stored value back into the shape its spec promises. */
    const coerce = function (spec, value) {
        if (value === undefined || value === null) { return spec.value; }

        // a toggle is a boolean or nothing: a string "false" left by a hand-edited store would read as on
        if (spec.type === "toggle") { return typeof value === "boolean" ? value : spec.value; }

        if (spec.type === "order") { return coerceOrder(spec, value); }

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

        // the value the app holds, not a fresh copy of it: an order is an array
        if (same(held.values[key], next)) { return held.values[key]; }

        held.values[key] = next;
        held.touched = true;
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
        held.touched = true;
        save(app);
        held.repaint.forEach(function (fn) { fn(); });
        held.specs.forEach(function (spec) {
            if (VALUE_TYPES.indexOf(spec.type) >= 0) { notify(app, spec.key, held.values[spec.key]); }
        });
    };

    /**
     * The HUD layout store has turned up: take what it holds for every app declared so
     * far. An app whose settings the player already changed this session has a newer
     * value than the disk does, so its values are written *to* the store instead, the way
     * the drawer treats a switch flipped before the store existed. Apps that declare
     * later read both stores, key by key, in `define` (see `stored`). The folds are taken the
     * same way, key by key. A record that is not a plain object (a damaged store) is ignored.
     * Returns the keys whose values changed.
     */
    const adoptOne = function (app) {
        const held = entry(app);
        const fromHud = recordOf(persist.readHud(hudId(app)));
        const changed = [];

        if (!held) { return changed; }

        if (held.touched) {
            save(app);
        } else if (Object.keys(fromHud).length > 0) {
            held.specs.forEach(function (spec) {
                if (VALUE_TYPES.indexOf(spec.type) < 0 || !Object.prototype.hasOwnProperty.call(fromHud, spec.key)) { return; }

                const next = coerce(spec, fromHud[spec.key]);

                if (!same(held.values[spec.key], next)) {
                    held.values[spec.key] = next;
                    changed.push(spec.key);
                }
            });

            if (changed.length > 0) { persist.writeLocal(localKey(app), held.values); }
        }

        const folds = recordOf(persist.readHud(foldsHudId(app)));
        let foldsChanged = false;

        if (held.touchedFolds) {
            persist.save(foldsHudId(app), foldsLocalKey(app), held.collapsed);
        } else {
            // into the folds define read (a copy): a fold only localStorage has is kept, as define keeps it
            Object.keys(folds).forEach(function (key) {
                if (key !== PROTO_KEY && held.collapsed[key] !== folds[key]) {
                    held.collapsed[key] = folds[key];
                    foldsChanged = true;
                }
            });

            if (foldsChanged) { persist.writeLocal(foldsLocalKey(app), held.collapsed); }
        }

        if (changed.length > 0 || foldsChanged) { held.repaint.forEach(function (fn) { fn(); }); }

        if (changed.length > 0) {
            changed.forEach(function (key) { notify(app, key, held.values[key]); });
            ACEUIAppLoader.log("[settings] " + app + ": adopted from the HUD store: " + changed.join(", "));
        }

        return changed;
    };

    const adopt = function () {
        const adopted = {};

        // one app's trouble must not keep the apps after it from their stored values
        Object.keys(declared).forEach(function (app) {
            const changed = ACEUIAppLoader.safely("[settings] " + app + " adopt", function () { return adoptOne(app); }) || [];

            if (changed.length > 0) { adopted[app] = changed; }
        });

        return adopted;
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

    /**
     * A row is swatch (optional), label, control; the label grows to push the control to
     * the right edge, so the layout is the same with or without a swatch.
     */
    const rowStyle = {
        display: "flex",
        flexDirection: "row",
        alignItems: "center",
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

    /**
     * A thin upright bar, deliberately nothing like the toggle's square: a row that reads
     * "square, name, square" makes the colour chip look like a second switch.
     */
    const swatchStyle = {
        display: "block",
        flexShrink: "0",
        width: "0.2rem",
        height: "0.8rem",
        borderRadius: "0.1rem",
        marginRight: "0.45rem"
    };

    /** A colour chip before a label: a colour string, or a class and attributes the app's stylesheet colours. */
    const swatch = function (def) {
        const node = make("span", swatchStyle);

        if (typeof def === "string") {
            node.style.background = def;

            return node;
        }

        if (def.className) { node.className = def.className; }

        if (def.color) { node.style.background = def.color; }

        Object.keys(def.attrs || {}).forEach(function (name) { node.setAttribute(name, def.attrs[name]); });

        return node;
    };

    /**
     * The drag handle on an order row: two hairlines drawn with borders, because the
     * glyph for it (U+2261) is not in the game's typeface and rendered as a box.
     */
    const grip = function () {
        return make("span", {
            display: "block",
            flexShrink: "0",
            width: "0.5rem",
            height: "0.22rem",
            borderTop: "1px solid " + THEME.inkOff,
            borderBottom: "1px solid " + THEME.inkOff,
            marginRight: "0.45rem"
        });
    };

    const button = function (text, onClick) {
        const node = make("span", buttonStyle, text);

        node.addEventListener("click", onClick);

        return node;
    };

    const toggleControl = function (app, spec, repaint) {
        const box = make("span", {
            display: "block",
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

        // `unit` names what the number is ("2 rem", "350 ms"); a bare number in a pane of mixed units reads as nothing
        repaint.push(function () { value.textContent = String(get(app, spec.key)) + (spec.unit ? " " + spec.unit : ""); });

        wrap.appendChild(value);
        wrap.appendChild(button("−", nudge(-step)));
        wrap.appendChild(button("+", nudge(step)));

        return wrap;
    };

    /** What a choice's option is called on screen: the spec's `labels` map, else the value with a capital. */
    const optionText = function (spec, value) {
        const text = String(value);

        if (spec.labels && spec.labels[value]) { return String(spec.labels[value]); }

        return text.charAt(0).toUpperCase() + text.slice(1);
    };

    /**
     * A choice with `segmented: true`: every option on show at once as a row of joined
     * pills, the current one lit, so the player sees what the alternatives are without
     * cycling through them. For a handful of short options; a long list wants the cycle.
     */
    const segmentedControl = function (app, spec, repaint) {
        const options = spec.options || [];
        const wrap = make("span", {
            display: "flex",
            flexDirection: "row",
            alignItems: "stretch",
            marginLeft: "0.25rem",
            border: THEME.controlBorder,
            borderRadius: "0.2rem",
            overflow: "hidden",
            userSelect: "none"
        });
        const pills = options.map(function (option, at) {
            const pill = make("span", {
                padding: "0.1rem 0.5rem",
                borderLeft: at === 0 ? "none" : THEME.controlBorder,
                color: THEME.inkDim,
                cursor: "pointer",
                whiteSpace: "nowrap"
            }, optionText(spec, option));

            pill.addEventListener("click", function () { set(app, spec.key, option); });
            wrap.appendChild(pill);

            return pill;
        });

        repaint.push(function () {
            const current = get(app, spec.key);

            pills.forEach(function (pill, at) {
                const on = options[at] === current;

                pill.style.background = on ? THEME.controlBg : "transparent";
                pill.style.color = on ? THEME.white : THEME.inkDim;
                pill.style.fontWeight = on ? "700" : "400";
            });
        });

        return wrap;
    };

    /** Clicking cycles the options: <select> is unproven here, a cycle button is not. */
    const choiceControl = function (app, spec, repaint) {
        if (spec.segmented) { return segmentedControl(app, spec, repaint); }

        const options = spec.options || [];
        const node = button("", function () {
            const at = options.indexOf(get(app, spec.key));

            set(app, spec.key, options[(at + 1) % options.length]);
        });

        repaint.push(function () { node.textContent = String(get(app, spec.key)); });

        return node;
    };

    /**
     * A toggle drawn as a chip: its own label inside a pill that lights up when it is on.
     * A section of switches becomes one wrapping row of them instead of a column of
     * label-and-box rows, which is how a `flow: "chips"` section lays its toggles out.
     */
    const chipControl = function (app, spec, repaint) {
        const chip = make("span", {
            display: "flex",
            flexDirection: "row",
            alignItems: "center",
            padding: "0.15rem 0.55rem",
            margin: "0 0.3rem 0.3rem 0",
            border: THEME.controlBorder,
            borderRadius: "0.9rem",
            color: THEME.inkDim,
            cursor: "pointer",
            userSelect: "none",
            whiteSpace: "nowrap"
        });

        if (spec.swatch) { chip.appendChild(swatch(spec.swatch)); }

        chip.appendChild(make("span", {}, spec.label || spec.key));

        repaint.push(function () {
            const on = Boolean(get(app, spec.key));

            chip.style.background = on ? CHIP_ON_BG : "transparent";
            chip.style.borderColor = on ? THEME.on : CHIP_OFF_BORDER;
            chip.style.color = on ? THEME.white : THEME.inkDim;
        });

        chip.addEventListener("click", function () { set(app, spec.key, !get(app, spec.key)); });

        return chip;
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

                // Escape is the way out of a menu, not a hotkey worth binding; Delete unbinds
                if (ACEUIAppLoader.keys.is(e, CLEAR_KEY)) {
                    set(app, spec.key, "");
                } else if (!ACEUIAppLoader.keys.is(e, CANCEL_KEY)) {
                    set(app, spec.key, e.code || e.key);
                }

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

        // while it is waiting, the prompt is what the control says; an unbound key says so
        repaint.push(function () {
            const value = String(get(app, spec.key));

            if (!listening.stop) { node.textContent = value || spec.empty || EMPTY_KEY_TEXT; }
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

    /** How many columns a section asked for, held to 1..COLUMNS_MAX. */
    const columnsOf = function (spec) {
        const asked = Math.floor(Number(spec.columns)) || 1;

        return Math.min(COLUMNS_MAX, Math.max(1, asked));
    };

    /** A body whose rows sit side by side: more than one column, or chips. */
    const flowsAcross = function (spec) {
        return columnsOf(spec) > 1 || spec.flow === FLOW_CHIPS;
    };

    /**
     * A section: a header row that folds and unfolds the rows after it. Returns the body
     * the following rows go into. A body with columns, or of chips, wraps its rows.
     */
    const sectionControl = function (app, spec, repaint, container, applies) {
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
            color: THEME.inkDim,
            cursor: "pointer",
            userSelect: "none"
        });
        const glyph = make("span", { color: THEME.inkOff, fontSize: "0.68rem", marginLeft: "0.5rem" });
        const across = flowsAcross(spec);
        const body = make("div", across
            ? { display: "flex", flexDirection: "row", flexWrap: "wrap", alignItems: "center", paddingTop: spec.flow === FLOW_CHIPS ? "0.3rem" : "0" }
            : {});

        // upper-cased here, not by the stylesheet: this engine ignores text-transform and
        // logs a warning for every element that asks for it, on every frame
        header.appendChild(make("span", {}, String(spec.label || spec.key).toUpperCase()));
        header.appendChild(glyph);
        header.addEventListener("click", function () { setCollapsed(app, spec.key, !isCollapsed(app, spec.key)); });

        repaint.push(function () {
            const folded = isCollapsed(app, spec.key);
            const shown = applies(spec);

            header.style.display = shown ? "flex" : "none";
            body.style.display = folded || !shown ? "none" : (across ? "flex" : "block");
            glyph.textContent = folded ? FOLDED_GLYPH : OPEN_GLYPH;
        });

        container.appendChild(header);
        container.appendChild(body);

        return body;
    };

    /**
     * A list the player reorders by dragging a row: `{ type: "order", label, items: [{ key,
     * label }], value: [keys, top first] }`. Rows are moved in the DOM as the cursor passes
     * their middles, so the list reorders live under the hand; the value is written once,
     * on release. The window listeners are undone with the pane, like the key control's.
     */
    const orderControl = function (app, spec, repaint) {
        const held = entry(app);
        const items = spec.items || [];
        const list = make("div", { display: "flex", flexDirection: "column", width: "100%", marginTop: "0.1rem", fontSize: rowStyle.fontSize });
        const rows = {};
        /**
         * `top` and `pitch` are the slot geometry, measured once when the row is pressed.
         * The first version measured the rows on every move, but moving a row in the DOM
         * changes what is under the cursor, which moved it back -- and in Cohtml the rects
         * after a DOM move are stale until the next frame anyway. The slots do not move
         * while the rows are being shuffled between them, so they are what to measure.
         */
        const drag = { key: null, order: null, top: 0, pitch: 0 };

        const rowOf = function (item) {
            const row = make("div", {
                display: "flex",
                flexDirection: "row",
                alignItems: "center",
                padding: "0.1rem 0.35rem",
                marginBottom: "0.1rem",
                background: THEME.controlBg,
                border: THEME.controlBorder,
                borderRadius: "0.2rem",
                cursor: "grab",
                userSelect: "none"
            });

            row.appendChild(grip());

            if (item.swatch) { row.appendChild(swatch(item.swatch)); }

            row.appendChild(make("span", { color: THEME.ink }, item.label || item.key));

            return row;
        };

        /** Put the rows in the DOM in `order`. */
        const arrange = function (order) {
            order.forEach(function (key) {
                if (rows[key]) { list.appendChild(rows[key]); }
            });
        };

        /** The slot the cursor is over, from the geometry measured when the drag began. */
        const indexAt = function (y, order) {
            if (drag.pitch <= 0) { return order.indexOf(drag.key); }

            return ACEUIAppLoader.clamp(Math.floor((y - drag.top) / drag.pitch), 0, order.length - 1);
        };

        const moved = function (order, from, to) {
            const next = order.slice();

            next.splice(to, 0, next.splice(from, 1)[0]);

            return next;
        };

        const onMove = function (e) {
            const from = drag.order.indexOf(drag.key);
            const to = indexAt(e.clientY, drag.order);

            if (to !== from) {
                drag.order = moved(drag.order, from, to);
                arrange(drag.order);
            }
        };

        // also the pane's teardown, with no event: that ends it too
        const finish = function (e) {
            // the middle or right button let go during the drag: the left is still held, the drag goes on
            if (!drag.key || ACEUIAppLoader.otherButton(e)) { return; }

            const done = drag.order;

            window.removeEventListener("mousemove", onMove, true);
            window.removeEventListener("mouseup", finish, true);
            rows[drag.key].style.background = THEME.controlBg;
            drag.key = null;
            drag.order = null;
            set(app, spec.key, done);
        };

        const start = function (key, e) {
            // a middle or right press on a row is not a reorder (a right one is the window's own right-click)
            if (drag.key || ACEUIAppLoader.otherButton(e)) { return; }

            const box = list.getBoundingClientRect();

            e.preventDefault();
            drag.key = key;
            drag.order = (get(app, spec.key) || []).slice();
            drag.top = box.top;
            drag.pitch = drag.order.length > 0 ? box.height / drag.order.length : 0;
            rows[key].style.background = DRAG_BG;
            window.addEventListener("mousemove", onMove, true);
            window.addEventListener("mouseup", finish, true);

            // a pane torn down mid-drag must not leave the window listeners behind
            if (held) { held.undo.push(finish); }
        };

        items.forEach(function (item) {
            rows[item.key] = rowOf(item);
            rows[item.key].addEventListener("mousedown", function (e) { start(item.key, e); });
        });

        // a reset or a set from elsewhere re-sorts the rows; not under a hand mid-drag
        repaint.push(function () {
            if (!drag.key) { arrange(get(app, spec.key) || []); }
        });

        return list;
    };

    const CONTROLS = {
        order: orderControl,
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

        /**
         * A spec with `when` (a function of the app name) is drawn only while it says so:
         * an option that means nothing in the current mode is not on the page. Judged on
         * every repaint, so a change to the option it depends on swaps the rows at once.
         * A `when` that throws counts as applying, so a bug hides nothing.
         */
        const applies = function (spec) {
            if (typeof spec.when !== "function") { return true; }

            try {
                return Boolean(spec.when(app));
            } catch (e) {
                return true;
            }
        };
        const watchWhen = function (node, spec, shownDisplay) {
            if (typeof spec.when !== "function") { return; }

            held.repaint.push(function () { node.style.display = applies(spec) ? shownDisplay : "none"; });
        };
        const footerHints = held.layout.hints === HINTS_FOOTER;
        // with hints in the footer, the line shows the hint of whatever the pointer is over
        const footer = footerHints ? make("span", { color: THEME.inkDim, fontSize: "0.6rem", flex: "1 1 auto", minHeight: "0.8rem", paddingRight: "0.6rem" }, HINT_IDLE_TEXT) : null;
        const hintOnHover = function (node, spec) {
            if (!footer || !spec.hint) { return; }

            node.addEventListener("mouseover", function () { footer.textContent = spec.hint; });
            node.addEventListener("mouseout", function () { footer.textContent = HINT_IDLE_TEXT; });
        };

        // rows go into the current section's body, or straight into the container before
        // the first section; a section with columns lays them out side by side, a chips
        // section draws its toggles as chips
        const target = { body: container, columns: 1, chips: false };

        held.specs.forEach(function (spec) {
            if (spec.type === "section") {
                target.body = sectionControl(app, spec, held.repaint, container, applies);
                target.columns = columnsOf(spec);
                target.chips = spec.flow === FLOW_CHIPS;

                return;
            }

            const control = CONTROLS[spec.type];

            if (target.chips && spec.type === "toggle") {
                const chip = chipControl(app, spec, held.repaint);

                hintOnHover(chip, spec);
                watchWhen(chip, spec, "flex");
                target.body.appendChild(chip);

                return;
            }

            const row = make("div", rowStyle);

            watchWhen(row, spec, rowStyle.display);

            if (target.columns > 1) {
                css(row, { width: (PERCENT / target.columns).toFixed(COLUMN_DECIMALS) + "%", boxSizing: "border-box", paddingRight: "0.6rem" });
            } else if (target.chips) {
                // among chips in a wrapping row, an ordinary row takes a line of its own, as ui.md says, its
                // control at the right edge; left to its content it sat on the chips' line (second review, 2026-09-24)
                css(row, { width: PERCENT + "%", boxSizing: "border-box" });
            }

            if (spec.swatch) { row.appendChild(swatch(spec.swatch)); }

            row.appendChild(make("span", { color: THEME.inkDim, marginRight: "0.5rem", flex: "1 1 auto" }, spec.label || spec.key));

            if (control && BLOCK_TYPES.indexOf(spec.type) < 0) { row.appendChild(control(app, spec, held.repaint)); }

            hintOnHover(row, spec);
            target.body.appendChild(row);

            // a block control (a list) goes under its label, the full width of the pane
            if (control && BLOCK_TYPES.indexOf(spec.type) >= 0) {
                const block = control(app, spec, held.repaint);

                // hidden with its label when the spec's `when` says so (full review, 2026-09-24: the list stayed)
                watchWhen(block, spec, block.style.display || "block");
                target.body.appendChild(block);
            }

            if (spec.hint && !footerHints) {
                const hint = make("div", { color: THEME.inkDim, fontSize: "0.6rem", paddingBottom: "0.2rem", width: "100%" }, spec.hint);

                watchWhen(hint, spec, "block");
                target.body.appendChild(hint);
            }
        });

        if (footer) {
            // one line at the foot: the hint on the left, the reset on the right
            const foot = make("div", { display: "flex", flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: "0.6rem" });

            foot.appendChild(footer);
            foot.appendChild(css(button(CLEAR_TEXT, function () { reset(app); }), { marginLeft: "0", flexShrink: "0" }));
            container.appendChild(foot);
        } else {
            container.appendChild(css(button(CLEAR_TEXT, function () { reset(app); }), { marginTop: "0.6rem", marginLeft: "0" }));
        }

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

    /** What 1rem is, in px, as the drawer reads it (it knows what the stock publishes); 0 without one, and then no spot is worked out. */
    const pxPerRem = function () {
        const drawer = ACEUIAppLoader.drawer;

        return drawer && typeof drawer.pxPerRem === "function" ? drawer.pxPerRem() : 0;
    };

    const px = function (n) { return Math.round(n) + "px"; };

    /**
     * Where a window `width` wide (a rem length, as define's layout gives it; any other unit
     * gives no spot, and the window opens where a plain open would) goes beside
     * `anchor`: on the side of it with more room, when the window fits there, its top lined up
     * with the app's in the upper half of the screen and its bottom in the lower half; with no
     * room on either side, under the app (over it in the lower half). As window options, the
     * lower-half and left-side spots measured from the far edge, so the window's own height
     * and width need not be known; once it is laid out the panel module keeps it on screen
     * and stores it (`placed`). Null when there is nothing to go by (a hidden app).
     */
    const besideSpot = function (anchor, width) {
        if (!anchor || typeof anchor.getBoundingClientRect !== "function") { return null; }

        const box = anchor.getBoundingClientRect();
        const frame = ACEUIAppLoader.window.container().getBoundingClientRect();
        const rem = pxPerRem();
        const gap = BESIDE_GAP_REM * rem;
        const text = String(width);
        // the window's frame is on top of the width asked for
        const wide = text.slice(-REM_SUFFIX.length) === REM_SUFFIX ? parseFloat(text) * rem + 2 * ACEUIAppLoader.window.BORDER_PX : 0;

        if (!(box.width > 0) || !(frame.width > 0) || !(rem > 0) || !(wide > 0)) { return null; }

        const roomLeft = box.left - frame.left;
        const roomRight = frame.right - box.right;
        const upper = box.top + box.height / 2 - frame.top < frame.height / 2;
        const spot = {};

        if (Math.max(roomLeft, roomRight) >= wide + gap) {
            if (roomRight >= roomLeft) { spot.left = px(box.right - frame.left + gap); } else { spot.right = px(frame.right - box.left + gap); }

            if (upper) { spot.top = px(box.top - frame.top); } else { spot.bottom = px(frame.bottom - box.bottom); }

            return spot;
        }

        spot.left = px(ACEUIAppLoader.clamp(roomLeft, 0, Math.max(0, frame.width - wide)));

        if (upper) { spot.top = px(box.bottom - frame.top + gap); } else { spot.bottom = px(frame.bottom - box.top + gap); }

        return spot;
    };

    /**
     * Open the app's window. `near` (optional) is an element to open it beside, each time: a
     * position the player dragged the window to is restored over it all the same.
     */
    const open = function (app, near) {
        const held = entry(app);

        if (!held) { return null; }

        const width = held.layout.width || WINDOW_WIDTH;
        const spot = near ? besideSpot(near, width) : null;
        const options = {
            title: titleFor(app) + " settings",
            width: width,
            onClose: function () { teardown(app); },
            onRightClick: function () { return rightClickWindow(app); },
            placed: Boolean(spot)
        };

        if (spot) { Object.assign(options, spot); }

        const win = ACEUIAppLoader.window.open(windowId(app), options);

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
     * Whether a right-click opens and shuts this app's window: it has settings, it did not
     * declare `rightClick: false`, and the player has not switched it off in the drawer.
     */
    const rightClickable = function (app) {
        const held = entry(app);
        const drawer = ACEUIAppLoader.drawer;

        if (!held || !held.specs.length || held.layout.rightClick === false) { return false; }

        if (drawer && typeof drawer.rightClickOn === "function") { return drawer.rightClickOn(); }

        return true;
    };

    /**
     * A right-click on the app's panel (me.panel wires it): the window opens beside `near`,
     * or shuts when it is open. Returns true when it did either.
     */
    const rightClick = function (app, near) {
        if (!rightClickable(app)) { return false; }

        if (isOpen(app)) {
            close(app);
            ACEUIAppLoader.log("[settings] " + app + ": closed by a right-click on the app");

            return true;
        }

        open(app, near);
        ACEUIAppLoader.log("[settings] " + app + ": opened by a right-click on the app");

        return true;
    };

    /** A right-click on the window itself shuts it, unless the app declared `rightClickCloses: false`. */
    const rightClickWindow = function (app) {
        const held = entry(app);

        if (!rightClickable(app) || held.layout.rightClickCloses === false || !isOpen(app)) { return false; }

        close(app);
        ACEUIAppLoader.log("[settings] " + app + ": closed by a right-click on its window");

        return true;
    };

    /**
     * define's layout: a new one replaces the last, except that the right-click switches carry
     * over when it does not name them, so a redefine for a wider pane cannot quietly switch back
     * on what the app turned off.
     */
    const layoutFor = function (next, last) {
        if (!next) { return last || {}; }

        const out = Object.assign({}, next);

        if (last) {
            RIGHT_CLICK_KEYS.forEach(function (key) {
                if (!Object.prototype.hasOwnProperty.call(out, key) && Object.prototype.hasOwnProperty.call(last, key)) { out[key] = last[key]; }
            });
        }

        return out;
    };

    /**
     * Declare an app's settings. Returns the live values object: stored values are already
     * merged in, so an app can read it immediately. Calling again replaces the schema.
     *
     * `layout`, optional, is how the pane is drawn: `{ width: "36rem" }` for a wider window
     * (sections with `columns: 2` or `3` and segmented choices want the room) and
     * `{ hints: "footer" }` to show hints in one line at the foot, for the row under the
     * pointer, instead of a line under every row. `{ rightClick: false }` turns right-click
     * off for this app, opening and shutting alike; `{ rightClickCloses: false }` stops only a
     * right-click on the window shutting it (see the top of this file). Left out, a redefine
     * keeps the last one.
     */
    const define = function (app, specs, layout) {
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
        const last = entry(app);
        // an app that declares in its attach, switched off and on in the drawer with its window open: the old
        // controls let go of what they bound while the entry that lists it is still here, and are drawn again after.
        // Before the stored values are read, so what letting go commits (an order drag under way) is read back
        const redraw = Boolean(last) && isOpen(app);

        if (redraw) { teardown(app); }

        const saved = stored(app);
        const values = {};

        list.forEach(function (spec) {
            // own keys only: a spec named like an Object member ("toString") must not read the member as its value
            if (VALUE_TYPES.indexOf(spec.type) >= 0) { values[spec.key] = coerce(spec, Object.prototype.hasOwnProperty.call(saved, spec.key) ? saved[spec.key] : undefined); }
        });

        declared[app] = {
            specs: list,
            values: values,
            layout: layoutFor(layout, last ? last.layout : null),
            listeners: (last && last.listeners) || [],
            collapsed: storedFolds(app),
            touched: false,     // set() or reset() ran this session: newer than the disk
            touchedFolds: false,
            repaint: [],
            undo: []            // what the drawn controls bound outside their own elements
        };

        // the drawer offers a way in for any app that has something to configure; clicking
        // it opens this app's own window rather than unfolding a pane inside the drawer
        if (ACEUIAppLoader.drawer && typeof ACEUIAppLoader.drawer.registerOpener === "function") {
            ACEUIAppLoader.drawer.registerOpener(app, function () { toggle(app); });
        }

        // a settings window open when the HUD reloaded (Escape and resume) comes back: the
        // window module remembers it was open, and this is how it is opened again
        if (ACEUIAppLoader.window && typeof ACEUIAppLoader.window.reopen === "function") {
            ACEUIAppLoader.window.reopen(windowId(app), function () { open(app); });
        }

        if (redraw) {
            const win = ACEUIAppLoader.window.get(windowId(app));

            if (win) {
                win.root.style.width = declared[app].layout.width || WINDOW_WIDTH;
                win.setTitle(titleFor(app) + " settings");
                clear(win.body);
                render(app, win.body);
            }
        }

        return values;
    };

    // the store appears a little after app scripts may have run; whatever it holds for
    // the apps declared by then replaces their defaults (see adopt)
    persist.whenHudReady(adopt);

    return {
        TYPES: TYPES,
        define: define,
        adopt: adopt,
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
        rightClick: rightClick,
        rightClickable: rightClickable,
        rightClickWindow: rightClickWindow,
        besideSpot: besideSpot,
        stored: stored,
        BESIDE_GAP_REM: BESIDE_GAP_REM,
        WINDOW_WIDTH: WINDOW_WIDTH,
        isOpen: isOpen,
        windowId: windowId,
        hudId: hudId,
        localKey: localKey
    };
}());
