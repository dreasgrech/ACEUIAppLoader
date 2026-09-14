/* Harness fixture: a mod that records what the loader gave it while its script ran. */
(function () {
    const me = ACEUIModLoader.mod();

    window.__alpha = {
        name: me.name,
        title: me.title,
        version: me.version,
        base: me.base,
        loaded: me.loaded,
        hudId: me.hudId,
        storageKey: me.storageKey,
        filterKey: me.key("filters"),
        rootPresent: Boolean(me.root),
        rootParent: me.root && me.root.parentElement ? me.root.parentElement.id : "",
        rootAttr: me.root ? me.root.getAttribute("data-mod") : null
    };
    me.log("alpha script ran");
}());
