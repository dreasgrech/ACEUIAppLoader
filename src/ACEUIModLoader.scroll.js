/**
 * ACEUIModLoader.scroll -- scrolling a box by hand, because Cohtml will not do it.
 *
 * `overflow: auto` is inert here: an overflowing box does not scroll to the wheel and
 * shows no scrollbar. Every panel with a list in it therefore has to move `scrollTop`
 * itself and draw its own thumb. The dev console worked that out, and the capabilities
 * probe then copied it -- its own comment says "mirrors ACEDevConsole" -- so the same
 * ninety lines existed twice, with the same three subtleties in both:
 *
 *   - the wheel's sign is **inverted** compared with a browser (a positive deltaY is up,
 *     observed in game and matching how the stock bundle reads it);
 *   - the thumb's geometry is only written when it changes, since a style write per frame
 *     on a moving element is what this renderer charges for;
 *   - a drag listens on the window, not the thumb, or the pointer outruns it.
 *
 *     const scroller = ACEUIModLoader.scroll.attach({
 *         body: bodyElement,              // the clipped box (overflow: hidden)
 *         track: trackElement,            // the scrollbar gutter
 *         thumb: thumbElement,            // the thumb inside it
 *         follow: true,                   // stick to the newest content (a log view)
 *         nofitClass: "dc-nofit",         // set on the track while everything fits
 *         draggingClass: "dragging",      // set on the track while the thumb is held
 *         onFollow: function (on) { ... } // following started or stopped
 *     });
 *
 *     scroller.sync();                    // after the content changed
 *     scroller.toBottom();                // jump to the newest
 *     scroller.detach();                  // releases every listener
 *
 * A handle that has been detached stays safe to call: every method becomes a no-op. Work
 * that outlives a panel is normal here -- an app switched off in the app drawer is detached
 * within milliseconds of loading, while its own timers and probes are still in flight --
 * and such a callback should find a scroller that does nothing, not one that throws.
 *
 * The body needs `overflow: hidden` and the track/thumb need sizes from the app's own
 * stylesheet; this owns behaviour, not appearance.
 */
