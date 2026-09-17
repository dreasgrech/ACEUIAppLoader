/* Harness fixture: an app bundled in the package rather than installed, and a developer
   tool, so the drawer keeps it behind its switch. Alpha is in apps.json too, with a
   folder that does not exist -- the installed alpha must win, and this one must never be
   fetched. */
(function () {
    const me = ACEUIModLoader.app();

    window.__gadget = {
        name: me.name,
        base: me.base,
        version: me.version,
        developer: me.developer,
        attached: 0,
        detached: 0
    };

    ACEUIModLoader.shared.register("gadget", { answer: 42 });

    me.mount(function () {
        window.__gadget.attached += 1;

        return { running: true };
    }, function () {
        window.__gadget.detached += 1;
    });
}());
