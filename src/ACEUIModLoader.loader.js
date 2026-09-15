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
 * There is no other source of mod names: without an engine (a plain browser) or
 * without an answer within PRESET_TIMEOUT_MS the loader logs why and loads nothing.
 *
 * Per mod, `ACEUIModLoaderMods/<name>/mod.json` holds what cannot be inferred:
 *     { "version": "0.4.0", "styles": ["pedalgraph.css"], "scripts": ["pedalgraph.js"] }
 * Optional: "pages" (default ["hud.html"], "*" = every page), "title" (log prefix,
 * default the name), "root": false (do not create a root element). The name is
 * the folder's; a "name" key must match it if present.
 *
 * Before a mod's scripts run the loader creates its root, `<div id="<name>"
 * data-mod="<name>">`, inside the HUD's positioning container (or <body> on
 * pages without one), so a script only has to attach to `#<name>`. While the
 * scripts run, `ACEUIModLoader.mod()` describes the mod being loaded: name,
 * version, title, root, a prefixed logger and derived storage keys, so none of
 * that is repeated in the mod's own source; `mod("x").mount(attach)` calls
 * `attach(#x)` once the DOM has the root, so a script needs no boot code either.
 *
 * Never request a URL that could be a folder: the game's loose-file lookup only
 * checks existence and then dies opening it (crashed the game three times). Only
 * plain file names listed in a mod.json are ever requested.
 *
 * Everything the loader logs starts with "[ACEUIModLoader]" so the game log (and
 * tools/check_ingame_log.py) can follow it.
 */
