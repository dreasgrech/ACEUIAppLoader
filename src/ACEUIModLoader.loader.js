/**
 * ACEUIModLoader.loader -- finds and loads the installed UI mods.
 *
 * Last of the library files appended to the stock `uiresources/js/cohtml.js`.
 *
 * Discovery. A page cannot list folders, but the game lists one folder for it: the
 * video settings presets in `Saved Games\ACE\Video\*.settingspreset`, on request
 * `SettingsRequestVideoPresetList`, answered through `SettingsResponseVideoPresetList`
 * with the file stems. Every mod therefore ships an EMPTY marker file
 * `Video\ACEUIModLoaderMods-<name>.settingspreset` next to its folder
 * `mods\uiresources\ACEUIModLoaderMods\<name>\`; the player unzips both into
 * `Saved Games\ACE` and nothing has to be registered anywhere. The marker must stay
 * empty: the game deserialises each listed file first, and an empty file is a valid
 * default message. (Confirmed in game 2026-09-14.)
 *
 * The stock UI shows that same list in its video presets menu, so this file also
 * wraps `engine.on`: any stock handler for the response gets a copy of the answer
 * with our markers removed. Our own handler is flagged and sees the raw list.
 *
 * Fallback. Without an engine (browser harness) or without an answer within
 * PRESET_TIMEOUT_MS, the loader reads `ACEUIModLoaderMods/manifest.json`
 * (`{ "mods": ["pedalgraph", "devconsole"] }`) instead, so development setups keep
 * working. Per mod (`ACEUIModLoaderMods/<name>/mod.json`):
 *     { "name": "pedalgraph", "version": "0.4.0", "pages": ["hud.html"],
 *       "styles": ["pedalgraph.css"], "scripts": ["pedalgraph.js", "mod.js"] }
 *
 * Never request a URL that could be a folder: the game's loose-file lookup only
 * checks existence and then dies opening it (crashed the game three times). Only
 * plain file names listed in a mod.json are ever requested.
 *
 * Everything the loader logs starts with "[ACEUIModLoader]" so the game log (and
 * tools/check_ingame_log.py) can follow it.
 */
