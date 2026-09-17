/**
 * ACEUIAppLoader.shared -- what one app offers another.
 *
 * An app that has something other apps can use registers it here, under its own name:
 *
 *     ACEUIAppLoader.shared.register("profiler", { mark: mark, report: report });
 *
 *     const profiler = ACEUIAppLoader.shared.get("profiler");
 *     if (profiler) { profiler.mark("my slow bit"); }
 *
 * Why a registry rather than a global each. Globals work -- `DevConsole`, `ACEUIProfiler`
 * and `CapabilitiesProbe` are all still there for anyone already using them -- but they
 * collide: `ACEUIAppLoader.console` is this library's console hook, so the dev console
 * could never have taken that name. One table, keyed by the app name the loader already
 * knows, has room for everyone's, including apps we have never heard of.
 *
 * What registering does NOT do is promise anything. An app is registered only while it is
 * loaded on this page and switched on, so the answer to `get` changes over a session and
 * `has` is the only honest way to ask. The apps bundled in the loader's own package are
 * the nearest thing to a guarantee -- they ship with it, so a page that has this library
 * of this version has them -- and even then a player may be running an older loader, or
 * have installed a copy of their own that replaces the bundled one.
 *
 * Nothing here talks to the DOM or the engine: it is a table with a log line.
 */
ACEUIAppLoader.shared = (function () {

    const log = ACEUIAppLoader.log;

    /** name -> whatever that app handed us. */
    const registry = {};

    /**
     * Offer this app's surface to the others. Registering twice replaces the first -- a
     * app the drawer stopped and started again is the normal way that happens.
     */
    const register = function (name, api) {
        if (typeof name !== "string" || !name || !api) { return null; }

        registry[name] = api;
        log("[shared] " + name + " registered");

        return api;
    };

    /** Forget it again. An app with a detach should do this in it. */
    const unregister = function (name) {
        const had = Object.prototype.hasOwnProperty.call(registry, name);

        delete registry[name];

        return had;
    };

    /** What that app offers, or null. Ask every time rather than keeping the answer. */
    const get = function (name) {
        return Object.prototype.hasOwnProperty.call(registry, name) ? registry[name] : null;
    };

    const has = function (name) {
        return Object.prototype.hasOwnProperty.call(registry, name);
    };

    /** Everyone who has registered, sorted, so a diagnostic can print it. */
    const names = function () {
        return Object.keys(registry).sort();
    };

    return {
        register: register,
        unregister: unregister,
        get: get,
        has: has,
        names: names
    };
}());
