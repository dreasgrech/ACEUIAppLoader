/**
 * ACEUIAppLoader.input -- stop the game reading keystrokes as car controls.
 *
 * An app that takes typed input has a problem: the game still treats those keys as
 * gameplay bindings, so typing an expression toggles headlights and wipers, and the
 * arrow keys shove the seat about. The engine has the switches for this; they are just
 * not obvious.
 *
 * `UIMenuState` carries two separate flags and **both** matter:
 *
 *   | ksUI.menuState method | flag                            | covers                  |
 *   |-----------------------|---------------------------------|-------------------------|
 *   | toggleKeyboardInput   | is_chat_active (field 10)       | the text path, letters  |
 *   | ignoreInputActions    | ignore_gameplay_input_actions(7)| bound gameplay actions  |
 *
 * The stock chat box (`ks-hudchat`) only flips the first, which is why letters stop
 * toggling car functions but the arrow keys still move the seat -- a gap in the base
 * game that anyone copying the chat box inherits. Setting both is what actually works.
 * Either method may be missing on a given build; whichever exists is used.
 *
 * **Ownership is counted, not a boolean.** Two apps can want the keyboard at once -- the
 * console while its prompt has focus, DOOM while it is open. If the console released on
 * blur it would yank the keyboard out from under DOOM. So each holder captures under its
 * own name and the flags only drop when the last one lets go.
 *
 *     const release = ACEUIAppLoader.input.bindFocus(myInput, "myapp");       // a text box
 *     const release = ACEUIAppLoader.input.bindClickFocus(myPanel, "myapp");  // click to focus
 *     ACEUIAppLoader.input.capture("myapp");                             // or by hand
 *     ACEUIAppLoader.input.release("myapp");                             // and in detach
 *
 * Releasing matters more than capturing: an app that keeps the capture after it is gone
 * leaves the car unable to read its own controls, so call `release(owner)` in detach --
 * or use the unbind function `bindFocus`/`bindClickFocus` hand back, which does it.
 */
