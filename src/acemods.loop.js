/**
 * AceMods.loop -- per-frame runtime and a fixed-rate sampler.
 *
 * `start(onFrame)` runs `onFrame(now)` on every animation frame until `stop`.
 * The next frame is requested before the callback runs, so an exception in one
 * frame does not stop the loop.
 *
 * `sampler(hz, maxGapMs)` + `advance(sampler, now, onSample)` turn frame time
 * into a fixed sample rate independent of the frame rate: `onSample` is called
 * once per due period (catching up after short hitches), and the return value is
 * how far (0..1) the clock is towards the next sample, for continuous rendering
 * between samples. A gap longer than `maxGapMs` (a pause, a stall) restarts the
 * clock instead of replaying hundreds of identical samples.
 */
AceMods.loop = (function () {

    const MS_PER_S = 1000;

    const start = function (onFrame) {
        const handle = { rafId: 0, running: true };
        const tick = function (now) {
            if (!handle.running) { return; }

            handle.rafId = requestAnimationFrame(tick);
            onFrame(now);
        };

        handle.rafId = requestAnimationFrame(tick);

        return handle;
    };

    const stop = function (handle) {
        handle.running = false;
        cancelAnimationFrame(handle.rafId);
        handle.rafId = 0;
    };

    const sampler = function (hz, maxGapMs) {
        return { periodMs: MS_PER_S / hz, maxGapMs: maxGapMs, lastSampleAt: 0 };
    };

    /** Forget the clock; the next advance starts fresh (used when data goes away). */
    const reset = function (s) {
        s.lastSampleAt = 0;
    };

    const advance = function (s, now, onSample) {
        if (s.lastSampleAt === 0 || now - s.lastSampleAt > s.maxGapMs) {
            s.lastSampleAt = now;
        }

        while (now - s.lastSampleAt >= s.periodMs) {
            s.lastSampleAt += s.periodMs;
            onSample();
        }

        return AceMods.clamp((now - s.lastSampleAt) / s.periodMs, 0, 1);
    };

    return {
        start: start,
        stop: stop,
        sampler: sampler,
        reset: reset,
        advance: advance
    };
}());
