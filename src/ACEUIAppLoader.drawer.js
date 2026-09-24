/**
 * ACEUIAppLoader.drawer -- the app drawer: every loaded app in one place.
 *
 * A panel that lives off one edge of the screen and slides in when the mouse reaches that
 * edge, in the spirit of Assetto Corsa Content Manager's app bar. It lists every app the
 * loader discovered, with a switch that shows or hides it, and opens an app's own options
 * pane if it registered one. Choices persist, so an app you switched off stays off across
 * the HUD reload on Escape/resume.
 *
 * Why this lives in the loader rather than in an app: the loader is the only thing that
 * knows what is installed, and an app drawer that only listed *some* apps would be
 * useless. It also gives apps somewhere to put settings without each one growing its own
 * settings window.
 *
 * An app gets a way in by declaring settings -- ACEUIAppLoader.settings registers the
 * opener on its behalf, and clicking it opens that app's own window. An app with something
 * more bespoke than a settings page registers what to open itself:
 *
 *     ACEUIAppLoader.drawer.registerOpener("telemetry", function () { myWindow.open(); });
 *
 * It opens a window rather than unfolding a pane inside the drawer because an inline pane
 * pushes every row below it down the list, which with a dozen apps makes the list unusable.
 *
 * How it opens (a player's review, 2026-09-23: "the area to open the sidebar is so close to
 * the side of the screen ... I keep going off to my second monitor"). The first version had
 * a 10px strip on the right edge, an element the pointer had to enter. The stock UI sizes
 * everything from the resolution (1rem = min(width / 120, height / 67.5) px, clamped 10-48:
 * components.js resize()), so 10px was under half a rem at 1440p and a third at 4K; and the
 * HUD hides the cursor after three seconds and only shows it again after a 100px move
 * (BaseHud.mouseToggler), so the approach to the edge was a blind one. Now there is no
 * element at all: one `mousemove` listener on the window opens the drawer when the pointer
 * is within `zone` rem of the chosen edge, so the zone can be as wide as the player likes
 * without an element there swallowing clicks on the HUD under it, and it closes when the
 * pointer has been outside both the zone and the panel for a moment. A click at the edge, a
 * hotkey and a pin are the other ways in, for players whose pointer leaves the game window
 * before it reaches the edge. A thin hint line fades in on the edge as the pointer nears it,
 * so a hidden cursor no longer means aiming blind.
 *
 * All of that is the player's to set, in the drawer's own settings pane (OPTIONS in its
 * header): zone width, which part of the edge, hover or click or hotkey, dwell, close delay,
 * the hotkey, pinning, the hint, the side, an offset for triple screens, the panel's width,
 * insets, scale and opacity, and whether it animates. Values are clamped again when they are
 * applied, so no stored value can put the drawer where it cannot be reached or cover the HUD.
 *
 * Styling note: everything here is styled with inline styles rather than a stylesheet.
 * The loader ships as a single overriding file inside a package whose layout is delicate
 * (see game-internals.md on the resource lookup), so adding a CSS file to it is a risk
 * not worth taking; and a script-created <style> element is unproven in this Cohtml
 * build. Inline styles need neither, and inline `transition` still animates the slide.
 * Sizes inside the panel are in em, so one font-size on the panel scales the whole thing
 * (the `me.scale` technique); the panel's own width and the zone are in rem.
 *
 * Cohtml notes: the panel is built once, and the only per-interaction writes are a
 * transform, an opacity and a visibility on the panel, an opacity on the hint line, a
 * visibility on the zone box and colours on a row. Nothing is rebuilt per frame -- there is no frame loop here at all; the drawer
 * reacts to mouse events only, and the mouse handlers read no layout: the zone and the
 * panel's box are worked out from the settings and the viewport, never measured.
 *
 * The slide is shaped by measurement, not taste (dev/snippets/fpsprobe.js, in game
 * 2026-09-15). The HUD page advances at a rock-steady 58.5 frames per second -- half the
 * game's 117, with no hitches and no measurable cost from any app -- so an animation gets
 * a frame every 17 ms and no more. At the original 180 ms the panel crossed in eleven
 * frames, one of which moved it a quarter of its own width, and then spent its last five
 * frames creeping through the final 7%: a jump followed by a crawl, which is what
 * "choppy" was. Hence a longer slide and a fade over it -- the stock UI's own idiom
 * (uicomponents.css: 0.25-0.5 s, opacity paired with transform, 1-2 rem of travel).
 * `will-change` is not in this engine at all, so there is no layer hint to reach for.
 */
