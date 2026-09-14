/**
 * AceMods -- UI mod loader for Assetto Corsa EVO.
 *
 * Appended to the stock `uiresources/js/cohtml.js` at build time (tools/build_loader.py),
 * so it runs first on every Gameface page the game loads (intro, menu, ingame, hud,
 * ...). Once the page's DOM exists it reads `acemods/manifest.json`, then each listed
 * mod's `acemods/<name>/mod.json`, and injects that mod's stylesheets and scripts, in
 * order, on the pages the mod asked for. Mods are plain folders under
 * `Saved Games\ACE\mods\uiresources\acemods\` (a loose-file search directory of the
 * game); only this loader is a package. See ACEUIModLoader/docs/design.md.
 *
 * Manifest (`acemods/manifest.json`, maintained by tools/install_mod.py):
 *     { "mods": ["pedalgraph", "debugconsole"] }
 *
 * Per mod (`acemods/<name>/mod.json`):
 *     { "name": "pedalgraph", "version": "0.3.0", "pages": ["hud.html"],
 *       "styles": ["pedalgraph.css"], "scripts": ["pedalgraph.js", "mod.js"] }
 *
 * Everything the loader logs starts with "[AceMods]" so the game log (and
 * tools/check_ingame_log.py) can follow it.
 */
const AceMods = (function () {

    const VERSION = "0.1.0";
    const LOG_PREFIX = "[AceMods]";
    /** Folder, relative to the page, that holds the manifest and the mod folders. */
    const ROOT = "acemods/";
    const MANIFEST_URL = ROOT + "manifest.json";
    const MOD_FILE = "mod.json";
    /** Fallback when a mod.json lists no pages: only the HUD. */
    const DEFAULT_PAGES = ["hud.html"];

    const state = {
        page: location.pathname.split("/").pop() || "",
        mods: [],           // { name, info, status }
        readyCallbacks: []
    };

    const log = function (message) {
        console.log(LOG_PREFIX + " " + message);
    };

    /** Prefixed logger for mods: AceMods.logger("[PedalGraph]")("hello"). */
    const logger = function (prefix) {
        return function (message) { console.log(prefix + " " + message); };
    };

    /** GET a text resource relative to the page; onDone(text|null). Missing => null. */
    const fetchText = function (url, onDone) {
        const xhr = new XMLHttpRequest();

        xhr.open("GET", url);
        xhr.onload = function () {
            const ok = xhr.status === 200 || (xhr.status === 0 && xhr.responseText);

            onDone(ok ? xhr.responseText : null);
        };
        xhr.onerror = function () { onDone(null); };
        xhr.send();
    };

    const parseJson = function (text, what) {
        try {
            return JSON.parse(text);
        } catch (ignore) { /* reported by the caller */ }

        log(what + ": invalid JSON");

        return null;
    };

    const addStylesheet = function (url) {
        const link = document.createElement("link");

        link.rel = "stylesheet";
        link.type = "text/css";
        link.href = url;
        document.head.appendChild(link);
    };

    /** Append a classic script and wait for it, so a mod's files run in manifest order. */
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

    const loadScripts = function (base, files, index, onDone) {
        if (index >= files.length) { onDone(true); return; }

        addScript(base + files[index], function (ok) {
            if (!ok) { log("failed to load " + base + files[index]); onDone(false); return; }

            loadScripts(base, files, index + 1, onDone);
        });
    };

    const wantsPage = function (info) {
        const pages = Array.isArray(info.pages) && info.pages.length ? info.pages : DEFAULT_PAGES;

        return pages.indexOf(state.page) >= 0 || pages.indexOf("*") >= 0;
    };

    const loadMod = function (name, onDone) {
        const base = ROOT + name + "/";
        const entry = { name: name, info: null, status: "pending" };

        state.mods.push(entry);
        fetchText(base + MOD_FILE, function (text) {
            const info = text === null ? null : parseJson(text, name + "/" + MOD_FILE);

            if (!info) {
                entry.status = "missing";
                log("mod " + name + ": no " + MOD_FILE + ", skipped");
                onDone();

                return;
            }

            entry.info = info;

            if (!wantsPage(info)) {
                entry.status = "not-for-this-page";
                onDone();

                return;
            }

            log("mod " + name + " " + (info.version || "?") + ": loading " + ((info.scripts || []).length) + " script(s), "
                + ((info.styles || []).length) + " stylesheet(s)");
            (info.styles || []).forEach(function (file) { addStylesheet(base + file); });
            loadScripts(base, info.scripts || [], 0, function (ok) {
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
        log("loader " + VERSION + " on /" + state.page);
        fetchText(MANIFEST_URL, function (text) {
            const manifest = text === null ? null : parseJson(text, MANIFEST_URL);

            if (!manifest || !Array.isArray(manifest.mods)) {
                log("no manifest at " + MANIFEST_URL + "; nothing to load");

                return;
            }

            log("manifest: " + manifest.mods.length + " mod(s)");
            loadMods(manifest.mods, 0);
        });
    };

    /** Runs after all mods for this page have been processed (or immediately if done). */
    const ready = function (callback) {
        state.readyCallbacks.push(callback);
    };

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", start);
    } else {
        start();
    }

    return {
        VERSION: VERSION,
        LOG_PREFIX: LOG_PREFIX,
        ROOT: ROOT,
        page: state.page,
        mods: state.mods,
        log: log,
        logger: logger,
        addStylesheet: addStylesheet,
        addScript: addScript,
        ready: ready
    };
}());

/* A top-level const is not a window property; mods test `window.AceMods` to detect the loader. */
window.AceMods = AceMods;
