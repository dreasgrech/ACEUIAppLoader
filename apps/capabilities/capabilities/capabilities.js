/**
 * ACE UI Capabilities Probe -- a capability probe for the Assetto Corsa EVO Gameface HUD.
 *
 * A loose UI mod, loaded into the HUD page by the ACEUIModLoader, whose only job is
 * to answer "what can JavaScript actually do inside the game's Cohtml/V8?" It runs
 * a wide battery of feature detections -- language and engine, timers, storage,
 * network, the pixel path (canvas, pixel readback, the Blob route ACEDOOM presents
 * frames with), workers, media and audio, crypto, DOM, input/gamepad, and the
 * Gameface engine bridge plus the telemetry model globals -- and shows each as
 * yes / no / partial / warn.
 *
 * The results are also written to the game log with the mod's prefix, so
 * check_ingame_log.py can read off exactly what is available after an in-game run:
 * a summary line, then the misses and the partials by name. That log is the point;
 * the panel is for reading it live. The list is long, so the body scrolls (wheel or
 * the scrollbar; drag the panel by its header).
 *
 * Two probes are *active* rather than presence-only: a fetch of a `data:` URI and a
 * Blob-URL Worker round-trip. Both are local (no network, no file lookup), both run
 * behind a timeout, and the worker is always terminated -- so nothing here can hang.
 * The summary is recomputed once those settle, so its counts are accurate.
 *
 * Cohtml rules: the panel is built once at attach and never rebuilt per frame; the
 * only per-frame work is ACEUIModLoader.panel.update settling the restored position.
 * Rows are rewritten once, when a probe settles, not on a loop.
 *
 * Identity (name, version, title, root, logger, storage keys) comes from
 * ACEUIModLoader.mod("capabilities"); styling lives in capabilities.css.
 */
