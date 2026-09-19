'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { mkdtemp, mkdir, writeFile, rename, rm } = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createServer } = require('../index');

test('authorized catalog API, safe media delivery, ranges, and real WebSockets integrate', async t => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'video-server-'));
    const root = path.join(base, 'videos');
    const mediaPath = path.join(root, 'Movies/testvideo.mp4');
    await mkdir(path.dirname(mediaPath), { recursive: true });
    await writeFile(mediaPath, Buffer.alloc(256, 7));
    const { server, wsServer, catalog } = createServer({
        startDelay: 50, videosRoot: root, dataFile: path.join(base, 'data/metadata.json'),
        catalogOptions: { watch: false, settleMs: 0, safetyMinMs: 600000 },
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(async () => {
        wsServer.shutDown();
        await new Promise(resolve => server.close(resolve));
        await catalog.close();
        await rm(base, { recursive: true, force: true });
    });
    const host = `127.0.0.1:${server.address().port}`;
    function client() {
        const socket = new WebSocket(`ws://${host}`, 'echo-protocol');
        const messages = [];
        socket.addEventListener('message', event => messages.push(JSON.parse(event.data)));
        return { socket, messages, send: data => socket.send(JSON.stringify(data)) };
    }
    async function until(predicate) {
        const deadline = Date.now() + 4000;
        while (!predicate()) {
            if (Date.now() > deadline) throw Error('Timed out waiting for protocol message');
            await new Promise(resolve => setTimeout(resolve, 10));
        }
    }

    assert.equal((await fetch(`http://${host}/api/catalog`)).status, 403);
    assert.equal((await fetch(`http://${host}/api/catalog/refresh`, { method: 'POST' })).status, 403);
    const master = client();
    await once(master.socket, 'open');
    master.socket.send('syncTime');
    master.socket.send('null');
    master.send({ type: 'clock', sent: 123 });
    master.send({ type: 'hello', master: true });
    await until(() => master.messages.some(message => message.type === 'welcome'));
    const token = master.messages.find(message => message.type === 'welcome').controllerToken;
    assert.match(token, /^[A-Za-z0-9_-]+$/);
    const headers = { 'X-Controller-Token': token };

    assert.equal((await fetch(`http://${host}/api/catalog?sort=invalid`, { headers })).status, 400);
    const catalogResponse = await fetch(`http://${host}/api/catalog?sort=name-asc`, { headers });
    assert.equal(catalogResponse.status, 200);
    const listing = await catalogResponse.json();
    assert.equal(listing.items.length, 1);
    assert.equal(listing.items[0].path, undefined);
    const id = listing.items[0].id;

    let response = await fetch(`http://${host}/media/${id}`, { headers: { Range: 'bytes=0-99' } });
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('content-range'), 'bytes 0-99/256');
    assert.equal((await response.arrayBuffer()).byteLength, 100);
    response = await fetch(`http://${host}/media/${id}`, { headers: { Range: 'bytes=-10' } });
    assert.equal(response.status, 206);
    assert.equal((await response.arrayBuffer()).byteLength, 10);
    response = await fetch(`http://${host}/media/${id}`, { headers: { Range: 'bytes=250-' } });
    assert.equal(response.status, 206);
    assert.equal((await response.arrayBuffer()).byteLength, 6);
    for (const range of ['bytes=1-0', 'bytes=999-1000', 'bytes=0-1,4-5', 'items=0-1']) {
        assert.equal((await fetch(`http://${host}/media/${id}`, { headers: { Range: range } })).status, 416);
    }
    response = await fetch(`http://${host}/media/${id}`, { method: 'HEAD' });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-length'), '256');
    response = await fetch(`http://${host}/media/${id}`);
    assert.equal(response.status, 200);
    assert.equal((await response.arrayBuffer()).byteLength, 256);
    assert.equal((await fetch(`http://${host}/media/not-a-catalog-id`)).status, 404);

    // The route must stream the already validated handle, not reopen a replaced pathname.
    const originalOpen = catalog.openFile.bind(catalog);
    const oldPath = `${mediaPath}.old`;
    catalog.openFile = async mediaId => {
        const opened = await originalOpen(mediaId);
        await rename(mediaPath, oldPath);
        await writeFile(mediaPath, Buffer.alloc(256, 9));
        return opened;
    };
    response = await fetch(`http://${host}/media/${id}`);
    assert.equal(response.status, 200);
    assert.equal(new Uint8Array(await response.arrayBuffer())[0], 7);
    catalog.openFile = originalOpen;
    await rm(mediaPath);
    await rename(oldPath, mediaPath);

    // A changed published file is rejected until reconciliation settles its new signature.
    await writeFile(mediaPath, Buffer.alloc(128, 3));
    assert.equal((await fetch(`http://${host}/media/${id}`)).status, 404);
    assert.equal((await fetch(`http://${host}/api/catalog/refresh`, { method: 'POST', headers })).status, 200);
    assert.equal((await fetch(`http://${host}/media/${id}`)).status, 200);
    assert.match((await (await fetch(`http://${host}/`)).text()), /player.js/);
    assert.match((await (await fetch(`http://${host}/library.html?master=true`)).text()), /Video library/);

    const display = client();
    await once(display.socket, 'open');
    display.send({ type: 'hello' });
    await until(() => master.messages.some(message => message.count === 2));
    assert.ok(master.messages.some(message => message.type === 'clock' && message.sent === 123
        && Number.isFinite(message.serverTime)));
    display.send({ type: 'command', action: 'select', mediaId: id });
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(master.messages.some(message => message.media?.id === id), false);
    master.send({ type: 'command', action: 'select', mediaId: id });
    await until(() => display.messages.some(message => message.type === 'state' && message.media?.id === id));
    const selected = display.messages.find(message => message.type === 'state' && message.media?.id === id);
    assert.equal(selected.playing, false);
    assert.equal(selected.position, 0);

    master.send({ type: 'command', action: 'play' });
    await until(() => display.messages.some(message => message.type === 'prepare'));
    const preparation = display.messages.findLast(message => message.type === 'prepare');
    master.send({ type: 'ready', version: preparation.version, mediaGeneration: preparation.mediaGeneration });
    display.send({ type: 'ready', version: preparation.version, mediaGeneration: preparation.mediaGeneration });
    await until(() => display.messages.some(message => message.type === 'state' && message.playing));
    const state = display.messages.find(message => message.type === 'state' && message.playing);
    assert.equal(state.media.id, id);
    assert.ok(state.at > 0);
    await until(() => master.messages.some(message => message.type === 'state' && message.playing));
    assert.deepEqual(master.messages.find(message => message.type === 'state' && message.playing), state);
    master.socket.close();
    await until(() => display.messages.some(message => message.type === 'state'
        && !message.playing && message.version > state.version));
    display.socket.close();
});
