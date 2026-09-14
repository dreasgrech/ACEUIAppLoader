/**
 * DevConsole -- loader entry point.
 *
 * Loaded by the ACEUIModLoader on hud.html after devconsole.js (order from mod.json).
 * The stylesheet is already linked by the loader. All this file does is give the
 * console a root element inside the HUD's positioning container and start it.
 */
(function () {
    const CONTAINER_SELECTOR = ".absolutecenter";
    const log = ACEUIModLoader.logger("[DevConsole]");

    const container = document.querySelector(CONTAINER_SELECTOR);

    if (!container) {
        log("no " + CONTAINER_SELECTOR + " on this page; not attaching");

        return;
    }

    if (document.getElementById(DevConsole.ROOT_ID)) {
        log("root already present; not attaching twice");

        return;
    }

    const root = document.createElement("div");

    root.id = DevConsole.ROOT_ID;
    container.appendChild(root);
    DevConsole.attach(root);
}());