ACEUIModLoader.loader = (function () {

    /** Folder, relative to the page, that holds one folder per mod. */
    const ROOT = "ACEUIModLoaderMods/";
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
    /** After this long without an answer the loader gives up and loads nothing. */
    const PRESET_TIMEOUT_MS = 1500;
    /** Property set on our own response handler so the engine.on wrapper leaves it alone. */
    const OWN_HANDLER = "aceuimodloaderRaw";

    /** Where mod roots go: the stock HUD's positioning container, else the body. */
    const CONTAINER_SELECTOR = ".absolutecenter";
    /** Attribute on a loader-created root naming its mod. */
    const MOD_ATTR = "data-mod";
    /** Set on a root once `mount` has attached a mod to it, so a second mount is a no-op. */
    const MOUNTED_ATTR = "data-mounted";
    /** What `mod()` reports for a mod the loader did not load (preview pages). */
    const DEV_VERSION = "dev";
    /** Derived identifiers: storage keys "ace<name>.<suffix>", HUD layout id "hud_<name>". */
    const KEY_PREFIX = "ace";
    const HUD_ID_PREFIX = "hud_";
    const POSITION_SUFFIX = "pos";

    const log = ACEUIModLoader.log;

    const state = {
        mods: [],           // { name, info, status }
        current: null,      // the entry whose scripts are running right now
        source: "",         // "presets" (the game answered) | "none" (no engine or no answer)
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
     * Find the installed mod names by asking the game for the video preset list.
     * onFound(names, source) is called exactly once; source is "presets" or "none".
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
        const nothing = function (reason) {
            log(reason + "; nothing to load");
            finish([], "none");
        };
        const onAnswer = function (response) {
            finish(markerNames(response ? response.filenames : null), "presets");
        };
        const send = function () {
            if (settled) { return; }

            engine.trigger("OnUICommand", PRESET_REQUEST, { __Type: PRESET_REQUEST, version: 0 });
        };

        if (!rawOn) {
            nothing("no engine on this page");

            return;
        }

        onAnswer[OWN_HANDLER] = true;
        handle = rawOn.call(engine, PRESET_RESPONSE, onAnswer);
        window.setTimeout(function () {
            if (!settled) { nothing("no preset list answer in " + PRESET_TIMEOUT_MS + " ms"); }
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

    /** A mod.json list field: the array itself, or empty when absent (optional keys). */
    const listOf = function (value) {
        return Array.isArray(value) ? value : [];
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

    /** The mod's root element, created inside the HUD container unless the mod opts out or one exists. */
    const mountRoot = function (name, info) {
        const existing = document.getElementById(name);
        const container = document.querySelector(CONTAINER_SELECTOR) || document.body;
        const root = document.createElement("div");

        if (existing || info.root === false) { return existing; }

        root.id = name;
        root.setAttribute(MOD_ATTR, name);
        container.appendChild(root);

        // A mod switched off in the app drawer must be hidden the moment its root exists,
        // not when the drawer is built: the drawer builds on ready(), which fires only
        // after every mod has loaded, so the app would flash on for that whole time.
        if (ACEUIModLoader.drawer) { ACEUIModLoader.drawer.applyStored(name); }

        return root;
    };

    const findEntry = function (name) {
        return state.mods.filter(function (entry) { return entry.name === name; })[0] || null;
    };

    /** The drawer owns the on/off switches; without it every mod is on. */
    const enabled = function (name) {
        return !ACEUIModLoader.drawer || ACEUIModLoader.drawer.isVisible(name);
    };

    /**
     * Start a mod that is loaded but not running. Returns false when there is nothing to
     * start -- no entry, no attach recorded, or it is running already.
     */
    const activate = function (name) {
        const entry = findEntry(name);
        const root = document.getElementById(name);

        if (!entry || typeof entry.attach !== "function" || !root) { return false; }

        if (root.hasAttribute(MOUNTED_ATTR)) { return false; }

        root.setAttribute(MOUNTED_ATTR, "");
        entry.instance = entry.attach(root);
        log("mod " + name + " started");

        return true;
    };

    /**
     * Stop a running mod through its own detach, so its listeners, loops and sounds go
     * with it. Returns false when the mod never gave us a detach -- the drawer then falls
     * back to hiding it, which is all it can do.
     */
    const deactivate = function (name) {
        const entry = findEntry(name);
        const root = document.getElementById(name);

        if (!entry || typeof entry.detach !== "function" || !entry.instance) { return false; }

        try {
            entry.detach(entry.instance);
        } catch (e) {
            log("mod " + name + " detach threw: " + ACEUIModLoader.errorText(e));
        }

        entry.instance = null;

        if (root) { root.removeAttribute(MOUNTED_ATTR); }

        log("mod " + name + " stopped");

        return true;
    };

    /**
     * Everything a mod's script needs to know about itself, derived from the folder name
     * and mod.json: `ACEUIModLoader.mod()` while its scripts run, `ACEUIModLoader.mod("x")` any
     * time. Unknown names (preview pages without the loader) get a "dev" description.
     */
    const describe = function (name, entry) {
        const info = entry && entry.info ? entry.info : {};
        const title = info.title || name;
        const key = function (suffix) { return KEY_PREFIX + name + "." + suffix; };
        /** Call `attach(root)` with `#<name>` once the DOM has it (now, or on DOMContentLoaded); once per root. */
        /**
         * `mount(attach, detach)`. Passing detach is what lets the app drawer really turn
         * a mod off: hiding its root leaves its key handlers, frame loop and sounds
         * running (DOOM still answered Insert while "disabled"). With both halves the
         * loader can stop and restart a mod, and a mod switched off is never attached in
         * the first place.
         */
        const mount = function (attach, detach) {
            const boot = function () {
                const root = document.getElementById(name);

                if (!root || root.hasAttribute(MOUNTED_ATTR)) { return; }

                if (entry) {
                    entry.attach = attach;
                    entry.detach = detach || null;
                }

                // switched off in the drawer: loaded, but deliberately not started
                if (!enabled(name)) { return; }

                root.setAttribute(MOUNTED_ATTR, "");

                const instance = attach(root);

                if (entry) { entry.instance = instance; }
            };

            if (document.readyState === "loading") {
                document.addEventListener("DOMContentLoaded", boot);
            } else {
                boot();
            }
        };

        return {
            name: name,
            title: title,
            version: info.version || DEV_VERSION,
            base: entry ? ROOT + name + "/" : "",
            loaded: Boolean(entry),
            root: document.getElementById(name),
            prefix: "[" + title + "]",
            log: ACEUIModLoader.logger("[" + title + "]"),
            hudId: HUD_ID_PREFIX + name,
            storageKey: key(POSITION_SUFFIX),
            key: key,
            mount: mount
        };
    };

    const mod = function (name) {
        const wanted = name || (state.current ? state.current.name : "");

        return describe(wanted, findEntry(wanted));
    };

    const loadMod = function (name, onDone) {
        const base = ROOT + name + "/";
        const entry = { name: name, info: null, status: "pending" };

        state.mods.push(entry);
        fetchText(base + MOD_FILE, function (text) {
            const info = text === null ? null : parseJson(text, name + "/" + MOD_FILE);
            const styles = info ? listOf(info.styles) : [];
            const scripts = info ? listOf(info.scripts) : [];

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

            if (info.name && info.name !== name) {
                entry.status = "invalid";
                log("mod " + name + ": " + MOD_FILE + " names it \"" + info.name + "\", skipped");
                onDone();

                return;
            }

            if (!wantsPage(info)) {
                entry.status = "not-for-this-page";
                onDone();

                return;
            }

            log("mod " + name + " " + (info.version || DEV_VERSION) + ": loading " + scripts.length + " script(s), "
                + styles.length + " stylesheet(s)");
            styles.forEach(function (file) { addStylesheet(base + file); });
            mountRoot(name, info);
            state.current = entry;
            loadScripts(base, scripts, 0, function (ok) {
                state.current = null;
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

    /** "presets" (the game listed the markers) or "none" (no engine or no answer); "" until discovered. */
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
        CONTAINER_SELECTOR: CONTAINER_SELECTOR,
        MOD_ATTR: MOD_ATTR,
        MOUNTED_ATTR: MOUNTED_ATTR,
        DEV_VERSION: DEV_VERSION,
        mods: state.mods,
        mod: mod,
        source: source,
        filtering: filtering,
        isMarker: isMarker,
        markerNames: markerNames,
        withoutMarkers: withoutMarkers,
        isFileName: isFileName,
        ready: ready,
        enabled: enabled,
        activate: activate,
        deactivate: deactivate,
        addStylesheet: addStylesheet,
        addScript: addScript
    };
}());

/* Convenience aliases so mods can stay on the flat `ACEUIModLoader.*` API. */
ACEUIModLoader.ROOT = ACEUIModLoader.loader.ROOT;
ACEUIModLoader.mods = ACEUIModLoader.loader.mods;
ACEUIModLoader.mod = ACEUIModLoader.loader.mod;
ACEUIModLoader.ready = ACEUIModLoader.loader.ready;
ACEUIModLoader.addStylesheet = ACEUIModLoader.loader.addStylesheet;
ACEUIModLoader.addScript = ACEUIModLoader.loader.addScript;
