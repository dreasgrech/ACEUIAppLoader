/**
 * ACEUIAppLoader.window -- floating windows for apps, with a title bar and a close button.
 *
 * An app that needs a second surface -- settings, help, a picker, a report -- should not
 * have to hand-build a panel, wire dragging, remember where the player put it and manage
 * a frame loop. This does all of that:
 *
 *     const win = ACEUIAppLoader.window.open("doom.help", { title: "DOOM help" });
 *     win.body.appendChild(myContent);      // fill it with whatever you like
 *     win.setTitle("DOOM help (page 2)");
 *     win.close();
 *
 *     ACEUIAppLoader.window.toggle("doom.help", { title: "DOOM help" });
 *     ACEUIAppLoader.window.isOpen("doom.help");
 *     ACEUIAppLoader.window.get("doom.help");
 *     ACEUIAppLoader.window.closeAll();
 *
 * The id is yours to choose and should be unique per window, not per app -- an app can
 * have several. It is also the storage key, so a window remembers its own position:
 * prefix it with the app name (`"doom.help"`, `"telemetry.laps"`) to keep them apart.
 *
 * Options, all optional: `title`, `width`, `left`, `top`, `onClose`, `onOpen`.
 *
 * Dragging and position persistence come from ACEUIAppLoader.panel, which settles a
 * restored position over a few frames, so an open window needs a frame loop. One loop is
 * shared by every open window and it stops when the last one closes -- nothing runs while
 * they are all shut.
 *
 * Which windows are open is remembered too, in both stores like the drawer's switches, so
 * a window that was open when the HUD page reloads (Escape and resume) comes back, and one
 * open when the game was quit comes back next launch. The loader cannot rebuild a window's
 * content -- that is its owner's -- so the owner says how, once per id, each time its
 * script runs:
 *
 *     ACEUIAppLoader.window.reopen("doom.help", function () { showHelp(); });
 *
 * If that id was open when the page went away, the function runs on the next frame; if the
 * HUD store (which arrives a little later) says so, it runs then. A window closed by hand, or by
 * `close`/`closeAll`, is forgotten; `discard`/`discardAll` shut without forgetting, which is
 * what a page going away means (the tests use it to play a reload).
 *
 * Styling is inline for the same reason as the app drawer: the loader ships as a single
 * overriding file inside a package whose layout is delicate, so it carries no stylesheet.
 */
