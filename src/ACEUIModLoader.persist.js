/**
 * ACEUIModLoader.persist -- the two places a HUD mod can keep small state.
 *
 * Primary: the stock HUD's layout container (`HUD.elementModified(id, data)` /
 * `HUD.StoredData.layouts[<current>].elements[id]`), which the game writes to disk
 * when the HUD closes and reads back on every HUD load -- the same path the stock
 * widgets use for their positions. It only exists once the HUD's layout store has
 * loaded, a little after mod scripts run, so readers poll it (see ACEUIModLoader.panel).
 *
 * Fallback: localStorage, which lives as long as the UI view; it survives the HUD
 * page reload that Escape/resume causes but not a game restart.
 *
 * Ids in the HUD store follow the stock convention `hud_<name>`; localStorage keys
 * are free-form (mods use `ace<mod>.<what>`). Both stores take plain JSON data.
 */
ACEUIModLoader.persist = (function () {

    const DEFAULT_LAYOUT = "default";

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

    /** Stored entry for `id`, or null when the store is not ready or has none. */
    const readHud = function (id) {
        const elements = hudElements();

        return elements && elements[id] ? elements[id] : null;
    };

    /** Writes through the stock API; false when the HUD object is not there (yet). */
    const writeHud = function (id, data) {
        const hud = window.HUD;

        if (!hud || typeof hud.elementModified !== "function") { return false; }

        hud.elementModified(id, data);

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
        readHud: readHud,
        writeHud: writeHud,
        readLocal: readLocal,
        writeLocal: writeLocal,
        removeLocal: removeLocal,
        save: save
    };
}());
