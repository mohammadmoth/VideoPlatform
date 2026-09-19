(() => {
    'use strict';
    const ui = Object.fromEntries(['collection', 'section', 'sort', 'refresh', 'status', 'error', 'videos']
        .map(id => [id, document.getElementById(id)]));
    const params = new URL(location.href).searchParams;
    if (params.get('master') !== 'true') {
        params.set('master', 'true');
        history.replaceState({}, '', `${location.pathname}?${params}${location.hash}`);
    }
    ui.sort.value = params.get('sort') || 'name-asc';
    let initialCollection = params.get('collection') || '';
    let initialSection = params.get('section') || '';
    let items = [];
    let socket;
    let master = false;
    let controllerToken = sessionStorage.getItem('videoControllerToken');
    let selectedId = null;
    let selectionTimer;
    let reconnectTimer;
    let disposed = false;

    const natural = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
    function unique(values) { return [...new Set(values)].sort(natural.compare); }
    function setOptions(select, values, allLabel, selected) {
        select.replaceChildren(new Option(allLabel, ''));
        for (const value of values) select.add(new Option(value.label, value.id));
        if (values.some(value => value.id === selected)) select.value = selected;
    }
    function setAuthorized(authorized) {
        for (const control of [ui.collection, ui.section, ui.sort, ui.refresh]) control.disabled = !authorized;
        if (!authorized) {
            items = [];
            ui.videos.replaceChildren();
            ui.status.textContent = 'Library access requires the active controller.';
        }
    }
    function controllerHeaders() { return { 'X-Controller-Token': controllerToken || '' }; }
    function saveContext(anchor = '') {
        const next = new URL(location.href);
        next.searchParams.set('master', 'true');
        next.searchParams.set('sort', ui.sort.value);
        if (ui.collection.value) next.searchParams.set('collection', ui.collection.value);
        else next.searchParams.delete('collection');
        if (ui.section.value) next.searchParams.set('section', ui.section.value);
        else next.searchParams.delete('section');
        next.hash = anchor;
        const state = { videoPlatform: 'library', collection: ui.collection.value,
            section: ui.section.value, sort: ui.sort.value, anchor };
        history.replaceState(state, '', next);
        sessionStorage.setItem('videoLibraryReturn', JSON.stringify({ url: next.pathname + next.search + next.hash }));
    }
    function sectionsFor(item) { return item.sections.join(' / '); }
    function render() {
        const savedCollection = ui.collection.value || initialCollection;
        const collectionMap = new Map();
        for (const item of items) collectionMap.set(item.collectionId, {
            id: item.collectionId, label: item.collection, synthetic: item.syntheticCollection,
        });
        const collections = [...collectionMap.values()];
        const labelCounts = new Map();
        for (const collection of collections) {
            labelCounts.set(collection.label, (labelCounts.get(collection.label) || 0) + 1);
        }
        for (const collection of collections) {
            if (labelCounts.get(collection.label) > 1) {
                collection.label += collection.synthetic ? ' (root files)' : ' (folder)';
            }
        }
        collections.sort((a, b) => natural.compare(a.label, b.label));
        setOptions(ui.collection, collections, 'All collections', savedCollection);
        initialCollection = '';
        const inCollection = items.filter(item => !ui.collection.value || item.collectionId === ui.collection.value);
        const savedSection = ui.section.value || initialSection;
        setOptions(ui.section, unique(inCollection.map(sectionsFor).filter(Boolean))
            .map(value => ({ id: value, label: value })), 'All sections', savedSection);
        initialSection = '';
        const visible = inCollection.filter(item => !ui.section.value || sectionsFor(item) === ui.section.value);
        ui.videos.replaceChildren();
        for (const item of visible) {
            const li = document.createElement('li');
            li.id = `video-${item.id}`;
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'video';
            const locationText = [item.collection, ...item.sections].join(' / ');
            button.textContent = `${item.name} — ${locationText}`;
            button.addEventListener('click', () => select(item));
            li.append(button);
            ui.videos.append(li);
        }
        ui.status.textContent = visible.length ? `${visible.length} video(s)` : 'No videos in this view.';
        saveContext(location.hash.slice(1));
        if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView({ block: 'center' });
    }
    async function load() {
        if (!master || !controllerToken) return;
        const requestedToken = controllerToken;
        ui.error.textContent = '';
        ui.status.textContent = 'Loading library…';
        try {
            const response = await fetch(`/api/catalog?sort=${encodeURIComponent(ui.sort.value)}`, {
                headers: controllerHeaders(),
            });
            const data = await response.json();
            if (!master || controllerToken !== requestedToken) return;
            if (!response.ok) throw Error(data.error || `Catalog request failed (${response.status})`);
            items = data.items;
            render();
            if (data.pendingCount) ui.status.textContent += ` ${data.pendingCount} file(s) are still settling.`;
            if (data.error) ui.error.textContent = data.error;
        } catch (error) {
            if (master) { ui.error.textContent = error.message; ui.status.textContent = 'Library unavailable.'; }
        }
    }
    async function refresh() {
        if (!master || !controllerToken) return;
        ui.refresh.disabled = true;
        ui.status.textContent = 'Refreshing…';
        ui.error.textContent = '';
        try {
            const response = await fetch('/api/catalog/refresh', {
                method: 'POST', headers: controllerHeaders(),
            });
            const data = await response.json();
            if (!response.ok) throw Error(data.error || `Refresh failed (${response.status})`);
            if (master) await load();
        } catch (error) {
            if (master) { ui.error.textContent = error.message; ui.status.textContent = 'Refresh failed.'; }
        } finally { ui.refresh.disabled = !master; }
    }
    function select(item) {
        if (!master || socket?.readyState !== WebSocket.OPEN) {
            ui.error.textContent = 'This page is not the active controller. Close the other controller and reload.';
            return;
        }
        selectedId = item.id;
        saveContext(`video-${item.id}`);
        ui.status.textContent = `Selecting ${item.name}…`;
        socket.send(JSON.stringify({ type: 'command', action: 'select', mediaId: item.id }));
        clearTimeout(selectionTimer);
        selectionTimer = setTimeout(() => {
            selectedId = null;
            ui.error.textContent = 'Selection was not confirmed. Refresh the library and try again.';
        }, 5000);
    }
    function connect() {
        if (disposed || (socket && socket.readyState < WebSocket.CLOSING)) return;
        clearTimeout(reconnectTimer);
        const active = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/`, 'echo-protocol');
        socket = active;
        active.addEventListener('open', () => active.send(JSON.stringify({
            type: 'hello', master: true, screen: false,
            ...(controllerToken ? { controllerToken } : {}),
        })));
        active.addEventListener('message', event => {
            if (socket !== active) return;
            let message;
            try { message = JSON.parse(event.data); } catch { return; }
            if (message.type === 'welcome' || message.type === 'role') {
                master = message.master;
                document.body.dataset.controller = String(master);
                if (master && message.controllerToken) {
                    controllerToken = message.controllerToken;
                    sessionStorage.setItem('videoControllerToken', controllerToken);
                    setAuthorized(true);
                    load();
                } else if (!master) {
                    setAuthorized(false);
                    ui.error.textContent = 'Another controller is active. Library access is disabled.';
                }
            } else if (message.type === 'participants' && !message.hasMaster && !master) {
                active.send(JSON.stringify({ type: 'hello', master: true, screen: false,
                    ...(controllerToken ? { controllerToken } : {}) }));
            } else if (message.type === 'state' && selectedId && message.media?.id === selectedId
                && message.position === 0 && !message.playing) {
                clearTimeout(selectionTimer);
                location.assign('/?master=true');
            }
        });
        active.addEventListener('close', () => {
            if (socket !== active) return;
            socket = null;
            master = false;
            setAuthorized(false);
            if (!disposed) {
                ui.error.textContent = 'Controller connection lost. Reconnecting…';
                reconnectTimer = setTimeout(connect, 1500);
            }
        });
    }
    ui.collection.addEventListener('change', () => { ui.section.value = ''; render(); });
    ui.section.addEventListener('change', render);
    ui.sort.addEventListener('change', load);
    ui.refresh.addEventListener('click', refresh);
    window.addEventListener('pagehide', () => {
        disposed = true;
        clearTimeout(reconnectTimer);
        clearTimeout(selectionTimer);
        const active = socket;
        socket = null;
        active?.close();
    });
    window.addEventListener('pageshow', event => {
        if (!event.persisted) return;
        disposed = false;
        controllerToken = sessionStorage.getItem('videoControllerToken');
        connect();
    });
    setAuthorized(false);
    connect();
})();
