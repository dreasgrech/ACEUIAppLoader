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
 * without an answer after two asks (PRESET_TIMEOUT_MS, then PRESET_RETRY_MS) the loader
 * logs why and loads no installed apps.
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
    /** The page the player looks at while driving: the one place a notice to them belongs. */
    const HUD_PAGE = DEFAULT_PAGES[0];
    /** An app.json page list containing this loads the app on every page. */
    const ANY_PAGE = "*";
    const HTTP_OK = 200;

    /** The game command that lists `Saved Games\ACE\Video\*.settingspreset`, and its answer. */
    const PRESET_REQUEST = "SettingsRequestVideoPresetList";
    const PRESET_RESPONSE = "SettingsResponseVideoPresetList";
    /** Marker file name: MARKER_PREFIX + app name + MARKER_EXT, zero bytes. */
    const MARKER_PREFIX = "ACEUIAppLoader-";
    const MARKER_EXT = ".settingspreset";
    /** After this long without an answer the question is asked once more... */
    const PRESET_TIMEOUT_MS = 1500;
    /** ...and given this long, before the loader decides nothing is installed. */
    const PRESET_RETRY_MS = 3000;
    const PRESET_ATTEMPTS = 2;
    /** What a folder that never lists usually means, said where the player will look. */
    const NO_ANSWER_HINT = "; a .settingspreset in Saved Games\\ACE\\Video that is not empty, or not a preset, stops the game listing that folder";
    /**
     * What an app may be called, so what a marker's stem may be after the prefix: the
     * rule tools/install_app.py applies, and a test keeps the two equal. It matters here
     * because the name becomes a URL. A `#` in it would cut the request off at the folder
     * above, and asking for a folder is the one request that kills the game.
     */
    const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
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
    /** The notice shown on the HUD when the package was built for another game build. */
    const NOTICE_ATTR = "data-ace-notice";
    const NOTICE_Z_INDEX = "9500";
    /** How often, and for how long, to look for the game's version before the check is dropped. */
    const GAME_VERSION_POLL_MS = 250;
    const GAME_VERSION_WAIT_MS = 15000;
    /**
     * The game's full build is "0.9.1+release.6" (the exe, the log, our stamp), but what it
     * publishes to the UI on ModelUIState.game_version is the release alone: "0.9.1"
     * (seen in game 2026-09-18, when the notice fired on a matching build). So the two are
     * compared on the part before this separator. A hotfix that changes only the build
     * number cannot be told apart from inside the page.
     */
    const VERSION_BUILD_SEPARATOR = "+";
    /** Derived identifiers: storage keys "ace<name>.<suffix>", HUD layout id "hud_<name>". */
    const KEY_PREFIX = "ace";
    const HUD_ID_PREFIX = "hud_";
    const POSITION_SUFFIX = "pos";
    /** Between app name and suffix in a remembered value's HUD id: `hud_doom.open`. */
    const REMEMBER_SEPARATOR = ".";
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
        done: false,        // every app for this page has been processed
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

    /** A name an app may have; see NAME_RE. */
    const isAppName = function (name) {
        return typeof name === "string" && NAME_RE.test(name);
    };

    /** App names from a preset list answer: markers only, prefix removed, well-formed, sorted. */
    const markerNames = function (filenames) {
        return (Array.isArray(filenames) ? filenames : []).filter(isMarker).map(function (name) {
            return name.slice(MARKER_PREFIX.length);
        }).filter(function (name) {
            if (isAppName(name)) { return true; }

            log("app \"" + name + "\" ignored: a name is letters, digits, _ . - and nothing else");

            return false;
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
     *
     * The first silence is not the end. The stock UI asks for the same list on its video
     * settings page and, when its answer arrives, clears EVERY handler for it
     * (`engine.off(name)` with no callback, components.js `MessageHandler.onResponse`),
     * ours included; and a busy engine can simply be late -- one session's log has the
     * timeout firing on the pit-lane page. So after PRESET_TIMEOUT_MS the handler is
     * registered again and the question asked once more, with a longer window, before
     * the loader decides there is nothing installed.
     */
    const discover = function (onFound) {
        let settled = false;
        let handle = null;
        let attempt = 0;
        const finish = function (names, source) {
            if (settled) { return; }

            settled = true;
            if (handle && typeof handle.clear === "function") { handle.clear(); }
            onFound(names, source);
        };
        // Only about the installed apps: the apps bundled in the package are found without
        // the game's help, so "no answer" no longer means nothing runs. Whether anything
        // does is decided once both sources are in, in start().
        const nothing = function (reason, hint) {
            log(reason + "; no installed apps" + (hint || ""));
            finish([], "none");
        };
        const onAnswer = function (response) {
            finish(markerNames(response ? response.filenames : null), "presets");
        };
        const listen = function () {
            if (handle && typeof handle.clear === "function") { handle.clear(); }

            handle = rawOn.call(engine, PRESET_RESPONSE, onAnswer);
        };
        const send = function () {
            if (settled) { return; }

            engine.trigger("OnUICommand", PRESET_REQUEST, { __Type: PRESET_REQUEST, version: 0 });
        };
        const ask = function () {
            const waitMs = attempt === 0 ? PRESET_TIMEOUT_MS : PRESET_RETRY_MS;

            attempt += 1;
            listen();
            window.setTimeout(function () {
                if (settled) { return; }

                if (attempt < PRESET_ATTEMPTS) {
                    log("no preset list answer in " + waitMs + " ms; asking again");
                    ask();

                    return;
                }

                nothing("no preset list answer in " + waitMs + " ms (attempt " + attempt + " of " + PRESET_ATTEMPTS + ")", NO_ANSWER_HINT);
            }, waitMs);

            if (engine.whenReady && typeof engine.whenReady.then === "function") {
                engine.whenReady.then(send);
            } else {
                send();
            }
        };

        if (!rawOn) {
            nothing("no engine on this page");

            return;
        }

        onAnswer[OWN_HANDLER] = true;
        ask();
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

    /**
     * An element already carrying the app's id that the loader did not create: a stock
     * element, most likely, and not ours to hand to an app whose attach will write its own
     * markup into whatever it is given.
     */
    const idTaken = function (name) {
        const existing = document.getElementById(name);

        return Boolean(existing) && existing.getAttribute(APP_ATTR) !== name;
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

        // an attach that throws leaves nothing mounted: the mark goes with it, or the drawer could
        // neither start the app again nor stop it for the life of the page
        try {
            entry.instance = entry.attach(root);
        } catch (e) {
            root.removeAttribute(MOUNTED_ATTR);
            throw e;
        }

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
         * A small value this app wants back: after the HUD reloads on Escape/resume, and
         * after a game restart. It goes to both stores (see ACEUIAppLoader.persist): the
         * stock HUD layout store, the only one the game writes to disk, and localStorage,
         * read synchronously so the value is there the moment the script asks. The HUD
         * store holds element records, so the value travels there wrapped as
         * `{ value, app, suffix }` -- the two names are what `adoptRemembered` needs to
         * copy it into localStorage when the store turns up after the script has read its
         * fallback. localStorage holds the bare value, as it always did. Anything large
         * belongs in the engine's own container (ACEUIAppLoader.persist.writeStore).
         */
        const rememberedId = function (suffix) { return HUD_ID_PREFIX + name + REMEMBER_SEPARATOR + suffix; };

        const recall = function (suffix, fallback) {
            const fromHud = ACEUIAppLoader.persist.readHud(rememberedId(suffix));
            const value = fromHud && Object.prototype.hasOwnProperty.call(fromHud, "value")
                ? fromHud.value
                : ACEUIAppLoader.persist.readLocal(key(suffix));

            return value === null || value === undefined ? fallback : value;
        };

        const remember = function (suffix, value) {
            ACEUIAppLoader.persist.writeHud(rememberedId(suffix), { value: value, app: name, suffix: suffix });

            return ACEUIAppLoader.persist.writeLocal(key(suffix), value);
        };

        const forget = function (suffix) {
            ACEUIAppLoader.persist.writeHud(rememberedId(suffix), { value: null, app: name, suffix: suffix });
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
         *
         * A right-click on the panel opens the app's settings window beside it and shuts it
         * again; `options.rightClick: false` turns that off for this panel (see
         * ACEUIAppLoader.settings for the other ways).
         */
        const panelFor = function (root, onFrame, options) {
            const opts = options || {};
            const panel = ACEUIAppLoader.panel.attach(root, {
                hudId: HUD_ID_PREFIX + name,
                storageKey: key(POSITION_SUFFIX),
                log: log,
                onSaved: opts.onSaved || null,
                // a right-click on the app opens its settings beside it, and shuts them (settings.rightClick says when).
                // `{ rightClick: false }` here, the name define's layout uses, keeps only this panel out: the window's
                // own right-click follows define
                onRightClick: opts.rightClick === false ? null : function () {
                    return Boolean(ACEUIAppLoader.settings) && ACEUIAppLoader.settings.rightClick(name, root);
                }
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

        /**
         * `mount(attach, detach)`: call `attach(root)` with `#<name>` once the DOM has it
         * (now, or on DOMContentLoaded), once per root.
         *
         * Passing detach is what lets the app drawer really turn an app off: hiding its root
         * leaves its key handlers, frame loop and sounds running (DOOM still answered Insert
         * while "disabled"). With both halves the loader can stop and restart an app, and an
         * app switched off is never attached in the first place.
         */
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

                let instance = null;

                // as in activate: a throw must not leave the app marked as mounted
                try {
                    instance = attach(root);
                } catch (e) {
                    root.removeAttribute(MOUNTED_ATTR);
                    throw e;
                }

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

    /**
     * The HUD layout store has turned up: every remembered value it holds (see `remember`)
     * is copied into localStorage, so a script that read its fallback before the store
     * existed finds the stored value the next time it asks -- on its next attach, or on
     * the HUD reload. A value already in localStorage is newer (written this session) and
     * is left alone. Returns the localStorage keys written.
     */
    const adoptRemembered = function () {
        const elements = ACEUIAppLoader.persist.hudElements() || {};
        const written = [];

        Object.keys(elements).forEach(function (id) {
            const record = elements[id];

            if (!record || typeof record !== "object" || !record.app || !record.suffix) { return; }

            if (!Object.prototype.hasOwnProperty.call(record, "value") || record.value === null) { return; }

            const localKey = KEY_PREFIX + record.app + "." + record.suffix;

            if (ACEUIAppLoader.persist.readLocal(localKey) !== null) { return; }

            ACEUIAppLoader.persist.writeLocal(localKey, record.value);
            written.push(localKey);
        });

        if (written.length > 0) { ACEUIAppLoader.log("[loader] remembered values adopted from the HUD store: " + written.join(", ")); }

        return written;
    };

    ACEUIAppLoader.persist.whenHudReady(adoptRemembered);

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

            if (info.root !== false && idTaken(name)) {
                entry.status = "invalid";
                log("app " + name + ": the page already has an element with id \"" + name + "\" that is not an app root, skipped");
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
            state.done = true;
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

    const noticeText = function (built, running) {
        return "ACE UI App Loader was built for game " + built + " but this is " + running
            + ". If the HUD or the menus look wrong, delete ACEUIAppLoader.kspkg from Saved Games\\ACE\\mods"
            + " and install the release for this game version. Click to dismiss.";
    };

    /**
     * A strip across the top of the HUD, in the loader's own red, gone with a click. The
     * one thing a stale package can still do for the player is tell them what it is: the
     * two stock files it carries are the old game's, and if the HUD around this notice
     * looks wrong, that is why. Inline styles, like every surface the loader draws.
     */
    const showMoved = function (built, running) {
        const dom = ACEUIAppLoader.dom;
        const notice = dom.make("div", {
            position: "fixed",
            left: "0",
            right: "0",
            top: "0",
            padding: "0.5rem 1rem",
            background: dom.THEME.accent,
            color: dom.THEME.white,
            fontFamily: dom.THEME.font,
            fontSize: "0.8rem",
            textAlign: "center",
            zIndex: NOTICE_Z_INDEX,
            cursor: "pointer"
        }, noticeText(built, running));

        notice.setAttribute(NOTICE_ATTR, "");
        notice.addEventListener("click", function () {
            if (notice.parentNode) { notice.parentNode.removeChild(notice); }
        });
        document.body.appendChild(notice);

        return notice;
    };

    /** The release a version string names: "0.9.1" of "0.9.1+release.6", or of "0.9.1". */
    const releaseOf = function (version) {
        return String(version).split(VERSION_BUILD_SEPARATOR)[0];
    };

    /** The version the game publishes on ModelUIState, or null until the model is filled in. */
    const runningGameVersion = function () {
        const model = window.ModelUIState;

        return model && typeof model.game_version === "string" && model.game_version ? model.game_version : null;
    };

    /**
     * Say so when the package was built for a different game build -- in the log, and on
     * the HUD itself.
     *
     * The override this library arrives through is resolved against the base package's
     * whole file table, so a game update can leave the package loading nothing at all;
     * worse, the two stock files the package carries are the OLD game's, so a stale
     * package that still wins can leave the HUD blank or every page broken. Neither
     * symptom says what it is. `builtFor` is stamped in by the build; the game publishes
     * its own version on ModelUIState, which is registered well before this runs.
     * Returns whether they differ.
     */
    const warnIfGameMoved = function () {
        const built = ACEUIAppLoader.builtFor;
        const running = runningGameVersion();
        const moved = Boolean(built && running && releaseOf(running) !== releaseOf(built));

        if (moved) {
            log("built for game " + built + " but running on " + running
                + ": rebuild the package if anything is missing");

            if (ACEUIAppLoader.page === HUD_PAGE && document.body) { showMoved(built, running); }
        }

        return moved;
    };

    /**
     * The model objects exist before this runs, but the stock bundle fills them in from
     * its per-frame sync, which has not happened yet at DOMContentLoaded -- so the version
     * can be missing for the first frames, and a check made once there would silently say
     * nothing. Look until it is there, then compare once. Returns what the comparison said,
     * or false while it is still waiting.
     */
    const watchGameVersion = function (deadline) {
        if (!ACEUIAppLoader.builtFor) { return false; }

        if (runningGameVersion() !== null) { return warnIfGameMoved(); }

        if (Date.now() < deadline) {
            window.setTimeout(function () { watchGameVersion(deadline); }, GAME_VERSION_POLL_MS);
        }

        return false;
    };

    const start = function () {
        // the build stamps how many table records each override carries: the primary and
        // the alternate release differ in nothing else a log could show
        log("loader " + ACEUIAppLoader.VERSION + " on /" + ACEUIAppLoader.page
            + (ACEUIAppLoader.records ? " (" + ACEUIAppLoader.records + " records)" : ""));
        watchGameVersion(Date.now() + GAME_VERSION_WAIT_MS);
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

    /** Runs after all apps for this page have been processed -- now, if that already happened. */
    const ready = function (callback) {
        if (state.done) {
            callback(state.apps);

            return;
        }

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
        PRESET_RETRY_MS: PRESET_RETRY_MS,
        HUD_PAGE: HUD_PAGE,
        NOTICE_ATTR: NOTICE_ATTR,
        CONTAINER_SELECTOR: CONTAINER_SELECTOR,
        APP_ATTR: APP_ATTR,
        MOUNTED_ATTR: MOUNTED_ATTR,
        DEV_VERSION: DEV_VERSION,
        apps: state.apps,
        app: app,
        adoptRemembered: adoptRemembered,
        source: source,
        filtering: filtering,
        isMarker: isMarker,
        isAppName: isAppName,
        markerNames: markerNames,
        discover: discover,
        idTaken: idTaken,
        warnIfGameMoved: warnIfGameMoved,
        releaseOf: releaseOf,
        watchGameVersion: watchGameVersion,
        showMoved: showMoved,
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