ACEUIModLoader.loader = (function () {

    /** Folder, relative to the page, that holds the mod folders (and the fallback manifest). */
    const ROOT = "ACEUIModLoaderMods/";
    const MANIFEST_URL = ROOT + "manifest.json";
    const MOD_FILE = "mod.json";
    /** Fallback when a mod.json lists no pages: only the HUD. */
    const DEFAULT_PAGES = ["hud.html"];
    /** A mod.json page list containing this loads the mod on every page. */
    const ANY_PAGE = "*";
    const HTTP_OK = 200;

    /** The game command that lists `Saved Games\ACE\Video\*.settingspreset`, and its answer. */
    const PRESET_REQUEST = "SettingsRequestVideoPresetList";
    const PRESET_RESPONSE = "SettingsResponseVideoPresetList";
    /** Marker file name: MARKER_PREFIX + mod name + MARKER_EXT, zero bytes. */
    const MARKER_PREFIX = "ACEUIModLoaderMods-";
    const MARKER_EXT = ".settingspreset";
    /** After this long without an answer the manifest fallback is used. */
    const PRESET_TIMEOUT_MS = 1500;
    /** Property set on our own response handler so the engine.on wrapper leaves it alone. */
    const OWN_HANDLER = "aceuimodloaderRaw";

    const log = ACEUIModLoader.log;

    const state = {
        mods: [],           // { name, info, status }
        source: "",         // "presets" | "manifest" | "none"
        filtering: false,   // engine.on wrapped, stock handlers never see markers
        readyCallbacks: []
    };

    const engineAvailable = function () {
        return typeof window.engine === "object" && window.engine !== null
            && typeof engine.on === "function" && typeof engine.trigger === "function";
    };

    /** The untouched engine.on, captured before it is wrapped; null in a plain browser. */
    const rawOn = engineAvailable() ? engine.on : null;

    /** Anything with our prefix is ours and is hidden from the stock UI, even if malformed. */
    const hasPrefix = function (name) {
        return typeof name === "string" && name.indexOf(MARKER_PREFIX) === 0;
    };

    /** A usable marker: our prefix followed by a mod name. */
    const isMarker = function (name) {
        return hasPrefix(name) && name.length > MARKER_PREFIX.length;
    };

    /** Mod names from a preset list answer: markers only, prefix removed, sorted. */
    const markerNames = function (filenames) {
        return (Array.isArray(filenames) ? filenames : []).filter(isMarker).map(function (name) {
            return name.slice(MARKER_PREFIX.length);
        }).sort();
    };

    /** A copy of a preset list answer without our markers (what the stock UI gets). */
    const withoutMarkers = function (response) {
        const copy = {};

        if (!response || !Array.isArray(response.filenames)) { return response; }

        Object.keys(response).forEach(function (key) { copy[key] = response[key]; });
        copy.filenames = response.filenames.filter(function (name) { return !hasPrefix(name); });

        return copy;
    };

    /** Wrap engine.on so stock handlers for the preset list never see markers. */
    const hideMarkersFromStock = function () {
        const wrapped = function (name, callback, context) {
            const filtering = function (response) {
                return callback.call(context || engine, withoutMarkers(response));
            };

            if (name !== PRESET_RESPONSE || typeof callback !== "function" || callback[OWN_HANDLER]) {
                return rawOn.call(engine, name, callback, context);
            }

            return rawOn.call(engine, name, filtering, context);
        };

        if (!rawOn) { return false; }

        engine.on = wrapped;

        return engine.on === wrapped;
    };

    /** GET a text resource relative to the page; onDone(text|null). Missing => null. */
    const fetchText = function (url, onDone) {
        const xhr = new XMLHttpRequest();

        xhr.open("GET", url);
        xhr.onload = function () {
            const ok = xhr.status === HTTP_OK || (xhr.status === 0 && xhr.responseText);

            onDone(ok ? xhr.responseText : null);
        };
        xhr.onerror = function () { onDone(null); };
        xhr.send();
    };

    const parseJson = function (text, what) {
        try {
            return JSON.parse(text);
        } catch (ignore) { /* reported below */ }

        log(what + ": invalid JSON");

        return null;
    };

    /**
     * Find the installed mod names: ask the game for the video preset list, fall back
     * to the manifest. onFound(names, source) is called exactly once.
     */
    const discover = function (onFound) {
        let settled = false;
        let handle = null;
        const finish = function (names, source) {
            if (settled) { return; }

            settled = true;
            if (handle && typeof handle.clear === "function") { handle.clear(); }
            onFound(names, source);
        };
        const fromManifest = function (reason) {
            fetchText(MANIFEST_URL, function (text) {
                const manifest = text === null ? null : parseJson(text, MANIFEST_URL);

                if (!manifest || !Array.isArray(manifest.mods)) {
                    log(reason + "; no manifest at " + MANIFEST_URL + "; nothing to load");
                    finish([], "none");

                    return;
                }

                finish(manifest.mods.slice(), "manifest");
            });
        };
        const onAnswer = function (response) {
            finish(markerNames(response ? response.filenames : null), "presets");
        };
        const send = function () {
            if (settled) { return; }

            engine.trigger("OnUICommand", PRESET_REQUEST, { __Type: PRESET_REQUEST, version: 0 });
        };

        if (!rawOn) {
            fromManifest("no engine");

            return;
        }

        onAnswer[OWN_HANDLER] = true;
        handle = rawOn.call(engine, PRESET_RESPONSE, onAnswer);
        window.setTimeout(function () {
            if (!settled) { fromManifest("no preset list answer in " + PRESET_TIMEOUT_MS + " ms"); }
        }, PRESET_TIMEOUT_MS);

        if (engine.whenReady && typeof engine.whenReady.then === "function") {
            engine.whenReady.then(send);
        } else {
            send();
        }
    };

    const addStylesheet = function (url) {
        const link = document.createElement("link");

        link.rel = "stylesheet";
        link.type = "text/css";
        link.href = url;
        document.head.appendChild(link);
    };

    /** Append a classic script and wait for it, so a mod's files run in mod.json order. */
    const addScript = function (url, onDone) {
        const script = document.createElement("script");
        let settled = false;
        const finish = function (ok) {
            if (settled) { return; }

            settled = true;
            onDone(ok);
        };

        script.src = url;
        script.onload = function () { finish(true); };
        script.onerror = function () { finish(false); };
        document.body.appendChild(script);
    };

    /** A file entry a mod.json may list: a plain relative file name with an extension, never a folder. */
    const isFileName = function (file) {
        return typeof file === "string" && file.indexOf("/") < 0 && file.indexOf("\\") < 0
            && file !== "." && file !== ".." && file.indexOf(".") > 0 && file.lastIndexOf(".") < file.length - 1;
    };

    const loadScripts = function (base, files, index, onDone) {
        if (index >= files.length) { onDone(true); return; }

        addScript(base + files[index], function (ok) {
            if (!ok) { log("failed to load " + base + files[index]); onDone(false); return; }

            loadScripts(base, files, index + 1, onDone);
        });
    };

    const wantsPage = function (info) {
        const pages = Array.isArray(info.pages) && info.pages.length ? info.pages : DEFAULT_PAGES;

        return pages.indexOf(ACEUIModLoader.page) >= 0 || pages.indexOf(ANY_PAGE) >= 0;
    };

    const loadMod = function (name, onDone) {
        const base = ROOT + name + "/";
        const entry = { name: name, info: null, status: "pending" };

        state.mods.push(entry);
        fetchText(base + MOD_FILE, function (text) {
            const info = text === null ? null : parseJson(text, name + "/" + MOD_FILE);
            const styles = info ? ACEUIModLoader.toArray(info.styles) : [];
            const scripts = info ? ACEUIModLoader.toArray(info.scripts) : [];

            if (!info) {
                entry.status = "missing";
                log("mod " + name + ": no " + MOD_FILE + ", skipped");
                onDone();

                return;
            }

            entry.info = info;

            if (!styles.concat(scripts).every(isFileName)) {
                entry.status = "invalid";
                log("mod " + name + ": " + MOD_FILE + " lists something that is not a plain file name, skipped");
                onDone();

                return;
            }

            if (!wantsPage(info)) {
                entry.status = "not-for-this-page";
                onDone();

                return;
            }

            log("mod " + name + " " + (info.version || "?") + ": loading " + scripts.length + " script(s), "
                + styles.length + " stylesheet(s)");
            styles.forEach(function (file) { addStylesheet(base + file); });
            loadScripts(base, scripts, 0, function (ok) {
                entry.status = ok ? "loaded" : "failed";
                log("mod " + name + (ok ? " loaded" : " FAILED"));
                onDone();
            });
        });
    };

    const loadMods = function (names, index) {
        if (index >= names.length) {
            state.readyCallbacks.forEach(function (cb) { cb(state.mods); });
            state.readyCallbacks = [];

            return;
        }

        loadMod(names[index], function () { loadMods(names, index + 1); });
    };

    const start = function () {
        log("loader " + ACEUIModLoader.VERSION + " on /" + ACEUIModLoader.page);
        state.filtering = hideMarkersFromStock();

        if (rawOn && !state.filtering) {
            log("could not wrap engine.on; markers will show in the video presets menu");
        }

        discover(function (names, source) {
            state.source = source;

            if (source !== "none") {
                log(source + ": " + names.length + " mod(s)");
            }

            loadMods(names, 0);
        });
    };

    /** Runs after all mods for this page have been processed. */
    const ready = function (callback) {
        state.readyCallbacks.push(callback);
    };

    /** "presets" (the game listed the markers), "manifest" (fallback) or "none"; "" until discovered. */
    const source = function () {
        return state.source;
    };

    /** True when stock handlers for the preset list get the marker-free copy. */
    const filtering = function () {
        return state.filtering;
    };

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", start);
    } else {
        start();
    }

    return {
        ROOT: ROOT,
        MOD_FILE: MOD_FILE,
        DEFAULT_PAGES: DEFAULT_PAGES,
        PRESET_REQUEST: PRESET_REQUEST,
        PRESET_RESPONSE: PRESET_RESPONSE,
        MARKER_PREFIX: MARKER_PREFIX,
        MARKER_EXT: MARKER_EXT,
        PRESET_TIMEOUT_MS: PRESET_TIMEOUT_MS,
        mods: state.mods,
        source: source,
        filtering: filtering,
        isMarker: isMarker,
        markerNames: markerNames,
        withoutMarkers: withoutMarkers,
        isFileName: isFileName,
        ready: ready,
        addStylesheet: addStylesheet,
        addScript: addScript
    };
}());

/* Convenience aliases so mods can stay on the flat `ACEUIModLoader.*` API. */
ACEUIModLoader.ROOT = ACEUIModLoader.loader.ROOT;
ACEUIModLoader.mods = ACEUIModLoader.loader.mods;
ACEUIModLoader.ready = ACEUIModLoader.loader.ready;
ACEUIModLoader.addStylesheet = ACEUIModLoader.loader.addStylesheet;
ACEUIModLoader.addScript = ACEUIModLoader.loader.addScript;