const CapabilitiesProbe = (function () {

    const me = ACEUIModLoader.mod("capabilities");

    const el = ACEUIModLoader.el;
    const close = ACEUIModLoader.close;
    const toArray = ACEUIModLoader.toArray;
    const clamp = ACEUIModLoader.clamp;
    const persist = ACEUIModLoader.persist;
    const log = me.log;

    const FILTER_ATTR = "data-filter";
    const FILTER_KEY = me.key("filters");

    /** Scrolling: Cohtml does not scroll an overflowing box by itself (see ACEDevConsole). */
    const WHEEL_STEP = 0.25;
    const MIN_THUMB_PX = 12;
    /** Cohtml reports wheel deltaY with the opposite sign to a browser (positive = up). */
    const WHEEL_SIGN = -1;

    /** Result states, shared with the stylesheet through STATUS_CLASS. */
    const YES = "yes";
    const NO = "no";
    const PARTIAL = "partial";
    const WARN = "warn";

    /** Class names shared with capabilities.css. */
    const CLASS = {
        root: "ace-capabilities",
        header: "cp-header",
        title: "cp-title",
        summary: "cp-summary",
        tools: "cp-tools",
        btn: "cp-btn",
        filters: "cp-filters",
        filter: "cp-filter",
        on: "cp-on",
        count: "cp-count",
        search: "cp-search",
        hidden: "cp-hidden",
        body: "cp-body",
        scroll: "cp-scroll",
        scrollbar: "cp-scrollbar",
        thumb: "cp-thumb",
        nofit: "cp-nofit",
        dragging: "dragging",
        cat: "cp-cat",
        catName: "cp-cat-name",
        row: "cp-row",
        dot: "cp-dot",
        name: "cp-name",
        detail: "cp-detail",
        statusYes: "cp-yes",
        statusNo: "cp-no",
        statusPartial: "cp-partial",
        statusWarn: "cp-warn"
    };

    const STATUS_CLASS = {};

    STATUS_CLASS[YES] = CLASS.statusYes;
    STATUS_CLASS[NO] = CLASS.statusNo;
    STATUS_CLASS[PARTIAL] = CLASS.statusPartial;
    STATUS_CLASS[WARN] = CLASS.statusWarn;

    /** Status filter chips (each toggles the visibility of rows with that status). */
    const STATUS_FILTERS = [
        { id: YES, label: "available" },
        { id: NO, label: "unavailable" },
        { id: PARTIAL, label: "partial" },
        { id: WARN, label: "warn" }
    ];

    const ROW_ATTR = "data-row";
    const ACT_ATTR = "data-act";
    const NODRAG_ATTR = "data-nodrag";

    // ---- probe helpers -------------------------------------------------------------

    /**
     * Resolve a dotted global path against `window` (e.g. "navigator.sendBeacon"),
     * returning undefined if any step is missing. Paths are plain strings, so a probe
     * can name an API without the script referencing the identifier as code.
     */
    const resolve = function (path) {
        const parts = path.split(".");
        let current = window;
        let i;

        for (i = 0; i < parts.length; i += 1) {
            if (current === null || current === undefined) { return undefined; }

            current = current[parts[i]];
        }

        return current;
    };

    /** A presence check: yes when the global exists, no when it does not. */
    const present = function (path) {
        return function () {
            const value = resolve(path);

            if (typeof value === "undefined") { return { status: NO, detail: "undefined" }; }

            return { status: YES, detail: "typeof " + typeof value };
        };
    };

    /** A presence-only check row. */
    const p = function (name, path) {
        return { name: name, run: present(path) };
    };

    /** A functional check row: `run` returns { status, detail }. */
    const f = function (name, run) {
        return { name: name, run: run };
    };

    /** An active check row: a synchronous placeholder, then `probe(setResult)` settles it. */
    const active = function (name, note, probe) {
        return { name: name, run: function () { return { status: WARN, detail: note }; }, probe: probe };
    };

    const makeCanvas = function () {
        return document.createElement("canvas");
    };

    /** A small 2D context, or null if canvas 2D is unavailable. */
    const ctx2d = function () {
        const canvas = makeCanvas();

        canvas.width = 2;
        canvas.height = 2;

        return canvas.getContext ? canvas.getContext("2d") : null;
    };

    // ---- functional checks: language ----------------------------------------------

    const dynFunction = function () {
        try {
            const fn = new Function("return 6 * 7");

            if (fn() === 42) { return { status: YES, detail: "new Function() compiles and runs" }; }

            return { status: PARTIAL, detail: "ran, wrong result" };
        } catch (e) {
            return { status: NO, detail: "blocked: " + (e && e.message || e) };
        }
    };

    const asyncSupport = function () {
        try {
            const make = new Function("return (async function () { return 1; })");

            return typeof make() === "function"
                ? { status: YES, detail: "async functions parse" }
                : { status: NO, detail: "not a function" };
        } catch (e) {
            return { status: NO, detail: "parse error" };
        }
    };

    const generators = function () {
        try {
            const make = new Function("return (function* () { yield 1; })");
            const gen = make();

            return typeof gen === "function" && typeof gen().next === "function"
                ? { status: YES, detail: "generators run" }
                : { status: PARTIAL, detail: "parsed, no iterator" };
        } catch (e) {
            return { status: NO, detail: "parse error" };
        }
    };

    const modernSyntax = function () {
        try {
            const test = new Function("var o = { a: { b: 2 } }; var x = null; return (o?.a?.b) === 2 && (x ?? 7) === 7");

            return test()
                ? { status: YES, detail: "optional chaining and nullish coalescing run" }
                : { status: PARTIAL, detail: "ran, unexpected result" };
        } catch (e) {
            return { status: NO, detail: "syntax not supported" };
        }
    };

    const dateNow = function () {
        return typeof Date.now === "function"
            ? { status: YES, detail: "Date.now() = " + Date.now() }
            : { status: NO, detail: "no Date.now" };
    };

    // ---- functional checks: storage / dom -----------------------------------------

    const cookie = function () {
        return typeof document.cookie === "string"
            ? { status: YES, detail: "document.cookie readable" }
            : { status: NO, detail: "no document.cookie" };
    };

    const webAnimations = function () {
        const node = document.createElement("div");

        return typeof node.animate === "function"
            ? { status: YES, detail: "Element.animate present" }
            : { status: NO, detail: "no Element.animate" };
    };

    const shadowDom = function () {
        const node = document.createElement("div");

        return typeof node.attachShadow === "function"
            ? { status: YES, detail: "attachShadow present" }
            : { status: NO, detail: "no attachShadow" };
    };

    // ---- functional checks: graphics / pixel path ---------------------------------

    const canvas2d = function () {
        return ctx2d() ? { status: YES, detail: "2d context ok" } : { status: NO, detail: "no 2d context" };
    };

    /** The pixel-write path: getImageData / putImageData. Absent here -> encode a PNG instead. */
    const canvasReadback = function () {
        const ctx = ctx2d();

        if (!ctx) { return { status: NO, detail: "no 2d context" }; }

        if (typeof ctx.getImageData !== "function" || typeof ctx.putImageData !== "function") {
            return { status: NO, detail: "getImageData/putImageData absent -- write pixels via a Blob PNG" };
        }

        try {
            ctx.getImageData(0, 0, 1, 1);

            return { status: YES, detail: "pixel readback ok" };
        } catch (e) {
            return { status: PARTIAL, detail: "methods exist but threw: " + (e && e.message || e) };
        }
    };

    /** ACEDOOM presents frames as Blob object URLs; toDataURL is a simpler route if present. */
    const canvasPng = function () {
        const canvas = makeCanvas();

        canvas.width = 4;
        canvas.height = 4;

        const ctx = canvas.getContext ? canvas.getContext("2d") : null;

        if (!ctx) { return { status: NO, detail: "no 2d context" }; }

        if (typeof canvas.toDataURL !== "function") { return { status: NO, detail: "no toDataURL" }; }

        let url = "";

        try {
            ctx.fillRect(0, 0, 2, 2);
            url = canvas.toDataURL("image/png");
        } catch (e) {
            return { status: NO, detail: "threw: " + (e && e.message || e) };
        }

        if (url.indexOf("data:image/png") === 0) { return { status: YES, detail: "PNG data URL, " + url.length + " chars" }; }

        return { status: PARTIAL, detail: "returned " + url.slice(0, 24) };
    };

    const canvasToBlob = function () {
        return typeof makeCanvas().toBlob === "function"
            ? { status: YES, detail: "toBlob present" }
            : { status: NO, detail: "no toBlob" };
    };

    const glContext = function (mode) {
        return function () {
            const canvas = makeCanvas();
            let ctx = null;

            try {
                ctx = canvas.getContext ? canvas.getContext(mode) : null;
            } catch (e) {
                return { status: NO, detail: "threw getting " + mode };
            }

            return ctx ? { status: YES, detail: mode + " context ok" } : { status: NO, detail: "no " + mode + " context" };
        };
    };

    const svgSupport = function () {
        if (typeof document.createElementNS !== "function") { return { status: NO, detail: "no createElementNS" }; }

        try {
            // slashes built from char codes so the linter's comment-stripper does not eat the line
            const svgNs = "http:" + String.fromCharCode(47, 47) + "www.w3.org/2000/svg";
            const node = document.createElementNS(svgNs, "path");

            return node
                ? { status: PARTIAL, detail: "elements create; Renoir re-tessellates on change -- never per frame" }
                : { status: NO, detail: "null element" };
        } catch (e) {
            return { status: NO, detail: "threw" };
        }
    };

    // ---- functional checks: media / crypto / bridge -------------------------------

    const audioElement = function () {
        if (typeof window.Audio !== "function") { return { status: NO, detail: "no Audio constructor" }; }

        try {
            const a = new Audio();

            return typeof a.play === "function"
                ? { status: PARTIAL, detail: "element + play() exist; no decoder in Cohtml (silent)" }
                : { status: NO, detail: "no play()" };
        } catch (e) {
            return { status: NO, detail: "threw" };
        }
    };

    const videoCodecs = function () {
        const v = document.createElement("video");

        if (!v || typeof v.canPlayType !== "function") { return { status: NO, detail: "no video element" }; }

        const mp4 = v.canPlayType("video/mp4") || "";
        const webm = v.canPlayType("video/webm") || "";

        if (!mp4 && !webm) { return { status: NO, detail: "canPlayType mp4/webm both empty (no demuxers)" }; }

        return { status: PARTIAL, detail: "mp4=" + (mp4 || "-") + " webm=" + (webm || "-") };
    };

    const engineTrigger = function () {
        const eng = window.engine;

        return eng && typeof eng.trigger === "function"
            ? { status: YES, detail: "engine.trigger present (FMOD / UI command bridge)" }
            : { status: NO, detail: "no engine.trigger (outside the game?)" };
    };

    /** Every telemetry model global the game has published on window (Model*), all names. */
    const modelGlobals = function () {
        let keys = [];

        try {
            keys = Object.keys(window).filter(function (k) { return k.indexOf("Model") === 0; });
        } catch (e) {
            return { status: WARN, detail: "cannot enumerate window" };
        }

        if (!keys.length) { return { status: WARN, detail: "no Model* globals (outside the game?)" }; }

        return { status: YES, detail: keys.length + ": " + keys.join(", ") };
    };

    // ---- active probes (deferred, timed, never hang) -------------------------------

    /** Fetch a local data: URI: proves fetch actually functions without any network. */
    const fetchDataProbe = function (setResult) {
        const fetchFn = window.fetch;

        if (typeof fetchFn !== "function") { setResult(NO, "no fetch"); return; }

        let settled = false;

        const finishProbe = function (status, detail) {
            if (settled) { return; }

            settled = true;
            setResult(status, detail);
        };

        const timer = window.setTimeout ? window.setTimeout(function () { finishProbe(WARN, "timed out (2s)"); }, 2000) : 0;
        const clear = function () { if (timer && window.clearTimeout) { window.clearTimeout(timer); } };

        try {
            fetchFn("data:text/plain,ok").then(function (res) {
                return res && typeof res.text === "function" ? res.text() : "";
            }).then(function (text) {
                clear();
                finishProbe(text === "ok" ? YES : PARTIAL, text === "ok" ? "data: URI fetched ok" : "resolved, body=" + String(text).slice(0, 12));
            }, function (err) {
                clear();
                finishProbe(NO, "rejected: " + (err && err.message || err));
            });
        } catch (e) {
            clear();
            finishProbe(NO, "threw: " + (e && e.message || e));
        }
    };

    /** Spin up a Blob-URL worker, double a number, read it back; always terminated. */
    const workerProbe = function (setResult) {
        const urlObj = window.URL;
        const hasBlob = typeof window.Blob === "function";
        const canUrl = urlObj && typeof urlObj.createObjectURL === "function";

        if (typeof window.Worker !== "function") { setResult(NO, "no Worker"); return; }

        if (!hasBlob || !canUrl) { setResult(PARTIAL, "Worker exists; no Blob URL to load one from"); return; }

        let settled = false;
        let worker = null;
        let url = "";

        const finishProbe = function (status, detail) {
            if (settled) { return; }

            settled = true;

            if (worker && typeof worker.terminate === "function") { worker.terminate(); }

            if (url && typeof urlObj.revokeObjectURL === "function") { urlObj.revokeObjectURL(url); }

            setResult(status, detail);
        };

        const timer = window.setTimeout ? window.setTimeout(function () { finishProbe(WARN, "no reply in 600ms"); }, 600) : 0;
        const clear = function () { if (timer && window.clearTimeout) { window.clearTimeout(timer); } };

        try {
            const src = "onmessage = function (e) { postMessage(e.data * 2); };";
            const blob = new Blob([src], { type: "text/javascript" });

            url = urlObj.createObjectURL(blob);
            worker = new Worker(url);

            worker.onmessage = function (e) {
                clear();
                finishProbe(e.data === 42 ? YES : PARTIAL, "round-trip ok, got " + e.data);
            };

            worker.onerror = function (err) {
                clear();
                finishProbe(NO, "worker error: " + (err && err.message || "?"));
            };

            worker.postMessage(21);
        } catch (e) {
            clear();
            finishProbe(NO, "threw: " + (e && e.message || e));
        }
    };

    // ---- the battery ---------------------------------------------------------------

    const CATEGORIES = [
        { cat: "Language & engine", checks: [
            p("WebAssembly", "WebAssembly"),
            f("eval / new Function", dynFunction),
            f("async functions", asyncSupport),
            f("generators", generators),
            f("optional chaining / ??", modernSyntax),
            p("Promise", "Promise"),
            p("Promise.allSettled", "Promise.allSettled"),
            p("Promise.any", "Promise.any"),
            p("BigInt", "BigInt"),
            p("Proxy", "Proxy"),
            p("Reflect", "Reflect"),
            p("Symbol", "Symbol"),
            p("WeakRef", "WeakRef"),
            p("WeakMap", "WeakMap"),
            p("WeakSet", "WeakSet"),
            p("FinalizationRegistry", "FinalizationRegistry"),
            p("Map / Set", "Map"),
            p("Atomics", "Atomics"),
            p("SharedArrayBuffer", "SharedArrayBuffer"),
            p("BigInt64Array", "BigInt64Array"),
            p("globalThis", "globalThis"),
            p("TextEncoder", "TextEncoder"),
            p("TextDecoder", "TextDecoder"),
            p("structuredClone", "structuredClone"),
            p("Intl", "Intl")
        ] },
        { cat: "Timing & scheduling", checks: [
            p("setTimeout", "setTimeout"),
            p("setInterval", "setInterval"),
            p("clearTimeout", "clearTimeout"),
            p("requestAnimationFrame", "requestAnimationFrame"),
            p("cancelAnimationFrame", "cancelAnimationFrame"),
            p("queueMicrotask", "queueMicrotask"),
            p("requestIdleCallback", "requestIdleCallback"),
            p("performance", "performance"),
            p("performance.now", "performance.now"),
            p("performance.mark", "performance.mark"),
            p("performance.memory", "performance.memory"),
            f("Date.now", dateNow),
            p("MessageChannel", "MessageChannel")
        ] },
        { cat: "Storage", checks: [
            p("localStorage", "localStorage"),
            p("sessionStorage", "sessionStorage"),
            p("indexedDB", "indexedDB"),
            p("CacheStorage", "caches"),
            f("document.cookie", cookie)
        ] },
        { cat: "Network", checks: [
            p("fetch", "fetch"),
            p("XMLHttpRequest", "XMLHttpRequest"),
            p("WebSocket", "WebSocket"),
            p("EventSource", "EventSource"),
            p("navigator.sendBeacon", "navigator.sendBeacon"),
            p("Request / Response", "Response"),
            p("Headers", "Headers"),
            p("AbortController", "AbortController"),
            p("RTCPeerConnection (WebRTC)", "RTCPeerConnection"),
            p("WebTransport", "WebTransport"),
            p("navigator.onLine", "navigator.onLine"),
            active("fetch(data:) round-trip", "probing data: URI...", fetchDataProbe)
        ] },
        { cat: "Graphics & pixel path", checks: [
            f("canvas 2d context", canvas2d),
            f("canvas getImageData/putImageData", canvasReadback),
            f("canvas -> PNG data URL", canvasPng),
            f("canvas.toBlob", canvasToBlob),
            p("ImageData", "ImageData"),
            p("ImageBitmap", "ImageBitmap"),
            p("createImageBitmap", "createImageBitmap"),
            p("OffscreenCanvas", "OffscreenCanvas"),
            p("WebGLRenderingContext", "WebGLRenderingContext"),
            f("WebGL", glContext("webgl")),
            f("WebGL2", glContext("webgl2")),
            p("Path2D", "Path2D"),
            p("DOMMatrix", "DOMMatrix"),
            p("devicePixelRatio", "devicePixelRatio"),
            f("SVG elements", svgSupport)
        ] },
        { cat: "Workers & concurrency", checks: [
            p("Worker", "Worker"),
            p("SharedWorker", "SharedWorker"),
            p("Blob", "Blob"),
            p("URL.createObjectURL", "URL.createObjectURL"),
            p("navigator.hardwareConcurrency", "navigator.hardwareConcurrency"),
            active("Blob Worker round-trip", "probing Blob worker...", workerProbe)
        ] },
        { cat: "Media & audio", checks: [
            p("AudioContext", "AudioContext"),
            p("webkitAudioContext", "webkitAudioContext"),
            p("OfflineAudioContext", "OfflineAudioContext"),
            f("HTMLAudioElement.play", audioElement),
            f("video codecs", videoCodecs),
            p("MediaSource", "MediaSource"),
            f("engine audio bridge", engineTrigger)
        ] },
        { cat: "DOM & observers", checks: [
            p("MutationObserver", "MutationObserver"),
            p("ResizeObserver", "ResizeObserver"),
            p("IntersectionObserver", "IntersectionObserver"),
            p("DOMParser", "DOMParser"),
            p("customElements", "customElements"),
            f("Element.animate", webAnimations),
            f("Element.attachShadow", shadowDom),
            p("CustomEvent", "CustomEvent"),
            p("DocumentFragment", "DocumentFragment"),
            p("HTMLTemplateElement", "HTMLTemplateElement"),
            p("getSelection", "getSelection"),
            p("getComputedStyle", "getComputedStyle"),
            p("matchMedia", "matchMedia"),
            p("URLSearchParams", "URLSearchParams"),
            p("document.fonts", "document.fonts"),
            p("FontFace", "FontFace")
        ] },
        { cat: "Input & events", checks: [
            p("PointerEvent", "PointerEvent"),
            p("KeyboardEvent", "KeyboardEvent"),
            p("WheelEvent", "WheelEvent"),
            p("TouchEvent", "TouchEvent"),
            p("EventTarget", "EventTarget"),
            p("navigator.getGamepads", "navigator.getGamepads"),
            p("Gamepad", "Gamepad")
        ] },
        { cat: "Gameface bridge & telemetry", checks: [
            p("engine", "engine"),
            p("engine.on", "engine.on"),
            p("engine.off", "engine.off"),
            p("engine.trigger", "engine.trigger"),
            p("engine.call", "engine.call"),
            p("engine.BindingsReady", "engine.BindingsReady"),
            p("cohtml", "cohtml"),
            p("HUD (layout store)", "HUD"),
            p("ModelCurrentCar", "ModelCurrentCar"),
            f("Model* globals", modelGlobals)
        ] }
    ];

    /** The checks flattened in render order, so row N is CHECKS[N]. */
    const CHECKS = [];

    CATEGORIES.forEach(function (category) {
        category.checks.forEach(function (check) { CHECKS.push(check); });
    });

    // ---- markup (built once) -------------------------------------------------------

    const rowMarkup = function (check, id) {
        const attrs = {};

        attrs[ROW_ATTR] = id;

        return el("div", CLASS.row, attrs)
            + el("span", CLASS.dot) + close("span")
            + el("span", CLASS.name) + check.name + close("span")
            + el("span", CLASS.detail) + close("span")
            + close("div");
    };

    const catMarkup = function (category, startId) {
        let rows = "";

        category.checks.forEach(function (check, i) {
            rows += rowMarkup(check, startId + i);
        });

        return el("div", CLASS.cat)
            + el("div", CLASS.catName) + category.cat + close("div")
            + rows
            + close("div");
    };

    const button = function (act, label) {
        const attrs = {};

        attrs[NODRAG_ATTR] = "";
        attrs[ACT_ATTR] = act;

        return el("div", CLASS.btn, attrs) + label + close("div");
    };

    const filterMarkup = function (filter) {
        const attrs = {};

        attrs[FILTER_ATTR] = filter.id;

        return el("div", CLASS.filter, attrs)
            + el("span", CLASS.dot + " " + STATUS_CLASS[filter.id]) + close("span")
            + filter.label
            + el("span", CLASS.count) + "0" + close("span")
            + close("div");
    };

    const searchMarkup = function () {
        return el("input", CLASS.search, { type: "text", placeholder: "filter..." });
    };

    const markup = function () {
        const scrollAttrs = {};
        const filtersAttrs = {};
        let body = "";
        let id = 0;

        // data-nodrag so scrolling, grabbing the scrollbar, or typing does not start a panel drag
        scrollAttrs[NODRAG_ATTR] = "";
        filtersAttrs[NODRAG_ATTR] = "";

        CATEGORIES.forEach(function (category) {
            body += catMarkup(category, id);
            id += category.checks.length;
        });

        return el("div", CLASS.header)
                + el("span", CLASS.title) + me.title + close("span")
                + el("span", CLASS.summary) + close("span")
                + close("div")
            + el("div", CLASS.tools)
                + button("rerun", "Re-run")
                + button("log", "Log to console")
                + close("div")
            + el("div", CLASS.filters, filtersAttrs)
                + STATUS_FILTERS.map(filterMarkup).join("")
                + searchMarkup()
                + close("div")
            + el("div", CLASS.scroll, scrollAttrs)
                + el("div", CLASS.body) + body + close("div")
                + el("div", CLASS.scrollbar) + el("div", CLASS.thumb) + close("div") + close("div")
                + close("div");
    };

    // ---- state ---------------------------------------------------------------------

    const create = function (root) {
        root.classList.add(CLASS.root);

        if (!root.querySelector("." + CLASS.body)) { root.innerHTML = markup(); }

        const rows = toArray(root.querySelectorAll("[" + ROW_ATTR + "]")).map(function (rowEl, i) {
            return {
                el: rowEl,
                dot: rowEl.querySelector("." + CLASS.dot),
                detail: rowEl.querySelector("." + CLASS.detail),
                name: CHECKS[i] ? CHECKS[i].name : ""
            };
        });

        const cats = toArray(root.querySelectorAll("." + CLASS.cat)).map(function (catEl) {
            return { el: catEl, rows: toArray(catEl.querySelectorAll("." + CLASS.row)) };
        });

        const filters = {};
        const filterEls = {};
        const stored = persist.readLocal(FILTER_KEY);

        STATUS_FILTERS.forEach(function (filter) {
            const node = root.querySelector("[" + FILTER_ATTR + "=\"" + filter.id + "\"]");

            filters[filter.id] = !(stored && stored[filter.id] === false);
            filterEls[filter.id] = { el: node, count: node.querySelector("." + CLASS.count) };
            node.classList.toggle(CLASS.on, filters[filter.id]);
        });

        return {
            root: root,
            rows: rows,
            cats: cats,
            filters: filters,
            filterEls: filterEls,
            query: "",                  // lower-cased search text, "" for none
            body: root.querySelector("." + CLASS.body),
            track: root.querySelector("." + CLASS.scrollbar),
            thumb: root.querySelector("." + CLASS.thumb),
            search: root.querySelector("." + CLASS.search),
            summary: root.querySelector("." + CLASS.summary),
            results: [],
            pending: 0,
            drag: null,                 // thumb drag in progress: { startY, startTop }
            thumbHeight: -1,            // last applied thumb geometry (only written on change)
            thumbY: -1,
            wheelLogged: false,         // the first wheel event is logged once
            laidOut: false,             // the scrollbar has been sized once layout exists
            handlers: null,
            panel: null,
            loop: null
        };
    };

    // ---- running -------------------------------------------------------------------

    const setRow = function (row, status, detail) {
        const statusClass = STATUS_CLASS[status] || CLASS.statusWarn;

        row.dot.className = CLASS.dot + " " + statusClass;
        row.detail.className = CLASS.detail + " " + statusClass;
        row.detail.textContent = detail;
    };

    const recount = function (state) {
        const counts = { yes: 0, no: 0, partial: 0, warn: 0 };

        state.results.forEach(function (r) {
            if (r) { counts[r.status] = (counts[r.status] || 0) + 1; }
        });

        return counts;
    };

    const updateSummary = function (state) {
        const counts = recount(state);

        state.summary.textContent = counts.yes + " yes / " + counts.no + " no / " + counts.partial + " partial / " + counts.warn + " warn";
    };

    const names = function (results, status) {
        return results.filter(function (r) { return r && r.status === status; }).map(function (r) { return r.name; });
    };

    const logSummary = function (state, label) {
        const counts = recount(state);

        log(label + " on " + ACEUIModLoader.page + ": " + counts.yes + " yes, " + counts.no + " no, " + counts.partial + " partial, " + counts.warn + " warn");

        const missing = names(state.results, NO);
        const partial = names(state.results, PARTIAL);

        if (missing.length) { log("missing: " + missing.join(", ")); }

        if (partial.length) { log("partial: " + partial.join(", ")); }
    };

    const logAll = function (state) {
        log("--- full report (" + CHECKS.length + " checks, " + ACEUIModLoader.page + ") ---");

        state.results.forEach(function (r) {
            if (r) { log(r.name + " = " + r.status + " -- " + r.detail); }
        });
    };

    const record = function (state, index, name, status, detail) {
        state.results[index] = { name: name, status: status, detail: detail };
    };

    const runAll = function (state) {
        state.results = [];
        state.pending = 0;

        state.rows.forEach(function (row, i) {
            const check = CHECKS[i];
            let res;

            try {
                res = check.run();
            } catch (e) {
                res = { status: NO, detail: "check threw: " + (e && e.message || e) };
            }

            setRow(row, res.status, res.detail);
            record(state, i, check.name, res.status, res.detail);

            if (check.probe) { state.pending += 1; }
        });

        updateSummary(state);
        logSummary(state, "probe");
        updateFilterCounts(state);
        applyFilters(state);

        state.rows.forEach(function (row, i) {
            const check = CHECKS[i];

            if (check.probe) {
                check.probe(function (status, detail) {
                    setRow(row, status, detail);
                    record(state, i, check.name, status, detail);
                    log("probe " + check.name + " = " + status + " (" + detail + ")");
                    updateSummary(state);
                    updateFilterCounts(state);
                    applyFilters(state);
                    state.pending -= 1;

                    if (state.pending === 0) { logSummary(state, "probe complete"); }
                });
            }
        });
    };

    // ---- scrolling (Cohtml needs the box scrolled by hand; mirrors ACEDevConsole) --

    /** Size and place the thumb from the body's scroll geometry; writes style only on change. */
    const syncScrollbar = function (state) {
        const body = state.body;
        const visible = body.clientHeight;
        const total = body.scrollHeight;
        const trackHeight = state.track.clientHeight;
        const fits = total <= visible || trackHeight === 0;
        let thumbHeight;
        let y;

        state.track.classList.toggle(CLASS.nofit, fits);

        if (fits) { return; }

        thumbHeight = Math.min(trackHeight, Math.max(MIN_THUMB_PX, Math.round(trackHeight * visible / total)));
        y = Math.round((trackHeight - thumbHeight) * clamp(body.scrollTop / (total - visible), 0, 1));

        if (thumbHeight !== state.thumbHeight) {
            state.thumbHeight = thumbHeight;
            state.thumb.style.height = thumbHeight + "px";
        }

        if (y !== state.thumbY) {
            state.thumbY = y;
            state.thumb.style.transform = "translateY(" + y + "px)";
        }
    };

    /** Move the clipped body by `dy` pixels and re-place the thumb. */
    const scrollBy = function (state, dy) {
        const body = state.body;
        const max = Math.max(0, body.scrollHeight - body.clientHeight);

        body.scrollTop = clamp(body.scrollTop + dy, 0, max);
        syncScrollbar(state);
    };

    const onWheel = function (state, e) {
        const direction = e.deltaY > 0 ? 1 : (e.deltaY < 0 ? -1 : 0);

        if (!state.wheelLogged) {
            state.wheelLogged = true;
            log("first wheel deltaY=" + e.deltaY + " (positive is treated as up)");
        }

        if (direction === 0) { return; }

        scrollBy(state, direction * WHEEL_SIGN * state.body.clientHeight * WHEEL_STEP);
        e.preventDefault();
    };

    const onThumbDown = function (state, e) {
        state.drag = { startY: e.clientY, startTop: state.body.scrollTop };
        state.track.classList.toggle(CLASS.dragging, true);
        window.addEventListener("mousemove", state.handlers.thumbMove);
        window.addEventListener("mouseup", state.handlers.thumbUp);
        e.preventDefault();
    };

    const onThumbMove = function (state, e) {
        const body = state.body;
        const travel = state.track.clientHeight - state.thumbHeight;
        const max = Math.max(0, body.scrollHeight - body.clientHeight);

        if (!state.drag || travel <= 0) { return; }

        scrollBy(state, state.drag.startTop + (e.clientY - state.drag.startY) * max / travel - body.scrollTop);
    };

    const onThumbUp = function (state) {
        if (!state.drag) { return; }

        state.drag = null;
        state.track.classList.toggle(CLASS.dragging, false);
        window.removeEventListener("mousemove", state.handlers.thumbMove);
        window.removeEventListener("mouseup", state.handlers.thumbUp);
    };

    /** A press on the track jumps to that point; on the thumb it starts a drag. */
    const onTrackDown = function (state, e) {
        const body = state.body;
        const travel = state.track.clientHeight - state.thumbHeight;
        const max = Math.max(0, body.scrollHeight - body.clientHeight);
        let ratio = 1;

        if (e.target === state.thumb) {
            onThumbDown(state, e);

            return;
        }

        if (typeof e.offsetY === "number" && travel > 0) { ratio = clamp((e.offsetY - state.thumbHeight / 2) / travel, 0, 1); }

        scrollBy(state, ratio * max - body.scrollTop);
        e.preventDefault();
    };

    // ---- filters: status chips + search box (mirrors ACEDevConsole) ----------------

    const updateFilterCounts = function (state) {
        const counts = recount(state);

        STATUS_FILTERS.forEach(function (filter) {
            state.filterEls[filter.id].count.textContent = counts[filter.id] || 0;
        });
    };

    const rowVisible = function (state, row, res) {
        const status = res ? res.status : WARN;

        if (state.filters[status] === false) { return false; }

        if (state.query === "") { return true; }

        return (row.name + " " + (res ? res.detail : "")).toLowerCase().indexOf(state.query) >= 0;
    };

    /** Apply the status chips and search text: hide rows, then hide categories left empty. */
    const applyFilters = function (state) {
        state.rows.forEach(function (row, i) {
            row.el.classList.toggle(CLASS.hidden, !rowVisible(state, row, state.results[i]));
        });

        state.cats.forEach(function (cat) {
            const anyVisible = cat.rows.some(function (r) { return !r.classList.contains(CLASS.hidden); });

            cat.el.classList.toggle(CLASS.hidden, !anyVisible);
        });

        scrollBy(state, 0);   // clamp scrollTop to the new content height and re-place the thumb
    };

    const setFilter = function (state, id, on) {
        const store = {};

        state.filters[id] = on;
        state.filterEls[id].el.classList.toggle(CLASS.on, on);

        STATUS_FILTERS.forEach(function (filter) { store[filter.id] = state.filters[filter.id]; });
        persist.writeLocal(FILTER_KEY, store);

        applyFilters(state);
    };

    const onSearchChange = function (state) {
        const query = String(state.search.value || "").trim().toLowerCase();

        if (query === state.query) { return; }

        state.query = query;
        applyFilters(state);
    };

    // ---- rendering -----------------------------------------------------------------

    /** One animation frame: settle the panel position, then size the scrollbar once layout exists. */
    const tick = function (state, now) {
        ACEUIModLoader.panel.update(state.panel, now);

        if (!state.laidOut && state.body.clientHeight > 0) {
            state.laidOut = true;
            syncScrollbar(state);
        }
    };

    // ---- lifecycle -----------------------------------------------------------------

    const onClick = function (state, e) {
        const btn = ACEUIModLoader.closestWithAttribute(e.target, ACT_ATTR, state.root);

        if (btn) {
            const act = btn.getAttribute(ACT_ATTR);

            if (act === "rerun") {
                log("re-run requested");
                runAll(state);
            } else if (act === "log") {
                logAll(state);
            }

            return;
        }

        const chip = ACEUIModLoader.closestWithAttribute(e.target, FILTER_ATTR, state.root);

        if (chip) {
            const id = chip.getAttribute(FILTER_ATTR);

            setFilter(state, id, state.filters[id] === false);
        }
    };

    const attach = function (root) {
        const state = create(root);

        state.handlers = {
            click: function (e) { onClick(state, e); },
            wheel: function (e) { onWheel(state, e); },
            trackDown: function (e) { onTrackDown(state, e); },
            thumbMove: function (e) { onThumbMove(state, e); },
            thumbUp: function () { onThumbUp(state); },
            searchChange: function () { onSearchChange(state); }
        };

        root.addEventListener("click", state.handlers.click);
        state.body.addEventListener("wheel", state.handlers.wheel);
        state.track.addEventListener("mousedown", state.handlers.trackDown);
        state.search.addEventListener("input", state.handlers.searchChange);
        state.search.addEventListener("keyup", state.handlers.searchChange);

        state.panel = ACEUIModLoader.panel.attach(root, { hudId: me.hudId, storageKey: me.storageKey, log: log });
        state.loop = ACEUIModLoader.loop.start(function (now) { tick(state, now); });

        runAll(state);
        log("attached, " + CHECKS.length + " checks, lib=" + ACEUIModLoader.VERSION);

        return state;
    };

    const detach = function (state) {
        ACEUIModLoader.loop.stop(state.loop);
        ACEUIModLoader.panel.detach(state.panel);

        if (state.handlers) {
            state.root.removeEventListener("click", state.handlers.click);
            state.body.removeEventListener("wheel", state.handlers.wheel);
            state.track.removeEventListener("mousedown", state.handlers.trackDown);
            state.search.removeEventListener("input", state.handlers.searchChange);
            state.search.removeEventListener("keyup", state.handlers.searchChange);
            window.removeEventListener("mousemove", state.handlers.thumbMove);
            window.removeEventListener("mouseup", state.handlers.thumbUp);
            state.handlers = null;
        }
    };

    log("script loaded, version=" + me.version + ", lib=" + ACEUIModLoader.VERSION + ", url=" + location.href);

    return {
        CLASS: CLASS,
        CATEGORIES: CATEGORIES,
        CHECKS: CHECKS,
        create: create,
        runAll: runAll,
        attach: attach,
        detach: detach
    };
}());

/* Attach to #capabilities: the loader creates it in game, the preview page carries it. */
ACEUIModLoader.mod("capabilities").mount(CapabilitiesProbe.attach);
