'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { createServer } = require('../index');

test('HTTP range serving and real WebSocket clients synchronize and reject malformed input', async t => {
    const { server, wsServer } = createServer({ startDelay: 50 });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => { wsServer.shutDown(); return new Promise(resolve => server.close(resolve)); });
    const host = `127.0.0.1:${server.address().port}`;
    const response = await fetch(`http://${host}/testvideo.mp4`, { headers: { Range: 'bytes=0-99' } });
    assert.equal(response.status, 206);
    assert.equal((await response.arrayBuffer()).byteLength, 100);
    assert.match((await (await fetch(`http://${host}/`)).text()), /player.js/);

    function client() {
        const socket = new WebSocket(`ws://${host}`, 'echo-protocol');
        const messages = [];
        socket.addEventListener('message', event => messages.push(JSON.parse(event.data)));
        const send = data => socket.send(JSON.stringify(data));
        return { socket, messages, send };
    }
    async function until(predicate) {
        const deadline = Date.now() + 4000;
        while (!predicate()) {
            if (Date.now() > deadline) throw Error('Timed out waiting for protocol message');
            await new Promise(resolve => setTimeout(resolve, 10));
        }
    }
    const master = client();
    const display = client();
    await Promise.all([once(master.socket, 'open'), once(display.socket, 'open')]);
    master.socket.send('syncTime'); // Old malformed text must not be relayed or crash the server.
    master.socket.send('null');
    master.send({ type: 'clock', sent: 123 });
    master.send({ type: 'hello', master: true });
    display.send({ type: 'hello' });
    await until(() => master.messages.some(m => m.count === 2));
    assert.ok(master.messages.some(m => m.type === 'clock' && m.sent === 123 && Number.isFinite(m.serverTime)));
    master.send({ type: 'command', action: 'play' });
    await until(() => display.messages.some(m => m.type === 'prepare'));
    const version = display.messages.find(m => m.type === 'prepare').version;
    master.send({ type: 'ready', version });
    display.send({ type: 'ready', version });
    await until(() => display.messages.some(m => m.type === 'state' && m.playing));
    const state = display.messages.find(m => m.type === 'state' && m.playing);
    assert.ok(state.at > 0);
    await until(() => master.messages.some(m => m.type === 'state' && m.playing));
    assert.deepEqual(master.messages.find(m => m.type === 'state' && m.playing), state);
    master.socket.close();
    await until(() => display.messages.some(m => m.type === 'state' && !m.playing && m.version > state.version));
    display.socket.close();
});
