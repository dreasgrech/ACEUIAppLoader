/**
 * ACE UI Capabilities Probe -- a capability probe for the Assetto Corsa EVO Gameface HUD.
 *
 * A loose UI app, loaded into the HUD page by the ACEUIAppLoader, whose only job is
 * to answer "what can JavaScript actually do inside the game's Cohtml/V8?" It runs
 * a wide battery of feature detections -- language and engine, timers, storage,
 * network, the pixel path (canvas, pixel readback, the Blob route ACEDOOM presents
 * frames with), workers, media and audio, DOM, input/gamepad, the Gameface engine
 * bridge, and the live telemetry model globals (each with its field names and current
 * values, so an app can be built against what the game actually publishes) -- and shows
 * each as yes / no / partial / warn.
 *
 * The results are also written to the game log with the app's prefix, so
 * check_ingame_log.py can read off exactly what is available after an in-game run:
 * a summary line, then the misses and the partials by name. That log is the point;
 * the panel is for reading it live. The list is long, so the body scrolls (wheel or
 * the scrollbar; drag the panel by its header).
 *
 * Three probes are *active* rather than presence-only: a fetch of a `data:` URI, a
 * Blob-URL Worker round-trip, and a WebSocket connection to a loopback port. All are
 * local (no external service, no file lookup), each runs behind a timeout, and the
 * worker and the socket are always closed -- so nothing here can hang. The summary is
 * recomputed once those settle, so its counts are accurate.
 *
 * Cohtml rules: the panel is built once at attach and never rebuilt per frame; the
 * only per-frame work is the shared panel lifecycle settling the restored position.
 * Rows are rewritten once, when a probe settles, not on a loop.
 *
 * Identity (name, version, title, root, logger, storage keys) comes from
 * ACEUIAppLoader.app("capabilities"); styling lives in capabilities.css.
 */
