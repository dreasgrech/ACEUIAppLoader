/*
 * Test doubles and the harness helpers for browser harnesses (the loader's and every
 * app's). Include this BEFORE the library so the library's console hook wraps the
 * capturing console.
 *
 *   window.__clock.step(t)   run the animation-frame callbacks queued so far
 *   window.__log / __warn    what reached console.log / console.warn+error
 *   localStorage             in-memory, so file:// origin quirks cannot interfere
 *   window.__harness         t(name, fn), eq(a, b, what), ok(cond, what), near(a, b, eps, what),
 *                            results, finish([extraLines]) -> writes the PASS/FAIL report,
 *                            "SUMMARY n/m" and "DONE" that tools/headless.py reads
 */
(function () {
    const store = {};
    const origLog = console.log.bind(console);

    // Manual animation-frame clock: tests call __clock.step(t) to run queued callbacks.
    window.__clock = {
        queue: [],
        nextId: 1,
        cancelled: 0,
        step: function (t) {
            const run = window.__clock.queue;

            window.__clock.queue = [];
            run.forEach(function (q) { q[1](t); });
        }
    };
    window.requestAnimationFrame = function (cb) {
        const id = window.__clock.nextId;

        window.__clock.nextId += 1;
        window.__clock.queue.push([id, cb]);

        return id;
    };
    window.cancelAnimationFrame = function (id) {
        const n = window.__clock.queue.length;

        window.__clock.queue = window.__clock.queue.filter(function (q) { return q[0] !== id; });

        if (window.__clock.queue.length !== n) { window.__clock.cancelled += 1; }
    };

    Object.defineProperty(window, "localStorage", { value: {
        getItem: function (k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
        setItem: function (k, v) { store[k] = String(v); },
        removeItem: function (k) { delete store[k]; },
        clear: function () { Object.keys(store).forEach(function (k) { delete store[k]; }); }
    } });

    // Capture what reaches the *original* console, to prove the library's hook chains to it.
    window.__log = [];
    window.__warn = [];
    console.log = function () {
        const a = Array.prototype.slice.call(arguments);

        window.__log.push(a.join(" "));
        origLog.apply(null, a);
    };
    console.warn = function () { window.__warn.push(Array.prototype.slice.call(arguments).join(" ")); };
    console.error = function () { window.__warn.push(Array.prototype.slice.call(arguments).join(" ")); };

    // ---- harness helpers ----------------------------------------------------------------

    const results = [];

    const t = function (name, fn) {
        try {
            fn();
            results.push({ name: name, pass: true });
        } catch (e) {
            results.push({ name: name, pass: false, msg: String(e && e.message || e) });
        }
    };

    const eq = function (a, b, what) {
        if (a !== b) { throw new Error((what || "") + " expected " + JSON.stringify(b) + " got " + JSON.stringify(a)); }
    };

    const ok = function (c, what) {
        if (!c) { throw new Error(what || "assertion failed"); }
    };

    const near = function (a, b, eps, what) {
        if (Math.abs(a - b) > eps) { throw new Error((what || "") + " expected ~" + b + " got " + a); }
    };

    /** An element by id, created in <body> when the page does not carry it. */
    const ensure = function (id, tag) {
        let node = document.getElementById(id);

        if (!node) {
            node = document.createElement(tag);
            node.id = id;
            document.body.appendChild(node);
        }

        return node;
    };

    /** Write the report the headless runner parses; `extra` lines (diagnostics) go before the summary. */
    const finish = function (extra) {
        const passed = results.filter(function (r) { return r.pass; }).length;
        const lines = results.map(function (r) { return (r.pass ? "PASS " : "FAIL ") + r.name + (r.msg ? "  -- " + r.msg : ""); });
        const done = ensure("done", "div");

        ensure("results", "pre").textContent = lines.concat(extra || []).join("\n") + "\nSUMMARY " + passed + "/" + results.length;
        done.hidden = false;
        done.textContent = "DONE";
    };

    window.__harness = { results: results, t: t, eq: eq, ok: ok, near: near, finish: finish };
}());