ACEUIAppLoader.input = (function () {

    /** The two levers, in the order the stock UI calls them. */
    const LEVERS = ["toggleKeyboardInput", "ignoreInputActions"];

    /**
     * Getting the keyboard back must not depend on any particular key.
     *
     * The player can rebind anything, so hardcoding Escape would only rescue players who
     * left pause on Escape. The engine sends the UI its *bound actions* by name
     * (`UIExInputsAction`, `e.action`), which is binding-agnostic: whatever key the player
     * chose for the menu, the action arrives under the same name. Those are the primary
     * signal. The raw Escape key and losing window focus are kept as extra nets, since a
     * stuck capture is severe enough to be worth three ways out.
     */
    const RELEASE_ACTIONS = ["InputAction_UI_Menu", "InputAction_UI_Cancel"];
    const ACTION_EVENT = "UIExInputsAction";
    const ESCAPE_KEY = "Escape";
    const ESCAPE_CODE = 27;
    const CLEAR_POLL_MS = 50;
    const CLEAR_WAIT_MS = 10000;
    /**
     * Whether a page of ours left the engine holding the keyboard. The flags live in the
     * game's menu state and outlive the HUD page, so the next page has to know whether to
     * release them -- and only then. The stock menus set the same flags for their own text
     * boxes and pause screens, and a page that reset them unasked would be racing the
     * stock UI for a switch it does not own. localStorage rather than ACEUIAppLoader.persist,
     * which loads after this file.
     */
    const HELD_KEY = "aceinput.held";
    const HELD_VALUE = "1";

    const state = {
        owners: {},         // name -> true, for every holder that currently wants the keyboard
        count: 0,
        applied: false      // what we last told the engine, so we only speak on change
    };

    const menuState = function () {
        return window.ksUI && window.ksUI.menuState ? window.ksUI.menuState : null;
    };

    const readHeld = function () {
        try {
            return localStorage.getItem(HELD_KEY) === HELD_VALUE;
        } catch (ignore) { /* no storage: nothing recorded, nothing to undo */ }

        return false;
    };

    const writeHeld = function (on) {
        try {
            if (on) {
                localStorage.setItem(HELD_KEY, HELD_VALUE);
            } else {
                localStorage.removeItem(HELD_KEY);
            }
        } catch (ignore) { /* no storage: the release nets on this page still work */ }
    };

    /** True when the engine offers at least one of the levers on this page. */
    const available = function () {
        const menu = menuState();
        let i;

        if (!menu) { return false; }

        for (i = 0; i < LEVERS.length; i += 1) {
            if (typeof menu[LEVERS[i]] === "function") { return true; }
        }

        return false;
    };

    /** Push the wanted state to every lever the engine has; returns how many took it. */
    const apply = function (want) {
        const menu = menuState();
        let taken = 0;

        if (!menu) { return 0; }

        LEVERS.forEach(function (lever) {
            if (typeof menu[lever] !== "function") { return; }

            try {
                menu[lever](want);
                taken += 1;
            } catch (e) {
                ACEUIAppLoader.log("[input] " + lever + "(" + want + ") failed: " + ACEUIAppLoader.errorText(e));
            }
        });

        if (taken) {
            state.applied = want;
            writeHeld(want);
        }

        return taken;
    };

    const isCaptured = function () {
        return state.count > 0;
    };

    /** Who is currently holding the keyboard, for logging and the dev console. */
    const holders = function () {
        return Object.keys(state.owners);
    };

    const name = function (owner) {
        return owner ? String(owner) : "anonymous";
    };

    /** Take the keyboard for `owner`. Repeated calls by the same owner count once. */
    const capture = function (owner) {
        const who = name(owner);

        if (state.owners[who]) { return isCaptured(); }

        state.owners[who] = true;
        state.count += 1;

        if (state.count === 1) { apply(true); }

        return isCaptured();
    };

    /** Let go for `owner`; the flags drop only when nobody is left holding them. */
    const release = function (owner) {
        const who = name(owner);

        if (!state.owners[who]) { return isCaptured(); }

        delete state.owners[who];
        state.count -= 1;

        if (state.count === 0) { apply(false); }

        return isCaptured();
    };

    /**
     * Drop the capture for everyone and tell the engine, whatever the holders thought.
     *
     * This is the safety net, and it exists because the failure mode is severe: the
     * capture lives in the game's own menu state, so it survives the HUD page reload.
     * A capture that is never released leaves the game ignoring bound actions for ever,
     * and since Escape is itself a bound action, the one key that would reload the HUD
     * is the key being swallowed. That happened: a missed `blur` left the console holding
     * the keyboard and the pause menu could not be opened at all.
     */
    const releaseEverything = function (reason) {
        const names = holders();

        state.owners = {};
        state.count = 0;

        if (!names.length && !state.applied) { return false; }

        apply(false);

        if (names.length) {
            ACEUIAppLoader.log("[input] released everything (" + reason + "): " + names.join(", "));
        }

        return true;
    };

    const isEscape = function (e) {
        return e.key === ESCAPE_KEY || e.code === ESCAPE_KEY || e.keyCode === ESCAPE_CODE;
    };

    /**
     * The player's own menu or cancel binding, whatever key they put it on. This is the
     * signal that matters: it respects a rebound pause key, where a hardcoded Escape
     * would not.
     */
    const onAction = function (e) {
        if (e && RELEASE_ACTIONS.indexOf(e.action) >= 0) { releaseEverything(e.action); }
    };

    /** Raw Escape, as a second net for when the action never arrives. */
    const onEscape = function (e) {
        if (isEscape(e)) { releaseEverything("escape key"); }
    };

    /** Alt-tabbing away should not leave the game holding a capture it cannot clear. */
    const onWindowBlur = function () {
        releaseEverything("window lost focus");
    };

    /** Subscribe to the player's bound actions, if the bridge is there. */
    const watchActions = function () {
        const bridge = window.engine;

        if (!bridge || typeof bridge.on !== "function") { return false; }

        try {
            bridge.on(ACTION_EVENT, onAction);

            return true;
        } catch (e) {
            ACEUIAppLoader.log("[input] cannot watch " + ACTION_EVENT + ": " + ACEUIAppLoader.errorText(e));

            return false;
        }
    };

    /**
     * A fresh HUD page has no holders, so the engine should not still be ignoring input
     * from a previous one -- when it was one of OURS that left it so. The library loads
     * before the stock bundle, so ksUI is not there yet; retry briefly until it is. This is
     * what recovers a session that got stuck. A page nothing of ours captured on is left
     * alone: the stock menus own those flags on their pages (see HELD_KEY).
     */
    const clearOnLoad = function (deadline) {
        if (!readHeld()) { return; }

        if (available()) {
            state.applied = true;              // force the write even though we hold nothing
            releaseEverything("page load");

            return;
        }

        if (Date.now() > deadline) { return; }

        window.setTimeout(function () { clearOnLoad(deadline); }, CLEAR_POLL_MS);
    };

    /** Is `node` the element or inside it? Walked by hand rather than trusting contains(). */
    const within = function (element, node) {
        let cursor = node;

        while (cursor) {
            if (cursor === element) { return true; }

            cursor = cursor.parentNode;
        }

        return false;
    };

    /**
     * Click-to-focus, for a panel that is not a text box: the keyboard is taken when the
     * pointer goes down inside `element` and given back when it goes down anywhere else.
     * That is what lets an app stay open without holding the keyboard hostage -- DOOM can
     * sit in a corner while you drive, and take the keys again when you click it.
     *
     * Listens on the capture phase so it sees the click wherever it lands. Returns the
     * function that unbinds and releases.
     */
    const bindClickFocus = function (element, owner) {
        const who = name(owner);
        const onDown = function (e) {
            if (within(element, e.target)) { capture(who); } else { release(who); }
        };

        if (!element) { return function () { release(who); }; }

        window.addEventListener("mousedown", onDown, true);

        return function () {
            window.removeEventListener("mousedown", onDown, true);
            release(who);
        };
    };

    /**
     * Wire an element so the keyboard is held exactly while it has focus. Returns the
     * function that unbinds it and releases, so an app's detach is one call.
     */
    const bindFocus = function (element, owner) {
        const who = name(owner);
        const onFocus = function () { capture(who); };
        const onBlur = function () { release(who); };

        if (!element || typeof element.addEventListener !== "function") {
            return function () { release(who); };
        }

        // `blur` is the primary signal, but a missed blur used to strand the capture, so a
        // pointer press anywhere outside the element releases as well
        const onDownAnywhere = function (e) {
            if (!within(element, e.target)) { release(who); }
        };

        element.addEventListener("focus", onFocus);
        element.addEventListener("blur", onBlur);
        window.addEventListener("mousedown", onDownAnywhere, true);

        return function () {
            element.removeEventListener("focus", onFocus);
            element.removeEventListener("blur", onBlur);
            window.removeEventListener("mousedown", onDownAnywhere, true);
            release(who);
        };
    };

    // Three ways back: the player's own menu/cancel binding, the raw Escape key, and
    // losing window focus. A fresh page never inherits a stuck capture either.
    watchActions();
    window.addEventListener("keydown", onEscape, true);
    window.addEventListener("blur", onWindowBlur);
    clearOnLoad(Date.now() + CLEAR_WAIT_MS);

    return {
        LEVERS: LEVERS,
        HELD_KEY: HELD_KEY,
        state: state,
        available: available,
        heldAcrossPages: readHeld,
        clearOnLoad: clearOnLoad,
        isCaptured: isCaptured,
        holders: holders,
        capture: capture,
        release: release,
        releaseEverything: releaseEverything,
        RELEASE_ACTIONS: RELEASE_ACTIONS,
        onAction: onAction,
        within: within,
        bindFocus: bindFocus,
        bindClickFocus: bindClickFocus
    };
}());
