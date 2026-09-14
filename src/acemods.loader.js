/**
 * AceMods.loader -- finds and loads the installed UI mods.
 *
 * Last of the library files appended to the stock `uiresources/js/cohtml.js`.
 * Once the page's DOM exists it reads `acemods/manifest.json`, then each listed
 * mod's `acemods/<name>/mod.json`, and injects that mod's stylesheets and
 * scripts, in order, on the pages the mod asked for. Mods are plain folders
 * under `Saved Games\ACE\mods\uiresources\acemods\` (a loose-file search
 * directory of the game); only the loader is a package. See docs/design.md.
 *
 * Manifest (`acemods/manifest.json`, maintained by tools/install_mod.py):
 *     { "mods": ["pedalgraph", "devconsole"] }
 *
 * Per mod (`acemods/<name>/mod.json`):
 *     { "name": "pedalgraph", "version": "0.4.0", "pages": ["hud.html"],
 *       "styles": ["pedalgraph.css"], "scripts": ["pedalgraph.js", "mod.js"] }
 *
 * Everything the loader logs starts with "[AceMods]" so the game log (and
 * tools/check_ingame_log.py) can follow it.
 */
AceMods.loader = (function () {

    /** Folder, relative to the page, that holds the manifest and the mod folders. */
    const ROOT = "acemods/";
    const MANIFEST_URL = ROOT + "manifest.json";
    const MOD_FILE = "mod.json";
    /** Fallback when a mod.json lists no pages: only the HUD. */
    const DEFAULT_PAGES = ["hud.html"];
    /** A mod.json page list containing this loads the mod on every page. */
    const ANY_PAGE = "*";
    const HTTP_OK = 200;

    const log = AceMods.log;

    const state = {
        mods: [],           // { name, info, status }
        readyCallbacks: []
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

        return pages.indexOf(AceMods.page) >= 0 || pages.indexOf(ANY_PAGE) >= 0;
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
        log("loader " + AceMods.VERSION + " on /" + AceMods.page);
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

    /** Runs after all mods for this page have been processed. */
    const ready = function (callback) {
        state.readyCallbacks.push(callback);
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
        mods: state.mods,
        ready: ready,
        addStylesheet: addStylesheet,
        addScript: addScript
    };
}());

/* Convenience aliases so mods can stay on the flat `AceMods.*` API. */
AceMods.ROOT = AceMods.loader.ROOT;
AceMods.mods = AceMods.loader.mods;
AceMods.ready = AceMods.loader.ready;
AceMods.addStylesheet = AceMods.loader.addStylesheet;
AceMods.addScript = AceMods.loader.addScript;
