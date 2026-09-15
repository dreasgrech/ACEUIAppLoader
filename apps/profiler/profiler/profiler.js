/**
 * ACE UI Profiler -- a UI mod for Assetto Corsa EVO, built on the ACEUIModLoader library.
 *
 * The loader creates `<div id="profiler">` inside the HUD container before this
 * script runs and `ACEUIModLoader.mod("profiler")` describes the mod (name, version
 * from mod.json, title, root, a prefixed logger, derived storage keys), so none of
 * that is declared here. Styling lives in profiler.css.
 *
 * Cohtml rules: build the markup once, then only change textContent, classes,
 * one attribute and transforms per frame; never rebuild SVG geometry.
 */
const ACEUIProfiler = (function () {

    const me = ACEUIModLoader.mod("profiler");

    /** Class names shared with profiler.css. */
    const CLASS = {
        root: "ace-profiler",
        header: "pr-header",
        body: "pr-body",
        value: "pr-value"
    };

    const el = ACEUIModLoader.el;
    const close = ACEUIModLoader.close;

    // ---- markup ------------------------------------------------------------------

    const markup = function () {
        return el("div", CLASS.header) + me.title + close("div")
            + el("div", CLASS.body) + el("span", CLASS.value) + "-" + close("span") + close("div");
    };

    /** Build the DOM once (or re-use it) and return the state the loop works on. */
    const create = function (root) {
        root.classList.add(CLASS.root);

        if (!root.querySelector("." + CLASS.body)) { root.innerHTML = markup(); }

        return {
            root: root,
            value: root.querySelector("." + CLASS.value),
            lastText: "",
            panel: null,                // ACEUIModLoader.panel state (drag + position)
            loop: null                  // ACEUIModLoader.loop handle
        };
    };

    // ---- rendering -----------------------------------------------------------------

    /** One animation frame: settle the panel, then draw. Only touch the DOM when something changed. */
    const tick = function (state, now) {
        const car = window.ModelCurrentCar;
        const text = car && car.has_focused_car ? ACEUIModLoader.percentText(car.gas_percent || 0) : "-";

        ACEUIModLoader.panel.update(state.panel, now);

        if (ACEUIModLoader.hudHidden() || text === state.lastText) { return; }

        state.lastText = text;
        state.value.textContent = text;
    };

    // ---- lifecycle ---------------------------------------------------------------

    const attach = function (root) {
        const state = create(root);

        state.panel = ACEUIModLoader.panel.attach(root, { hudId: me.hudId, storageKey: me.storageKey, log: me.log });
        state.loop = ACEUIModLoader.loop.start(function (now) { tick(state, now); });
        me.log("attached");

        return state;
    };

    const detach = function (state) {
        ACEUIModLoader.loop.stop(state.loop);
        ACEUIModLoader.panel.detach(state.panel);
    };

    me.log("script loaded, version=" + me.version + ", lib=" + ACEUIModLoader.VERSION);

    return {
        CLASS: CLASS,
        create: create,
        tick: tick,
        attach: attach,
        detach: detach
    };
}());

/* Attach to #profiler: the loader creates it in game, the preview page carries it. */
ACEUIModLoader.mod("profiler").mount(ACEUIProfiler.attach);