ACEUIAppLoader.drawer = (function () {

    const STORE_KEY = "acedrawer.apps";

    /**
     * Where the switches live. localStorage is read synchronously and is what makes a
     * switched-off app hide instantly on an Escape/resume reload -- but it dies with the
     * game. The stock HUD layout container is the one the game writes to disk, so it is
     * what survives a restart; it only appears a little after app scripts run, so it is
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

    /**
     * The drawer's own settings are declared under this name, like an app's, so the
     * settings module stores, draws and adopts them exactly as it does for apps. It is not
     * an app row: the pane names itself through define's `title`.
     */
    const DRAWER_APP = "acedrawer";
    const SETTINGS_TITLE = "App drawer";
    const SETTINGS_WIDTH = "36rem";

    /** Setting keys, and their defaults. Every value is clamped again where it is used (metrics, applyLook, closeSoon, onMove). */
    const KEY = {
        zone: "zone", extent: "extent", trigger: "trigger", dwell: "dwell", closeDelay: "closeDelay",
        toggleKey: "toggleKey", pinned: "pinned", hint: "hint",
        side: "side", triple: "triple", offset: "offset", width: "width", top: "top", bottom: "bottom",
        scale: "scale", opacity: "opacity", motion: "motion"
    };

    const SIDE_RIGHT = "right";
    const SIDE_LEFT = "left";
    const EXTENT_FULL = "full";
    const EXTENT_UPPER = "upper";
    const EXTENT_MIDDLE = "middle";
    const EXTENT_LOWER = "lower";
    const TRIGGER_HOVER = "hover";
    const TRIGGER_CLICK = "click";
    const TRIGGER_HOTKEY = "hotkey";
    const HINT_OFF = "off";
    const HINT_NEAR = "near";
    const HINT_ALWAYS = "always";

    /**
     * Geometry. The zone is the distance from the edge the pointer has to come within, in
     * rem: 2rem is the HUD's own margin (`.absolutecenter`), so by default the zone never
     * lies over a stock widget at its default place, and it is about four times the old
     * strip at 1440p (43px), 32px at 1080p, 64px at 4K. Mouse travel is physical pixels, so
     * low resolutions want a larger value; the floor of 1rem is 11px at 720p.
     */
    const ZONE_REM = 2;
    const ZONE_MIN_REM = 1;
    const ZONE_MAX_REM = 10;
    const ZONE_STEP_REM = 0.5;
    const PANEL_WIDTH_REM = 15;
    const WIDTH_MIN_REM = 10;
    const WIDTH_MAX_REM = 30;
    const PANEL_TOP_REM = 4;
    const PANEL_BOTTOM_REM = 4;
    const INSET_MAX_REM = 30;
    /** What must be left of the panel when the insets are large. */
    const MIN_PANEL_HEIGHT_REM = 10;
    /** An extra distance from the edge, for a drawer that should not sit on the physical edge. */
    const OFFSET_MAX_REM = 60;
    /** Whatever the offset and triple settings ask, the edge line stays in the near half of the screen. */
    const OFFSET_MAX_FRACTION = 0.45;
    /** The game spans triple screens as one wide viewport; the centre screen ends a third of the way in. */
    const TRIPLE_SCREENS = 3;
    /** The extent settings divide the edge into thirds. */
    const THIRDS = 3;
    const SIZE_STEP_REM = 0.5;

    const SCALE_DEFAULT = 1;
    const SCALE_MIN = 0.7;
    const SCALE_MAX = 1.6;
    const SCALE_STEP = 0.05;
    const OPACITY_DEFAULT = 0.92;
    const OPACITY_MIN = 0.3;
    const OPACITY_MAX = 1;
    const OPACITY_STEP = 0.02;
    /** The panel's colours, as rgb triplets so the opacity setting can complete them. */
    const PANEL_RGB = "0, 0, 0";
    const HEADER_RGB = "28, 30, 31";

    const SLIDE_MS = 300;
    /** The fade finishes first, so the panel is solid before it stops moving. */
    const FADE_MS = 220;
    const CLOSE_DELAY_MS = 350;
    const CLOSE_MIN_MS = 100;
    const CLOSE_MAX_MS = 2000;
    const DELAY_STEP_MS = 50;
    /**
     * Dwell: how long the pointer must stay in the zone before the drawer opens. Off by
     * default: a flick towards a second monitor has no dwell to give, and the flick is the
     * case the zone exists for. It is a guard for players whose pointer passes the edge on
     * the way to something else.
     */
    const DWELL_MS = 0;
    const DWELL_MAX_MS = 1000;

    /**
     * The hint: a thin line on the edge, `pointer-events: none`, under the panel, that
     * fades in while the pointer is within HINT_REACH zones of the edge -- the cursor is
     * usually hidden by then (see the header). Thin rather than zone-wide because inline
     * `pointer-events: none` is unproven in this engine (the stock uses it in stylesheets
     * only): a line under the panel blocks nothing that matters if it fails. For a few
     * seconds after every build it shows at full strength (unless the hint is off), so a
     * player who never found the old strip sees where the drawer lives.
     */
    const HINT_REACH = 2;
    const HINT_LINE_REM = 0.3;
    const HINT_FADE_MS = 150;
    const HINT_INTRO_MS = 4000;
    const HINT_ALPHA_NEAR = "0.9";
    const HINT_ALPHA_ALWAYS = "0.35";
    const HINT_ALPHA_OFF = "0";
    /** Red, so the line reads against the scene: a white one was not seen in game (2026-09-23). */
    const HINT_COLOUR = "rgb(255, 40, 40)";
    /**
     * The zone drawn as a box while the drawer's settings pane is open, so a player changing
     * the zone or the extent sees the area that opens the drawer rather than a number.
     */
    const ZONE_BOX_BG = "rgba(255, 40, 40, 0.18)";
    const ZONE_BOX_BORDER = "1px solid rgba(255, 40, 40, 0.6)";

    /**
     * A pointer sample that jumps more than this fraction of the screen from the previous
     * one is not a movement. With the drawer on the left edge and a second monitor on the
     * right, the pointer leaving the game to the right opened the drawer (in game
     * 2026-09-23): the engine reports **0,0** as the pointer leaves the window and the real
     * position when it returns (log 2026-09-23 19:02: "2499,249 to 0,0", then "0,0 to
     * 2552,219"). A hand at 5000 px/s moves about 85px between two 58.5 fps samples; a
     * quarter of the screen is far beyond that. Neither a jump nor a repeat of the previous
     * position opens the drawer, and the first few jumps are logged.
     */
    const JUMP_FRACTION = 0.25;
    const JUMP_LOG_MAX = 5;

    /**
     * How the panel comes and goes. The slide is the stock idiom, but nothing in the stock
     * UI moves a panel this large and it was seen to hitch in game (2026-09-23); a fade
     * moves nothing, and "none" is instant.
     */
    const MOTION_SLIDE = "slide";
    const MOTION_FADE = "fade";
    const MOTION_NONE = "none";

    /** Above the stock HUD, below nothing in particular; the HUD does not use z-index much. The hint sits under the panel. */
    const Z_INDEX = "9000";
    const HINT_Z_INDEX = "8999";

    /** What 1rem is when nothing says: the browser default, for the harness. */
    const FALLBACK_PX_PER_REM = 16;
    const LOG_DECIMALS = 2;

    /**
     * Where the drawer belongs: the HUD, and any other page an app actually runs on. The
     * loader is on every page, so ready() fires on every page too; on the menus nothing
     * loads, and a zone there sat over the stock menus' own scrollbars at the right edge
     * and opened a drawer whose every row said "not-for-this-page".
     */
    const HUD_PAGE = "hud.html";
    const LOADED_STATUS = "loaded";

    /** One palette for every surface the loader draws; see ACEUIAppLoader.dom. */
    const THEME = ACEUIAppLoader.dom.THEME;

    const TITLE_TEXT = "APPS";
    /**
     * Words, not symbols. The main font has no gear glyph -- it rendered as a blank box
     * in game -- and the stock UI's icon font ('icons', /fonts/acevoicons.ttf) addresses
     * its glyphs by bare characters whose meanings are not documented anywhere we can
     * check, so guessing one risks showing the wrong picture rather than none.
     */
    const OPTIONS_GLYPH = "OPTIONS";
    const PIN_TEXT = "PIN";
    const PINNED_TEXT = "PINNED";
    const EMPTY_TEXT = "no apps loaded on this page";
    const DEV_TEXT = "DEVELOPER APPS";

    /** How the pane lays its sections out, and how many decimals each kind of value shows. */
    const SECTION_COLUMNS = 2;
    const DIGITS_REM = 1;
    const DIGITS_MS = 0;
    const DIGITS_FACTOR = 2;

    /** The drawer's settings, in the order the pane draws them. */
    const SPECS = [
        { key: "opening", type: "section", label: "Opening", columns: SECTION_COLUMNS },
        { key: KEY.zone, type: "range", label: "Edge zone", value: ZONE_REM, min: ZONE_MIN_REM, max: ZONE_MAX_REM, step: ZONE_STEP_REM, unit: "rem", digits: DIGITS_REM,
            hint: "how close to the edge the pointer must come; 2 is the HUD's own margin. Mouse travel is in pixels, so a low resolution wants more" },
        { key: KEY.extent, type: "choice", label: "Along the edge", value: EXTENT_FULL, options: [EXTENT_FULL, EXTENT_UPPER, EXTENT_MIDDLE, EXTENT_LOWER], segmented: true,
            hint: "which part of the edge opens it: the whole height or one third of it" },
        { key: KEY.trigger, type: "choice", label: "Open with", value: TRIGGER_HOVER, options: [TRIGGER_HOVER, TRIGGER_CLICK, TRIGGER_HOTKEY], segmented: true,
            labels: { hover: "Hover", click: "Click at edge", hotkey: "Hotkey only" },
            hint: "hover: reaching the zone opens it; click: a press in the zone; hotkey only: the key below (with no key bound, hover applies)" },
        { key: KEY.dwell, type: "range", label: "Dwell", value: DWELL_MS, min: 0, max: DWELL_MAX_MS, step: DELAY_STEP_MS, unit: "ms", digits: DIGITS_MS,
            // shown whenever hover is the trigger in force, which "hotkey only" with no key bound also is (triggerNow)
            when: function (app) {
                const S = ACEUIAppLoader.settings;
                const trigger = S.get(app, KEY.trigger);

                return trigger === TRIGGER_HOVER || (trigger === TRIGGER_HOTKEY && !S.get(app, KEY.toggleKey));
            },
            hint: "how long the pointer must stay in the zone before it opens; 0 opens at once, which is what a flick to the edge needs" },
        { key: KEY.closeDelay, type: "range", label: "Close after", value: CLOSE_DELAY_MS, min: CLOSE_MIN_MS, max: CLOSE_MAX_MS, step: DELAY_STEP_MS, unit: "ms", digits: DIGITS_MS,
            hint: "how long the pointer can be away from the drawer before it closes" },
        { key: KEY.toggleKey, type: "key", label: "Toggle key", value: "",
            hint: "a key that opens and closes it from anywhere; click, then press the key. Delete while waiting unbinds it" },
        { key: KEY.pinned, type: "toggle", label: "Always open", value: false,
            hint: "on the screen at once and after every reload; PIN in the header or the key puts it away" },
        { key: KEY.hint, type: "choice", label: "Edge hint", value: HINT_NEAR, options: [HINT_OFF, HINT_NEAR, HINT_ALWAYS], segmented: true,
            labels: { off: "Off", near: "When near", always: "Always" },
            hint: "a thin line on the edge: as the pointer nears it (the cursor is often hidden by then), always, or never" },
        { key: "panel", type: "section", label: "Panel", columns: SECTION_COLUMNS },
        { key: KEY.side, type: "choice", label: "Side", value: SIDE_RIGHT, options: [SIDE_LEFT, SIDE_RIGHT], segmented: true,
            hint: "the edge it lives on. With a second monitor to the right, the left edge is the one the pointer cannot leave through" },
        { key: KEY.triple, type: "toggle", label: "Triple screen (experimental)", value: false,
            hint: "puts the edge a third of the way in, where the centre screen ends. Untested on a real triple: if the drawer lands in the wrong place, switch it off and report the [drawer] built line from your log" },
        { key: KEY.offset, type: "range", label: "Edge offset", value: 0, min: 0, max: OFFSET_MAX_REM, step: SIZE_STEP_REM, unit: "rem", digits: DIGITS_REM,
            hint: "moves the edge the drawer uses inwards from the screen edge, on top of the triple-screen third" },
        { key: KEY.width, type: "range", label: "Width", value: PANEL_WIDTH_REM, min: WIDTH_MIN_REM, max: WIDTH_MAX_REM, step: SIZE_STEP_REM, unit: "rem", digits: DIGITS_REM },
        { key: KEY.top, type: "range", label: "Top inset", value: PANEL_TOP_REM, min: 0, max: INSET_MAX_REM, step: SIZE_STEP_REM, unit: "rem", digits: DIGITS_REM },
        { key: KEY.bottom, type: "range", label: "Bottom inset", value: PANEL_BOTTOM_REM, min: 0, max: INSET_MAX_REM, step: SIZE_STEP_REM, unit: "rem", digits: DIGITS_REM },
        { key: KEY.scale, type: "range", label: "Scale", value: SCALE_DEFAULT, min: SCALE_MIN, max: SCALE_MAX, step: SCALE_STEP, digits: DIGITS_FACTOR,
            hint: "the size of the rows and text; the width is its own setting" },
        { key: KEY.opacity, type: "range", label: "Opacity", value: OPACITY_DEFAULT, min: OPACITY_MIN, max: OPACITY_MAX, step: OPACITY_STEP, digits: DIGITS_FACTOR },
        { key: KEY.motion, type: "choice", label: "Motion", value: MOTION_SLIDE, options: [MOTION_SLIDE, MOTION_FADE, MOTION_NONE], segmented: true,
            labels: { slide: "Slide", fade: "Fade", none: "None" },
            hint: "how it appears: slide in from the edge, fade in place, or at once. Fade moves nothing, if the slide stutters on your machine" }
    ];

    /** Defaults by key, read from SPECS so there is one copy of each. */
    const DEFAULTS = {};

    SPECS.forEach(function (spec) {
        if (spec.type !== "section") { DEFAULTS[spec.key] = spec.value; }
    });

    const state = {
        built: false,
        open: false,
        panel: null,
        header: null,
        list: null,
        count: null,
        devHolder: null,        // the developer row's box, painted with the header's colour
        hint: null,             // the edge line
        zoneBox: null,          // the zone drawn while the settings pane is open
        track: null,            // the list's scrollbar gutter and thumb
        thumb: null,
        scroller: null,         // ACEUIAppLoader.scroll handle for the list
        pin: null,              // the PIN button in the header
        apps: [],               // { name, title, status, developer, holder, row, box, label, gear }
        visible: {},            // name -> bool, persisted
        dev: {},                // name -> is it a developer tool, from the rows we built
        developer: false,       // show the apps that call themselves developer tools
        devRow: null,           // { box, label }, the switch at the foot of the panel
        openers: {},            // name -> what to open when its OPTIONS button is clicked
        touched: false,         // the user flipped a switch: newer than anything on disk
        touchedNames: {},       // which app switches were flipped before the HUD store was adopted
        touchedDev: false,      // and whether the developer switch was
        closeTimer: 0,
        dwellTimer: 0,
        introTimer: 0,
        intro: false,           // the hint is showing at full strength after a build
        buttonHeld: false,      // a mouse button is down: a drag to the edge is not a request to open
        opts: null,             // the settings as last read, a plain object (see readOptions)
        look: null,             // the metrics last applied, for the log and the tests
        wired: false,           // the window listeners are on (once per page)
        unsubscribe: null,      // settings.onChange, subscribed once
        unbindKey: null,        // keys.bind, bound once
        last: { x: 0, y: 0, known: false },     // the previous pointer sample, for the jump guard
        jumpsLogged: 0,
        syncTimer: 0,           // the list's scrollbar is measured after a slide, never during one
        parkTimer: 0,           // the panel is hidden (and, after a fade, parked) once it has finished going
        visitPending: false     // opened by the hotkey: no auto-close until the pointer has reached the panel
    };

    const persist = ACEUIAppLoader.persist;

    /**
     * Read the saved switches immediately, while the library is still loading and before
     * any app root exists, so applyStored() can hide a switched-off app the moment the
     * loader creates it. The HUD store is preferred when it happens to be ready already;
     * otherwise localStorage carries us until adoptHudStore() picks it up.
     */
    /**
     * A stored switch map as the drawer can use it: a plain object, and of its entries only
     * the booleans (a hand-edited or damaged store's "false" would otherwise read as on).
     * Null for anything that is not a map.
     */
    const switchesOf = function (stored) {
        if (!stored || typeof stored !== "object" || Array.isArray(stored)) { return null; }

        const out = {};

        Object.keys(stored).forEach(function (name) {
            if (typeof stored[name] === "boolean") { out[name] = stored[name]; }
        });

        return out;
    };

    /** The developer switch as stored: on only when it says true. */
    const developerOf = function (dev) {
        return Boolean(dev && typeof dev === "object" && dev.on === true);
    };

    const loadStored = function () {
        const stored = switchesOf(persist.readHud(HUD_ID) || persist.readLocal(STORE_KEY));
        const dev = persist.readHud(DEV_HUD_ID) || persist.readLocal(DEV_STORE_KEY);

        if (stored && !state.touched) { state.visible = stored; }

        if (dev && !state.touched) { state.developer = developerOf(dev); }
    };

    loadStored();

    // ---- tiny DOM helpers ----------------------------------------------------------

    const css = ACEUIAppLoader.dom.css;
    const div = ACEUIAppLoader.dom.div;
    const clamp = ACEUIAppLoader.clamp;

    /** Set the text of an element we already have; `dom.make` covers the create-and-fill case. */
    const text = function (node, value) {
        node.textContent = value;

        return node;
    };

    // ---- the drawer's own settings -------------------------------------------------

    /**
     * The settings as a plain object: the mouse handler reads a dozen of them per event,
     * and a lookup through the settings module for each would be twelve filters over the
     * spec list. Refreshed on build and on every change. Without the settings module (a
     * bare harness) the defaults apply.
     */
    const readOptions = function () {
        const settings = ACEUIAppLoader.settings;
        const opts = {};

        Object.keys(DEFAULTS).forEach(function (key) {
            const value = settings ? settings.get(DRAWER_APP, key) : undefined;

            opts[key] = value === undefined ? DEFAULTS[key] : value;
        });

        state.opts = opts;

        return opts;
    };

    const options = function () {
        return state.opts || readOptions();
    };

    /** The trigger in force: "hotkey only" with no key bound would leave no way in, so hover applies. */
    const triggerNow = function () {
        const opts = options();

        return opts.trigger === TRIGGER_HOTKEY && !opts.toggleKey ? TRIGGER_HOVER : opts.trigger;
    };

    /**
     * What 1rem is, in px. The stock resize() writes it inline on <html> and publishes it
     * as window.FontSize; getComputedStyle reports inline values in this engine, so the
     * three agree in game and the last is what a browser harness has.
     */
    const pxPerRem = function () {
        const root = document.documentElement;
        const published = typeof window.FontSize === "number" ? window.FontSize : 0;

        // this runs on every pointer move: the style read is only made when the stock published nothing
        if (published) { return published; }

        const inline = root ? parseFloat(root.style.fontSize) : 0;

        if (inline) { return inline; }

        return (root ? parseFloat(getComputedStyle(root).fontSize) : 0) || FALLBACK_PX_PER_REM;
    };

    /**
     * The geometry in px, from the settings and the viewport alone: no layout reads (the
     * panel is mid-slide for 300 ms, and layout reads lag in this engine), no calc() (an
     * inline calc is applied as nothing). Clamped so no stored value can put the drawer
     * where it cannot be reached or leave nothing of it: the edge line stays in the near
     * half of the screen and the insets leave MIN_PANEL_HEIGHT_REM. `viewport`, optional,
     * is `{ W, H, pxPerRem }` in place of the real ones: the tests walk every screen shape
     * from 720p to a spanned triple through it, since none of them is on a desk here.
     */
    const metrics = function (viewport) {
        const opts = options();
        const given = viewport || {};
        const ppr = given.pxPerRem || pxPerRem();
        const W = given.W || window.innerWidth;
        const H = given.H || window.innerHeight;
        const minHeight = MIN_PANEL_HEIGHT_REM * ppr;
        let top = clamp(opts.top, 0, INSET_MAX_REM) * ppr;
        let bottom = clamp(opts.bottom, 0, INSET_MAX_REM) * ppr;

        if (top + bottom > H - minHeight) {
            bottom = Math.max(0, H - minHeight - top);
            top = Math.min(top, Math.max(0, H - minHeight));
        }

        return {
            W: W,
            H: H,
            pxPerRem: ppr,
            side: opts.side === SIDE_LEFT ? SIDE_LEFT : SIDE_RIGHT,
            zonePx: clamp(opts.zone, ZONE_MIN_REM, ZONE_MAX_REM) * ppr,
            offsetPx: Math.min(clamp(opts.offset, 0, OFFSET_MAX_REM) * ppr + (opts.triple ? W / TRIPLE_SCREENS : 0), W * OFFSET_MAX_FRACTION),
            widthPx: clamp(opts.width, WIDTH_MIN_REM, WIDTH_MAX_REM) * ppr,
            topPx: top,
            bottomPx: bottom,
            extentTop: opts.extent === EXTENT_MIDDLE ? H / THIRDS : (opts.extent === EXTENT_LOWER ? H * (THIRDS - 1) / THIRDS : 0),
            extentBottom: opts.extent === EXTENT_UPPER ? H / THIRDS : (opts.extent === EXTENT_MIDDLE ? H * (THIRDS - 1) / THIRDS : H)
        };
    };

    /**
     * How far a pointer x is from the edge line the drawer uses; negative beyond it. From the
     * whole pixel applyLook writes the panel at: from the fraction, the panel's first column
     * at a fractional offset (1rem at 1440p is 21.33px) was in neither the zone nor the panel,
     * and a pointer resting there closed the drawer under it (second review, 2026-09-24).
     */
    const edgeDistance = function (x, m) {
        const offset = Math.round(m.offsetPx);

        return m.side === SIDE_LEFT ? x - offset : m.W - offset - x;
    };

    const inExtent = function (y, m) {
        return y >= m.extentTop && y <= m.extentBottom;
    };

    /** Pointer coordinates are whole pixels; the boundaries are not (W / 3, rem multiples), so a hair of slack at each. */
    const EDGE_EPSILON_PX = 0.001;

    const inZone = function (x, y, m) {
        const mm = m || metrics();
        const d = edgeDistance(x, mm);

        return d >= -EDGE_EPSILON_PX && d <= mm.zonePx + EDGE_EPSILON_PX && inExtent(y, mm);
    };

    const nearZone = function (x, m) {
        const d = edgeDistance(x, m);

        return d >= 0 && d <= m.zonePx * HINT_REACH;
    };

    const inPanel = function (x, y, m) {
        const mm = m || metrics();
        const d = edgeDistance(x, mm);

        // the box as applyLook writes it, in whole pixels
        return d >= 0 && d <= Math.round(mm.widthPx) && y >= Math.round(mm.topPx) && y <= mm.H - Math.round(mm.bottomPx);
    };

    // ---- visibility ----------------------------------------------------------------

    const rootOf = function (name) {
        return document.getElementById(name);
    };

    /**
     * Whether this app calls itself a developer tool. The rows know once the drawer is
     * built, but the question is asked before that too -- the loader calls applyStored the
     * moment it creates an app's root, and the drawer is not built until every app has
     * loaded -- so the loader's own copy of the manifest answers until then.
     */
    const isDeveloper = function (name) {
        const loader = ACEUIAppLoader.loader;

        if (Object.prototype.hasOwnProperty.call(state.dev, name)) { return state.dev[name]; }

        return Boolean(loader && loader.isDeveloper(name));
    };

    /**
     * Is this app on? A developer app is also off while the developer switch is, and that
     * gate belongs here rather than in the code that flips switches: everything goes
     * through this one function -- applyVisibility, applyStored, refreshAll, and the
     * loader's own `enabled`, which decides whether an app is even started. So a developer
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
     * Switch an app on or off for real.
     *
     * Hiding the root is not enough: a hidden app keeps its key handlers, its frame loop
     * and its sounds (DOOM still answered Insert and played music while "disabled"). So
     * the loader is asked to stop it through its own detach, and to start it again on
     * the way back. The root is hidden as well, which is the whole story for an app that
     * never gave the loader a detach.
     */
    const applyVisibility = function (name) {
        const root = rootOf(name);
        const on = isVisible(name);
        const loader = ACEUIAppLoader.loader;

        if (root) { root.style.display = on ? "" : "none"; }

        // an app whose attach throws is logged and left stopped: the throw must not reach build(),
        // setVisible() or refreshAll(), which would leave no drawer, or a switch half flipped
        // (second review, 2026-09-24: activate rethrows since a failed start clears its mark)
        if (loader) {
            if (on) {
                ACEUIAppLoader.safely("[drawer] starting " + name, function () { loader.activate(name); });
            } else {
                loader.deactivate(name);
            }
        }

        return on;
    };

    /**
     * Called by the loader the instant it creates an app's root, before the app's scripts
     * run. Without this a switched-off app is visible from the moment its root exists
     * until the drawer is built -- and the drawer is built on ACEUIAppLoader.ready, which
     * only fires once *every* app has finished loading. With a large app in the queue
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
     * and `app().show(true)` says so in the log rather than leaving a panel unreachable.
     */
    const setVisible = function (name, on) {
        state.visible[name] = Boolean(on);
        state.touched = true;
        state.touchedNames[name] = true;
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

    /** The list changed height: the scrollbar follows, and hides when everything fits. */
    const syncList = function () {
        if (!state.scroller || !state.list) { return; }

        state.scroller.invalidate();
        state.scroller.sync();

        if (state.track) { state.track.style.visibility = state.list.scrollHeight > state.list.clientHeight ? "" : "hidden"; }
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
        state.touchedDev = true;
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

        // measured once the rows' new layout exists: layout reads lag in this engine
        scheduleSync();
    };

    /** Re-apply every switch: after adopting the HUD store, apps may need hiding. */
    const refreshAll = function () {
        const apps = ACEUIAppLoader.apps || [];

        apps.forEach(function (entry) { applyVisibility(entry.name); });
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
     * The container appears a little after app scripts run, so this is called through
     * `persist.whenHudReady` rather than polling for it here.
     */
    const adoptHudStore = function () {
        const stored = switchesOf(persist.readHud(HUD_ID));
        const dev = persist.readHud(DEV_HUD_ID);

        // A switch the user flipped before the store existed reached localStorage only,
        // and localStorage dies with the game: their choice is newer than anything on
        // disk, so rather than skipping, this is the moment to write it *to* disk. Only
        // the switches they flipped: the rest of the map on disk is still the truth (a
        // single early flip wrote the whole in-memory map, which after a restart is empty,
        // and wiped every other switch saved; second review, 2026-09-24)
        if (state.touched) {
            if (stored) {
                Object.keys(stored).forEach(function (name) {
                    if (!state.touchedNames[name]) { state.visible[name] = stored[name]; }
                });
            }

            if (dev && !state.touchedDev) { state.developer = developerOf(dev); }

            state.touchedNames = {};
            state.touchedDev = false;
            store();
            refreshRows();
            refreshAll();

            return false;
        }

        let adopted = false;

        // the developer switch first, and on its own: `isVisible` consults it, and a
        // profile that has never touched an app switch still has one of these to restore
        if (dev) {
            state.developer = developerOf(dev);
            persist.writeLocal(DEV_STORE_KEY, { on: state.developer });
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
     * What the OPTIONS button on an app's row should open. ACEUIAppLoader.settings calls
     * this for every app that declares settings, so most apps never call it themselves.
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

    const cancelDwell = function () {
        if (!state.dwellTimer) { return; }

        window.clearTimeout(state.dwellTimer);
        state.dwellTimer = 0;
    };

    /** Where the panel parks when closed: just off its own edge. */
    const closedTransform = function () {
        return metrics().side === SIDE_LEFT ? "translateX(-100%)" : "translateX(100%)";
    };

    const setHint = function (alpha) {
        if (state.hint && state.hint.style.opacity !== alpha) { state.hint.style.opacity = alpha; }
    };

    /**
     * The hint's strength for this moment: nothing while the drawer is open or the HUD is
     * hidden; full while the pointer is near or for the intro after a build; the quiet
     * "always" level otherwise, if asked for.
     */
    const updateHint = function (near) {
        const mode = options().hint;

        if (mode === HINT_OFF || state.open || ACEUIAppLoader.hudHidden()) {
            setHint(HINT_ALPHA_OFF);
        } else if (near || state.intro) {
            setHint(HINT_ALPHA_NEAR);
        } else {
            setHint(mode === HINT_ALWAYS ? HINT_ALPHA_ALWAYS : HINT_ALPHA_OFF);
        }
    };

    const cancelPark = function () {
        if (!state.parkTimer) { return; }

        window.clearTimeout(state.parkTimer);
        state.parkTimer = 0;
    };

    /**
     * Measure the list for its scrollbar once the panel has stopped moving: a layout read at
     * the start of a slide is a stall in the slide's first frames, and at build the list
     * has no layout yet anyway.
     */
    const scheduleSync = function () {
        if (state.syncTimer) { window.clearTimeout(state.syncTimer); }

        state.syncTimer = window.setTimeout(function () {
            state.syncTimer = 0;
            syncList();
        }, SLIDE_MS);
    };

    const open = function () {
        cancelClose();
        cancelDwell();
        cancelPark();

        // never on a hidden HUD, whoever asks (a pinned build, the pin turned on while hidden)
        if (!state.panel || state.open || ACEUIAppLoader.hudHidden()) { return; }

        state.open = true;
        state.panel.style.visibility = "";
        // with a fade the transition names opacity only, so this move is instant: unparked, then faded in
        state.panel.style.transform = "translateX(0)";
        state.panel.style.opacity = "1";
        updateHint(false);
        scheduleSync();
    };

    const close = function () {
        cancelClose();
        cancelDwell();
        cancelPark();

        if (!state.panel || !state.open) { return; }

        state.open = false;
        state.visitPending = false;
        state.panel.style.opacity = "0";

        const motion = options().motion;
        const settle = motion === MOTION_SLIDE ? SLIDE_MS : (motion === MOTION_FADE ? FADE_MS : 0);
        // Once it has gone the panel is hidden as well as moved: parked by its own width, a panel set in from
        // the edge (Edge offset, Triple screen) still overlaps the screen, and at opacity 0 alone it would sit
        // there unseen, catching clicks meant for the HUD (full review, 2026-09-24). A fading panel is parked
        // only then too; parked at once, it would vanish rather than fade
        const park = function () {
            state.parkTimer = 0;

            if (!state.open && state.panel) {
                state.panel.style.transform = closedTransform();
                state.panel.style.visibility = "hidden";
            }
        };

        if (motion !== MOTION_FADE) { state.panel.style.transform = closedTransform(); }

        if (settle > 0) { state.parkTimer = window.setTimeout(park, settle); } else { park(); }

        updateHint(false);
    };

    /** The dwell is up: open only if the pointer is still in the zone, no button is held and the HUD is showing. */
    const dwellDone = function () {
        state.dwellTimer = 0;

        const last = state.last;

        if (ACEUIAppLoader.hudHidden() || state.buttonHeld || !last.known || !inZone(last.x, last.y, metrics())) { return; }

        open();
    };

    const closeSoon = function () {
        cancelClose();
        state.closeTimer = window.setTimeout(close, clamp(options().closeDelay, CLOSE_MIN_MS, CLOSE_MAX_MS));
    };

    const toggle = function () {
        if (state.open) { close(); } else { open(); }
    };

    const isPinned = function () {
        return Boolean(options().pinned);
    };

    const paintPin = function () {
        if (!state.pin) { return; }

        text(state.pin, isPinned() ? PINNED_TEXT : PIN_TEXT);
        state.pin.style.color = isPinned() ? THEME.on : THEME.inkDim;
    };

    const setPinned = function (on) {
        const settings = ACEUIAppLoader.settings;

        if (settings && settings.specs(DRAWER_APP).length) {
            settings.set(DRAWER_APP, KEY.pinned, Boolean(on));
        } else {
            options().pinned = Boolean(on);
            paintPin();
        }

        return isPinned();
    };

    /** Is the drawer's own settings pane open? While it is, the zone is drawn on screen. */
    const paneOpen = function () {
        const settings = ACEUIAppLoader.settings;

        return Boolean(settings && settings.specs(DRAWER_APP).length && settings.isOpen(DRAWER_APP));
    };

    const showZoneBox = function (on) {
        if (!state.zoneBox) { return; }

        const wanted = on ? "" : "hidden";

        if (state.zoneBox.style.visibility !== wanted) { state.zoneBox.style.visibility = wanted; }
    };

    const logJump = function (from, x, y) {
        if (state.jumpsLogged >= JUMP_LOG_MAX) { return; }

        state.jumpsLogged += 1;
        ACEUIAppLoader.log("[drawer] pointer jumped from " + from.x + "," + from.y + " to " + x + "," + y
            + ": not a movement, ignored" + (state.jumpsLogged === JUMP_LOG_MAX ? " (the last one logged)" : ""));
    };

    // ---- the trigger ---------------------------------------------------------------

    /**
     * The pointer moved. Everything the drawer does with the mouse starts here, and none
     * of it reads layout: the zone and the panel's box come from metrics(). A hidden HUD
     * closes the drawer and keeps it closed. A held button is a drag (an app panel on its
     * way to the edge), not a request to open. Only a real movement from a known position
     * can open it: not a jump (see JUMP_FRACTION), not a repeat of the last sample, and
     * not the first sample after a build.
     */
    const onMove = function (e) {
        if (!state.panel) { return; }

        const m = metrics();
        const x = e.clientX;
        const y = e.clientY;
        const last = state.last;
        const prevX = last.x;
        const moved = !last.known || x !== last.x || y !== last.y;
        // across against the width, down against the height (on a triple a quarter of the width is taller than the screen)
        const jump = last.known && (Math.abs(x - last.x) > m.W * JUMP_FRACTION || Math.abs(y - last.y) > m.H * JUMP_FRACTION);
        // the engine's report of a pointer that has left the window, whatever the distance (gameface-notes.md)
        const gone = x === 0 && y === 0;
        const arrived = last.known && moved && !jump && !gone;

        if ((jump || gone) && moved && last.known) {
            logJump(last, x, y);
            // the pointer went elsewhere and came back: a button released out there never reached us
            state.buttonHeld = false;
        }

        last.x = x;
        last.y = y;
        last.known = true;

        showZoneBox(paneOpen());

        if (ACEUIAppLoader.hudHidden()) {
            if (state.open) { close(); }

            cancelDwell();
            updateHint(false);

            return;
        }

        const zone = inZone(x, y, m);
        // an edge set in from the screen's (offset, triple) does not stop the pointer, and a fast hand can cross
        // its zone between two samples: from this side of the line to beyond it counts as reaching it, when
        // nothing asks the pointer to stay (a dwell is there to refuse a pass-through)
        const crossed = arrived && m.offsetPx > 0 && options().dwell <= 0 && inExtent(y, m) && edgeDistance(prevX, m) >= 0 && edgeDistance(x, m) < 0;

        // near the edge anywhere along it, not only within the extent: the line itself shows
        // which part of the edge opens the drawer. Only a movement lights it: a jump or a
        // repeated position is the engine talking, not the hand
        updateHint(arrived && nearZone(x, m));

        // pinned means on the screen: back as soon as the HUD is (a hidden HUD closed it)
        if (!state.open && isPinned()) {
            open();

            return;
        }

        if (!state.open) {
            if (arrived && triggerNow() === TRIGGER_HOVER && (zone || crossed) && !state.buttonHeld) {
                if (options().dwell > 0) {
                    if (!state.dwellTimer) { state.dwellTimer = window.setTimeout(dwellDone, clamp(options().dwell, 0, DWELL_MAX_MS)); }
                } else {
                    open();
                }
            } else if (moved) {
                // a repeat of the last sample is the engine talking, not the hand: it neither starts nor calls off a dwell
                cancelDwell();
            }

            return;
        }

        // its own settings pane is open: the Panel settings are being changed on it, so it stays to be seen
        if (isPinned() || paneOpen()) {
            cancelClose();

            return;
        }

        // the pointer gone (0,0) is in neither, whatever the geometry says: at the top of a left-hand
        // zone it kept the drawer open for as long as the pointer was on another monitor
        if (!gone && (zone || inPanel(x, y, m))) {
            state.visitPending = false;
            cancelClose();
        } else if (!state.visitPending && !state.closeTimer) {
            closeSoon();
        }
    };

    /**
     * A press: in the zone it opens the drawer when that is the trigger; outside the panel
     * it closes an open drawer (a click elsewhere on the HUD is the player moving on) unless
     * it is pinned or its own settings pane is open. Tracked either way, so a drag in
     * progress cannot open it, and a pending dwell is called off.
     */
    const onDown = function (e) {
        state.buttonHeld = true;
        cancelDwell();

        if (!state.panel || ACEUIAppLoader.hudHidden()) { return; }

        const m = metrics();

        if (!state.open) {
            if (triggerNow() === TRIGGER_CLICK && inZone(e.clientX, e.clientY, m)) { open(); }

            return;
        }

        // a press in the zone (above or below the panel, along a full-height zone) is at the drawer, not elsewhere:
        // closing there, the next move in the zone opened it again
        if (!inPanel(e.clientX, e.clientY, m) && !inZone(e.clientX, e.clientY, m) && !isPinned() && !paneOpen()) { close(); }
    };

    const onUp = function () {
        state.buttonHeld = false;
    };

    /** The window lost focus (if the engine ever says so): the pointer is elsewhere. */
    const onBlur = function () {
        state.buttonHeld = false;

        if (state.open && !isPinned()) { closeSoon(); }
    };

    const onHotkey = function (e) {
        if (!state.panel || ACEUIAppLoader.hudHidden()) { return; }

        // closing a pinned drawer unpins it, as its hint says: left pinned, the next pointer move brought it back
        if (state.open && isPinned()) { setPinned(false); }

        toggle();
        // opened from anywhere: the pointer may be a screen away, so no auto-close until it has reached the panel
        state.visitPending = state.open;
        e.preventDefault();
    };

    const currentKey = function () {
        return options().toggleKey || "";
    };

    /** The window listeners, once per page: build() may run again, the listeners must not. */
    const wire = function () {
        const dom = ACEUIAppLoader.dom;

        if (state.wired) { return; }

        state.wired = true;
        dom.on(window, "mousemove", onMove);
        dom.on(window, "mousedown", onDown, true);
        dom.on(window, "mouseup", onUp, true);
        dom.on(document, "mouseup", onUp, true);
        dom.on(window, "blur", onBlur);
        dom.on(window, "resize", function () { applyLook(); });

        if (ACEUIAppLoader.keys) { state.unbindKey = ACEUIAppLoader.keys.bind(currentKey, onHotkey); }
    };

    // ---- the look ------------------------------------------------------------------

    const rgba = function (rgb, alpha) {
        return "rgba(" + rgb + ", " + alpha + ")";
    };

    /**
     * Put the settings on the panel and the hint. Called on build, on every change and on
     * a window resize; it writes styles only, never rebuilds rows, so a change is instant.
     * Offsets, insets and the width are written in whole px (clamped against the viewport;
     * the width is rem worked out in px, as metrics() gives it), and the scale is one font-size in rem on the panel, everything inside
     * being in em.
     */
    const applyLook = function () {
        const opts = readOptions();
        const m = metrics();
        const left = m.side === SIDE_LEFT;
        const alpha = clamp(opts.opacity, OPACITY_MIN, OPACITY_MAX);
        const fade = "opacity " + FADE_MS + "ms ease-out";
        const slide = opts.motion === MOTION_SLIDE ? "transform " + SLIDE_MS + "ms ease-out, " + fade : (opts.motion === MOTION_FADE ? fade : "none");

        state.look = m;

        if (!state.panel) { return m; }

        // the zone itself, drawn while the settings pane is open
        css(state.zoneBox, {
            left: left ? Math.round(m.offsetPx) + "px" : "auto",
            right: left ? "auto" : Math.round(m.offsetPx) + "px",
            top: Math.round(m.extentTop) + "px",
            bottom: Math.round(m.H - m.extentBottom) + "px",
            width: Math.round(m.zonePx) + "px"
        });
        showZoneBox(paneOpen());

        // whole pixels: an edge at a fraction is antialiased into a hairline (see dom.snapToPixels)
        css(state.panel, {
            left: left ? Math.round(m.offsetPx) + "px" : "auto",
            right: left ? "auto" : Math.round(m.offsetPx) + "px",
            top: Math.round(m.topPx) + "px",
            bottom: Math.round(m.bottomPx) + "px",
            width: Math.round(m.widthPx) + "px",
            fontSize: clamp(opts.scale, SCALE_MIN, SCALE_MAX) + "rem",
            background: rgba(PANEL_RGB, alpha),
            borderLeft: left ? "none" : THEME.border,
            borderRight: left ? THEME.border : "none",
            borderRadius: left ? "0 0.25em 0.25em 0" : "0.25em 0 0 0.25em",
            transition: slide,
            transform: state.open ? "translateX(0)" : closedTransform(),
            visibility: state.open || state.parkTimer ? "" : "hidden"
        });

        if (state.header) { state.header.style.background = rgba(HEADER_RGB, alpha); }

        if (state.devHolder) { state.devHolder.style.background = rgba(HEADER_RGB, alpha); }

        css(state.hint, {
            left: left ? Math.round(m.offsetPx) + "px" : "auto",
            right: left ? "auto" : Math.round(m.offsetPx) + "px",
            top: Math.round(m.extentTop) + "px",
            bottom: Math.round(m.H - m.extentBottom) + "px",
            width: HINT_LINE_REM + "rem",
            transition: opts.motion === MOTION_NONE ? "none" : "opacity " + HINT_FADE_MS + "ms ease-out"
        });

        paintPin();
        updateHint(false);
        // measured once the new sizes have a layout: layout reads lag in this engine
        scheduleSync();

        return m;
    };

    /** Is the pointer, as last seen, on the drawer or its zone? */
    const pointerHere = function () {
        const last = state.last;
        const m = metrics();

        return last.known && !(last.x === 0 && last.y === 0) && (inZone(last.x, last.y, m) || inPanel(last.x, last.y, m));
    };

    const onSettingChange = function (key) {
        applyLook();

        // pinned means on the screen, now and after every reload, not "stays once you open it". Unpinned
        // (or every key notified by Reset to defaults), it goes as any open drawer goes: not while its pane
        // is open, not under the pointer, not before a hotkey visit; the next move away closes it
        // (second review, 2026-09-24: it closed under a still pointer, and with its own pane open)
        if (key === KEY.pinned) {
            if (isPinned()) {
                open();
            } else if (state.open && !paneOpen() && !state.visitPending && !pointerHere()) {
                closeSoon();
            }
        }
    };

    /**
     * Declare the drawer's settings. Every build declares them again (a redefine replaces
     * the schema and keeps the listeners), but the change listener is subscribed once.
     */
    const defineSettings = function () {
        const settings = ACEUIAppLoader.settings;

        if (!settings || typeof settings.define !== "function") { return false; }

        settings.define(DRAWER_APP, SPECS, { width: SETTINGS_WIDTH, hints: "footer", title: SETTINGS_TITLE });

        if (!state.unsubscribe) { state.unsubscribe = settings.onChange(DRAWER_APP, onSettingChange); }

        return true;
    };

    const openSettings = function () {
        const settings = ACEUIAppLoader.settings;

        if (settings && settings.specs(DRAWER_APP).length) { settings.toggle(DRAWER_APP); }

        showZoneBox(paneOpen());
    };

    /** Every drawer setting back to its default: the console escape hatch, documented in the README. */
    const resetSettings = function () {
        const settings = ACEUIAppLoader.settings;

        if (settings && settings.specs(DRAWER_APP).length) {
            settings.reset(DRAWER_APP);
        } else {
            state.opts = null;
        }

        return applyLook();
    };

    const logBuilt = function (m) {
        ACEUIAppLoader.log("[drawer] built: " + m.side + ", zone " + options().zone + "rem (" + Math.round(m.zonePx) + "px), 1rem = "
            + m.pxPerRem.toFixed(LOG_DECIMALS) + "px, viewport " + m.W + "x" + m.H + ", trigger " + triggerNow()
            + (currentKey() ? ", key " + currentKey() : "") + (isPinned() ? ", pinned" : ""));
    };

    // ---- building ------------------------------------------------------------------

    /** A small text button in the header: OPTIONS, PIN. */
    const headerButton = function (label, onClick) {
        const node = css(text(document.createElement("span"), label), {
            flex: "0 0 auto",
            marginLeft: "0.5em",
            padding: "0 0.2em",
            color: THEME.inkDim,
            fontSize: "0.65em",
            cursor: "pointer"
        });

        node.addEventListener("click", function (e) {
            onClick();
            e.stopPropagation();
        });

        return node;
    };

    const buildRow = function (app, onToggle) {
        const row = div({
            display: "flex",
            flexDirection: "row",
            alignItems: "center",
            padding: "0.3em 0.6em",
            cursor: "pointer"
        });
        const box = div({
            flex: "0 0 auto",
            width: "0.6em",
            height: "0.6em",
            marginRight: "0.5em",
            border: "1px solid " + THEME.inkOff,
            borderRadius: "0.15em"
        });
        const label = css(text(document.createElement("span"), app.title), {
            flex: "1 1 auto",
            color: THEME.ink,
            fontSize: "0.75em",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap"
        });
        const gear = css(text(document.createElement("span"), OPTIONS_GLYPH), {
            flex: "0 0 auto",
            marginLeft: "0.4em",
            padding: "0 0.2em",
            color: THEME.inkDim,
            fontSize: "0.8em",
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
                ACEUIAppLoader.safely("[drawer] " + app.name + " options", state.openers[app.name]);
            }

            e.stopPropagation();
        });

        app.row = row;
        app.box = box;
        app.label = label;
        app.gear = gear;

        return row;
    };

    /** An app that did not load gets a row that says why, rather than vanishing silently. */
    const buildStatus = function (app) {
        return css(text(document.createElement("div"), app.status), {
            padding: "0 0.6em 0.3em 1.7em",
            color: THEME.inkDim,
            fontSize: "0.6em"
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

        if (entry.status !== LOADED_STATUS) { holder.appendChild(buildStatus(app)); }

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
        state.devHolder = holder;

        return holder;
    };

    /**
     * The list and its scrollbar: Cohtml does not scroll an overflowing box, so the list is
     * a clipped box that ACEUIAppLoader.scroll drives from the wheel, with a thumb beside
     * it. With few apps the gutter is hidden; large scales and insets are what make it show.
     */
    const buildList = function () {
        const wrap = div({ flex: "1 1 auto", display: "flex", flexDirection: "row", minHeight: "0" });
        const list = div({ flex: "1 1 auto", overflow: "hidden" });
        const track = div({ flex: "0 0 auto", position: "relative", width: "0.3em", visibility: "hidden" });
        const thumb = div({ position: "absolute", top: "0", left: "0", width: "100%", background: THEME.inkOff, borderRadius: "0.15em" });

        track.appendChild(thumb);
        wrap.appendChild(list);
        wrap.appendChild(track);

        state.list = list;
        state.track = track;
        state.thumb = thumb;

        return wrap;
    };

    const build = function (apps) {
        const selector = ACEUIAppLoader.loader ? ACEUIAppLoader.loader.CONTAINER_SELECTOR : "";
        const container = (selector && document.querySelector(selector)) || document.body;
        const stored = switchesOf(persist.readHud(HUD_ID) || persist.readLocal(STORE_KEY));
        const storedDev = persist.readHud(DEV_HUD_ID) || persist.readLocal(DEV_STORE_KEY);
        const panel = div({
            position: "fixed",
            display: "flex",
            flexDirection: "column",
            color: THEME.ink,
            fontFamily: THEME.font,
            zIndex: Z_INDEX,
            opacity: "0",
            overflow: "hidden"
        });
        const header = div({
            flex: "0 0 auto",
            display: "flex",
            flexDirection: "row",
            alignItems: "center",
            padding: "0.45em 0.6em"
        });
        // the count is pushed right by a spacer, not by text-align: in game the aligned span drew
        // its text straight after the title ("APPS7 loaded", 2026-09-23); a flex spacer needs no alignment
        const spacer = div({ flex: "1 1 auto" });
        const count = css(document.createElement("span"), { flex: "0 0 auto", marginLeft: "0.6em", color: THEME.inkDim, fontSize: "0.65em" });
        const hint = div({
            position: "fixed",
            background: HINT_COLOUR,
            opacity: HINT_ALPHA_OFF,
            pointerEvents: "none",
            zIndex: HINT_Z_INDEX
        });
        const zoneBox = div({
            position: "fixed",
            background: ZONE_BOX_BG,
            border: ZONE_BOX_BORDER,
            visibility: "hidden",
            pointerEvents: "none",
            zIndex: HINT_Z_INDEX
        });

        // building again replaces the drawer rather than stacking a second one on top
        [state.panel, state.hint, state.zoneBox].forEach(function (node) {
            if (node && node.parentNode) { node.parentNode.removeChild(node); }
        });

        if (state.scroller) { state.scroller.detach(); }

        if (state.syncTimer) { window.clearTimeout(state.syncTimer); }

        state.syncTimer = 0;
        cancelClose();
        cancelDwell();
        cancelPark();
        state.last.known = false;
        state.jumpsLogged = 0;
        state.apps = [];
        state.dev = {};
        state.devRow = null;
        // the panel below starts parked off-screen, so the flag has to agree: rebuilding
        // while it was open would otherwise leave `open()` thinking it already is
        state.open = false;

        if (stored && !state.touched) { state.visible = stored; }

        if (storedDev && !state.touched) { state.developer = developerOf(storedDev); }

        defineSettings();
        readOptions();

        header.appendChild(css(text(document.createElement("span"), TITLE_TEXT), {
            flex: "0 0 auto", color: "#fff", fontSize: "0.75em", fontWeight: "700", letterSpacing: "0.08em"
        }));
        header.appendChild(spacer);
        header.appendChild(count);
        header.appendChild(headerButton(OPTIONS_GLYPH, openSettings));
        state.pin = headerButton(PIN_TEXT, function () { setPinned(!isPinned()); });
        header.appendChild(state.pin);
        panel.appendChild(header);
        panel.appendChild(buildList());

        apps.forEach(function (entry) {
            state.list.appendChild(buildApp(entry));
            applyVisibility(entry.name);
        });

        if (!apps.length) {
            state.list.appendChild(css(text(document.createElement("div"), EMPTY_TEXT), {
                padding: "0.5em 0.6em", color: THEME.inkDim, fontSize: "0.65em"
            }));
        }

        panel.appendChild(buildDeveloperRow());

        // a pointer on the panel never closes it, whatever the mousemove maths says
        panel.addEventListener("mouseenter", cancelClose);

        container.appendChild(zoneBox);
        container.appendChild(hint);
        container.appendChild(panel);

        state.panel = panel;
        state.header = header;
        state.count = count;
        state.hint = hint;
        state.zoneBox = zoneBox;
        state.built = true;
        state.scroller = ACEUIAppLoader.scroll ? ACEUIAppLoader.scroll.attach({ body: state.list, track: state.track, thumb: state.thumb }) : null;

        wire();
        applyLook();
        refreshRows();
        scheduleSync();

        // a pinned drawer is on the screen from the start, not from the first time the pointer finds it
        if (isPinned()) { open(); }

        // the intro: the edge line at full strength for a moment, so the drawer can be found
        if (state.introTimer) { window.clearTimeout(state.introTimer); }

        state.intro = true;
        updateHint(false);
        state.introTimer = window.setTimeout(function () {
            state.intro = false;
            state.introTimer = 0;
            updateHint(false);
        }, HINT_INTRO_MS);

        logBuilt(state.look);

        return panel;
    };

    // the HUD store shows up shortly after this file runs; adopt it when it does
    persist.whenHudReady(adoptHudStore, { pollMs: HUD_POLL_MS, waitMs: HUD_WAIT_MS });

    /** Whether this page gets a drawer at all; see HUD_PAGE. */
    const belongsOn = function (apps) {
        return ACEUIAppLoader.page === HUD_PAGE || (apps || []).some(function (entry) {
            return entry.status === LOADED_STATUS;
        });
    };

    /** Build once the loader knows what is installed, where anything is. */
    if (typeof ACEUIAppLoader.ready === "function") {
        ACEUIAppLoader.ready(function (apps) {
            if (state.built) { return; }

            if (!belongsOn(apps)) {
                ACEUIAppLoader.log("[drawer] not built: no app runs on this page");

                return;
            }

            build(apps);
        });
    }

    return {
        STORE_KEY: STORE_KEY,
        DRAWER_APP: DRAWER_APP,
        SPECS: SPECS,
        DEFAULTS: DEFAULTS,
        SLIDE_MS: SLIDE_MS,
        FADE_MS: FADE_MS,
        CLOSE_DELAY_MS: CLOSE_DELAY_MS,
        HINT_INTRO_MS: HINT_INTRO_MS,
        HINT_REACH: HINT_REACH,
        HINT_ALPHA_NEAR: HINT_ALPHA_NEAR,
        HINT_ALPHA_ALWAYS: HINT_ALPHA_ALWAYS,
        MIN_PANEL_HEIGHT_REM: MIN_PANEL_HEIGHT_REM,
        OFFSET_MAX_FRACTION: OFFSET_MAX_FRACTION,
        JUMP_FRACTION: JUMP_FRACTION,
        MOTION_SLIDE: MOTION_SLIDE,
        MOTION_FADE: MOTION_FADE,
        MOTION_NONE: MOTION_NONE,
        paneOpen: paneOpen,
        state: state,
        belongsOn: belongsOn,
        build: build,
        open: open,
        close: close,
        toggle: toggle,
        metrics: metrics,
        pxPerRem: pxPerRem,
        inZone: inZone,
        inPanel: inPanel,
        triggerNow: triggerNow,
        applyLook: applyLook,
        readOptions: readOptions,
        resetSettings: resetSettings,
        setPinned: setPinned,
        isPinned: isPinned,
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
