/**
 * ACEUIModLoader.drawer -- the app drawer: every loaded mod in one place.
 *
 * A panel that lives off the right edge of the screen and slides in when the mouse
 * reaches that edge, in the spirit of Assetto Corsa Content Manager's app bar. It lists
 * every mod the loader discovered, with a switch that shows or hides it, and opens a
 * mod's own options pane if it registered one. Choices persist, so a mod you switched
 * off stays off across the HUD reload on Escape/resume.
 *
 * Why this lives in the loader rather than in a mod: the loader is the only thing that
 * knows what is installed, and an app drawer that only listed *some* apps would be
 * useless. It also gives mods somewhere to put settings without each one growing its own
 * settings window.
 *
 * A mod gets a way in by declaring settings -- ACEUIModLoader.settings registers the
 * opener on its behalf, and clicking it opens that mod's own window. A mod with something
 * more bespoke than a settings page registers what to open itself:
 *
 *     ACEUIModLoader.drawer.registerOpener("telemetry", function () { myWindow.open(); });
 *
 * It opens a window rather than unfolding a pane inside the drawer because an inline pane
 * pushes every row below it down the list, which with a dozen apps makes the list unusable.
 *
 * Styling note: everything here is styled with inline styles rather than a stylesheet.
 * The loader ships as a single overriding file inside a package whose layout is delicate
 * (see game-internals.md on the resource lookup), so adding a CSS file to it is a risk
 * not worth taking; and a script-created <style> element is unproven in this Cohtml
 * build. Inline styles need neither, and inline `transition` still animates the slide.
 *
 * Cohtml notes: the panel is built once, and the only per-interaction writes are a
 * transform and an opacity on the panel and colours on a row. Nothing is rebuilt per
 * frame -- there is no frame loop here at all; the drawer reacts to mouse events only.
 *
 * The slide is shaped by measurement, not taste (dev/snippets/fpsprobe.js, in game
 * 2026-09-15). The HUD page advances at a rock-steady 58.5 frames per second -- half the
 * game's 117, with no hitches and no measurable cost from any mod -- so an animation gets
 * a frame every 17 ms and no more. At the original 180 ms the panel crossed in eleven
 * frames, one of which moved it a quarter of its own width, and then spent its last five
 * frames creeping through the final 7%: a jump followed by a crawl, which is what
 * "choppy" was. Hence a longer slide and a fade over it -- the stock UI's own idiom
 * (uicomponents.css: 0.25-0.5 s, opacity paired with transform, 1-2 rem of travel).
 * `will-change` is not in this engine at all, so there is no layer hint to reach for.
 */
