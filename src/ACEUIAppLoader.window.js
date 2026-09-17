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

    const THEME = ACEUIAppLoader.dom.THEME;

    const NO_DRAG_ATTR = ACEUIAppLoader.panel.NO_DRAG_ATTR;

    /** id -> { id, root, header, body, panel, options } */
    const open_windows = {};
    let loop = null;

    const make = ACEUIAppLoader.dom.make;

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

    const close = function (id) {
        const win = open_windows[id];

        if (!win) { return false; }

        ACEUIAppLoader.panel.detach(win.panel);

        if (win.root.parentNode) { win.root.parentNode.removeChild(win.root); }

        delete open_windows[id];
        stopLoop();

        if (typeof win.options.onClose === "function") {
            ACEUIAppLoader.safely("[window] " + id + " onClose", function () { win.options.onClose(id); });
        }

        return true;
    };

    const closeAll = function () {
        ids().forEach(close);
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
        const shut = make("span", {
            padding: "0 0.3rem",
            color: THEME.inkDim,
            fontWeight: "700",
            cursor: "pointer"
        }, CLOSE_TEXT);
        // the body is where the app puts its content; clicking in it must not drag
        const body = make("div", { padding: "0.4rem 0.6rem 0.6rem 0.6rem" });

        root.setAttribute(WINDOW_ATTR, id);
        shut.setAttribute(CLOSE_ATTR, "");
        shut.setAttribute(NO_DRAG_ATTR, "");
        body.setAttribute(NO_DRAG_ATTR, "");
        shut.addEventListener("click", function (e) { close(id); e.stopPropagation(); });

        header.appendChild(titleNode);
        header.appendChild(shut);
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

    return {
        WINDOW_ATTR: WINDOW_ATTR,
        CLOSE_ATTR: CLOSE_ATTR,
        open: open,
        close: close,
        closeAll: closeAll,
        toggle: toggle,
        isOpen: isOpen,
        get: get,
        ids: ids
    };
}());
