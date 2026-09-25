/**
 * ACEUIAppLoader.panel -- a draggable HUD panel that remembers where it was.
 *
 * `attach(root, options)` makes `root` draggable inside its parent (the HUD's
 * `.absolutecenter`), clamped so it stays fully on screen, and persists its
 * position as fractions of the parent (resolution independent) through
 * ACEUIAppLoader.persist under `options.hudId` / `options.storageKey`. The app's frame
 * loop must call `update(panel, now)` every frame until the restore has settled, and for a
 * `settle` panel for as long as it is open (it keeps the panel on screen as it grows, and at
 * its share of the screen when that is resized).
 *
 * Restore sequence, to avoid any visible jump: the root is hidden at attach; a
 * synchronous localStorage attempt places it before its first paint (localStorage
 * survives the Escape/resume reload); then, in the loop, the stock HUD store has
 * the last word as soon as it exists -- our entry, else the localStorage
 * fallback, else the stylesheet default -- or after RESTORE_WAIT_MS without a
 * HUD object. A window prefers a position the player dragged it to, from either
 * store. Restoring waits for layout: a zero-size parent would clamp the panel
 * into a corner.
 *
 * Elements carrying `data-nodrag` (inputs, buttons) do not start a drag. The middle and
 * right buttons never drag, nor end a drag. A right-button press calls `options.onRightClick(e)`
 * when given, unless it lands in an element carrying `data-noright` (a part of the panel that
 * uses the right button itself, like DOOM's screen; on the root it covers the whole panel), a
 * listener inside the panel handled the press itself (`preventDefault`), or the left button is
 * held anywhere on the page (read it with `leftHeld()`); onRightClick returns true when it
 * acted, and only then (or while the left button is held) is a browser's own menu kept off.
 * One press acts once, however many panels share its root. A `settle` panel moved no more than
 * DRAG_SLOP_PX is a click: it goes back where it was and nothing is stored. A drag released
 * while the UI is hidden, or taken over by a browser's own drag and drop, counts for nothing:
 * the root's inline spot is put back as the press found it. The click that follows the release
 * of a middle or right press made on a panel (outside its `data-noright` parts), or on a root
 * given to `guardClicks` (the app drawer), presses nothing inside that root, so a right-click
 * never also presses a control; this holds whatever the panel's own right-click options.
 *
 * `options.settle` (windows): the root is filled after it opens, and this engine lays a new
 * element out a frame late, so it stays hidden until it has a size, and once shown it is kept
 * on screen whenever its size or its parent's changes (a section unfolded near the bottom, a
 * windowed resize), clamped from its home spot (where it was restored, placed or dragged to,
 * else where it first showed; kept as fractions of its parent, as a stored position is), so
 * folding the section back returns it there, where a reload would put it too.
 * A position stored after a drag is marked `dragged`. `options.placed`: the owner placed the
 * root itself (a settings window opened beside its app); only a dragged position wins over
 * that, so a spot placed before (or one stored before 0.27, when a click with a twitch counted
 * as a drag) is placed afresh, while a plain open (the reopen after a reload) restores any.
 * With nothing it restores, the spot is kept on screen once laid out and stored, unmarked.
 * Off the HUD page there is no HUD store to wait for, and a settling panel does not.
 * Options: { hudId, storageKey, log (prefixed logger), onSaved(position), onRightClick(e), settle, placed }.
 */
