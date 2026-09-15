/*
 * slidetest.js -- four ways for the drawer to arrive, so you can say which one looks
 * smooth in the engine rather than in theory. Dev console, in a session:
 *
 *     .run slidetest
 *
 * Keep the pointer away from the right edge while it runs (about 40 s), or the drawer's
 * own hot zone will open it underneath the test. Each variant opens and closes twice,
 * two seconds apart, and logs its name first with the [slidetest] prefix, so watch the
 * right-hand side and note which letter looked best.
 *
 *   A  what ships now: 180 ms, the whole 15 rem of travel, transform only.
 *   B  the same slide given 300 ms. More frames for the same distance: if the engine is
 *      advancing the page slowly, this is the one that improves.
 *   C  the stock UI's own idiom: 2 rem of travel plus a fade, 250 ms. Kunos never slides
 *      a big panel across the screen -- everything in uicomponents.css moves 1-2 rem and
 *      cross-fades, at 0.25-0.5 s.
 *   D  no travel at all, a 250 ms fade. The floor: nothing to step through, so if D
 *      still looks choppy the page itself is stuttering, not the animation.
 *
 * The panel's own styles are restored at the end, so nothing here outlives the run.
 */
(function () {
    const log = function (text) { console.log("[slidetest] " + text); };

    const HOLD_MS = 2000;
    const CYCLES = 2;

    const drawer = window.ACEUIModLoader && ACEUIModLoader.drawer;
    const panel = drawer && drawer.state ? drawer.state.panel : null;

    if (!panel) {
        log("no drawer panel on this page -- run this on the HUD");

        return;
    }

    const original = {
        transition: panel.style.transition,
        transform: panel.style.transform,
        opacity: panel.style.opacity
    };

    const VARIANTS = [
        {
            name: "A  180 ms, full travel, transform only (what ships now)",
            transition: "transform 180ms ease",
            shut: "translateX(100%)", open: "translateX(0)", shutAlpha: "", openAlpha: ""
        },
        {
            name: "B  300 ms, full travel, transform only",
            transition: "transform 300ms ease",
            shut: "translateX(100%)", open: "translateX(0)", shutAlpha: "", openAlpha: ""
        },
        {
            name: "C  250 ms, 2 rem of travel plus a fade (the stock idiom)",
            transition: "transform 250ms ease-out, opacity 250ms ease-out",
            shut: "translateX(2rem)", open: "translateX(0)", shutAlpha: "0", openAlpha: "1"
        },
        {
            name: "D  250 ms fade, no travel",
            transition: "opacity 250ms ease-out",
            shut: "translateX(0)", open: "translateX(0)", shutAlpha: "0", openAlpha: "1"
        }
    ];

    const apply = function (variant, showing) {
        panel.style.transform = showing ? variant.open : variant.shut;
        panel.style.opacity = showing ? variant.openAlpha : variant.shutAlpha;
    };

    /**
     * Put the panel in the variant's closed state with no transition, so the first open
     * of each variant is a real animation rather than a jump from the previous one.
     */
    const arm = function (variant, then) {
        panel.style.transition = "none";
        apply(variant, false);

        window.setTimeout(function () {
            panel.style.transition = variant.transition;
            then();
        }, 100);
    };

    const cycle = function (variant, left, then) {
        if (left <= 0) {
            then();

            return;
        }

        apply(variant, true);

        window.setTimeout(function () {
            apply(variant, false);
            window.setTimeout(function () { cycle(variant, left - 1, then); }, HOLD_MS);
        }, HOLD_MS);
    };

    const restore = function () {
        panel.style.transition = "none";
        panel.style.transform = original.transform || "translateX(100%)";
        panel.style.opacity = original.opacity;

        window.setTimeout(function () {
            panel.style.transition = original.transition;
            drawer.close();
            log("done -- the drawer is back to its own styles. Which letter looked smoothest?");
        }, 100);
    };

    const run = function (index) {
        if (index >= VARIANTS.length) {
            restore();

            return;
        }

        const variant = VARIANTS[index];

        log((index + 1) + " of " + VARIANTS.length + ": " + variant.name);
        arm(variant, function () {
            cycle(variant, CYCLES, function () { run(index + 1); });
        });
    };

    log("watch the right-hand edge, pointer away from it; " + VARIANTS.length
        + " variants, " + CYCLES + " opens each");
    run(0);
}());
