/**
 * ACEUIAppLoader.loader -- finds and loads the installed UI apps.
 *
 * Last of the library files appended to the stock `uiresources/js/cohtml.js`.
 *
 * Discovery. A page cannot list folders, but the game lists one folder for it: the
 * video settings presets in `Saved Games\ACE\Video\*.settingspreset`, on request
 * `SettingsRequestVideoPresetList`, answered through `SettingsResponseVideoPresetList`
 * with the file stems. Every app therefore ships an EMPTY marker file
 * `Video\ACEUIAppLoader-<name>.settingspreset` next to its folder
 * `mods\uiresources\ACEUIAppLoader\<name>\`; the player unzips both into
 * `Saved Games\ACE` and nothing has to be registered anywhere. The marker must stay
 * empty: the game deserialises each listed file first, and an empty file is a valid
 * default message. (Confirmed in game 2026-09-14.)
 *
 * The stock UI shows that same list in its video presets menu, so this file also
 * wraps `engine.on`: any stock handler for the response gets a copy of the answer
 * with our markers removed. Our own handler is flagged and sees the raw list.
 *
 * There is no other source of app names: without an engine (a plain browser) or
 * without an answer within PRESET_TIMEOUT_MS the loader logs why and loads nothing.
 *
 * Bundled apps. The loader also ships apps of its own -- its developer tools -- inside
 * its own package under `ACEUIAppLoaderBuiltIn/<name>/`, listed by
 * `ACEUIAppLoaderBuiltIn/apps.json` (written by tools/build_loader.py). They need no marker
 * and no install, so they are there even on the path where the preset list never answers.
 * The two roots must stay apart, because **loose files never beat packed files**: a
 * bundled app sitting at the loose path could never be overridden, and iterating on it
 * with tools/install_app.py would silently do nothing. Apart, the opposite holds and is
 * useful -- an installed app of the same name WINS over the bundled copy, which is how a
 * bundled app is worked on.
 *
 * Per app, `<root>/<name>/app.json` holds what cannot be inferred:
 *     { "version": "0.4.0", "styles": ["pedalgraph.css"], "scripts": ["pedalgraph.js"] }
 * Optional: "pages" (default ["hud.html"], "*" = every page), "title" (log prefix,
 * default the name), "root": false (do not create a root element), "developer": true
 * (a tool rather than something a player wants: the app drawer keeps it behind its
 * "developer apps" switch). The name is the folder's; a "name" key must match it if
 * present.
 *
 * Before an app's scripts run the loader creates its root, `<div id="<name>"
 * data-app="<name>">`, inside the HUD's positioning container (or <body> on
 * pages without one), so a script only has to attach to `#<name>`. While the
 * scripts run, `ACEUIAppLoader.app()` describes the app being loaded: name,
 * version, title, root, a prefixed logger and derived storage keys, so none of
 * that is repeated in the app's own source; `app("x").mount(attach)` calls
 * `attach(#x)` once the DOM has the root, so a script needs no boot code either.
 *
 * Never request a URL that could be a folder: the game's loose-file lookup only
 * checks existence and then dies opening it (crashed the game three times). Only
 * plain file names listed in an app.json are ever requested.
 *
 * Everything the loader logs starts with "[ACEUIAppLoader]" so the game log (and
 * tools/check_ingame_log.py) can follow it.
 */
