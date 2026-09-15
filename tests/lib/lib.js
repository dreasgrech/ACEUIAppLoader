/*
 * Loads the ACEUIModLoader library into a browser page (harnesses, previews) exactly
 * as build_loader.py appends it to cohtml.js: same files, same order. FILES mirrors
 * LIB_ORDER in tools/build_loader.py; a test fails when they disagree.
 *
 *   <script src="../../../ACEUIModLoader/tests/lib/lib.js"></script>
 *
 * The src/ folder is found relative to this file; `data-src="<url to src/>"`
 * on the script tag overrides that.
 */
(function () {
    const FILES = ["core", "console", "persist", "panel", "loop", "loader", "drawer"];
    const script = document.currentScript;
    const base = script.getAttribute("data-src") || script.src.replace(/tests\/lib\/lib\.js.*$/, "src/");

    FILES.forEach(function (name) {
        document.write("<script src=\"" + base + "ACEUIModLoader." + name + ".js\"><\/script>");
    });
}());