ACEUIModLoader.scroll = (function () {

    /** A wheel notch moves this fraction of the visible height. */
    const WHEEL_STEP = 0.25;
    /** Below this the thumb is too small to grab. */
    const MIN_THUMB_PX = 12;
    /** Cohtml reports the wheel with the opposite sign to a browser. */
    const WHEEL_SIGN = -1;

    const clamp = ACEUIModLoader.clamp;
    const dom = ACEUIModLoader.dom;

    const maxScroll = function (body) {
        return Math.max(0, body.scrollHeight - body.clientHeight);
    };

    /** Size and place the thumb from the body's geometry; writes style only on a change. */
    const sync = function (s) {
        const body = s.body;
        const visible = body.clientHeight;
        const total = body.scrollHeight;
        const trackHeight = s.track ? s.track.clientHeight : 0;
        const fits = total <= visible || trackHeight === 0;
        let height;
        let y;

        if (s.nofitClass) { dom.setClass(s.track, s.nofitClass, fits); }

        if (fits || !s.thumb) { return s; }

        height = Math.min(trackHeight, Math.max(MIN_THUMB_PX, Math.round(trackHeight * visible / total)));
        y = Math.round((trackHeight - height) * clamp(body.scrollTop / (total - visible), 0, 1));

        if (height !== s.thumbHeight) {
            s.thumbHeight = height;
            s.thumb.style.height = height + "px";
        }

        if (y !== s.thumbY) {
            s.thumbY = y;
            s.thumb.style.transform = "translateY(" + y + "px)";
        }

        return s;
    };

    /** Following means the view sticks to the newest content; scrolling away stops it. */
    const setFollow = function (s, on) {
        const next = Boolean(on);

        if (s.follow === next) { return s; }

        s.follow = next;

        if (typeof s.onFollow === "function") { s.onFollow(next); }

        return s;
    };

    const scrollBy = function (s, dy) {
        const body = s.body;
        const max = maxScroll(body);
        const top = clamp(body.scrollTop + dy, 0, max);

        body.scrollTop = top;

        if (s.wantsFollow) { setFollow(s, top >= max); }

        sync(s);

        return s;
    };

    /** Jump to the newest content. A follower calls this whenever its content grew. */
    const toBottom = function (s) {
        s.body.scrollTop = s.body.scrollHeight;
        sync(s);

        return s;
    };

    const onWheel = function (s, e) {
        const direction = e.deltaY > 0 ? 1 : (e.deltaY < 0 ? -1 : 0);

        if (!s.wheelLogged && typeof s.log === "function") {
            s.wheelLogged = true;
            s.log("first wheel event deltaY=" + e.deltaY + " (positive is treated as up)");
        }

        if (direction === 0) { return; }

        scrollBy(s, direction * WHEEL_SIGN * s.body.clientHeight * WHEEL_STEP);
        e.preventDefault();
    };

    const endDrag = function (s) {
        if (!s.drag) { return; }

        s.drag = null;

        if (s.draggingClass) { dom.setClass(s.track, s.draggingClass, false); }

        s.dragBag.off();
    };

    const startDrag = function (s, e) {
        s.drag = { startY: e.clientY, startTop: s.body.scrollTop };

        if (s.draggingClass) { dom.setClass(s.track, s.draggingClass, true); }

        s.dragBag.on(window, "mousemove", function (move) {
            const travel = s.track.clientHeight - s.thumbHeight;

            if (!s.drag || travel <= 0) { return; }

            scrollBy(s, s.drag.startTop + (move.clientY - s.drag.startY) * maxScroll(s.body) / travel
                - s.body.scrollTop);
        });
        s.dragBag.on(window, "mouseup", function () { endDrag(s); });
        s.dragBag.on(document, "mouseup", function () { endDrag(s); });
        e.preventDefault();
    };

    /** A press on the thumb drags it; anywhere else on the track jumps to that point. */
    const onTrackDown = function (s, e) {
        const travel = s.track.clientHeight - s.thumbHeight;
        let ratio = 1;

        if (e.target === s.thumb) {
            startDrag(s, e);

            return;
        }

        if (typeof e.offsetY === "number" && travel > 0) {
            ratio = clamp((e.offsetY - s.thumbHeight / 2) / travel, 0, 1);
        }

        scrollBy(s, ratio * maxScroll(s.body) - s.body.scrollTop);
        e.preventDefault();
    };

    const attach = function (options) {
        const opts = options || {};
        const s = {
            body: opts.body,
            track: opts.track || null,
            thumb: opts.thumb || null,
            nofitClass: opts.nofitClass || "",
            draggingClass: opts.draggingClass || "",
            onFollow: opts.onFollow || null,
            log: opts.log || null,
            wantsFollow: Boolean(opts.follow),
            follow: Boolean(opts.follow),
            wheelLogged: false,
            detached: false,            // a late callback after detach must be harmless
            drag: null,
            thumbHeight: -1,            // last applied geometry, so frames only touch it on change
            thumbY: -1,
            bag: dom.listeners(),
            dragBag: dom.listeners()
        };

        if (!s.body) { return null; }

        s.bag.on(s.body, "wheel", function (e) { onWheel(s, e); });

        if (s.track) { s.bag.on(s.track, "mousedown", function (e) { onTrackDown(s, e); }); }

        return {
            state: s,
            sync: function () { return s.detached ? s : sync(s); },
            scrollBy: function (dy) { return s.detached ? s : scrollBy(s, dy); },
            toBottom: function () { return s.detached ? s : toBottom(s); },
            setFollow: function (on) { return s.detached ? s : setFollow(s, on); },
            following: function () { return s.follow; },
            /**
             * Forget the thumb's cached geometry after a resize or a scale change. It is
             * deliberately not re-applied here: layout has not settled yet, so the next
             * `sync` (the panel's next frame) is the first honest reading.
             */
            invalidate: function () {
                s.thumbHeight = -1;
                s.thumbY = -1;

                return s;
            },
            detached: function () { return s.detached; },
            detach: function () {
                endDrag(s);
                s.detached = true;

                return s.bag.off();
            }
        };
    };

    return {
        WHEEL_STEP: WHEEL_STEP,
        WHEEL_SIGN: WHEEL_SIGN,
        MIN_THUMB_PX: MIN_THUMB_PX,
        attach: attach
    };
}());