ACEUIAppLoader.panel = (function () {

    const RESTORE_WAIT_MS = 2000;
    /** Class on the root while it is being dragged (apps style it). */
    const DRAGGING_CLASS = "dragging";
    /** Attribute on descendants that must not start a drag. */
    const NO_DRAG_ATTR = "data-nodrag";
    /** Attribute on descendants (or the root) whose right-button presses are their own: onRightClick is not called. */
    const NO_RIGHT_ATTR = "data-noright";
    const LOG_DECIMALS = 3;
    const HIDDEN = "hidden";
    const AUTO = "auto";
    /** How far a press may move the panel and still be a click, px: a hand never holds perfectly still. */
    const DRAG_SLOP_PX = 2;
    /** MouseEvent.button of the middle button: its press is kept apart from the right's (see the click rule). */
    const MIDDLE_BUTTON = 1;
    /** The inline properties that place the root: what a drag that counts for nothing puts back. */
    const ANCHORS = ["left", "top", "right", "bottom"];

    const clamp = ACEUIAppLoader.clamp;
    const persist = ACEUIAppLoader.persist;

    const isPosition = function (pos) {
        return Boolean(pos) && typeof pos.fx === "number" && typeof pos.fy === "number";
    };

    /** A stored position this panel restores: when it is being placed afresh, only one the player dragged it to. */
    const restorable = function (panel, pos) {
        return isPosition(pos) && (!panel.placed || pos.dragged === true);
    };

    /**
     * Of the two stores' positions, the one to restore: the HUD store's (per layout) when it has
     * one, else localStorage's, as it always was for an app panel. A window (a settle panel) wants
     * the player's own spot over one it was merely placed at, so for it a dragged one from either
     * store comes first.
     */
    const pick = function (panel, fromHud, fromLocal) {
        const usable = [fromHud, fromLocal].filter(function (pos) { return restorable(panel, pos); });
        const dragged = panel.settle ? usable.filter(function (pos) { return pos.dragged === true; }) : [];

        return dragged[0] || usable[0] || null;
    };

    /**
     * The page's pointer, once per page, on the window in the capture phase, so every press is
     * seen before any panel's: whether the left button is held somewhere (a scrollbar, an order
     * row, another panel being dragged), so a right tap meanwhile is not a request for the
     * settings; whether a browser preview's menu is to be kept off (the last right press acted,
     * or was made while the left was held); which press last acted, so one press acts once; and
     * the click rule's state (below).
     */
    const pointer = { leftHeld: false, rightTaken: false, actedOn: null, pressRoots: {}, swallow: null };
    // a release the page never hears of: the presses it would have ended are lost with it
    const letGo = function () {
        pointer.leftHeld = false;
        pointer.pressRoots = {};
    };
    /** The roots of the attached panels and windows, and those given to guardClicks: where the click rule applies. */
    const roots = [];

    /**
     * The root a middle or right press or release on `target` is the loader's own on (see the click rule), or null;
     * the outermost when panels nest, whichever was attached first.
     */
    const rootOf = function (target) {
        let found = null;

        roots.forEach(function (root) {
            if ((found === null || inside(root, found)) && ownsRightClick(root, target)) { found = root; }
        });

        return found;
    };

    const disarm = function () {
        const swallow = pointer.swallow;

        pointer.swallow = null;

        if (swallow && swallow.release) { swallow.release(); }
    };

    /**
     * Arm the click rule for the release of a middle or right press (`button`, or null for a release misreported as
     * the left): the click that follows presses nothing inside the root the press was made on, nor inside the one the
     * release came on (a press that shut its window, released over another app), and nothing anywhere when the press
     * shut the root it was on (the engine may aim the click at whatever is under the pointer now, or at the pressed
     * node itself, off the page, where the window's listeners never hear it: the root gets one of its own). Until the
     * 0 ms timer runs, or a key or a left release comes first: a browser sends no click for those buttons, and a later
     * click (a script's) is not the press's. The release root counts only for a press of that button on record: a
     * left release reported as the right is not a right-click.
     */
    const arm = function (button, releaseRoot) {
        const key = button !== null ? button : (pointer.pressRoots[ACEUIAppLoader.RIGHT_BUTTON] ? ACEUIAppLoader.RIGHT_BUTTON : MIDDLE_BUTTON);
        const pressed = Object.prototype.hasOwnProperty.call(pointer.pressRoots, key);
        const pressRoot = pointer.pressRoots[key] || null;
        const within = [pressRoot, pressed ? releaseRoot : null].filter(Boolean);
        const gone = Boolean(pressRoot) && !inside(document, pressRoot);

        delete pointer.pressRoots[key];
        disarm();

        if (within.length === 0) { return; }

        pointer.swallow = { within: within, gone: gone, release: null };

        if (gone) {
            const stop = function (e) {
                e.preventDefault();
                e.stopPropagation();
                disarm();
            };

            pressRoot.addEventListener("click", stop, true);
            pointer.swallow.release = function () { pressRoot.removeEventListener("click", stop, true); };
        }

        window.setTimeout(disarm, 0);
    };

    window.addEventListener("mousedown", function (e) {
        const other = ACEUIAppLoader.otherButton(e);

        // a new press: one press acts once (onRightDown), whether or not the engine hands every press a new event object
        pointer.actedOn = null;

        // where a middle or right press landed, decided now and kept per button: the press may shut the window it is on
        // before its click comes, and the other button may be pressed and let go meanwhile
        if (other) { pointer.pressRoots[e.button] = rootOf(e.target); }

        // a right press starts a new right-click; one made while the left is held keeps a browser's menu off (the
        // menu would take the left release, which may come first), and onRightDown sets it when the press acts
        if (e.button === ACEUIAppLoader.RIGHT_BUTTON) { pointer.rightTaken = pointer.leftHeld; }

        if (!other) { pointer.leftHeld = true; }
    }, true);
    // the click after a release is that release's: a middle or right release arms the click rule (so does a left one
    // with no left press held: that press's release, misreported, whose click a real stray left click must not lose to
    // where it was let go); a left release disarms it
    window.addEventListener("mouseup", function (e) {
        const other = ACEUIAppLoader.otherButton(e);

        if (other || !pointer.leftHeld) {
            arm(other ? e.button : null, other ? rootOf(e.target) : null);
        } else {
            disarm();
        }

        if (!other) { pointer.leftHeld = false; }
    }, true);
    // a key's click (Enter on a focused button, Space let go) is the key's, however soon after a right-click
    window.addEventListener("keydown", disarm, true);
    window.addEventListener("keyup", disarm, true);
    // a release the page never hears of (let go on another screen, or taken by a browser's drag and drop) must not leave
    // right-clicks dead, nor arm the click rule on a later stray release
    window.addEventListener("blur", letGo);
    window.addEventListener("dragend", letGo, true);
    // a right-click during a left drag keeps a browser's menu off too: the menu would take the left release
    window.addEventListener("contextmenu", function (e) {
        if (pointer.rightTaken || pointer.leftHeld) { e.preventDefault(); }

        pointer.rightTaken = false;
    }, true);
    // the click rule: the click after a middle or right release presses nothing inside the panel the press was made on
    // or the one it came on. The press already did what a right-click does, and a browser sends no such click, but an
    // engine that does would also press the control under it (DOOM's close button in its title bar, a toggle in a
    // window that stays open, an app's row in the drawer). Judged by the press and its release, which is what the
    // loader reads everywhere (a click's own button field is unmeasured here), and only inside the loader's own roots
    // (the library loads on the stock pages too, whose clicks are never the rule's) unless the press shut its own.
    // Capture listeners on the window (the probe's counter) still hear it
    window.addEventListener("click", function (e) {
        const swallow = pointer.swallow;

        if (swallow && (swallow.gone || swallow.within.some(function (root) { return inside(root, e.target); }))) {
            e.preventDefault();
            e.stopPropagation();
        }

        disarm();
    }, true);

    /**
     * A root the click rule covers that is not a panel (the app drawer); returns the function that lets it go, once.
     * An element only: the rule reads its attributes on every middle or right press on the page.
     */
    const guardClicks = function (root) {
        let listed = Boolean(root) && typeof root.hasAttribute === "function";

        if (listed) { roots.push(root); }

        return function () {
            if (listed) {
                listed = false;
                unlist(root);
            }
        };
    };

    /** Takes one listing of `root` out of the click rule (a root listed twice, by two panels, keeps the other). */
    const unlist = function (root) {
        const at = roots.indexOf(root);

        if (at >= 0) { roots.splice(at, 1); }
    };

    /** Whether `node` is `root` or inside it; a parent walk, as a target need not be a node (the window) and `contains` is unproven here. */
    const inside = function (root, node) {
        let at = node;

        while (at) {
            if (at === root) { return true; }

            at = at.parentNode;
        }

        return false;
    };

    /** A target on this root whose right-clicks are the panel's: inside it, not in a part (or a root) marked data-noright. */
    const ownsRightClick = function (root, target) {
        return inside(root, target) && !root.hasAttribute(NO_RIGHT_ATTR) && !ACEUIAppLoader.closestWithAttribute(target, NO_RIGHT_ATTR, root);
    };

    /** What a root with no parent (a preview page, a harness) is measured against: nothing, which every size test reads as "not ready". */
    const EMPTY_RECT = { left: 0, top: 0, width: 0, height: 0 };

    const parentRect = function (panel) {
        const parent = panel.root.parentElement;

        return parent ? parent.getBoundingClientRect() : EMPTY_RECT;
    };

    const hasSize = function (rect) {
        return rect.width > 0 && rect.height > 0;
    };

    const parentHasSize = function (panel) {
        return hasSize(parentRect(panel));
    };

    /** A spot inside the parent, whole px, clamped so the root stays fully inside it. */
    const clampedSpot = function (panel, parent, x, y) {
        return {
            x: Math.round(clamp(x, 0, Math.max(0, parent.width - panel.root.offsetWidth))),
            y: Math.round(clamp(y, 0, Math.max(0, parent.height - panel.root.offsetHeight)))
        };
    };

    /**
     * Place the panel at viewport coordinates, clamped so it stays fully inside its parent.
     * Returns where it was put, in whole px inside the parent: what was written, not a layout
     * read, which lags here.
     */
    const moveTo = function (panel, clientX, clientY) {
        const root = panel.root;
        const parent = parentRect(panel);
        const at = clampedSpot(panel, parent, clientX - parent.left, clientY - parent.top);

        root.style.left = at.x + "px";
        root.style.top = at.y + "px";
        root.style.right = AUTO;
        root.style.bottom = AUTO;

        return at;
    };

    /**
     * Where the root is inside its parent: from what moveTo wrote when it wrote px (a rect read
     * lags a frame here, and includes a margin), else from `rect`.
     */
    const writtenAt = function (panel, parent, rect) {
        const left = pxValue(panel.root.style.left);
        const top = pxValue(panel.root.style.top);

        return { x: left === null ? rect.left - parent.left : left, y: top === null ? rect.top - parent.top : top };
    };

    /** A spot inside the parent as fractions of it: what a home is kept as, so it follows the parent's size. */
    const fractionsOf = function (at, parent) {
        return { fx: parent.width > 0 ? at.x / parent.width : 0, fy: parent.height > 0 ? at.y / parent.height : 0 };
    };

    /** A log label naming the panel, for safely. */
    const labelOf = function (panel, what) {
        return "[panel] " + (panel.hudId || panel.storageKey) + " " + what;
    };

    /** The root has been laid out: a clamp or a measured spot means something. */
    const laidOut = function (panel) {
        return panel.root.offsetWidth > 0 && panel.root.offsetHeight > 0;
    };

    /** A length written in px ("12px", "12.5px"), else null. */
    const pxValue = function (text) {
        return /^-?\d+(\.\d+)?px$/.test(text) ? parseFloat(text) : null;
    };

    /**
     * Current position as fractions of the parent, plus the pixel form the stock
     * layout code expects on every element it stores. From what moveTo wrote when it did (every
     * save follows one), not a rect read straight after it, which lags a frame in this engine.
     */
    const currentPosition = function (panel) {
        const parent = parentRect(panel);
        const pos = fractionsOf(writtenAt(panel, parent, panel.root.getBoundingClientRect()), parent);

        pos.x = panel.root.style.left;
        pos.y = panel.root.style.top;

        return pos;
    };

    const positionText = function (pos) {
        return "fx=" + pos.fx.toFixed(LOG_DECIMALS) + " fy=" + pos.fy.toFixed(LOG_DECIMALS);
    };

    /**
     * Store where the panel is and return it; `dragged`: the player put it there, so it wins over a
     * placed open. Nothing stored, and null, while its parent has no size (the UI hidden): the spot
     * would be measured against nothing.
     */
    const savePosition = function (panel, dragged) {
        if (!parentHasSize(panel)) {
            panel.log("position not saved: the container has no size (the UI hidden)");

            return null;
        }

        const pos = currentPosition(panel);

        if (dragged === true) { pos.dragged = true; }

        const where = persist.save(panel.hudId, panel.storageKey, pos);

        panel.log("position saved " + positionText(pos) + " to " + (where.join(", ") || "nowhere"));

        if (panel.onSaved) { panel.onSaved(pos); }

        return pos;
    };

    const applyPosition = function (panel, pos, source) {
        const parent = parentRect(panel);

        panel.home = { fx: pos.fx, fy: pos.fy };
        moveTo(panel, parent.left + pos.fx * parent.width, parent.top + pos.fy * parent.height);
        panel.log("position restored from " + source + " " + positionText(pos));
    };

    const show = function (panel) {
        panel.root.style.visibility = "";
    };

    /** Restore is settled: show the panel where it is (a settling one moved inside the screen first). */
    const finishRestore = function (panel) {
        panel.restored = true;

        if (panel.settle) { keepInside(panel); }

        show(panel);
    };

    const restoreImmediately = function (panel) {
        const fromLocal = persist.readLocal(panel.storageKey);

        if (!restorable(panel, fromLocal) || !parentHasSize(panel)) { return; }

        applyPosition(panel, fromLocal, "localStorage (immediate)");

        // a window is not filled yet: the clamp above measured an empty one, and the loop measures it again once laid out
        if (!panel.settle) { show(panel); }
    };

    const maybeRestore = function (panel, now) {
        if (!parentHasSize(panel)) { return; }

        if (panel.attachedAt === 0) { panel.attachedAt = now; }

        // a read does not force layout in this engine: a window measured before it has a size would be
        // clamped, and a placed spot stored, against nothing (the top-left corner)
        if (panel.settle && !laidOut(panel) && now - panel.attachedAt < RESTORE_WAIT_MS) { return; }

        const hudReady = persist.hudAvailable();
        const fromHud = persist.readHud(panel.hudId);
        // a window off the HUD page has no store to wait for: it would sit hidden for the whole wait
        const waitForHud = !hudReady && now - panel.attachedAt < RESTORE_WAIT_MS && !(panel.settle && ACEUIAppLoader.page !== ACEUIAppLoader.HUD_PAGE);

        if (!restorable(panel, fromHud) && waitForHud) { return; }

        const fromLocal = persist.readLocal(panel.storageKey);
        const chosen = pick(panel, fromHud, fromLocal);
        let placeNow = false;

        if (chosen) {
            applyPosition(panel, chosen, chosen === fromHud ? "hud layout" : "localStorage");
        } else if (panel.placed && laidOut(panel)) {
            // placed by its owner and laid out by now: kept on the screen and stored, so it comes back there after
            // a reload and grows downwards as its content does (review 2026-09-25: a settings window hung from its
            // bottom edge beside a low app put its title bar above the screen)
            const r = panel.root.getBoundingClientRect();

            panel.home = fractionsOf(moveTo(panel, r.left, r.top), parentRect(panel));
            placeNow = true;
        } else {
            panel.log("no stored position (hud layout " + (hudReady ? "has no entry" : "not available") + "), keeping default");
        }

        finishRestore(panel);

        // after it is shown: a save that throws must not keep the window hidden, retried every frame
        if (placeNow) { ACEUIAppLoader.safely(labelOf(panel, "placed spot"), function () { savePosition(panel); }); }
    };

    /**
     * A window whose size, or its parent's, changed since the last frame (a section unfolded or
     * folded, a windowed resize) is placed again from its home spot, clamped inside its parent,
     * its title bar kept on screen: pushed up while it is tall, back home when it is short again,
     * at the same share of the screen as a reload would put it. One with no home yet (a default
     * spot, nothing stored) takes the spot it is at as its home first. Not stored: the position
     * the player chose stays theirs, and a restore clamps against the full size anyway. Nothing
     * is measured while it or its parent has no size (the UI hidden, the root taken off the
     * page): a clamp against nothing would throw it into the corner.
     */
    const keepInside = function (panel) {
        const width = panel.root.offsetWidth;
        const height = panel.root.offsetHeight;
        const parent = parentRect(panel);
        const drawn = panel.drawn;

        if (!laidOut(panel) || !hasSize(parent)) { return; }

        if (width === drawn.width && height === drawn.height && parent.width === drawn.parentWidth && parent.height === drawn.parentHeight) { return; }

        drawn.width = width;
        drawn.height = height;
        drawn.parentWidth = parent.width;
        drawn.parentHeight = parent.height;

        // where it first showed, from what was written (a window opened at px of its own: the rect lags a frame here);
        // the rect only when nothing px was written (the default spot, in %)
        if (!panel.home) { panel.home = fractionsOf(writtenAt(panel, parent, panel.root.getBoundingClientRect()), parent); }

        moveTo(panel, parent.left + panel.home.fx * parent.width, parent.top + panel.home.fy * parent.height);
    };

    /** Call every frame; cheap once the restore has settled (a settling window reads its size). */
    const update = function (panel, now) {
        if (!panel.restored) {
            maybeRestore(panel, now);

            return;
        }

        if (panel.settle && !panel.dragging) { keepInside(panel); }
    };

    /**
     * The right button on the panel: onRightClick on the press itself, not on a release, so it
     * rests on the one fact DOOM already relies on (a press reports its button). A right drag
     * does nothing else, so there is no click to tell apart from one.
     */
    const onRightDown = function (panel, e) {
        // a press a listener inside the panel handled (DOOM's running screen before 0.6.1 took "use" with
        // preventDefault and no marker), or one tapped while the left button is held, is not a request for the settings
        if (!panel.onRightClick || !ownsRightClick(panel.root, e.target) || pointer.leftHeld || panel.dragging || e.defaultPrevented) { return; }

        // one press acts once: a root attached twice (an app whose attach threw after me.panel, then ran again) would
        // otherwise open and shut its window on the same press
        if (pointer.actedOn === e) { return; }

        pointer.actedOn = e;

        const acted = ACEUIAppLoader.safely(labelOf(panel, "onRightClick"), function () { return panel.onRightClick(e); });

        // only a right-click that did something keeps a browser's menu off: an app with nothing to open keeps its menu
        if (acted === true) { pointer.rightTaken = true; }
    };

    const onMouseDown = function (panel, e) {
        if (e.button === ACEUIAppLoader.RIGHT_BUTTON) {
            onRightDown(panel, e);

            return;
        }

        // the middle button never dragged anything on purpose
        if (ACEUIAppLoader.otherButton(e)) { return; }

        if (ACEUIAppLoader.closestWithAttribute(e.target, NO_DRAG_ATTR, panel.root)) { return; }

        const parent = parentRect(panel);
        const at = writtenAt(panel, parent, panel.root.getBoundingClientRect());

        panel.dragging = true;
        panel.moved = false;
        // measured where moveTo would put it: a window left reaching past a parent that shrank (a windowed resize)
        // is clamped by the first move, and a twitch must not count that as a drag and pin it there
        panel.pressedAt = clampedSpot(panel, parent, at.x, at.y);
        ANCHORS.forEach(function (side) { panel.pressedStyle[side] = panel.root.style[side]; });
        panel.dragOffset.x = e.clientX - (parent.left + at.x);
        panel.dragOffset.y = e.clientY - (parent.top + at.y);
        panel.root.classList.add(DRAGGING_CLASS);
    };

    const onMouseMove = function (panel, e) {
        // nothing while the container has no size (the UI hidden mid-drag): a move against nothing lands in the corner
        if (!panel.dragging || !parentHasSize(panel)) { return; }

        const at = moveTo(panel, e.clientX - panel.dragOffset.x, e.clientY - panel.dragOffset.y);
        // a window that jittered is a click: saving it would pin a settings window that is meant to open beside its
        // app. An app panel keeps any move, as it always did. From what moveTo wrote, not a layout read, which lags
        // a frame here and would lose a quick flick
        const slop = panel.settle ? DRAG_SLOP_PX : 0;

        if (Math.abs(at.x - panel.pressedAt.x) > slop || Math.abs(at.y - panel.pressedAt.y) > slop) { panel.moved = true; }
    };

    /**
     * A drag that counts for nothing (released with the UI hidden, or taken over by a browser's drag and
     * drop): the drag ends and the root's inline spot is put back exactly as the press found it. Written,
     * not moved: a clamp against no size would put it in the corner, and px written over a stylesheet's
     * right or bottom anchor would pin an app panel's size between the two.
     */
    const cancelDrag = function (panel) {
        panel.dragging = false;
        panel.root.classList.remove(DRAGGING_CLASS);
        ANCHORS.forEach(function (side) { panel.root.style[side] = panel.pressedStyle[side]; });
    };

    /** A click that never moved the panel is not a drag: nothing to save, and a jitter put back, so what is drawn is what is stored. */
    const onMouseUp = function (panel, e) {
        // the middle or right button let go during a left drag: the left is still held, the drag goes on
        if (!panel.dragging || ACEUIAppLoader.otherButton(e)) { return; }

        const parent = parentRect(panel);

        // released with the UI hidden: nothing can be measured, so the drag counts for nothing
        if (!hasSize(parent)) {
            cancelDrag(panel);

            return;
        }

        panel.dragging = false;
        panel.root.classList.remove(DRAGGING_CLASS);

        if (panel.moved) {
            panel.home = fractionsOf(writtenAt(panel, parent, panel.root.getBoundingClientRect()), parent);
            // an app's onSaved may throw (the stores' own throws are caught in persist): the drag is over either way
            ACEUIAppLoader.safely(labelOf(panel, "drag save"), function () { savePosition(panel, true); });

            return;
        }

        // only a window can end a press here moved (within the slop): an app panel keeps any move, so it is where it was
        const x = pxValue(panel.root.style.left);
        const y = pxValue(panel.root.style.top);

        if ((x !== null && x !== panel.pressedAt.x) || (y !== null && y !== panel.pressedAt.y)) {
            moveTo(panel, parent.left + panel.pressedAt.x, parent.top + panel.pressedAt.y);
        }
    };

    const attach = function (root, options) {
        const panel = {
            root: root,
            hudId: options.hudId || null,
            storageKey: options.storageKey || null,
            log: options.log || ACEUIAppLoader.log,
            onSaved: options.onSaved || null,
            onRightClick: typeof options.onRightClick === "function" ? options.onRightClick : null,
            placed: options.placed === true,
            settle: options.settle === true,
            drawn: { width: -1, height: -1, parentWidth: -1, parentHeight: -1 },  // a settling window's size and its parent's last frame, for keepInside
            home: null,                 // where it was restored, placed or dragged to, else where it first showed, as fractions of its parent: keepInside's anchor
            dragging: false,
            moved: false,               // the current drag moved it past the slop (DRAG_SLOP_PX for a window, any move for an app panel)
            dragOffset: { x: 0, y: 0 },
            pressedAt: { x: 0, y: 0 },  // where the root was, px inside its parent, when the drag began
            pressedStyle: { left: "", top: "", right: "", bottom: "" },  // its inline spot then, for cancelDrag
            handlers: null,
            attachedAt: 0,              // timestamp of the first frame after attach
            restored: false             // position restore done (or given up)
        };

        panel.handlers = {
            down: function (e) { onMouseDown(panel, e); },
            move: function (e) { onMouseMove(panel, e); },
            up: function (e) { onMouseUp(panel, e); },
            // a browser preview's own drag and drop would take a press on text or an image and never send the mouseup;
            // mid-drag it can start from a selection outside the root, so it is refused page-wide then. A part that
            // never starts a panel drag (data-nodrag: an input) keeps its own: selected text dragged to another field
            nativeDrag: function (e) {
                const ours = inside(panel.root, e.target) && !ACEUIAppLoader.closestWithAttribute(e.target, NO_DRAG_ATTR, panel.root);

                if (panel.dragging || ours) { e.preventDefault(); }
            },
            // one that started all the same took the release with it: the drag counts for nothing
            nativeDragEnd: function () {
                if (panel.dragging) { cancelDrag(panel); }
            }
        };

        // hidden until positioned; immediate attempt now, the HUD store settles it in the loop.
        // Before the listeners, so that a throw in here leaves nothing registered that only a
        // handle we never returned could take off again
        root.style.visibility = HIDDEN;
        restoreImmediately(panel);

        roots.push(root);
        root.addEventListener("mousedown", panel.handlers.down);
        window.addEventListener("dragstart", panel.handlers.nativeDrag, true);
        window.addEventListener("dragend", panel.handlers.nativeDragEnd, true);
        window.addEventListener("mousemove", panel.handlers.move);
        window.addEventListener("mouseup", panel.handlers.up);
        document.addEventListener("mouseup", panel.handlers.up);

        return panel;
    };

    /** Release the listeners and show the root. The DOM is left in place; a drag going on counts for nothing. */
    const detach = function (panel) {
        if (panel.dragging) { cancelDrag(panel); }

        show(panel);

        if (panel.handlers) {
            unlist(panel.root);
            panel.root.removeEventListener("mousedown", panel.handlers.down);
            window.removeEventListener("dragstart", panel.handlers.nativeDrag, true);
            window.removeEventListener("dragend", panel.handlers.nativeDragEnd, true);
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
        NO_RIGHT_ATTR: NO_RIGHT_ATTR,
        DRAG_SLOP_PX: DRAG_SLOP_PX,
        /** The left button is held somewhere on the page (read only; the listeners above keep it). */
        leftHeld: function () { return pointer.leftHeld; },
        guardClicks: guardClicks,
        isPosition: isPosition,
        moveTo: moveTo,
        currentPosition: currentPosition,
        savePosition: savePosition,
        update: update,
        attach: attach,
        detach: detach
    };
}());