ACEUIAppLoader.window = (function () {

    const DEFAULT_WIDTH = "17rem";
    const DEFAULT_LEFT = "30%";
    const DEFAULT_TOP = "20%";
    const Z_INDEX = "9100";

    const CLOSE_TEXT = "X";
    const WINDOW_ATTR = "data-ace-window";
    const CLOSE_ATTR = "data-ace-window-close";
    const HUD_PREFIX = "hud_";
    const HUD_SUFFIX = "_window";
    const LOCAL_PREFIX = "acewindow.";

    /** Where the set of open windows is kept: the HUD layout store (survives a restart) and localStorage (this session). */
    const OPEN_HUD_ID = "hud_acewindows";
    const OPEN_STORE_KEY = "acewindows.open";

    const THEME = ACEUIAppLoader.dom.THEME;

    const NO_DRAG_ATTR = ACEUIAppLoader.panel.NO_DRAG_ATTR;

    const persist = ACEUIAppLoader.persist;

    /** id -> { id, root, header, body, panel, options } */
    const open_windows = {};
    let loop = null;

    /** id -> how to open it again (the owner's function), see `reopen`. */
    const reopeners = {};

    const make = ACEUIAppLoader.dom.make;

    /**
     * A window belongs to the page it was opened on: a settings pane opened over the HUD
     * comes back over the HUD, not over the pit-lane menu an app that lives on every page
     * would also load on. The stores hold `{ open: { "hud.html": [ids], ... } }`.
     */
    const page = ACEUIAppLoader.page || "";

    /** The stored record as page -> map of open ids. */
    const storedPages = function (record) {
        const out = {};
        const pages = record && record.open && typeof record.open === "object" && !Array.isArray(record.open) ? record.open : {};

        Object.keys(pages).forEach(function (name) {
            out[name] = {};

            if (Array.isArray(pages[name])) {
                pages[name].forEach(function (id) { if (typeof id === "string" && id) { out[name][id] = true; } });
            }
        });

        return out;
    };

    /**
     * When each page's list was last written, from a record. Each page carries its own stamp
     * (`pageAt`): one stamp for the whole record let a change on one page (a menu page an app
     * lives on too) overwrite every other page's list, and a window opened before the HUD
     * store arrived wiped the HUD's list from disk (full review, 2026-09-24). A record from
     * before per-page stamps counts every page at its one `at`.
     */
    const pageStamps = function (record) {
        const out = {};
        const legacy = record && typeof record.at === "number" ? record.at : 0;
        const stamps = record && record.pageAt && typeof record.pageAt === "object" ? record.pageAt : {};

        Object.keys(storedPages(record)).forEach(function (name) {
            out[name] = typeof stamps[name] === "number" ? stamps[name] : legacy;
        });

        return out;
    };

    /** Two records merged page by page, each page's list taken from whichever wrote it last. */
    const mergeRecords = function (a, b) {
        const pagesA = storedPages(a);
        const pagesB = storedPages(b);
        const atA = pageStamps(a);
        const atB = pageStamps(b);
        const out = { pages: {}, at: {}, fromA: {} };

        Object.keys(pagesA).concat(Object.keys(pagesB)).forEach(function (name) {
            // b wins a tie: in adopt b is the store, and a list this page merely created empty has no stamp to beat it with
            const useB = Object.prototype.hasOwnProperty.call(pagesB, name)
                && (!Object.prototype.hasOwnProperty.call(pagesA, name) || atB[name] >= atA[name]);

            out.pages[name] = Object.assign({}, useB ? pagesB[name] : pagesA[name]);
            out.at[name] = useB ? atB[name] : atA[name];
            out.fromA[name] = !useB && Object.prototype.hasOwnProperty.call(pagesB, name);
        });

        return out;
    };

    /**
     * The opens and closes made before the HUD store was adopted, from a record: page -> id ->
     * open (true) or closed (false), the last word per window. Only localStorage ever holds
     * them (see saveRemembered); anything not of that shape is dropped.
     */
    const pendingOf = function (record) {
        const out = {};
        const ops = record && record.ops && typeof record.ops === "object" && !Array.isArray(record.ops) ? record.ops : {};

        Object.keys(ops).forEach(function (name) {
            const byId = ops[name];

            if (!byId || typeof byId !== "object" || Array.isArray(byId)) { return; }

            Object.keys(byId).forEach(function (id) {
                if (id && typeof byId[id] === "boolean") {
                    if (!out[name]) { out[name] = {}; }

                    out[name][id] = byId[id];
                }
            });
        });

        return out;
    };

    /**
     * What is remembered as open, per page, and when each page's list was written. Read once
     * at load from both stores, page by page, the newer list winning (within a game session
     * localStorage usually has it and the HUD store is not there yet; across a restart the
     * HUD store is adopted when it arrives, see `adopt`). `pending` holds the opens and closes
     * made before the HUD store was adopted, on this page and on any page loaded before it
     * that never saw the store (they come with localStorage), replayed on its lists when it is.
     */
    const localRecord = persist.readLocal(OPEN_STORE_KEY);
    const loaded = mergeRecords(localRecord, persist.readHud(OPEN_HUD_ID));
    /** What was loaded, in the stored shape: the snapshot adopt merges with, never touched by this page's own changes. */
    const loadedRecord0 = function () {
        const record = { open: {}, pageAt: {} };

        Object.keys(loaded.pages).forEach(function (name) {
            record.open[name] = Object.keys(loaded.pages[name]);
            record.pageAt[name] = loaded.at[name];
        });

        return record;
    };
    const remembered = { pages: mergeRecords(loadedRecord0(), null).pages, at: Object.assign({}, loaded.at), pending: pendingOf(localRecord), touched: false, adopted: false };

    /** The open ids remembered for this page, as a map. */
    const openHere = function () {
        if (!remembered.pages[page]) { remembered.pages[page] = {}; }

        return remembered.pages[page];
    };

    /**
     * The record, with every page's stamp. The two stores drift: the HUD store reaches disk
     * only when the game saves the layout, so after a reload it can hold an older list than
     * localStorage does -- a settings window closed just before a session restart came back
     * with it (seen in game 2026-09-23). A page whose windows are all shut is kept, empty,
     * with its stamp: dropped, an older copy of it elsewhere would win again.
     *
     * Until the HUD store has been adopted, only localStorage is written, with the pending
     * changes: the lists this page holds then are not the store's (after a restart they are
     * only what localStorage had), and written over the store they wiped what it remembered
     * for every page; kept with their changes, a reload before the store arrives still replays
     * them on its lists rather than putting this page's in their place (second review, 2026-09-24).
     */
    const saveRemembered = function () {
        const record = { open: {}, pageAt: {}, at: Date.now() };

        Object.keys(remembered.pages).forEach(function (name) {
            record.open[name] = Object.keys(remembered.pages[name]);
            record.pageAt[name] = typeof remembered.at[name] === "number" ? remembered.at[name] : 0;
        });

        if (!remembered.adopted) {
            record.ops = remembered.pending;
            persist.writeLocal(OPEN_STORE_KEY, record);

            return;
        }

        persist.save(OPEN_HUD_ID, OPEN_STORE_KEY, record);
    };

    const rememberOpen = function (id, on) {
        const here = openHere();

        if (Boolean(here[id]) === on) { return; }

        if (on) { here[id] = true; } else { delete here[id]; }

        // before the store is adopted the change is kept as a change, and the list's stamp is left as loaded:
        // the store's list, when it comes, is the base the change is replayed on
        if (remembered.adopted) {
            remembered.at[page] = Date.now();
        } else {
            if (!remembered.pending[page]) { remembered.pending[page] = {}; }

            remembered.pending[page][id] = on;
        }

        remembered.touched = true;
        saveRemembered();
    };

    /** Remembered open, not open now, and its owner has said how: due to come back. */
    const due = function (id) {
        return Boolean(openHere()[id]) && !open_windows[id] && typeof reopeners[id] === "function";
    };

    /** Bring back a remembered window through its owner's opener. */
    const restore = function (id) {
        if (!due(id)) { return false; }

        ACEUIAppLoader.safely("[window] " + id + " reopen", function () { reopeners[id](id); });

        if (open_windows[id]) { ACEUIAppLoader.log("[window] " + id + " reopened: it was open when the page went away"); }

        return Boolean(open_windows[id]);
    };

    /**
     * Reopening waits for the next frame rather than running inside the owner's call: an
     * owner registers from its script's top level, often from inside the very call that
     * declares the window's content (settings.define), and content that reads the owner's
     * own module state -- a `when` on a row reading the values `define` is about to return
     * -- would run before that state exists. A frame later everything is in place.
     */
    const schedule = function (id) {
        if (typeof window.requestAnimationFrame === "function") {
            window.requestAnimationFrame(function () { restore(id); });
        } else {
            restore(id);
        }
    };

    /**
     * Register how to open `id` again after a reload; returns true when it is due to come
     * back (on the next frame). The owner calls this each time its script runs, whether or
     * not the window was open: the loader decides from what it remembers.
     */
    const reopen = function (id, fn) {
        if (!id || typeof fn !== "function") { return false; }

        reopeners[id] = fn;

        if (!due(id)) { return false; }

        schedule(id);

        return true;
    };

    /**
     * The HUD store arrived. Page by page, its list and the one this page loaded are merged,
     * the newer winning (the disk lagging behind this game session keeps ours); the opens and
     * closes this page made meanwhile are replayed on top of its own page's list, so a window
     * opened before the store came does not wipe what the store remembered, and one closed
     * stays closed. Both stores are written with the result, and every remembered window of
     * this page whose owner has registered comes back on the next frame. Returns those ids.
     */
    const adopt = function () {
        const stored = persist.readHud(OPEN_HUD_ID);
        const pending = remembered.pending;
        const changed = Object.keys(pending);

        remembered.adopted = true;
        remembered.pending = {};

        if (!stored || !stored.open || typeof stored.open !== "object") {
            // nothing on disk to merge with: this session's lists, its changes in them, are the record
            if (remembered.touched || changed.length) { saveRemembered(); }

            return [];
        }

        const merged = mergeRecords(loadedRecord0(), stored);
        const kept = Object.keys(merged.fromA).filter(function (name) { return merged.fromA[name]; });

        if (kept.length) {
            ACEUIAppLoader.log("[window] the HUD store's list of open windows was older than this session's; kept ours (" + kept.join(", ") + ")");
        }

        // the opens and closes made before the store came, replayed on its lists, each page's on its own
        changed.forEach(function (name) {
            const base = merged.pages[name] || {};

            Object.keys(pending[name]).forEach(function (id) {
                if (pending[name][id]) { base[id] = true; } else { delete base[id]; }
            });
            merged.pages[name] = base;
            merged.at[name] = Date.now();
        });

        if (changed.length) {
            ACEUIAppLoader.log("[window] windows opened or closed before the HUD store arrived, replayed on its list: " + changed.join(", "));
        }

        remembered.pages = merged.pages;
        remembered.at = merged.at;
        saveRemembered();

        const coming = Object.keys(openHere()).filter(due);

        coming.forEach(schedule);

        return coming;
    };

    const ids = function () {
        return Object.keys(open_windows);
    };

    const isOpen = function (id) {
        return Boolean(open_windows[id]);
    };

    const get = function (id) {
        return open_windows[id] || null;
    };

    /** One loop for all open windows; it only exists while at least one is open. */
    const startLoop = function () {
        if (loop || !ACEUIAppLoader.loop) { return; }

        loop = ACEUIAppLoader.loop.start(function (now) {
            ids().forEach(function (id) { ACEUIAppLoader.panel.update(open_windows[id].panel, now); });
        });
    };

    const stopLoop = function () {
        if (!loop || ids().length) { return; }

        ACEUIAppLoader.loop.stop(loop);
        loop = null;
    };

    /** Take the window down; `forget` says whether it should stay remembered as open (a page going away) or not (shut on purpose). */
    const shut = function (id, forget) {
        const win = open_windows[id];

        if (!win) { return false; }

        ACEUIAppLoader.panel.detach(win.panel);

        if (win.root.parentNode) { win.root.parentNode.removeChild(win.root); }

        delete open_windows[id];
        stopLoop();

        if (forget) { rememberOpen(id, false); }

        if (typeof win.options.onClose === "function") {
            ACEUIAppLoader.safely("[window] " + id + " onClose", function () { win.options.onClose(id); });
        }

        return true;
    };

    const close = function (id) {
        return shut(id, true);
    };

    const closeAll = function () {
        ids().forEach(close);
    };

    /** Shut without forgetting: the window was open when the page went away and should come back. */
    const discard = function (id) {
        return shut(id, false);
    };

    const discardAll = function () {
        ids().forEach(discard);
    };

    const container = function () {
        const selector = ACEUIAppLoader.loader ? ACEUIAppLoader.loader.CONTAINER_SELECTOR : "";

        return (selector && document.querySelector(selector)) || document.body;
    };

    /**
     * Open (or bring back) the window with this id. Returns its handle: `{ id, root,
     * header, body, close, setTitle, isOpen }`. Opening one that is already open returns
     * the existing handle rather than stacking a second copy.
     */
    const open = function (id, options) {
        const opts = options || {};

        if (!id) { return null; }

        if (open_windows[id]) { return open_windows[id]; }

        const root = make("div", {
            position: "absolute",
            left: opts.left || DEFAULT_LEFT,
            top: opts.top || DEFAULT_TOP,
            width: opts.width || DEFAULT_WIDTH,
            display: "flex",
            flexDirection: "column",
            background: THEME.panelBg,
            border: "2px solid transparent",
            borderRadius: "0.25rem",
            color: THEME.ink,
            fontFamily: THEME.font,
            fontSize: "0.8rem",
            zIndex: Z_INDEX,
            cursor: "pointer"
        });
        const header = make("div", {
            display: "flex",
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "0.4rem 0.6rem",
            background: THEME.headerBg,
            borderRadius: "0.25rem 0.25rem 0 0"
        });
        const titleNode = make("span", {
            color: THEME.white,
            fontSize: "0.75rem",
            fontWeight: "700",
            letterSpacing: "0.04em"
        }, opts.title || id);
        const closeButton = make("span", {
            padding: "0 0.3rem",
            color: THEME.inkDim,
            fontWeight: "700",
            cursor: "pointer"
        }, CLOSE_TEXT);
        // the body is where the app puts its content; clicking in it must not drag
        const body = make("div", { padding: "0.4rem 0.6rem 0.6rem 0.6rem" });

        root.setAttribute(WINDOW_ATTR, id);
        closeButton.setAttribute(CLOSE_ATTR, "");
        closeButton.setAttribute(NO_DRAG_ATTR, "");
        body.setAttribute(NO_DRAG_ATTR, "");
        closeButton.addEventListener("click", function (e) { close(id); e.stopPropagation(); });

        header.appendChild(titleNode);
        header.appendChild(closeButton);
        root.appendChild(header);
        root.appendChild(body);
        container().appendChild(root);

        const win = {
            id: id,
            root: root,
            header: header,
            body: body,
            options: opts,
            setTitle: function (text) { titleNode.textContent = text; return win; },
            isOpen: function () { return isOpen(id); },
            close: function () { return close(id); },
            panel: ACEUIAppLoader.panel.attach(root, {
                hudId: HUD_PREFIX + id + HUD_SUFFIX,
                storageKey: LOCAL_PREFIX + id,
                log: ACEUIAppLoader.log
            })
        };

        open_windows[id] = win;
        startLoop();
        rememberOpen(id, true);

        if (typeof opts.onOpen === "function") {
            ACEUIAppLoader.safely("[window] " + id + " onOpen", function () { opts.onOpen(win); });
        }

        return win;
    };

    /** Open it if it is shut, shut it if it is open. Returns true when it ended up open. */
    const toggle = function (id, options) {
        if (isOpen(id)) {
            close(id);

            return false;
        }

        open(id, options);

        return true;
    };

    // the store appears a little after the page's scripts run; what it remembers as open
    // comes back then, unless this page has already decided otherwise (see adopt)
    persist.whenHudReady(adopt);

    return {
        WINDOW_ATTR: WINDOW_ATTR,
        CLOSE_ATTR: CLOSE_ATTR,
        OPEN_HUD_ID: OPEN_HUD_ID,
        OPEN_STORE_KEY: OPEN_STORE_KEY,
        remembered: remembered,
        open: open,
        close: close,
        closeAll: closeAll,
        discard: discard,
        discardAll: discardAll,
        reopen: reopen,
        adopt: adopt,
        toggle: toggle,
        isOpen: isOpen,
        get: get,
        ids: ids
    };
}());
