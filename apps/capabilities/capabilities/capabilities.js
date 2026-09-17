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
            ui: null                    // me.panel handle: the panel and its frame loop
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

    /** One animation frame: size the scrollbar once layout exists. The panel settles itself. */
    const tick = function (state) {
        if (!state.laidOut && state.body.clientHeight > 0) {
            state.laidOut = true;
            syncScrollbar(state);
        }
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

        state.ui = me.panel(root, function () { tick(state); });

        runAll(state);
        ACEUIAppLoader.shared.register(me.name, surface(state));
        log("attached, " + CHECKS.length + " checks, lib=" + ACEUIAppLoader.VERSION);

        return state;
    };

    const detach = function (state) {
        ACEUIAppLoader.shared.unregister(me.name);
        state.ui.stop();

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
        detach: detach
    };
}());

/* Attach to #capabilities: the loader creates it in game, the preview page carries it. */
ACEUIAppLoader.app("capabilities").mount(CapabilitiesProbe.attach, CapabilitiesProbe.detach);
