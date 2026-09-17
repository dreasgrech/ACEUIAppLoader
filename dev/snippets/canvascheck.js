/*
 * canvascheck.js -- does a canvas actually work here, and does it matter how it was made?
 * Dev console, in a session:
 *
 *     .run canvascheck
 *
 * Two apps draw with canvas 2D -- ACEUITelemetry's track map and speed trace, and the
 * profiler's frame graph -- and a canvas that yields no context fails silently: the
 * element is there, the drawing calls do nothing, and the result is an empty rectangle
 * that looks exactly like "nothing to show yet". The profiler's graph came up empty in
 * game, which is the question this answers.
 *
 * It checks the two ways an element can come into being here, because they are not
 * obviously equivalent in this engine: `document.createElement` and a markup string
 * assigned to `innerHTML`. It draws into each (a rectangle, a line, some text), and
 * reports what the engine allowed. There is no `getImageData` in this build, so nothing
 * can verify the pixels -- what it proves is that a context exists and the calls do not
 * throw, which is where an empty graph would fail.
 *
 * Everything it makes is removed again.
 */
(function () {
    const log = function (text) { console.log("[canvascheck] " + text); };

    const W = 64;
    const H = 32;

    const host = document.createElement("div");
    const made = [];

    host.style.position = "absolute";
    host.style.left = "-9999px";
    document.body.appendChild(host);

    const describe = function (label, canvas) {
        if (!canvas) {
            log(label + ": no canvas element at all");

            return;
        }

        const tag = canvas.tagName;
        const ctx = typeof canvas.getContext === "function" ? canvas.getContext("2d") : null;
        const calls = [];

        if (!ctx) {
            log(label + ": <" + tag + "> " + canvas.width + "x" + canvas.height
                + ", getContext is " + typeof canvas.getContext + " -> NO 2d CONTEXT");

            return;
        }

        try {
            ctx.fillStyle = "#44ea78";
            ctx.fillRect(0, 0, W, H);
            calls.push("fillRect");
            ctx.clearRect(2, 2, 4, 4);
            calls.push("clearRect");
            ctx.beginPath();
            ctx.moveTo(0, 0);
            ctx.lineTo(W, H);
            ctx.stroke();
            calls.push("stroke");
            ctx.fillText("x", 2, 10);
            calls.push("fillText");
        } catch (e) {
            log(label + ": drawing threw after " + calls.join(", ") + ": " + ACEUIModLoader.errorText(e));

            return;
        }

        log(label + ": <" + tag + "> " + canvas.width + "x" + canvas.height
            + ", on screen " + canvas.clientWidth + "x" + canvas.clientHeight
            + ", 2d context ok, drew " + calls.join(", "));
    };

    // 1. the way the profiler now builds it
    const created = document.createElement("canvas");

    created.width = W;
    created.height = H;
    host.appendChild(created);
    made.push(created);
    describe("createElement", created);

    // 2. the way it used to, and the way ACEUITelemetry still builds its map and trace
    const wrap = document.createElement("div");

    wrap.innerHTML = "<canvas class=\"cc-inner\" width=\"" + W + "\" height=\"" + H + "\"></canvas>";
    host.appendChild(wrap);
    made.push(wrap);
    describe("innerHTML", wrap.querySelector("canvas"));

    // 3. and what the apps on this page actually got
    const live = document.querySelectorAll("canvas");
    let withContext = 0;
    let i;

    for (i = 0; i < live.length; i += 1) {
        if (typeof live[i].getContext === "function" && live[i].getContext("2d")) { withContext += 1; }
    }

    log("on this page: " + live.length + " canvas element(s), " + withContext + " with a 2d context");

    made.forEach(function (node) {
        if (node.parentNode) { node.parentNode.removeChild(node); }
    });
    host.parentNode.removeChild(host);
    log("done -- nothing left behind");
}());