const CapabilitiesProbe = (function () {

    const me = ACEUIAppLoader.app("capabilities");

    const el = ACEUIAppLoader.el;
    const close = ACEUIAppLoader.close;
    const toArray = ACEUIAppLoader.toArray;
    const clamp = ACEUIAppLoader.clamp;
    const persist = ACEUIAppLoader.persist;
    const settings = ACEUIAppLoader.settings;
    const log = me.log;

    const FILTER_ATTR = "data-filter";

    /**
     * Scrolling: Cohtml does not scroll an overflowing box by itself, and the wheel's sign
     * is inverted here. Both are ACEUIAppLoader.scroll's business now -- this panel used to
     * carry its own copy of the dev console's version.
     */
    const scrolling = ACEUIAppLoader.scroll;

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

    /** A compact one-token preview of a field value, for the model inspector rows. */
    const previewValue = function (v) {
        const t = typeof v;

        if (v === null) { return "null"; }
        if (t === "number" || t === "boolean") { return String(v); }
        if (t === "string") { return "\"" + v.slice(0, 16) + "\""; }
        if (t === "object") { return Array.isArray(v) ? "[" + v.length + "]" : "{obj}"; }

        return t;
    };

    /**
     * Inspect one live telemetry model global by name: list its field names with a
     * current value each, so a dashboard can be built against the real schema. Absent
     * outside a session (WARN), populated in game (YES). This is the point of the
     * "Telemetry models (live)" category -- the field list lands in the log.
     */
    const inspectModel = function (path) {
        return function () {
            const model = resolve(path);
            let keys = [];
            let pairs = [];

            if (model === null || model === undefined) { return { status: WARN, detail: "absent (not in a session yet?)" }; }

            if (typeof model !== "object") { return { status: PARTIAL, detail: "not an object: typeof " + typeof model }; }

            try {
                keys = Object.keys(model);
            } catch (e) {
                return { status: WARN, detail: "cannot enumerate" };
            }

            if (!keys.length) { return { status: WARN, detail: "0 fields (not populated yet)" }; }

            pairs = keys.map(function (k) { return k + "=" + previewValue(model[k]); });

            return { status: YES, detail: keys.length + " fields -- " + pairs.join(", ") };
        };
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

    /**
     * Actually open a WebSocket to a loopback port. This upgrades "the constructor
     * exists" to "the socket stack initiates a real TCP connection", without touching
     * any external service. Nothing listens on the port, so we expect a fast refuse
     * (error / close) -- still proof the stack is live. An `open` would need a listener;
     * a full round-trip needs a real endpoint (a local relay you run), a separate step.
     */
    const socketConnectProbe = function (setResult) {
        if (typeof window.WebSocket !== "function") { setResult(NO, "no WebSocket"); return; }

        let settled = false;
        let socket = null;

        const finishProbe = function (status, detail) {
            if (settled) { return; }

            settled = true;

            if (socket && typeof socket.close === "function") {
                try { socket.close(); } catch (e) { log("socket close threw: " + (e && e.message || e)); }
            }

            setResult(status, detail);
        };

        const timer = window.setTimeout ? window.setTimeout(function () { finishProbe(WARN, "no open, close or error in 3s (inconclusive)"); }, 3000) : 0;
        const clear = function () { if (timer && window.clearTimeout) { window.clearTimeout(timer); } };

        try {
            // slashes from char codes so the linter's comment-stripper does not eat the line
            const url = "ws:" + String.fromCharCode(47, 47) + "127.0.0.1:47800";

            socket = new WebSocket(url);

            socket.onopen = function () {
                clear();
                finishProbe(YES, "connected -- something is listening on 127.0.0.1:47800");
            };

            socket.onerror = function () {
                clear();
                finishProbe(PARTIAL, "stack live: TCP attempted, refused (no listener) -- a real endpoint is the next step");
            };

            socket.onclose = function (e) {
                clear();
                finishProbe(PARTIAL, "stack live: socket closed" + (e && typeof e.code === "number" ? " (code " + e.code + ")" : "") + " -- needs a real endpoint");
            };
        } catch (e) {
            clear();
            finishProbe(NO, "threw: " + (e && e.message || e));
        }
    };

    /**
     * The other half of the network question: an XHR to a real TCP address. XHR to
     * `coui://` is proven (the stock UI loads templates that way), but that is the
     * resource-request callback, not a socket. This goes to the same loopback port
     * `tools/ws_echo.py` listens on, which answers plain HTTP with a 200 as well as
     * doing WebSocket handshakes -- so the listener's terminal says whether the request
     * ever left the page, exactly as it does for the socket probe.
     */
    const xhrConnectProbe = function (setResult) {
        const XHR = window.XMLHttpRequest;

        if (typeof XHR !== "function") { setResult(NO, "no XMLHttpRequest"); return; }

        let settled = false;
        let req = null;

        const finishProbe = function (status, detail) {
            if (settled) { return; }

            settled = true;

            if (req && typeof req.abort === "function") {
                try { req.abort(); } catch (e) { log("xhr abort threw: " + (e && e.message || e)); }
            }

            setResult(status, detail);
        };

        const timer = window.setTimeout ? window.setTimeout(function () { finishProbe(WARN, "no response in 3s (inconclusive)"); }, 3000) : 0;
        const clear = function () { if (timer && window.clearTimeout) { window.clearTimeout(timer); } };

        try {
            // slashes from char codes so the linter's comment-stripper does not eat the line
            const url = "http:" + String.fromCharCode(47, 47) + "127.0.0.1:47800/probe";

            req = new XHR();
            req.open("GET", url, true);

            // An onload alone proves nothing: Cohtml routes EVERY url through the host
            // resource-request callback, so a miss there calls back with a 404 that
            // looks exactly like a real HTTP reply. Only a 200 carrying the listener's
            // own marker proves the request actually reached the network.
            req.onload = function () {
                const body = String(req.responseText || "");
                const fromListener = body.indexOf("ws_echo") >= 0;
                const detail = fromListener
                    ? "200 from the listener -- a network XHR really works"
                    : "status " + req.status + ", " + body.length + " chars, not the listener -- the host resource manager answered; the request never reached the network";

                clear();
                finishProbe(fromListener && req.status === 200 ? YES : NO, detail);
            };

            req.onerror = function () {
                clear();
                finishProbe(PARTIAL, "error event -- check the listener terminal: a logged request means it left the page");
            };

            req.send(null);
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
            active("fetch(data:) round-trip", "probing data: URI...", fetchDataProbe),
            active("WebSocket connect (loopback)", "opening ws to 127.0.0.1...", socketConnectProbe),
            active("XHR to a network host (loopback)", "GET to 127.0.0.1...", xhrConnectProbe)
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
        ] },
        { cat: "Telemetry models (live)", checks: [
            f("ModelCurrentCar", inspectModel("ModelCurrentCar")),
            f("ModelTiming", inspectModel("ModelTiming")),
            f("ModelUIState", inspectModel("ModelUIState")),
            f("ModelUISessionState", inspectModel("ModelUISessionState")),
            f("ModelUIRadarState", inspectModel("ModelUIRadarState")),
            f("ModelCarsOnTrack", inspectModel("ModelCarsOnTrack")),
            f("ModelUIDriverState", inspectModel("ModelUIDriverState")),
            f("ModelLeaderboard", inspectModel("ModelLeaderboard"))
        ] }
    ];

    /** The checks flattened in render order, so row N is CHECKS[N]. */
    const CHECKS = [];

    CATEGORIES.forEach(function (category) {
        category.checks.forEach(function (check) { CHECKS.push(check); });
    });

    // ---- model recorder ------------------------------------------------------------

    /**
     * The recorder writes what the HUD models do over a session to the game log, so the
     * research behind an app (ACEAppResearch/research/*.md) can be checked against the
     * game: every change of the slow fields, a summary at every lap boundary, calibration
     * pairs of raw against normalized values, the g vector at the first hard-brake and
     * hard-steer frame of a lap, refuelling as litres per second, the clock against the
     * wall clock, and a heartbeat and a full leaderboard dump on fixed intervals.
     *
     * It is a setting ("Record HUD models to the log") and a button, off by default, and
     * it runs on this panel's frame loop; because the loader starts the app on every HUD
     * page load, a recording carries on through Escape and resume, which a console
     * snippet cannot. Everything it writes carries the "rec:" tag after the app prefix.
     */
    const SETTING_RECORD = "record";
    const REC_TAG = "rec: ";
    const REC_HEARTBEAT_MS = 10000;
    const REC_CLOCK_MS = 60000;
    const REC_RATE_WINDOW_MS = 5000;
    const REC_FULL_DUMP_MS = 30000;
    const REC_ORDER_THROTTLE_MS = 500;
    const REC_CLIP_LEVEL = 0.98;
    const REC_HARD_BRAKE = 0.8;
    const REC_HARD_STEER = 0.5;
    const REC_MIN_SPEED_KMH = 50;
    const REC_BRAKE_STEP_C = 25;
    const REC_TYRE_STEP_C = 5;
    const REC_PRESSURE_STEP = 0.5;
    const REC_REFUEL_MIN_L = 0.05;
    const REC_REFUEL_REPORT_MS = 1000;
    const REC_REFUEL_END_MS = 2000;
    const REC_LINES_AROUND = 3;
    const REC_DESCRIBE_DEPTH = 4;
    const REC_DECIMALS = 4;
    const REC_CORNERS = ["tyre_lf", "tyre_rf", "tyre_lr", "tyre_rr"];
    /**
     * The stock UI fetches a model from the engine every frame only while it is in its
     * enabled list (ksUI.Models); the leaderboards, the penalty state and the input axes
     * sit in the disabled list until a stock widget switches them on, and a hidden
     * leaderboard widget never does, so a race can pass with both leaderboards frozen
     * (measured 2026-09-23). Recording switches these on. They are never switched off
     * again: the list is not reference counted, and a stock widget may be relying on it.
     */
    const REC_MODELS = ["ModelLeaderboard", "ModelUIRealtimeLeaderboard", "ModelUIPenaltyState", "ModelUIExInputsAxii"];
    /** The engine event every UI notification (penalties, flags, race control) arrives on; the car-status kind comes in bursts and is skipped. */
    const NOTIFICATION_EVENT = "UINotification";
    const CAR_NOTIFICATION_TYPE = "UINotificationType_Car";
    const TYPE_KEY = "__Type";
    const MS_PER_S = 1000;

    /** A value as text for the log: like JSON, minus the game's __Type tags, numbers to four decimals. */
    const describe = function (value, depth) {
        const level = depth || 0;
        const t = typeof value;

        if (value === null) { return "null"; }
        if (value === undefined) { return "undefined"; }
        if (t === "number") {
            if (value !== value) { return "NaN"; }
            if (Math.floor(value) === value) { return String(value); }

            return String(parseFloat(value.toFixed(REC_DECIMALS)));
        }
        if (t === "boolean") { return String(value); }
        if (t === "string") { return "\"" + value + "\""; }
        if (t !== "object") { return t; }
        if (level >= REC_DESCRIBE_DEPTH) { return Array.isArray(value) ? "[...]" : "{...}"; }
        if (Array.isArray(value)) {
            return "[" + value.map(function (item) { return describe(item, level + 1); }).join(",") + "]";
        }

        const parts = [];

        Object.keys(value).forEach(function (key) {
            if (key !== TYPE_KEY) { parts.push(key + ":" + describe(value[key], level + 1)); }
        });

        return "{" + parts.join(",") + "}";
    };

    const recLog = function (text) { log(REC_TAG + text); };

    const pickFields = function (source, names) {
        const out = {};

        if (!source) { return null; }

        names.forEach(function (name) { out[name] = source[name]; });

        return out;
    };

    const stat = function () { return { min: Infinity, max: -Infinity, n: 0 }; };

    const feed = function (s, v) {
        if (typeof v !== "number" || v !== v) { return; }
        if (v < s.min) { s.min = v; }
        if (v > s.max) { s.max = v; }

        s.n += 1;
    };

    const statText = function (s) { return s.n ? describe(s.min) + ".." + describe(s.max) : "-"; };

    /** Log when `value` changes; `context` rides along on the line without counting as a change. */
    const watch = function (rec, key, value, label, context) {
        const text = describe(value);

        if (rec.last[key] === text) { return; }

        const first = !(key in rec.last);

        rec.last[key] = text;
        recLog((first ? "initial " : "changed ") + label + ": " + text + (context ? " at " + describe(context) : ""));
    };

    /** Count how often a model's signature changes inside the rate window. */
    const bump = function (rec, model, signature) {
        const key = "sig_" + model;

        if (rec.last[key] === signature) { return; }

        rec.last[key] = signature;
        rec.rates[model] = (rec.rates[model] || 0) + 1;
    };

    const note = function (bag, value) {
        const k = describe(value);

        bag[k] = (bag[k] || 0) + 1;
    };

    const newLap = function (now, fuel) {
        const corners = {};

        REC_CORNERS.forEach(function (c) {
            corners[c] = {
                bt: stat(), bn: stat(), bp: stat(), tt: stat(), tn: stat(), tl: stat(), tc: stat(), tr: stat(),
                nl: stat(), nc: stat(), nr: stat(), pr: stat(), pn: stat(), slip: stat(), lock: 0
            };
        });

        return {
            startedAt: now, frames: 0, ffb: stat(), ffbClip: 0, ffbOver: 0, ffbChanges: 0, ffbLast: null,
            g: { x: stat(), y: stat(), z: stat() }, steerDeg: stat(), steerPct: stat(), corners: corners,
            brakeSample: false, steerSample: false, fuelAtStart: fuel
        };
    };

    const recCreate = function () {
        return {
            running: false,
            startedAt: 0,
            frames: 0,
            lastHeartbeat: 0,
            lastClock: 0,
            lastFullDump: 0,
            orderChanges: 0,
            orderLoggedAt: 0,
            last: {},           // last seen text of each slow field, by key
            lap: null,          // per-lap accumulators
            rates: {},          // per-model change counters in the current window
            ratesText: "",
            rateWindowAt: 0,
            seen: { state: {}, color_override: {}, car_location: {}, rt_car_location: {}, lb_car_location: {} },
            calib: {},          // last bucket per corner per quantity
            pitFuel: null,      // refuelling bookkeeping while in the pit lane
            lapTimePrev: -1,
            notices: null       // engine.on handle for UINotification while recording
        };
    };

    /** A UI notification, whole, with where in the lap it arrived: the record a penalty rule is built from. */
    const onNotice = function (rec, message) {
        const car = window.ModelCurrentCar;

        if (!message || message.type === CAR_NOTIFICATION_TYPE) { return; }

        recLog("NOTICE " + describe(message) + " at " + describe({ npos: car ? car.npos : undefined, lapMs: car ? car.current_lap_time_ms : undefined,
            location: car ? car.car_location : undefined, invalid: window.ModelTiming ? window.ModelTiming.invalid : undefined }));
    };

    const listenForNotices = function (rec) {
        if (rec.notices || !window.engine || typeof window.engine.on !== "function") { return; }

        rec.notices = window.engine.on(NOTIFICATION_EVENT, function (message) { onNotice(rec, message); });
    };

    const stopListeningForNotices = function (rec) {
        if (rec.notices && typeof rec.notices.clear === "function") { rec.notices.clear(); }

        rec.notices = null;
    };

    const lapSummary = function (rec, car, now, why) {
        const L = rec.lap;

        if (!L) { return; }

        const secs = (now - L.startedAt) / MS_PER_S;

        recLog("---- lap summary (" + why + "): " + secs.toFixed(1) + " s, " + L.frames + " frames, " + (L.frames / (secs || 1)).toFixed(1) + " fps");
        recLog("ffb_strength " + statText(L.ffb) + " changes=" + L.ffbChanges + " frames>=" + REC_CLIP_LEVEL + ": " + L.ffbClip
            + " frames>1.0: " + L.ffbOver + " multiplier=" + describe(car ? car.car_ffb_mupliplier : undefined));
        recLog("g_forces x " + statText(L.g.x) + " y " + statText(L.g.y) + " z " + statText(L.g.z));
        recLog("steer_degrees " + statText(L.steerDeg) + " steering_percent " + statText(L.steerPct)
            + " car_steer_lock=" + describe(car ? car.car_steer_lock : undefined) + " input_steer_lock=" + describe(car ? car.input_steer_lock : undefined));
        recLog("fuel at lap start=" + describe(L.fuelAtStart) + " now=" + describe(car ? car.fuel_liter_current_quantity : undefined)
            + " used=" + describe(car ? car.fuel_liter_used : undefined) + " per_lap=" + describe(car ? car.fuel_liter_per_lap : undefined)
            + " laps_possible=" + describe(car ? car.laps_possible_with_fuel : undefined));
        REC_CORNERS.forEach(function (c) {
            const s = L.corners[c];

            recLog(c + " brakeC " + statText(s.bt) + " brakeNorm " + statText(s.bn) + " brakePress " + statText(s.bp)
                + " | tyreC " + statText(s.tt) + " core.n " + statText(s.tn) + " L/C/R C " + statText(s.tl) + " " + statText(s.tc) + " " + statText(s.tr)
                + " L/C/R n " + statText(s.nl) + " " + statText(s.nc) + " " + statText(s.nr) + " | press " + statText(s.pr) + " press.n " + statText(s.pn)
                + " | slip " + statText(s.slip) + " lockFrames=" + s.lock);
        });
        recLog("seen state=" + describe(rec.seen.state) + " color_override=" + describe(rec.seen.color_override)
            + " car_location(car)=" + describe(rec.seen.car_location) + " rt.car_location=" + describe(rec.seen.rt_car_location)
            + " lb.car_location=" + describe(rec.seen.lb_car_location));
    };

    /** One (raw, normalized) pair per bucket of the raw value, so the mapping can be fitted. */
    const calibrate = function (rec, corner, kind, raw, normalized, step) {
        if (typeof raw !== "number" || typeof normalized !== "number") { return; }

        const key = corner + "." + kind;
        const bucket = Math.floor(raw / step);

        if (rec.calib[key] === bucket) { return; }

        rec.calib[key] = bucket;
        recLog("calib " + key + ": raw=" + describe(raw) + " normalized=" + describe(normalized));
    };

    const flushOrder = function (rec, now, why) {
        if (rec.orderChanges > 0 && ("rt_order" in rec.last)) {
            recLog("realtime order now (" + why + "): " + rec.last.rt_order + " [" + rec.orderChanges + " reorders since the last line]");
            rec.orderChanges = 0;
            rec.orderLoggedAt = now;
        }
    };

    const heartbeat = function (rec, now, car, timing, rt, lb, cot) {
        recLog("== heartbeat t+" + ((now - rec.startedAt) / MS_PER_S).toFixed(0) + "s frames=" + rec.frames);
        recLog("car: " + describe(pickFields(car, ["speed", "gear", "rpm", "npos", "npos_perc", "current_lap_time_ms", "predicted_lap_time_ms",
            "delta_time_ms", "delta_time_ms_ui", "delta_time_drivername", "car_location", "is_player_car", "has_focused_car", "ffb_strength",
            "steering_percent", "steer_degrees", "g_forces", "gas_percent", "brake_percent", "air_temperature_c", "fuel_liter_current_quantity",
            "fuel_liter_per_lap", "instantaneous_fuel_liter_per_km", "laps_possible_with_fuel"])));
        recLog("timing: " + describe(timing));
        recLog("input axes: " + describe(window.ModelUIExInputsAxii));
        recLog("delta pair: delta_time_ms=" + describe(car ? car.delta_time_ms : undefined) + " delta_current=" + describe(timing ? timing.delta_current : undefined)
            + " delta_current_p=" + describe(timing ? timing.delta_current_p : undefined) + " delta_last_p=" + describe(timing ? timing.delta_last_p : undefined));

        if (rt && rt.lines) {
            let f = -1;

            rt.lines.forEach(function (line, i) { if (line.focused) { f = i; } });

            const from = Math.max(0, f - REC_LINES_AROUND);

            recLog("realtime lines=" + rt.lines.length + " focusedIndex=" + f + " around: " + describe(rt.lines.slice(from, from + 2 * REC_LINES_AROUND + 1)));
        } else {
            recLog("realtime leaderboard: missing");
        }

        if (lb && lb.lines) {
            recLog("leaderboard lines=" + lb.lines.length + " first4: " + describe(lb.lines.slice(0, 4).map(function (l) {
                return pickFields(l, ["pos", "car_number", "car_location", "time_diff", "last_lap_time", "best_lap_time", "total_laps", "num_pits",
                    "state", "color_override", "tyre_compound", "mandatory_pitstops_countdown"]);
            })));
        } else {
            recLog("leaderboard: missing");
        }

        if (cot && cot.cars_on_track) {
            let mine = null;

            cot.cars_on_track.forEach(function (c) { if (c.is_focused) { mine = c; } });
            recLog("cars_on_track n=" + cot.cars_on_track.length + " focused=" + describe(mine)
                + " offsets=" + describe(pickFields(cot, ["focused_car_angle", "trackmap_offset_x", "trackmap_offset_y"])));
        } else {
            recLog("cars on track: missing");
        }

        if (rec.ratesText) { recLog("changes per " + (REC_RATE_WINDOW_MS / MS_PER_S) + " s window (last full window): " + rec.ratesText); }
    };

    /** Every line of every leaderboard model, compact: lapped cars, pit cars and the far end of the field too. */
    const fullDump = function (rec, now, rt, lb, cot, radar) {
        recLog("== full dump t+" + ((now - rec.startedAt) / MS_PER_S).toFixed(0) + "s");

        if (rt && rt.lines) {
            recLog("realtime all: " + describe(rt.lines.map(function (l) {
                return [l.pos, l.car_number, l.focused ? "F" : "", l.lapped, l.time_gap, l.car_location, l.lap_count, l.state, l.color_override,
                    l.mandatory_pitstops_countdown, l.penalties, l.racePosition];
            })) + " (pos, number, focused, lapped, time_gap, car_location, lap_count, state, color_override, mandatory_pitstops_countdown, penalties, racePosition)");
        }

        if (lb && lb.lines) {
            recLog("leaderboard all: " + describe(lb.lines.map(function (l) {
                return [l.pos, l.car_number, l.focused ? "F" : "", l.time_diff, l.total_time, l.total_laps, l.car_location, l.state, l.color_override,
                    l.num_pits, l.mandatory_pitstops_countdown, l.last_lap_time, l.best_lap_time, l.tyre_compound, l.penalties];
            })) + " (pos, number, focused, time_diff, total_time, total_laps, car_location, state, color_override, num_pits, mandatory_pitstops_countdown, last, best, tyre_compound, penalties)");
        }

        if (cot && cot.cars_on_track) {
            recLog("cars_on_track all: " + describe(cot.cars_on_track.map(function (c) {
                return [c.car_number, c.car_position, c.is_focused ? "F" : "", c.coord_x, c.coord_y, c.car_laps_from_leader, c.in_pit, c.car_angle, c.multiplier];
            })) + " (number, position, focused, x, y, laps_from_leader, in_pit, angle, multiplier)");
        }

        if (radar) {
            recLog("radar: " + describe(pickFields(radar, ["is_visible", "opponents_num", "opacity", "max_opponent_opacity", "left_sign", "right_sign"]))
                + " opponents=" + describe(radar.opponents_data));
        }
    };

    const recordTyres = function (rec, L, car) {
        REC_CORNERS.forEach(function (c) {
            const ty = car[c];
            const s = L.corners[c];

            if (!ty) { return; }

            feed(s.bt, ty.brake_temperature_c); feed(s.bn, ty.brake_normalized_temperature); feed(s.bp, ty.brake_pressure);
            feed(s.tt, ty.tyre_temperature_c); feed(s.tn, ty.tyre_normalized_temperature_core);
            feed(s.tl, ty.tyre_temperature_left); feed(s.tc, ty.tyre_temperature_center); feed(s.tr, ty.tyre_temperature_right);
            feed(s.nl, ty.tyre_normalized_temperature_left); feed(s.nc, ty.tyre_normalized_temperature_center); feed(s.nr, ty.tyre_normalized_temperature_right);
            feed(s.pr, ty.tyre_pression); feed(s.pn, ty.tyre_normalized_pressure); feed(s.slip, ty.slip);

            if (ty.lock) { s.lock += 1; }

            calibrate(rec, c, "brake", ty.brake_temperature_c, ty.brake_normalized_temperature, REC_BRAKE_STEP_C);
            calibrate(rec, c, "tyreCore", ty.tyre_temperature_c, ty.tyre_normalized_temperature_core, REC_TYRE_STEP_C);
            calibrate(rec, c, "tyreLeft", ty.tyre_temperature_left, ty.tyre_normalized_temperature_left, REC_TYRE_STEP_C);
            calibrate(rec, c, "pressure", ty.tyre_pression, ty.tyre_normalized_pressure, REC_PRESSURE_STEP);
        });
    };

    /** Refuelling in the pit lane: one line per second of rise and one when it ends. */
    const recordRefuel = function (rec, now, car) {
        const inPits = car.car_location === "Pitlane";
        const litres = car.fuel_liter_current_quantity;
        const pitTime = car.pit_info ? car.pit_info.time_in_pits : undefined;

        if (inPits && typeof litres === "number") {
            if (!rec.pitFuel) {
                rec.pitFuel = { enteredAt: now, entered: litres, riseAt: 0, riseFrom: 0, last: litres, lastAt: now, reportedAt: 0 };
                recLog("pit lane entered with fuel=" + describe(litres) + " time_in_pits=" + describe(pitTime));

                return;
            }

            const F = rec.pitFuel;

            if (litres > F.last + REC_REFUEL_MIN_L) {
                if (!F.riseAt) {
                    F.riseAt = now;
                    F.riseFrom = F.last;
                    recLog("REFUEL started at fuel=" + describe(F.last) + " time_in_pits=" + describe(pitTime));
                }

                F.last = litres;
                F.lastAt = now;

                if (now - F.reportedAt >= REC_REFUEL_REPORT_MS) {
                    const dt = (now - F.riseAt) / MS_PER_S;

                    F.reportedAt = now;
                    recLog("REFUEL: " + describe(F.riseFrom) + " -> " + describe(litres) + " L in " + dt.toFixed(2) + " s = " + describe((litres - F.riseFrom) / (dt || 1)) + " L/s");
                }
            } else if (F.riseAt && now - F.lastAt > REC_REFUEL_END_MS) {
                const dt = (F.lastAt - F.riseAt) / MS_PER_S;

                recLog("REFUEL ended: " + describe(F.riseFrom) + " -> " + describe(F.last) + " L in " + dt.toFixed(2) + " s = "
                    + describe((F.last - F.riseFrom) / (dt || 1)) + " L/s time_in_pits=" + describe(pitTime));
                F.riseAt = 0;
            }
        } else if (rec.pitFuel && !inPits) {
            const F = rec.pitFuel;

            if (F.riseAt) {
                recLog("REFUEL ended (left pit lane): " + describe(F.riseFrom) + " -> " + describe(F.last) + " L in " + ((F.lastAt - F.riseAt) / MS_PER_S).toFixed(2) + " s");
            }

            recLog("pit lane left with fuel=" + describe(litres) + " after " + ((now - F.enteredAt) / MS_PER_S).toFixed(1) + " s (entered with " + describe(F.entered) + ")");
            rec.pitFuel = null;
        }
    };

    /** The slow fields: a line per change, with the context that places it in the lap. */
    const recordChanges = function (rec, now, car, timing, session, rt, lb, cot, lapMs) {
        const lf = car.low_frequency;

        if (timing) {
            watch(rec, "splits", { splits: timing.splits, splits_p: timing.splits_p, invalid: timing.invalid }, "timing.splits", { npos: car.npos, lapMs: lapMs });
            watch(rec, "timing_rest", pickFields(timing, ["last", "delta_last", "delta_last_p", "best", "ideal", "total", "invalid"]), "timing last/best/ideal/total/invalid");

            if (typeof timing.current === "string" && !("curfmt" in rec.last)) {
                rec.last.curfmt = "1";
                recLog("timing.current format sample: " + describe(timing.current) + " delta_current=" + describe(timing.delta_current));
            }
        }

        watch(rec, "location", car.car_location, "car_location", { time_in_pits: car.pit_info ? car.pit_info.time_in_pits : undefined, npos: car.npos, lapMs: lapMs });
        watch(rec, "pit_info", car.pit_info, "pit_info");
        watch(rec, "lowfreq", pickFields(lf, ["total_lap_count", "current_pos", "total_drivers", "last_laptime_ms", "best_laptime_ms", "is_last_lap",
            "mandatory_pitstops_done", "race_cut_gained_time_ms", "race_cut_current_delta", "performance_mode_name", "flags", "distance_to_deadline"]),
            "low_frequency", { lapMs: lapMs, npos: car.npos, time_left_ms: session ? session.time_left_ms : undefined });
        watch(rec, "driverstate", window.ModelUIDriverState, "ModelUIDriverState");
        watch(rec, "penaltystate", window.ModelUIPenaltyState, "ModelUIPenaltyState");
        watch(rec, "wrongway", { is_wrong_way: car.is_wrong_way, control_lock_time: car.control_lock_time, is_drs_available: car.is_drs_available }, "wrong way / control lock / drs");
        watch(rec, "cleared", car.cleared_mandatory_pitstops_count, "cleared_mandatory_pitstops_count");
        watch(rec, "ffbmul", car.car_ffb_mupliplier, "car_ffb_mupliplier");
        watch(rec, "perlap", car.fuel_liter_per_lap, "fuel_liter_per_lap",
            { laps_possible: car.laps_possible_with_fuel, used: car.fuel_liter_used, quantity: car.fuel_liter_current_quantity, lapMs: lapMs, location: car.car_location });
        watch(rec, "air", car.air_temperature_c, "air_temperature_c");
        watch(rec, "compounds", { front: car.tyre_lf ? car.tyre_lf.tyre_compound_front : undefined, rear: car.tyre_lf ? car.tyre_lf.tyre_compound_rear : undefined }, "tyre compounds");

        if (session) {
            watch(rec, "pitwindow", pickFields(session, ["pitstop_window_ranges", "current_pitstop_window_index", "is_current_pitstop_window_open",
                "pitstop_window_time_ms", "pitstop_window_time", "pitstop_window_requires_tyre_change", "pitstop_window_requires_refuelling"]),
                "pit window", { time_left_ms: session.time_left_ms, lapMs: lapMs });
            watch(rec, "session", pickFields(session, ["session_name", "event_id", "session_id", "phase_name", "initial_grip", "initial_weather", "total_lap", "current_lap",
                "lap_length_km", "end_session_flag", "lights_on", "lights_mode"]), "session");
            watch(rec, "timeleft_str", session.time_left, "session.time_left (string)");
            watch(rec, "timeleft_zero", typeof session.time_left_ms === "number" && session.time_left_ms <= 0, "session clock at or below zero",
                { time_left_ms: session.time_left_ms, is_last_lap: lf ? lf.is_last_lap : undefined, total_lap_count: lf ? lf.total_lap_count : undefined,
                    current_lap: session.current_lap, total_lap: session.total_lap, lapMs: lapMs, npos: car.npos, phase: session.phase_name });
            watch(rec, "nextsession", pickFields(session, ["has_next_session", "time_to_next_session", "wait_time", "show_waiting_for_players", "disconnected_from_server"]),
                "next session / waiting");
        }

        if (rt && rt.lines) {
            // reorders: at most one line per half second, carrying the count it stands for
            const order = rt.lines.map(function (l) { return l.car_number + (l.focused ? "*" : "") + ":" + l.pos + ":" + l.lapped; }).join(" ");

            if (rec.last.rt_order !== order) {
                const first = !("rt_order" in rec.last);

                rec.last.rt_order = order;
                rec.orderChanges += 1;

                if (first || now - rec.orderLoggedAt >= REC_ORDER_THROTTLE_MS) {
                    recLog((first ? "initial " : "changed ") + "realtime order (number*focused:pos:lapped): " + order
                        + (rec.orderChanges > 1 ? " [" + rec.orderChanges + " reorders since the last line]" : "")
                        + " at " + describe({ lapMs: lapMs, npos: car.npos, phase: session ? session.phase_name : undefined }));
                    rec.orderLoggedAt = now;
                    rec.orderChanges = 0;
                }
            }

            bump(rec, "realtime_gap", rt.lines.map(function (l) { return l.time_gap; }).join("|"));
            rt.lines.forEach(function (l) { note(rec.seen.state, l.state); note(rec.seen.color_override, l.color_override); note(rec.seen.rt_car_location, l.car_location); });
        }

        if (lb && lb.lines) {
            bump(rec, "leaderboard", lb.lines.map(function (l) { return l.pos + l.time_diff + l.car_location; }).join("|"));
            lb.lines.forEach(function (l) { note(rec.seen.lb_car_location, l.car_location); });
        }

        if (cot && cot.cars_on_track) {
            let mine = null;

            cot.cars_on_track.forEach(function (c) { if (c.is_focused) { mine = c; } });
            bump(rec, "cars_on_track", mine ? mine.coord_x + "," + mine.coord_y : "");
        }

        note(rec.seen.car_location, car.car_location);
        bump(rec, "npos", car.npos);
        bump(rec, "ffb", car.ffb_strength);
        bump(rec, "tyre_temp", car.tyre_lf ? car.tyre_lf.tyre_temperature_c : "");
        bump(rec, "brake_temp", car.tyre_lf ? car.tyre_lf.brake_temperature_c : "");
        bump(rec, "g_forces", car.g_forces ? car.g_forces.x + "," + car.g_forces.z : "");
        bump(rec, "fuel", car.fuel_liter_current_quantity);
        bump(rec, "delta_time_ms", car.delta_time_ms);
        bump(rec, "timing.current", timing ? timing.current : "");
        bump(rec, "frames", rec.frames);

        if (now - rec.rateWindowAt > REC_RATE_WINDOW_MS) {
            if (rec.rateWindowAt) { rec.ratesText = describe(rec.rates); }

            rec.rateWindowAt = now;
            rec.rates = {};
        }
    };

    /** One frame of recording; `now` is the frame clock in ms. */
    const recFrame = function (rec, now) {
        const car = window.ModelCurrentCar;
        const timing = window.ModelTiming;
        const session = window.ModelUISessionState;
        const rt = window.ModelUIRealtimeLeaderboard;
        const lb = window.ModelLeaderboard;
        const cot = window.ModelCarsOnTrack;
        const radar = window.ModelUIRadarState;

        rec.frames += 1;

        if (!car) {
            if (now - rec.lastHeartbeat > REC_HEARTBEAT_MS) {
                rec.lastHeartbeat = now;
                recLog("ModelCurrentCar missing");
            }

            return;
        }

        if (!rec.lap) {
            rec.lap = newLap(now, car.fuel_liter_current_quantity);
            recLog("start: " + describe(pickFields(car, ["car_location", "npos", "current_lap_time_ms", "fuel_liter_current_quantity", "g_forces", "steer_degrees",
                "steering_percent", "car_steer_lock", "input_steer_lock", "car_ffb_mupliplier", "speed", "focused_car_id", "player_car_id", "is_player_car"])));
            recLog("models present: " + describe({ timing: Boolean(timing), session: Boolean(session), realtime: Boolean(rt && rt.lines), leaderboard: Boolean(lb && lb.lines),
                cars_on_track: Boolean(cot && cot.cars_on_track), radar: Boolean(radar), driver_state: Boolean(window.ModelUIDriverState) }));
        }

        const lapMs = car.current_lap_time_ms;

        // a lap boundary is the lap clock going backwards
        if (typeof lapMs === "number" && rec.lapTimePrev >= 0 && lapMs < rec.lapTimePrev) {
            recLog("LAP BOUNDARY: lap clock " + rec.lapTimePrev + " -> " + lapMs + " npos=" + describe(car.npos) + " location=" + describe(car.car_location)
                + " timing=" + describe(timing) + " lowfreq=" + describe(pickFields(car.low_frequency, ["total_lap_count", "last_laptime_ms", "best_laptime_ms", "is_last_lap"])));
            lapSummary(rec, car, now, "lap boundary");
            rec.lap = newLap(now, car.fuel_liter_current_quantity);
        }

        rec.lapTimePrev = typeof lapMs === "number" ? lapMs : -1;

        const L = rec.lap;

        L.frames += 1;
        recordChanges(rec, now, car, timing, session, rt, lb, cot, lapMs);

        const ffb = car.ffb_strength;

        feed(L.ffb, ffb);

        if (typeof ffb === "number") {
            if (ffb !== L.ffbLast) { L.ffbChanges += 1; L.ffbLast = ffb; }
            if (Math.abs(ffb) >= REC_CLIP_LEVEL) { L.ffbClip += 1; }
            if (Math.abs(ffb) > 1) { L.ffbOver += 1; }
        }

        if (car.g_forces) { feed(L.g.x, car.g_forces.x); feed(L.g.y, car.g_forces.y); feed(L.g.z, car.g_forces.z); }

        feed(L.steerDeg, car.steer_degrees);
        feed(L.steerPct, car.steering_percent);

        if (!L.brakeSample && car.brake_percent >= REC_HARD_BRAKE && car.speed > REC_MIN_SPEED_KMH) {
            L.brakeSample = true;
            recLog("SIGN hard brake: brake=" + describe(car.brake_percent) + " speed=" + car.speed + " g=" + describe(car.g_forces)
                + " slip lf/rf=" + describe(car.tyre_lf ? car.tyre_lf.slip : undefined) + "/" + describe(car.tyre_rf ? car.tyre_rf.slip : undefined));
        }

        if (!L.steerSample && Math.abs(car.steering_percent) >= REC_HARD_STEER && car.speed > REC_MIN_SPEED_KMH) {
            L.steerSample = true;
            recLog("SIGN hard steer: steering_percent=" + describe(car.steering_percent) + " steer_degrees=" + car.steer_degrees + " speed=" + car.speed
                + " g=" + describe(car.g_forces) + " (note which way the car was turning)");
        }

        recordTyres(rec, L, car);
        recordRefuel(rec, now, car);

        if (now - rec.lastClock > REC_CLOCK_MS) {
            rec.lastClock = now;
            recLog("CLOCK wall=" + new Date().toISOString() + " car=" + car.time_of_day_hours + ":" + car.time_of_day_minutes + ":" + car.time_of_day_seconds
                + " session=" + (session ? session.time_of_day_hours + ":" + session.time_of_day_minutes + ":" + session.time_of_day_seconds : "?")
                + " time_left_ms=" + describe(session ? session.time_left_ms : undefined) + " event_id=" + describe(session ? session.event_id : undefined) + " session_id=" + describe(session ? session.session_id : undefined) + " air=" + describe(car.air_temperature_c)
                + " initial_weather=" + describe(session ? session.initial_weather : undefined) + " initial_grip=" + describe(session ? session.initial_grip : undefined));
        }

        if (now - rec.lastHeartbeat > REC_HEARTBEAT_MS) {
            rec.lastHeartbeat = now;
            flushOrder(rec, now, "heartbeat");
            heartbeat(rec, now, car, timing, rt, lb, cot);
        }

        if (now - rec.lastFullDump > REC_FULL_DUMP_MS) {
            rec.lastFullDump = now;
            fullDump(rec, now, rt, lb, cot, radar);
        }
    };

    /** Ask the stock UI to stream the models it leaves off until a widget wants them. */
    const enableModels = function () {
        const models = window.ksUI && window.ksUI.Models;

        if (!models || typeof models.enable !== "function") {
            recLog("ksUI.Models not present: the on-demand models stay as the page left them");

            return;
        }

        REC_MODELS.forEach(function (name) {
            if (models.Disabled && models.Disabled.indexOf(name) >= 0) {
                models.enable(name);
                recLog("enabled model " + name);
            }
        });
    };

    const recStart = function (rec, now) {
        if (rec.running) { return; }

        rec.running = true;
        rec.startedAt = now;
        enableModels();
        listenForNotices(rec);
        recLog("recording the HUD models from this page load (" + new Date().toISOString() + "); the Record button or the setting stops it");
    };

    const recStop = function (rec, now, why) {
        if (!rec.running) { return; }

        rec.running = false;
        stopListeningForNotices(rec);
        flushOrder(rec, now, why);
        lapSummary(rec, window.ModelCurrentCar, now, why);
        fullDump(rec, now, window.ModelUIRealtimeLeaderboard, window.ModelLeaderboard, window.ModelCarsOnTrack, window.ModelUIRadarState);
        recLog("stopped (" + why + ") after " + rec.frames + " frames");
    };

    /** The Record button shows the recorder's state; the setting is the truth. */
    const showRecording = function (state, on) {
        if (state.recordButton) { state.recordButton.classList.toggle(CLASS.on, on); }
    };

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

        // upper-cased here: the engine ignores text-transform and warns about it every frame
        return el("div", CLASS.cat)
            + el("div", CLASS.catName) + category.cat.toUpperCase() + close("div")
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
                + button("record", "Record models")
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
        const stored = me.recall("filters", null);

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
            run: 0,                     // which run the results belong to; see runAll
            scroller: null,             // ACEUIAppLoader.scroll handle (wheel, thumb, track)
            laidOut: false,             // the scrollbar has been sized once layout exists
            bag: null,                  // every listener this panel added, for detach
            ui: null,                   // me.panel handle: the panel and its frame loop
            rec: recCreate(),           // the model recorder; runs while the setting is on
            recordButton: root.querySelector("[" + ACT_ATTR + "=\"record\"]"),
            unsubscribe: null,          // settings.onChange handle
            frameNow: 0                 // the last frame clock the panel gave us
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

        log(label + " on " + ACEUIAppLoader.page + ": " + counts.yes + " yes, " + counts.no + " no, " + counts.partial + " partial, " + counts.warn + " warn");

        const missing = names(state.results, NO);
        const partial = names(state.results, PARTIAL);

        if (missing.length) { log("missing: " + missing.join(", ")); }

        if (partial.length) { log("partial: " + partial.join(", ")); }
    };

    const logAll = function (state) {
        log("--- full report (" + CHECKS.length + " checks, " + ACEUIAppLoader.page + ") ---");

        state.results.forEach(function (r) {
            if (r) { log(r.name + " = " + r.status + " -- " + r.detail); }
        });
    };

    const record = function (state, index, name, status, detail) {
        state.results[index] = { name: name, status: status, detail: detail };
    };

    const runAll = function (state) {
        /**
         * Each run is numbered. Three of these checks are asynchronous and slow on purpose
         * -- the socket probe waits up to three seconds for a refusal -- so clicking
         * Re-run leaves the previous run's probes in flight. Their callbacks close over
         * this state and would write their old answer into a fresh row, and decrement a
         * pending count that is no longer theirs: the "probe complete" summary then fires
         * early, or never, depending on the order they land in.
         */
        const generation = (state.run || 0) + 1;

        state.run = generation;
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
                    if (state.run !== generation) { return; }

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

    // ---- scrolling ------------------------------------------------------------------

    /** Re-place the thumb after the list changed; the scroller owns the geometry. */
    const syncScrollbar = function (state) {
        state.scroller.sync();
    };

    const scrollBy = function (state, dy) {
        state.scroller.scrollBy(dy);
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
        me.remember("filters", store);

        applyFilters(state);
    };

    const onSearchChange = function (state) {
        const query = String(state.search.value || "").trim().toLowerCase();

        if (query === state.query) { return; }

        state.query = query;
        applyFilters(state);
    };

    // ---- rendering -----------------------------------------------------------------

    /** One animation frame: size the scrollbar once layout exists, and record if asked. The panel settles itself. */
    const tick = function (state, now) {
        state.frameNow = now;

        if (!state.laidOut && state.body.clientHeight > 0) {
            state.laidOut = true;
            syncScrollbar(state);
        }

        if (state.rec.running) { recFrame(state.rec, now); }
    };

    // ---- lifecycle -----------------------------------------------------------------

    const onClick = function (state, e) {
        const btn = ACEUIAppLoader.closestWithAttribute(e.target, ACT_ATTR, state.root);

        if (btn) {
            const act = btn.getAttribute(ACT_ATTR);

            if (act === "rerun") {
                log("re-run requested");
                runAll(state);
            } else if (act === "log") {
                logAll(state);
            } else if (act === "record") {
                settings.set(me.name, SETTING_RECORD, !settings.get(me.name, SETTING_RECORD));
            }

            return;
        }

        const chip = ACEUIAppLoader.closestWithAttribute(e.target, FILTER_ATTR, state.root);

        if (chip) {
            const id = chip.getAttribute(FILTER_ATTR);

            setFilter(state, id, state.filters[id] === false);
        }
    };

    /**
     * What another app can ask the probe, rather than probing again for itself:
     *
     *     const probe = ACEUIAppLoader.shared.get("capabilities");
     *     if (probe && probe.status("WebSocket") === "yes") { ... }
     *
     * It is offered while the probe is attached and withdrawn when it is not, because the
     * answers live in that run's results -- there are none to give when it is switched off.
     */
    const surface = function (state) {
        return {
            checks: function () {
                return CHECKS.map(function (c) { return c.name; });
            },
            results: function () {
                return state.results.slice();
            },
            status: function (name) {
                const found = state.results.filter(function (r) { return r && r.name === name; })[0];

                return found ? found.status : null;
            }
        };
    };

    const attach = function (root) {
        const state = create(root);

        state.scroller = scrolling.attach({
            body: state.body,
            track: state.track,
            thumb: state.thumb,
            nofitClass: CLASS.nofit,
            draggingClass: CLASS.dragging,
            log: log
        });

        state.bag = ACEUIAppLoader.dom.listeners();
        state.bag.on(root, "click", function (e) { onClick(state, e); });
        state.bag.on(state.search, "input", function () { onSearchChange(state); });
        state.bag.on(state.search, "keyup", function () { onSearchChange(state); });

        state.ui = me.panel(root, function (now) { tick(state, now); });

        // the recorder is a setting, so the drawer offers it and it survives a HUD reload
        settings.define(me.name, [
            { key: SETTING_RECORD, type: "toggle", label: "Record HUD models to the log", value: false,
                hint: "every change of the slow fields, a summary per lap, calibration pairs and leaderboard dumps, tagged rec:" }
        ]);
        state.unsubscribe = settings.onChange(me.name, function (key, value) {
            if (key !== SETTING_RECORD) { return; }

            if (value) { recStart(state.rec, state.frameNow); } else { recStop(state.rec, state.frameNow, "switched off"); }

            showRecording(state, Boolean(value));
        });

        if (settings.get(me.name, SETTING_RECORD)) {
            recStart(state.rec, state.frameNow);
            showRecording(state, true);
        }

        runAll(state);
        ACEUIAppLoader.shared.register(me.name, surface(state));
        log("attached, " + CHECKS.length + " checks, lib=" + ACEUIAppLoader.VERSION);

        return state;
    };

    const detach = function (state) {
        ACEUIAppLoader.shared.unregister(me.name);
        state.ui.stop();

        if (state.unsubscribe) {
            state.unsubscribe();
            state.unsubscribe = null;
        }

        recStop(state.rec, state.frameNow, "detached");

        // kept, not nulled: the probe's own checks finish after a detach and still
        // re-filter the list, and a detached scroller is a no-op rather than a crash
        if (state.scroller) { state.scroller.detach(); }

        if (state.bag) {
            state.bag.off();
            state.bag = null;
        }
    };

    return {
        CLASS: CLASS,
        CATEGORIES: CATEGORIES,
        CHECKS: CHECKS,
        create: create,
        surface: surface,
        runAll: runAll,
        attach: attach,
        detach: detach,
        SETTING_RECORD: SETTING_RECORD,
        describe: describe,
        recCreate: recCreate,
        recFrame: recFrame
    };
}());

/* Attach to #capabilities: the loader creates it in game, the preview page carries it. */
ACEUIAppLoader.app("capabilities").mount(CapabilitiesProbe.attach, CapabilitiesProbe.detach);