ACEUIAppLoader.loader = (function () {

    /** Folder, relative to the page, that holds one folder per installed (loose) app. */
    const ROOT = "ACEUIAppLoader/";
    /** The same, for the apps bundled in the loader's own package; see the header. */
    const BUILTIN_ROOT = "ACEUIAppLoaderBuiltIn/";
    /** What lists them, since a page cannot list a folder: [{ name, version }]. */
    const BUILTIN_INDEX = "apps.json";
    const APP_FILE = "app.json";
    /** Fallback when an app.json lists no pages: only the HUD. */
    const DEFAULT_PAGES = ["hud.html"];
    /** An app.json page list containing this loads the app on every page. */
    const ANY_PAGE = "*";
    const HTTP_OK = 200;

    /** The game command that lists `Saved Games\ACE\Video\*.settingspreset`, and its answer. */
    const PRESET_REQUEST = "SettingsRequestVideoPresetList";
    const PRESET_RESPONSE = "SettingsResponseVideoPresetList";
    /** Marker file name: MARKER_PREFIX + app name + MARKER_EXT, zero bytes. */
    const MARKER_PREFIX = "ACEUIAppLoader-";
    const MARKER_EXT = ".settingspreset";
    /** After this long without an answer the loader gives up and loads nothing. */
    const PRESET_TIMEOUT_MS = 1500;
    /** Property set on our own response handler so the engine.on wrapper leaves it alone. */
    const OWN_HANDLER = "aceuiapploaderRaw";

    /** Where app roots go: the stock HUD's positioning container, else the body. */
    const CONTAINER_SELECTOR = ".absolutecenter";
    /** Attribute on a loader-created root naming its app. */
    const APP_ATTR = "data-app";
    /** Set on a root once `mount` has attached an app to it, so a second mount is a no-op. */
    const MOUNTED_ATTR = "data-mounted";
    /** What `app()` reports for an app the loader did not load (preview pages). */
    const DEV_VERSION = "dev";
    /** Derived identifiers: storage keys "ace<name>.<suffix>", HUD layout id "hud_<name>". */
    const KEY_PREFIX = "ace";
    const HUD_ID_PREFIX = "hud_";
    const POSITION_SUFFIX = "pos";
    /** Panel scale: one font-size in rem on a root whose insides are sized in em. */
    const SCALE_KEY = "scale";
    const SCALE_DEFAULT = 1;
    const SCALE_MIN = 0.6;
    const SCALE_MAX = 2;
    const SCALE_STEP = 0.1;
    const SCALE_DIGITS = 2;

    const log = ACEUIAppLoader.log;

    const state = {
        apps: [],           // { name, info, status, base, builtin }
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

    /** A usable marker: our prefix followed by an app name. */
    const isMarker = function (name) {
        return hasPrefix(name) && name.length > MARKER_PREFIX.length;
    };

    /** App names from a preset list answer: markers only, prefix removed, sorted. */
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
     * The apps bundled in the loader's own package, from the index the build writes.
     * `onFound([{ name, version }])` always runs: no index at all -- an older package, or
     * any page that is not served from one -- simply means no bundled apps.
     */
    const bundled = function (onFound) {
        fetchText(BUILTIN_ROOT + BUILTIN_INDEX, function (text) {
            const info = text === null ? null : parseJson(text, BUILTIN_ROOT + BUILTIN_INDEX);
            const apps = info ? listOf(info.apps) : [];

            onFound(apps.filter(function (entry) {
                return Boolean(entry) && typeof entry.name === "string" && entry.name.length > 0;
            }));
        });
    };

    /**
     * Find the installed app names by asking the game for the video preset list.
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
        // Only about the installed apps: the apps bundled in the package are found without
        // the game's help, so "no answer" no longer means nothing runs. Whether anything
        // does is decided once both sources are in, in start().
        const nothing = function (reason) {
            log(reason + "; no installed apps");
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

    /** Append a classic script and wait for it, so an app's files run in app.json order. */
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

    /** An app.json list field: the array itself, or empty when absent (optional keys). */
    const listOf = function (value) {
        return Array.isArray(value) ? value : [];
    };

    /** A file entry an app.json may list: a plain relative file name with an extension, never a folder. */
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

        return pages.indexOf(ACEUIAppLoader.page) >= 0 || pages.indexOf(ANY_PAGE) >= 0;
    };

    /** The app's root element, created inside the HUD container unless the app opts out or one exists. */
    const mountRoot = function (name, info) {
        const existing = document.getElementById(name);
        const container = document.querySelector(CONTAINER_SELECTOR) || document.body;
        const root = document.createElement("div");

        if (existing || info.root === false) { return existing; }

        root.id = name;
        root.setAttribute(APP_ATTR, name);
        container.appendChild(root);

        // An app switched off in the app drawer must be hidden the moment its root exists,
        // not when the drawer is built: the drawer builds on ready(), which fires only
        // after every app has loaded, so the app would flash on for that whole time.
        if (ACEUIAppLoader.drawer) { ACEUIAppLoader.drawer.applyStored(name); }

        return root;
    };

    const findEntry = function (name) {
        return state.apps.filter(function (entry) { return entry.name === name; })[0] || null;
    };

    /** The drawer owns the on/off switches; without it every app is on. */
    const enabled = function (name) {
        return !ACEUIAppLoader.drawer || ACEUIAppLoader.drawer.isVisible(name);
    };

    /**
     * Whether an app calls itself a developer tool. The app drawer keeps those behind its
     * own switch, so this is what tells it which rows those are.
     */
    const isDeveloper = function (name) {
        const entry = findEntry(name);

        return Boolean(entry && entry.info && entry.info.developer);
    };

    /**
     * Start an app that is loaded but not running. Returns false when there is nothing to
     * start -- no entry, no attach recorded, or it is running already.
     */
    const activate = function (name) {
        const entry = findEntry(name);
        const root = document.getElementById(name);

        if (!entry || typeof entry.attach !== "function" || !root) { return false; }

        if (root.hasAttribute(MOUNTED_ATTR)) { return false; }

        root.setAttribute(MOUNTED_ATTR, "");
        entry.instance = entry.attach(root);
        log("app " + name + " started");

        return true;
    };

    /**
     * Stop a running app through its own detach, so its listeners, loops and sounds go
     * with it. Returns false when the app never gave us a detach -- the drawer then falls
     * back to hiding it, which is all it can do.
     */
    const deactivate = function (name) {
        const entry = findEntry(name);
        const root = document.getElementById(name);

        if (!entry || typeof entry.detach !== "function" || !entry.instance) { return false; }

        try {
            entry.detach(entry.instance);
        } catch (e) {
            log("app " + name + " detach threw: " + ACEUIAppLoader.errorText(e));
        }

        entry.instance = null;

        if (root) { root.removeAttribute(MOUNTED_ATTR); }

        log("app " + name + " stopped");

        return true;
    };

    /**
     * Everything an app's script needs to know about itself, derived from the folder name
     * and app.json: `ACEUIAppLoader.app()` while its scripts run, `ACEUIAppLoader.app("x")` any
     * time. Unknown names (preview pages without the loader) get a "dev" description.
     */
    const describe = function (name, entry) {
        const info = entry && entry.info ? entry.info : {};
        const title = info.title || name;
        const key = function (suffix) { return KEY_PREFIX + name + "." + suffix; };
        const log = ACEUIAppLoader.logger("[" + title + "]");

        /**
         * A value this app wants back after the HUD reloads on Escape/resume. It lives in
         * `localStorage`, which is per view: it survives that reload and dies with the
         * game. Anything that must outlive the game belongs in a declared setting
         * (ACEUIAppLoader.settings) or, if it is large, in the engine's own container
         * (ACEUIAppLoader.persist.writeStore).
         */
        const recall = function (suffix, fallback) {
            const value = ACEUIAppLoader.persist.readLocal(key(suffix));

            return value === null || value === undefined ? fallback : value;
        };

        const remember = function (suffix, value) {
            return ACEUIAppLoader.persist.writeLocal(key(suffix), value);
        };

        const forget = function (suffix) {
            ACEUIAppLoader.persist.removeLocal(key(suffix));
        };

        /**
         * Panel scale, which three apps had each written for themselves.
         *
         * One `font-size` in rem on the root scales a whole panel, provided everything
         * inside is sized in em -- the technique the dev console and DOOM arrived at
         * separately. This applies it, keeps it inside the bounds, follows the app's own
         * `scale` setting when it declared one (so the settings window and a -/+ button
         * move the same value), and remembers it either way.
         *
         *     const scale = me.scale(root);
         *     scale.nudge(1);            // the + button
         *     scale.set(1.4);
         *     scale.value();
         *     scale.stop();              // in detach
         */
        const scale = function (root, options) {
            const opts = options || {};
            const bounds = {
                min: typeof opts.min === "number" ? opts.min : SCALE_MIN,
                max: typeof opts.max === "number" ? opts.max : SCALE_MAX,
                step: typeof opts.step === "number" ? opts.step : SCALE_STEP
            };
            const settings = ACEUIAppLoader.settings;
            const declared = function () {
                return settings && settings.specs(name).filter(function (spec) {
                    return spec.key === SCALE_KEY;
                }).length > 0;
            };
            const stored = function () {
                const value = declared() ? settings.get(name, SCALE_KEY) : recall(SCALE_KEY, opts.value);

                return typeof value === "number" ? value : (opts.value || SCALE_DEFAULT);
            };
            const handle = { applied: 0, unsubscribe: null };

            const apply = function (value) {
                const next = Number(ACEUIAppLoader.clamp(value, bounds.min, bounds.max).toFixed(SCALE_DIGITS));

                handle.applied = next;
                root.style.fontSize = next + "rem";

                if (typeof opts.onScale === "function") { opts.onScale(next); }

                return next;
            };

            const set = function (value) {
                const next = apply(value);

                if (declared()) {
                    settings.set(name, SCALE_KEY, next);
                } else {
                    remember(SCALE_KEY, next);
                }

                return next;
            };

            apply(stored());

            if (settings) {
                handle.unsubscribe = settings.onChange(name, function (key, value) {
                    if (key === SCALE_KEY && value !== handle.applied) { apply(value); }
                });
            }

            return {
                value: function () { return handle.applied; },
                set: set,
                nudge: function (steps) { return set(handle.applied + steps * bounds.step); },
                bounds: bounds,
                stop: function () {
                    if (handle.unsubscribe) { handle.unsubscribe(); }

                    handle.unsubscribe = null;
                }
            };
        };

        /**
         * The settings spec for that scale, to drop into the app's own `define` call, so
         * the same value is the one the settings window shows.
         */
        const scaleSpec = function (options) {
            const opts = options || {};

            return {
                key: SCALE_KEY,
                type: "range",
                label: opts.label || "Panel scale",
                value: typeof opts.value === "number" ? opts.value : SCALE_DEFAULT,
                min: typeof opts.min === "number" ? opts.min : SCALE_MIN,
                max: typeof opts.max === "number" ? opts.max : SCALE_MAX,
                step: typeof opts.step === "number" ? opts.step : SCALE_STEP,
                digits: SCALE_DIGITS
            };
        };

        /**
         * The whole widget lifecycle: a draggable panel that remembers where the player
         * put it, and the frame loop that drives it.
         *
         *     state.ui = me.panel(root, function (now) { tick(state, now); });
         *     ...
         *     state.ui.stop();          // in detach
         *
         * Two things this owns that every app used to repeat, and that go wrong quietly
         * when they are forgotten: the panel has to be ticked every frame until its
         * position restore settles (miss it and the widget never moves to where it was
         * left), and the loop has to be stopped in detach (miss it and an app switched off
         * in the app drawer keeps running for ever).
         *
         * `stop()` is safe to call twice. The handle carries `panel` for the rare app that
         * needs the panel itself -- to save a position by hand, say.
         */
        const panelFor = function (root, onFrame, options) {
            const opts = options || {};
            const panel = ACEUIAppLoader.panel.attach(root, {
                hudId: HUD_ID_PREFIX + name,
                storageKey: key(POSITION_SUFFIX),
                log: log,
                onSaved: opts.onSaved || null
            });
            const handle = { panel: panel, loop: null, stopped: false };

            handle.loop = ACEUIAppLoader.loop.start(function (now) {
                ACEUIAppLoader.panel.update(panel, now);

                if (onFrame) { onFrame(now); }
            }, name);

            handle.stop = function () {
                if (handle.stopped) { return false; }

                handle.stopped = true;
                ACEUIAppLoader.loop.stop(handle.loop);
                ACEUIAppLoader.panel.detach(panel);

                return true;
            };

            return handle;
        };
        /** Call `attach(root)` with `#<name>` once the DOM has it (now, or on DOMContentLoaded); once per root. */
        /**
         * `mount(attach, detach)`. Passing detach is what lets the app drawer really turn
         * an app off: hiding its root leaves its key handlers, frame loop and sounds
         * running (DOOM still answered Insert while "disabled"). With both halves the
         * loader can stop and restart an app, and an app switched off is never attached in
         * the first place.
         */
        /**
         * Show or hide this app, exactly as the drawer's switch does: the root is hidden and
         * the app is stopped through its own detach, or started again on the way back.
         *
         *     me.show(false);            // what a panel's close button should do
         *
         * A panel that hides itself instead leaves the drawer saying the app is on while
         * nothing is on screen, and the drawer is where anyone looks to get it back.
         */
        const show = function (on) {
            const drawer = ACEUIAppLoader.drawer;

            if (!drawer) { return true; }

            const now = drawer.setVisible(name, Boolean(on));

            // a developer app cannot be shown while the drawer's developer switch is off:
            // it would be on the screen with no row to switch it off again, which is the
            // unreachable panel this whole lifecycle exists to prevent
            if (on && !now) {
                log("not shown: developer apps are switched off in the app drawer");
            }

            return now;
        };

        /** Whether this app is on. Without a drawer -- a preview page -- everything is on. */
        const shown = function () {
            return enabled(name);
        };

        /**
         * Bind a key that shows and hides this app, for as long as the page lives.
         *
         *     me.toggle(function () { return options.toggleKey; });
         *
         * The loader holds it rather than the app, because an app that is switched off is not
         * running to hold anything -- which is what made a closed panel unreachable except
         * through the drawer. Call it once, beside `mount`; it returns an unbind for tests.
         */
        const toggleKey = function (getKey) {
            return ACEUIAppLoader.keys.bind(getKey, function (e) {
                show(!shown());
                e.preventDefault();
            });
        };

        const mount = function (attach, detach) {
            // every app logged this line for itself; mount is called once, at the end of a
            // app's script, so it says "the script ran" even for an app switched off in the
            // drawer -- which is exactly when you want to know
            log("script loaded, version " + (info.version || DEV_VERSION)
                + ", library " + ACEUIAppLoader.VERSION + ", page " + ACEUIAppLoader.page);

            const boot = function () {
                const root = document.getElementById(name);

                if (!root) {
                    // in game the loader creates this before the app's scripts run, so a
                    // missing root means a preview page whose markup does not match the name
                    log("nothing to attach to: no element with id \"" + name + "\" on this page");

                    return;
                }

                if (root.hasAttribute(MOUNTED_ATTR)) { return; }

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
            show: show,
            shown: shown,
            toggle: toggleKey,
            version: info.version || DEV_VERSION,
            developer: Boolean(info.developer),
            // whichever root this one came from: a bundled app's files are not where an
            // installed app's are, and an app that loads a file of its own needs the right one
            base: entry ? entry.base : "",
            loaded: Boolean(entry),
            root: document.getElementById(name),
            prefix: "[" + title + "]",
            log: log,
            hudId: HUD_ID_PREFIX + name,
            storageKey: key(POSITION_SUFFIX),
            key: key,
            scale: scale,
            scaleSpec: scaleSpec,
            recall: recall,
            remember: remember,
            forget: forget,
            panel: panelFor,
            mount: mount
        };
    };

    const app = function (name) {
        const wanted = name || (state.current ? state.current.name : "");

        return describe(wanted, findEntry(wanted));
    };

    const loadApp = function (name, root, onDone) {
        const base = root + name + "/";
        const entry = { name: name, info: null, status: "pending", base: base, builtin: root === BUILTIN_ROOT };

        state.apps.push(entry);
        fetchText(base + APP_FILE, function (text) {
            const info = text === null ? null : parseJson(text, name + "/" + APP_FILE);
            const styles = info ? listOf(info.styles) : [];
            const scripts = info ? listOf(info.scripts) : [];

            if (!info) {
                entry.status = "missing";
                log("app " + name + ": no " + APP_FILE + ", skipped");
                onDone();

                return;
            }

            entry.info = info;

            if (!styles.concat(scripts).every(isFileName)) {
                entry.status = "invalid";
                log("app " + name + ": " + APP_FILE + " lists something that is not a plain file name, skipped");
                onDone();

                return;
            }

            if (info.name && info.name !== name) {
                entry.status = "invalid";
                log("app " + name + ": " + APP_FILE + " names it \"" + info.name + "\", skipped");
                onDone();

                return;
            }

            if (!wantsPage(info)) {
                entry.status = "not-for-this-page";
                onDone();

                return;
            }

            log("app " + name + " " + (info.version || DEV_VERSION) + ": loading " + scripts.length + " script(s), "
                + styles.length + " stylesheet(s)");
            styles.forEach(function (file) { addStylesheet(base + file); });
            mountRoot(name, info);
            state.current = entry;
            loadScripts(base, scripts, 0, function (ok) {
                state.current = null;
                entry.status = ok ? "loaded" : "failed";
                log("app " + name + (ok ? " loaded" : " FAILED"));
                onDone();
            });
        });
    };

    /** `wanted` is [{ name, root }]: bundled apps first, then the installed apps. */
    const loadApps = function (wanted, index) {
        if (index >= wanted.length) {
            state.readyCallbacks.forEach(function (cb) { cb(state.apps); });
            state.readyCallbacks = [];

            return;
        }

        loadApp(wanted[index].name, wanted[index].root, function () { loadApps(wanted, index + 1); });
    };

    /**
     * What to load, from the two sources: the apps bundled in the package and the apps
     * installed loosely. An installed app of the same name replaces the bundled app
     * rather than joining it -- same name, same root element, and only one can have it --
     * and that is the supported way to work on a bundled app: install it loose, reload,
     * and the loose copy is what runs. Bundled apps come first so the rest of the page
     * has the developer tools before anything else starts.
     */
    const merge = function (apps, names) {
        const loose = names.map(function (name) { return { name: name, root: ROOT }; });
        const kept = apps.filter(function (entry) {
            const overridden = names.indexOf(entry.name) >= 0;

            if (overridden) {
                log(entry.name + ": installed copy overrides the bundled "
                    + (entry.version || DEV_VERSION));
            }

            return !overridden;
        });

        return kept.map(function (entry) {
            return { name: entry.name, root: BUILTIN_ROOT };
        }).concat(loose);
    };

    /**
     * Say so when the package was built for a different game build.
     *
     * The override this library arrives through is resolved against the base package's
     * whole file table, so a game update can leave the package loading nothing at all --
     * and the symptom is silence, which reads like a broken app rather than a stale one.
     * `builtFor` is stamped in by the build; the game publishes its own version on
     * ModelUIState, which is registered well before this runs.
     */
    const warnIfGameMoved = function () {
        const built = ACEUIAppLoader.builtFor;
        const running = window.ModelUIState ? window.ModelUIState.game_version : null;

        if (built && running && running !== built) {
            log("built for game " + built + " but running on " + running
                + ": rebuild the package if anything is missing");
        }
    };

    const start = function () {
        log("loader " + ACEUIAppLoader.VERSION + " on /" + ACEUIAppLoader.page);
        warnIfGameMoved();
        state.filtering = hideMarkersFromStock();

        if (rawOn && !state.filtering) {
            log("could not wrap engine.on; markers will show in the video presets menu");
        }

        // Both sources are asked at once and loading waits for the pair. Asking in turn
        // would put a file read in front of the preset list, which is an engine round trip
        // with a 1.5 s timeout behind it and the slower of the two by far; and the bundled
        // apps are in our own package, so they arrive whatever the engine does or does not
        // answer.
        let apps = null;
        let installed = null;
        const begin = function () {
            if (apps === null || installed === null) { return; }

            const wanted = merge(apps, installed);

            if (!wanted.length) { log("nothing to load"); }

            loadApps(wanted, 0);
        };

        bundled(function (list) {
            apps = list;

            if (list.length) {
                log("bundled: " + list.length + " app(s)");
            }

            begin();
        });

        discover(function (names, source) {
            state.source = source;
            installed = names;

            if (source !== "none") {
                log(source + ": " + names.length + " app(s)");
            }

            begin();
        });
    };

    /** Runs after all apps for this page have been processed. */
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
        BUILTIN_ROOT: BUILTIN_ROOT,
        BUILTIN_INDEX: BUILTIN_INDEX,
        APP_FILE: APP_FILE,
        DEFAULT_PAGES: DEFAULT_PAGES,
        PRESET_REQUEST: PRESET_REQUEST,
        PRESET_RESPONSE: PRESET_RESPONSE,
        MARKER_PREFIX: MARKER_PREFIX,
        MARKER_EXT: MARKER_EXT,
        PRESET_TIMEOUT_MS: PRESET_TIMEOUT_MS,
        CONTAINER_SELECTOR: CONTAINER_SELECTOR,
        APP_ATTR: APP_ATTR,
        MOUNTED_ATTR: MOUNTED_ATTR,
        DEV_VERSION: DEV_VERSION,
        apps: state.apps,
        app: app,
        source: source,
        filtering: filtering,
        isMarker: isMarker,
        markerNames: markerNames,
        withoutMarkers: withoutMarkers,
        isFileName: isFileName,
        merge: merge,
        ready: ready,
        enabled: enabled,
        isDeveloper: isDeveloper,
        activate: activate,
        deactivate: deactivate,
        addStylesheet: addStylesheet,
        addScript: addScript
    };
}());

/* Convenience aliases so apps can stay on the flat `ACEUIAppLoader.*` API. */
ACEUIAppLoader.ROOT = ACEUIAppLoader.loader.ROOT;
ACEUIAppLoader.apps = ACEUIAppLoader.loader.apps;
ACEUIAppLoader.app = ACEUIAppLoader.loader.app;
ACEUIAppLoader.ready = ACEUIAppLoader.loader.ready;
ACEUIAppLoader.addStylesheet = ACEUIAppLoader.loader.addStylesheet;
ACEUIAppLoader.addScript = ACEUIAppLoader.loader.addScript;
