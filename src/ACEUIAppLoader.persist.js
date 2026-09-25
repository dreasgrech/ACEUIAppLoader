/**
 * ACEUIAppLoader.persist -- the three places a HUD app can keep state.
 *
 * Primary: the stock HUD's layout container (`HUD.elementModified(id, data)` /
 * `HUD.StoredData.layouts[<current>].elements[id]`), which the game writes to disk
 * when the HUD closes and reads back on every HUD load -- the same path the stock
 * widgets use for their positions. It only exists once the HUD's layout store has
 * loaded, a little after app scripts run, so readers poll it (see ACEUIAppLoader.panel).
 *
 * Fallback: localStorage, which lives as long as the UI view; it survives the HUD
 * page reload that Escape/resume causes but not a game restart.
 *
 * Third: the engine's key/value container itself (`storeLoaded` / `readStore` /
 * `writeStore` / `removeStore`), which the HUD store is one key inside. It also reaches
 * disk but under a top-level key of the app's own choosing, so it suits state too big
 * to belong in the HUD layout. It arrives asynchronously -- see `storeApi` below.
 *
 * Ids in the HUD store follow the stock convention `hud_<name>`; localStorage keys
 * are free-form (apps use `ace<app>.<what>`). All three take plain JSON data.
 */
ACEUIAppLoader.persist = (function () {

    const DEFAULT_LAYOUT = "default";
    /** How often, and for how long, whenHudReady looks for the store. */
    const POLL_MS = 50;
    const WAIT_MS = 8000;

    /** The stock HUD's element map for the current layout, or null when not ready. */
    const hudElements = function () {
        const hud = window.HUD;

        if (!hud || !hud.StoredData || !hud.StoredData.layouts) { return null; }

        const layout = hud.StoredData.layouts[hud.currentLayout || hud.StoredData.lastLayout || DEFAULT_LAYOUT];

        return layout && layout.elements ? layout.elements : null;
    };

    const hudAvailable = function () {
        return hudElements() !== null;
    };

    /** Stored entry for `id`, or null when the store is not ready or has none. An own entry only: an id named like an Object member is just an id. */
    const readHud = function (id) {
        const elements = hudElements();

        return elements && Object.prototype.hasOwnProperty.call(elements, id) && elements[id] ? elements[id] : null;
    };

    /** Records whose failed write was logged this page (no prototype: an id is just an id). */
    const loggedFailures = Object.create(null);

    /**
     * Writes through the stock API; false when the HUD object is not there (yet), or when its
     * write throws, which must not take the caller down: a window half opened, a setting half
     * set. `save` and the loader's own writers also write localStorage, which keeps the change;
     * writeHud alone does not. The stock store does not throw once it is readable (its current
     * layout is "default" from the start), so a throw is a store not loaded yet, whose record the
     * callers adopt or merge when it is.
     * Logged once per record, and again after a write of it succeeds: a slider dragged against a
     * broken store writes on every step.
     */
    const writeHud = function (id, data) {
        const hud = window.HUD;

        if (!hud || typeof hud.elementModified !== "function") { return false; }

        try {
            hud.elementModified(id, data);
        } catch (e) {
            if (!loggedFailures[id]) {
                loggedFailures[id] = true;
                ACEUIAppLoader.log("[persist] HUD store write of " + id + " failed: " + ACEUIAppLoader.errorText(e) + " (not in the HUD store)");
            }

            return false;
        }

        delete loggedFailures[id];

        return true;
    };

    const readLocal = function (key) {
        try {
            return JSON.parse(localStorage.getItem(key) || "null");
        } catch (ignore) { /* unreadable store: treated as nothing stored */ }

        return null;
    };

    const writeLocal = function (key, data) {
        try {
            localStorage.setItem(key, JSON.stringify(data));

            return true;
        } catch (ignore) { /* storage unavailable: the HUD store is the one that matters */ }

        return false;
    };

    const removeLocal = function (key) {
        try {
            localStorage.removeItem(key);
        } catch (ignore) { /* nothing to remove */ }
    };

    /**
     * The engine's own key/value container (`window.STORAGE`), which is what the HUD
     * layout lives inside: the game writes every key of it to
     * `Saved Games\ACE\ui_storage.uistorage` and reads them back at startup. Unlike the
     * HUD store this takes a **top-level key of our own**, so an app with more to keep
     * than a position -- DOOM's saved games, say -- can do it without swelling the
     * layout blob the stock widgets depend on.
     *
     * Values go through JSON, so plain data only. Two things to know:
     *
     *   - it fills in asynchronously. `STORAGE` itself exists from the engine's Init,
     *     but its contents arrive a moment later, so a read before `storeLoaded()` sees
     *     nothing. Poll it (a frame loop is the natural place) rather than reading once.
     *   - `save` re-serialises and sends *every* key, not only yours. Write rarely and
     *     keep values small: the whole file is around 17 kB before we add anything.
     */
    const storeApi = function () {
        const store = window.STORAGE;

        return store && typeof store.get === "function" && typeof store.set === "function"
            && typeof store.save === "function" ? store : null;
    };

    /** True once the engine has handed the container its contents and a read is meaningful. */
    const storeLoaded = function () {
        const store = storeApi();

        return Boolean(store) && store.size > 0;
    };

    const readStore = function (key) {
        const store = storeApi();

        if (!store) { return null; }

        const value = store.get(key);

        return value === undefined ? null : value;
    };

    /** Writes and asks the engine to persist; false when the container is not there. */
    const writeStore = function (key, data) {
        const store = storeApi();

        if (!store) { return false; }

        store.set(key, data);

        try {
            const pending = store.save(key);

            // the engine hands back a promise; an unhandled rejection would reach the console
            if (pending && typeof pending.catch === "function") { pending.catch(function () { return null; }); }
        } catch (ignore) { /* the container refused the write; the caller still has its copy */ }

        return true;
    };

    const removeStore = function (key) {
        const store = storeApi();

        if (!store || typeof store.delete !== "function") { return false; }

        store.delete(key);

        return true;
    };

    /**
     * Call `onReady` once the stock HUD's layout store exists, or `onTimeout` (if given)
     * when it never turns up. Three separate pollers for this had grown in the library --
     * the drawer waiting to adopt stored switches, input waiting for `ksUI`, the panel
     * checking every frame -- each with its own interval and deadline. The store appears
     * a little after app scripts run, so this is the shape every one of them needed.
     *
     * Returns a cancel function, for an app that detaches before the store shows up.
     */
    const whenHudReady = function (onReady, options) {
        const opts = options || {};
        const pollMs = opts.pollMs || POLL_MS;
        const deadline = Date.now() + (opts.waitMs || WAIT_MS);
        const handle = { cancelled: false, timer: 0 };
        const poll = function () {
            if (handle.cancelled) { return; }

            if (hudAvailable()) {
                onReady();

                return;
            }

            if (Date.now() > deadline) {
                if (typeof opts.onTimeout === "function") { opts.onTimeout(); }

                return;
            }

            handle.timer = window.setTimeout(poll, pollMs);
        };

        poll();

        return function () {
            handle.cancelled = true;
            window.clearTimeout(handle.timer);
        };
    };

    /** Write to both stores; returns the names of the ones that took it, for logging. */
    const save = function (hudId, localKey, data) {
        const where = [];

        if (hudId && writeHud(hudId, data)) { where.push("hud layout"); }

        if (localKey && writeLocal(localKey, data)) { where.push("localStorage"); }

        return where;
    };

    return {
        hudElements: hudElements,
        hudAvailable: hudAvailable,
        whenHudReady: whenHudReady,
        readHud: readHud,
        writeHud: writeHud,
        readLocal: readLocal,
        writeLocal: writeLocal,
        removeLocal: removeLocal,
        storeLoaded: storeLoaded,
        readStore: readStore,
        writeStore: writeStore,
        removeStore: removeStore,
        save: save
    };
}());
