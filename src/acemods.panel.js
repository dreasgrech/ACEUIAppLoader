/**
 * AceMods.panel -- a draggable HUD panel that remembers where it was.
 *
 * `attach(root, options)` makes `root` draggable inside its parent (the HUD's
 * `.absolutecenter`), clamped so it stays fully on screen, and persists its
 * position as fractions of the parent (resolution independent) through
 * AceMods.persist under `options.hudId` / `options.storageKey`. The mod's frame
 * loop must call `update(panel, now)` every frame until the restore has settled.
 *
 * Restore sequence, to avoid any visible jump: the root is hidden at attach; a
 * synchronous localStorage attempt places it before its first paint (localStorage
 * survives the Escape/resume reload); then, in the loop, the stock HUD store has
 * the last word as soon as it exists -- our entry, else the localStorage
 * fallback, else the stylesheet default -- or after RESTORE_WAIT_MS without a
 * HUD object. Restoring waits for layout: a zero-size parent would clamp the panel
 * into a corner.
 *
 * Elements carrying `data-nodrag` (inputs, buttons) do not start a drag.
 * Options: { hudId, storageKey, log (prefixed logger), onSaved(position) }.
 */
AceMods.panel = (function () {

    const RESTORE_WAIT_MS = 2000;
    /** Class on the root while it is being dragged (mods style it). */
    const DRAGGING_CLASS = "dragging";
    /** Attribute on descendants that must not start a drag. */
    const NO_DRAG_ATTR = "data-nodrag";
    const LOG_DECIMALS = 3;
    const HIDDEN = "hidden";
    const AUTO = "auto";

    const clamp = AceMods.clamp;
    const persist = AceMods.persist;

    const isPosition = function (pos) {
        return Boolean(pos) && typeof pos.fx === "number" && typeof pos.fy === "number";
    };

    const parentRect = function (panel) {
        return panel.root.parentElement.getBoundingClientRect();
    };

    const parentHasSize = function (panel) {
        const parent = parentRect(panel);

        return parent.width > 0 && parent.height > 0;
    };

    /** Place the panel at viewport coordinates, clamped so it stays fully inside its parent. */
    const moveTo = function (panel, clientX, clientY) {
        const root = panel.root;
        const parent = parentRect(panel);
        const x = clamp(clientX - parent.left, 0, Math.max(0, parent.width - root.offsetWidth));
        const y = clamp(clientY - parent.top, 0, Math.max(0, parent.height - root.offsetHeight));

        root.style.left = Math.round(x) + "px";
        root.style.top = Math.round(y) + "px";
        root.style.right = AUTO;
        root.style.bottom = AUTO;
    };

    /**
     * Current position as fractions of the parent, plus the pixel form the stock
     * layout code expects on every element it stores.
     */
    const currentPosition = function (panel) {
        const parent = parentRect(panel);
        const r = panel.root.getBoundingClientRect();

        return {
            fx: parent.width > 0 ? (r.left - parent.left) / parent.width : 0,
            fy: parent.height > 0 ? (r.top - parent.top) / parent.height : 0,
            x: panel.root.style.left,
            y: panel.root.style.top
        };
    };

    const positionText = function (pos) {
        return "fx=" + pos.fx.toFixed(LOG_DECIMALS) + " fy=" + pos.fy.toFixed(LOG_DECIMALS);
    };

    const savePosition = function (panel) {
        const pos = currentPosition(panel);
        const where = persist.save(panel.hudId, panel.storageKey, pos);

        panel.log("position saved " + positionText(pos) + " to " + (where.join(", ") || "nowhere"));

        if (panel.onSaved) { panel.onSaved(pos); }

        return pos;
    };

    const applyPosition = function (panel, pos, source) {
        const parent = parentRect(panel);

        moveTo(panel, parent.left + pos.fx * parent.width, parent.top + pos.fy * parent.height);
        panel.log("position restored from " + source + " " + positionText(pos));
    };

    const show = function (panel) {
        panel.root.style.visibility = "";
    };

    /** Restore is settled: show the panel where it is. */
    const finishRestore = function (panel) {
        panel.restored = true;
        show(panel);
    };

    const restoreImmediately = function (panel) {
        const fromLocal = persist.readLocal(panel.storageKey);

        if (!isPosition(fromLocal) || !parentHasSize(panel)) { return; }

        applyPosition(panel, fromLocal, "localStorage (immediate)");
        show(panel);
    };

    const maybeRestore = function (panel, now) {
        if (!parentHasSize(panel)) { return; }

        if (panel.attachedAt === 0) { panel.attachedAt = now; }

        const hudReady = persist.hudAvailable();
        const fromHud = persist.readHud(panel.hudId);

        if (isPosition(fromHud)) {
            applyPosition(panel, fromHud, "hud layout");
            finishRestore(panel);

            return;
        }

        if (!hudReady && now - panel.attachedAt < RESTORE_WAIT_MS) { return; }

        const fromLocal = persist.readLocal(panel.storageKey);

        if (isPosition(fromLocal)) {
            applyPosition(panel, fromLocal, "localStorage");
        } else {
            panel.log("no stored position (hud layout " + (hudReady ? "has no entry" : "not available") + "), keeping default");
        }

        finishRestore(panel);
    };

    /** Call every frame; cheap once the restore has settled. */
    const update = function (panel, now) {
        if (!panel.restored) { maybeRestore(panel, now); }
    };

    const onMouseDown = function (panel, e) {
        if (AceMods.closestWithAttribute(e.target, NO_DRAG_ATTR, panel.root)) { return; }

        const r = panel.root.getBoundingClientRect();

        panel.dragging = true;
        panel.moved = false;
        panel.dragOffset.x = e.clientX - r.left;
        panel.dragOffset.y = e.clientY - r.top;
        panel.root.classList.add(DRAGGING_CLASS);
    };

    const onMouseMove = function (panel, e) {
        if (!panel.dragging) { return; }

        panel.moved = true;
        moveTo(panel, e.clientX - panel.dragOffset.x, e.clientY - panel.dragOffset.y);
    };

    /** A click that never moved the panel is not a drag: nothing to save. */
    const onMouseUp = function (panel) {
        if (!panel.dragging) { return; }

        panel.dragging = false;
        panel.root.classList.remove(DRAGGING_CLASS);

        if (panel.moved) { savePosition(panel); }
    };

    const attach = function (root, options) {
        const panel = {
            root: root,
            hudId: options.hudId || null,
            storageKey: options.storageKey || null,
            log: options.log || AceMods.log,
            onSaved: options.onSaved || null,
            dragging: false,
            moved: false,               // the current drag changed the position
            dragOffset: { x: 0, y: 0 },
            handlers: null,
            attachedAt: 0,              // timestamp of the first frame after attach
            restored: false             // position restore done (or given up)
        };

        panel.handlers = {
            down: function (e) { onMouseDown(panel, e); },
            move: function (e) { onMouseMove(panel, e); },
            up: function () { onMouseUp(panel); }
        };

        root.addEventListener("mousedown", panel.handlers.down);
        window.addEventListener("mousemove", panel.handlers.move);
        window.addEventListener("mouseup", panel.handlers.up);
        document.addEventListener("mouseup", panel.handlers.up);

        // hidden until positioned; immediate attempt now, the HUD store settles it in the loop
        root.style.visibility = HIDDEN;
        restoreImmediately(panel);

        return panel;
    };

    /** Release the listeners and show the root. The DOM is left in place. */
    const detach = function (panel) {
        panel.dragging = false;
        panel.root.classList.remove(DRAGGING_CLASS);
        show(panel);

        if (panel.handlers) {
            panel.root.removeEventListener("mousedown", panel.handlers.down);
            window.removeEventListener("mousemove", panel.handlers.move);
            window.removeEventListener("mouseup", panel.handlers.up);
            document.removeEventListener("mouseup", panel.handlers.up);
            panel.handlers = null;
        }
    };

    return {
        RESTORE_WAIT_MS: RESTORE_WAIT_MS,
        DRAGGING_CLASS: DRAGGING_CLASS,
        NO_DRAG_ATTR: NO_DRAG_ATTR,
        isPosition: isPosition,
        moveTo: moveTo,
        currentPosition: currentPosition,
        savePosition: savePosition,
        update: update,
        attach: attach,
        detach: detach
    };
}());