ACEUIModLoader.drawer = (function () {

    const STORE_KEY = "acedrawer.apps";

    /**
     * Where the switches live. localStorage is read synchronously and is what makes a
     * switched-off app hide instantly on an Escape/resume reload -- but it dies with the
     * game. The stock HUD layout container is the one the game writes to disk, so it is
     * what survives a restart; it only appears a little after mod scripts run, so it is
     * adopted when it turns up (see adoptHudStore). Ids there follow the stock
     * `hud_<name>` convention.
     */
    const HUD_ID = "hud_acedrawer";
    const HUD_POLL_MS = 50;
    const HUD_WAIT_MS = 8000;

    /**
     * The developer switch, in a store of its own so it cannot be confused with an app
     * called "developer". Off by default: the profiler, the dev console and the
     * capabilities probe ship with the loader, and a player has no use for any of them.
     */
    const DEV_STORE_KEY = "acedrawer.developer";
    const DEV_HUD_ID = "hud_acedrawer_dev";

    /** Geometry. The hot zone is a thin strip the pointer has to reach to open the drawer. */
    const HOT_WIDTH = "10px";
    const PANEL_WIDTH = "15rem";
    const PANEL_TOP = "4rem";
    const PANEL_BOTTOM = "4rem";
    const SLIDE_MS = 300;
    /** The fade finishes first, so the panel is solid before it stops moving. */
    const FADE_MS = 220;
    const CLOSE_DELAY_MS = 350;

    /** Above the stock HUD, below nothing in particular; the HUD does not use z-index much. */
    const Z_INDEX = "9000";

    /** One palette for every surface the loader draws; see ACEUIModLoader.dom. */
    const THEME = ACEUIModLoader.dom.THEME;

    const TITLE_TEXT = "APPS";
    /**
     * A word, not a symbol. The main font has no gear glyph -- it rendered as a blank box
     * in game -- and the stock UI's icon font ('icons', /fonts/acevoicons.ttf) addresses
     * its glyphs by bare characters whose meanings are not documented anywhere we can
     * check, so guessing one risks showing the wrong picture rather than none.
     */
    const OPTIONS_GLYPH = "OPTIONS";
    const EMPTY_TEXT = "no mods loaded on this page";
    const DEV_TEXT = "DEVELOPER APPS";

    const state = {
        built: false,
        open: false,
        panel: null,
        list: null,
        count: null,
        hot: null,
        apps: [],               // { name, title, status, developer, holder, row, box, label, gear }
        visible: {},            // name -> bool, persisted
        dev: {},                // name -> is it a developer tool, from the rows we built
        developer: false,       // show the apps that call themselves developer tools
        devRow: null,           // { box, label }, the switch at the foot of the panel
        openers: {},            // name -> what to open when its OPTIONS button is clicked
        touched: false,         // the user flipped a switch: newer than anything on disk
        closeTimer: 0
    };

    const persist = ACEUIModLoader.persist;

    /**
     * Read the saved switches immediately, while the library is still loading and before
     * any mod root exists, so applyStored() can hide a switched-off mod the moment the
     * loader creates it. The HUD store is preferred when it happens to be ready already;
     * otherwise localStorage carries us until adoptHudStore() picks it up.
     */
    const loadStored = function () {
        const stored = persist.readHud(HUD_ID) || persist.readLocal(STORE_KEY);
        const dev = persist.readHud(DEV_HUD_ID) || persist.readLocal(DEV_STORE_KEY);

        if (stored && !state.touched) { state.visible = stored; }

        if (dev && !state.touched) { state.developer = Boolean(dev.on); }
    };

    loadStored();

    // ---- tiny DOM helpers ----------------------------------------------------------

    const css = ACEUIModLoader.dom.css;
    const div = ACEUIModLoader.dom.div;

    /** Set the text of an element we already have; `dom.make` covers the create-and-fill case. */
    const text = function (node, value) {
        node.textContent = value;

        return node;
    };

    // ---- visibility ----------------------------------------------------------------

    const rootOf = function (name) {
        return document.getElementById(name);
    };

    /**
     * Whether this mod calls itself a developer tool. The rows know once the drawer is
     * built, but the question is asked before that too -- the loader calls applyStored the
     * moment it creates a mod's root, and the drawer is not built until every mod has
     * loaded -- so the loader's own copy of the manifest answers until then.
     */
    const isDeveloper = function (name) {
        const loader = ACEUIModLoader.loader;

        if (Object.prototype.hasOwnProperty.call(state.dev, name)) { return state.dev[name]; }

        return Boolean(loader && loader.isDeveloper(name));
    };

    /**
     * Is this app on? A developer app is also off while the developer switch is, and that
     * gate belongs here rather than in the code that flips switches: everything goes
     * through this one function -- applyVisibility, applyStored, refreshAll, and the
     * loader's own `enabled`, which decides whether a mod is even started. So a developer
     * app cannot be started, shown, or brought back by its hotkey while the switch is off,
     * and its own switch is left exactly as the user last set it, ready for when it is on
     * again. That default is "on": flipping the developer switch should show the tools
     * working, not three rows that each need switching on as well.
     */
    const isVisible = function (name) {
        if (!state.developer && isDeveloper(name)) { return false; }

        return state.visible[name] !== false;
    };

    /** Write to both stores: localStorage for the instant reload, the HUD store for disk. */
    const store = function () {
        persist.save(HUD_ID, STORE_KEY, state.visible);
        persist.save(DEV_HUD_ID, DEV_STORE_KEY, { on: state.developer });
    };

    /**
     * Switch a mod on or off for real.
     *
     * Hiding the root is not enough: a hidden mod keeps its key handlers, its frame loop
     * and its sounds (DOOM still answered Insert and played music while "disabled"). So
     * the loader is asked to stop it through its own detach, and to start it again on
     * the way back. The root is hidden as well, which is the whole story for a mod that
     * never gave the loader a detach.
     */
    const applyVisibility = function (name) {
        const root = rootOf(name);
        const on = isVisible(name);
        const loader = ACEUIModLoader.loader;

        if (root) { root.style.display = on ? "" : "none"; }

        if (loader) {
            if (on) { loader.activate(name); } else { loader.deactivate(name); }
        }

        return on;
    };

    /**
     * Called by the loader the instant it creates a mod's root, before the mod's scripts
     * run. Without this a switched-off mod is visible from the moment its root exists
     * until the drawer is built -- and the drawer is built on ACEUIModLoader.ready, which
     * only fires once *every* mod has finished loading. With a large mod in the queue
     * that is about a second of the app flashing on and then vanishing again after a
     * pause-menu reload, which is exactly what it looked like.
     */
    const applyStored = function (name) {
        return applyVisibility(name);
    };

    const paintSwitch = function (app) {
        const on = isVisible(app.name);

        css(app.box, {
            background: on ? THEME.on : "transparent",
            borderColor: on ? THEME.on : THEME.inkOff
        });
        app.label.style.color = on ? THEME.ink : THEME.inkOff;
    };

    /**
     * Flip one app's switch. Returns whether it is actually on afterwards, which is not
     * always what was asked for: a developer app stays off while the developer switch is,
     * and `mod().show(true)` says so in the log rather than leaving a panel unreachable.
     */
    const setVisible = function (name, on) {
        state.visible[name] = Boolean(on);
        state.touched = true;
        applyVisibility(name);
        store();

        state.apps.forEach(function (app) {
            if (app.name === name) { paintSwitch(app); }
        });

        return isVisible(name);
    };

    /** Whether the drawer is listing the developer tools at all. */
    const developerShown = function () {
        return state.developer;
    };

    /**
     * Show or hide the developer tools. This is a master switch, not a filter: an app it
     * hides is stopped as well, because an app drawn over the HUD with no row to reach it
     * is exactly the state the show/hide lifecycle exists to prevent. Their own switches
     * are untouched, so they come back as they were.
     */
    const setDeveloper = function (on) {
        state.developer = Boolean(on);
        state.touched = true;
        store();
        refreshRows();
        refreshAll();

        return state.developer;
    };

    const toggleDeveloper = function () {
        return setDeveloper(!state.developer);
    };

    /** Rows on the screen: the developer ones are listed only while the switch is on. */
    const listedApps = function () {
        return state.apps.filter(function (app) { return state.developer || !app.developer; });
    };

    /**
     * Put the list in step with the developer switch: which rows are there, and the count
     * in the header, which says what is listed rather than what is loaded -- a count that
     * disagreed with the rows under it would just look like a bug.
     */
    const refreshRows = function () {
        state.apps.forEach(function (app) {
            app.holder.style.display = !app.developer || state.developer ? "" : "none";
        });

        if (state.count) { text(state.count, listedApps().length + " loaded"); }

        if (state.devRow) {
            css(state.devRow.box, {
                background: state.developer ? THEME.on : "transparent",
                borderColor: state.developer ? THEME.on : THEME.inkOff
            });
            state.devRow.label.style.color = state.developer ? THEME.ink : THEME.inkOff;
        }
    };

    /** Re-apply every switch: after adopting the HUD store, mods may need hiding. */
    const refreshAll = function () {
        const mods = ACEUIModLoader.mods || [];

        mods.forEach(function (entry) { applyVisibility(entry.name); });
        state.apps.forEach(function (app) {
            applyVisibility(app.name);
            paintSwitch(app);
        });
    };

    /**
     * Take the switches from the HUD layout container -- the only store that survives a
     * game restart -- and mirror them into localStorage, so the *next* HUD reload in this
     * session hides switched-off apps instantly. A switch the user flipped in the meantime
     * wins: their intent is newer than anything on disk.
     *
     * The container appears a little after mod scripts run, so this is called through
     * `persist.whenHudReady` rather than polling for it here.
     */
    const adoptHudStore = function () {
        // A switch the user flipped before the store existed reached localStorage only,
        // and localStorage dies with the game: their choice is newer than anything on
        // disk, so rather than skipping, this is the moment to write it *to* disk.
        if (state.touched) {
            store();

            return false;
        }

        const stored = persist.readHud(HUD_ID);
        const dev = persist.readHud(DEV_HUD_ID);
        let adopted = false;

        // the developer switch first, and on its own: `isVisible` consults it, and a
        // profile that has never touched an app switch still has one of these to restore
        if (dev) {
            state.developer = Boolean(dev.on);
            persist.writeLocal(DEV_STORE_KEY, dev);
            adopted = true;
        }

        if (stored) {
            state.visible = stored;
            persist.writeLocal(STORE_KEY, stored);
            adopted = true;
        }

        if (!adopted) { return false; }

        refreshRows();
        refreshAll();

        return true;
    };

    const toggleApp = function (name) {
        setVisible(name, !isVisible(name));
    };

    // ---- options panes -------------------------------------------------------------

    const revealGear = function (name) {
        state.apps.forEach(function (app) {
            if (app.name === name) { app.gear.style.display = ""; }
        });
    };

    /**
     * What the OPTIONS button on a mod's row should open. ACEUIModLoader.settings calls
     * this for every mod that declares settings, so most mods never call it themselves.
     */
    const registerOpener = function (name, open) {
        if (typeof open !== "function") { return; }

        state.openers[name] = open;
        revealGear(name);
    };

    // ---- opening and closing -------------------------------------------------------

    const cancelClose = function () {
        if (!state.closeTimer) { return; }

        window.clearTimeout(state.closeTimer);
        state.closeTimer = 0;
    };

    const open = function () {
        cancelClose();

        if (!state.panel || state.open) { return; }

        state.open = true;
        state.panel.style.transform = "translateX(0)";
        state.panel.style.opacity = "1";
    };

    const close = function () {
        cancelClose();

        if (!state.panel || !state.open) { return; }

        state.open = false;
        state.panel.style.transform = "translateX(100%)";
        state.panel.style.opacity = "0";
    };

    const closeSoon = function () {
        cancelClose();
        state.closeTimer = window.setTimeout(close, CLOSE_DELAY_MS);
    };

    const toggle = function () {
        if (state.open) { close(); } else { open(); }
    };

    // ---- building ------------------------------------------------------------------

    const buildRow = function (app, onToggle) {
        const row = div({
            display: "flex",
            flexDirection: "row",
            alignItems: "center",
            padding: "0.3rem 0.6rem",
            cursor: "pointer"
        });
        const box = div({
            flex: "0 0 auto",
            width: "0.6rem",
            height: "0.6rem",
            marginRight: "0.5rem",
            border: "1px solid " + THEME.inkOff,
            borderRadius: "0.15rem"
        });
        const label = css(text(document.createElement("span"), app.title), {
            flex: "1 1 auto",
            color: THEME.ink,
            fontSize: "0.75rem",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap"
        });
        const gear = css(text(document.createElement("span"), OPTIONS_GLYPH), {
            flex: "0 0 auto",
            marginLeft: "0.4rem",
            padding: "0 0.2rem",
            color: THEME.inkDim,
            fontSize: "0.8rem",
            display: state.openers[app.name] ? "" : "none"
        });

        row.appendChild(box);
        row.appendChild(label);
        row.appendChild(gear);

        row.addEventListener("mouseenter", function () { row.style.background = THEME.hoverBg; });
        row.addEventListener("mouseleave", function () { row.style.background = "transparent"; });
        row.addEventListener("click", function (e) {
            if (e.target !== gear) {
                onToggle();
            } else if (state.openers[app.name]) {
                ACEUIModLoader.safely("[drawer] " + app.name + " options", state.openers[app.name]);
            }

            e.stopPropagation();
        });

        app.row = row;
        app.box = box;
        app.label = label;
        app.gear = gear;

        return row;
    };

    /** A mod that did not load gets a row that says why, rather than vanishing silently. */
    const buildStatus = function (app) {
        return css(text(document.createElement("div"), app.status), {
            padding: "0 0.6rem 0.3rem 1.7rem",
            color: THEME.inkDim,
            fontSize: "0.6rem"
        });
    };

    const buildApp = function (entry) {
        const info = entry.info || {};
        const app = {
            name: entry.name,
            title: info.title || entry.name,
            status: entry.status,
            developer: Boolean(info.developer)
        };
        const holder = div({ borderBottom: THEME.border });

        holder.appendChild(buildRow(app, function () { toggleApp(app.name); }));

        if (entry.status !== "loaded") { holder.appendChild(buildStatus(app)); }

        app.holder = holder;
        state.apps.push(app);
        state.dev[app.name] = app.developer;
        paintSwitch(app);

        return holder;
    };

    /**
     * The switch at the foot of the panel. It is the same row as an app's, one section
     * down: the tools it lists are not apps a player chose to install, so they are not in
     * the list with them.
     */
    const buildDeveloperRow = function () {
        const app = { name: "", title: DEV_TEXT };
        const holder = div({ flex: "0 0 auto", borderTop: THEME.border, background: THEME.headerBg });

        holder.appendChild(buildRow(app, toggleDeveloper));
        state.devRow = { box: app.box, label: app.label };

        return holder;
    };

    const build = function (mods) {
        const selector = ACEUIModLoader.loader ? ACEUIModLoader.loader.CONTAINER_SELECTOR : "";
        const container = (selector && document.querySelector(selector)) || document.body;
        const stored = persist.readHud(HUD_ID) || persist.readLocal(STORE_KEY);
        const storedDev = persist.readHud(DEV_HUD_ID) || persist.readLocal(DEV_STORE_KEY);
        const panel = div({
            position: "fixed",
            top: PANEL_TOP,
            bottom: PANEL_BOTTOM,
            right: "0",
            width: PANEL_WIDTH,
            display: "flex",
            flexDirection: "column",
            background: THEME.panelBg,
            borderLeft: THEME.border,
            borderRadius: "0.25rem 0 0 0.25rem",
            color: THEME.ink,
            fontFamily: THEME.font,
            zIndex: Z_INDEX,
            transform: "translateX(100%)",
            opacity: "0",
            transition: "transform " + SLIDE_MS + "ms ease-out, opacity " + FADE_MS + "ms ease-out",
            overflow: "hidden"
        });
        const header = div({
            flex: "0 0 auto",
            display: "flex",
            flexDirection: "row",
            alignItems: "baseline",
            justifyContent: "space-between",
            padding: "0.45rem 0.6rem",
            background: THEME.headerBg
        });
        const list = div({ flex: "1 1 auto", overflow: "hidden" });
        const count = css(document.createElement("span"), { color: THEME.inkDim, fontSize: "0.65rem" });
        const hot = div({
            position: "fixed",
            top: "0",
            bottom: "0",
            right: "0",
            width: HOT_WIDTH,
            zIndex: Z_INDEX
        });

        // building again replaces the drawer rather than stacking a second one on top
        if (state.panel && state.panel.parentNode) { state.panel.parentNode.removeChild(state.panel); }

        if (state.hot && state.hot.parentNode) { state.hot.parentNode.removeChild(state.hot); }

        cancelClose();
        state.apps = [];
        state.dev = {};
        state.devRow = null;
        // the panel below starts parked off-screen, so the flag has to agree: rebuilding
        // while it was open would otherwise leave `open()` thinking it already is
        state.open = false;

        if (stored && !state.touched) { state.visible = stored; }

        if (storedDev && !state.touched) { state.developer = Boolean(storedDev.on); }

        header.appendChild(css(text(document.createElement("span"), TITLE_TEXT), {
            color: "#fff", fontSize: "0.75rem", fontWeight: "700", letterSpacing: "0.08em"
        }));
        header.appendChild(count);
        panel.appendChild(header);
        panel.appendChild(list);

        mods.forEach(function (entry) {
            list.appendChild(buildApp(entry));
            applyVisibility(entry.name);
        });

        if (!mods.length) {
            list.appendChild(css(text(document.createElement("div"), EMPTY_TEXT), {
                padding: "0.5rem 0.6rem", color: THEME.inkDim, fontSize: "0.65rem"
            }));
        }

        panel.appendChild(buildDeveloperRow());

        // the pointer reaching the right edge opens it; leaving the panel closes it again
        hot.addEventListener("mouseenter", function () {
            if (!ACEUIModLoader.hudHidden()) { open(); }
        });
        panel.addEventListener("mouseenter", cancelClose);
        panel.addEventListener("mouseleave", closeSoon);

        container.appendChild(hot);
        container.appendChild(panel);

        state.panel = panel;
        state.list = list;
        state.count = count;
        state.hot = hot;
        state.built = true;
        refreshRows();

        return panel;
    };

    // the HUD store shows up shortly after this file runs; adopt it when it does
    persist.whenHudReady(adoptHudStore, { pollMs: HUD_POLL_MS, waitMs: HUD_WAIT_MS });

    /** Build once the loader knows what is installed. */
    if (typeof ACEUIModLoader.ready === "function") {
        ACEUIModLoader.ready(function (mods) {
            if (state.built) { return; }

            build(mods);
        });
    }

    return {
        STORE_KEY: STORE_KEY,
        SLIDE_MS: SLIDE_MS,
        FADE_MS: FADE_MS,
        CLOSE_DELAY_MS: CLOSE_DELAY_MS,
        state: state,
        build: build,
        open: open,
        close: close,
        toggle: toggle,
        isVisible: isVisible,
        applyStored: applyStored,
        adoptHudStore: adoptHudStore,
        refreshAll: refreshAll,
        HUD_ID: HUD_ID,
        DEV_HUD_ID: DEV_HUD_ID,
        DEV_STORE_KEY: DEV_STORE_KEY,
        setVisible: setVisible,
        toggleApp: toggleApp,
        isDeveloper: isDeveloper,
        developerShown: developerShown,
        setDeveloper: setDeveloper,
        toggleDeveloper: toggleDeveloper,
        registerOpener: registerOpener
    };
}());
