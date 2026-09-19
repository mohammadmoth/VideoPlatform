'use strict';
// Optional real-browser test, using Chrome DevTools directly (no extra npm dependencies).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { mkdtemp, rm } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('../index');

const chromePath = process.env.CHROMIUM_PATH;
test('two browser screens: buffered start, drift correction, pause, seek, late join and reconnect',
    { skip: !chromePath && 'Set CHROMIUM_PATH to run the real-browser test', timeout: 120000 }, async t => {
    const profile = await mkdtemp(path.join(os.tmpdir(), 'video-sync-chrome-'));
    const { server, wsServer } = createServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    const chrome = spawn(chromePath, ['--headless=new', '--no-sandbox', '--disable-gpu',
        '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
        '--disable-backgrounding-occluded-windows', '--remote-debugging-port=0',
        `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
    let cdp;
    t.after(async () => {
        cdp?.close();
        const exited = once(chrome, 'exit');
        chrome.kill('SIGKILL');
        await exited;
        wsServer.shutDown();
        await new Promise(resolve => server.close(resolve));
        await rm(profile, { recursive: true, force: true });
    });
    const endpoint = await new Promise((resolve, reject) => {
        let log = '';
        const timer = setTimeout(() => reject(Error(`Chrome startup timed out: ${log}`)), 15000);
        chrome.once('error', reject);
        chrome.once('exit', code => reject(Error(`Chrome exited (${code}): ${log}`)));
        chrome.stderr.on('data', data => {
            log += data;
            const match = log.match(/DevTools listening on (ws:\/\/\S+)/);
            if (match) { clearTimeout(timer); resolve(match[1]); }
        });
    });
    cdp = new WebSocket(endpoint);
    await once(cdp, 'open');
    let id = 0;
    const requests = new Map();
    const exceptions = [];
    cdp.addEventListener('message', event => {
        const message = JSON.parse(event.data);
        if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails);
        if (message.id) {
            const request = requests.get(message.id);
            requests.delete(message.id);
            if (message.error) request.reject(Error(JSON.stringify(message.error)));
            else request.resolve(message.result);
        }
    });
    function call(method, params = {}, sessionId) {
        return new Promise((resolve, reject) => {
            const requestId = ++id;
            requests.set(requestId, { resolve, reject });
            cdp.send(JSON.stringify({ id: requestId, method, params, sessionId }));
        });
    }
    async function evaluate(session, expression) {
        const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, session);
        if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails));
        return result.result.value;
    }
    async function until(session, expression, timeout = 30000) {
        const deadline = Date.now() + timeout;
        while (!await evaluate(session, expression)) {
            if (Date.now() > deadline) {
                const info = await evaluate(session, `({status:document.querySelector('#status')?.textContent,notice:document.querySelector('#notice')?.textContent,time:document.querySelector('video')?.currentTime,ready:document.querySelector('video')?.readyState,buffered:Array.from({length:document.querySelector('video').buffered.length},(_,i)=>[document.querySelector('video').buffered.start(i),document.querySelector('video').buffered.end(i)]),error:document.querySelector('video')?.error?.message})`);
                throw Error(`Timed out: ${expression}\n${JSON.stringify(info)}`);
            }
            await new Promise(resolve => setTimeout(resolve, 50));
        }
    }
    async function page(master, skew = 0) {
        const { targetId } = await call('Target.createTarget', { url: 'about:blank' });
        const { sessionId } = await call('Target.attachToTarget', { targetId, flatten: true });
        await call('Runtime.enable', {}, sessionId);
        await call('Page.enable', {}, sessionId);
        await call('Page.addScriptToEvaluateOnNewDocument', { source: `
            Object.defineProperty(performance, 'timeOrigin', {value: performance.timeOrigin + ${skew}});
            window.syncSockets = [];
            const NativeSocket = window.WebSocket;
            window.WebSocket = class extends NativeSocket {
                constructor(...args) { super(...args); window.syncSockets.push(this); }
                addEventListener(type, callback, options) {
                    super.addEventListener(type, type === 'message' ? event => {
                        if (!window.dropInbound) callback(event);
                    } : callback, options);
                }
            };
        ` }, sessionId);
        await call('Page.navigate', { url: base + (master ? '/?master=true' : '/') }, sessionId);
        await until(sessionId, `!!document.querySelector('#join') && document.readyState === 'complete'`);
        await evaluate(sessionId, `document.querySelector('#join').click()`);
        await until(sessionId, `document.querySelector('#join').hidden`);
        await evaluate(sessionId, `window.seekCount=0;document.querySelector('video').addEventListener('seeking',()=>window.seekCount++)`);
        return sessionId;
    }
    const master = await page(true);
    const display = await page(false, 45000);
    t.diagnostic('Initial media: ' + JSON.stringify(await evaluate(display, `({ready:document.querySelector('video').readyState,duration:document.querySelector('video').duration,buffered:Array.from({length:document.querySelector('video').buffered.length},(_,i)=>[document.querySelector('video').buffered.start(i),document.querySelector('video').buffered.end(i)])})`)));
    await evaluate(master, `document.querySelector('#play').click()`);
    await until(master, `!document.querySelector('video').paused && document.querySelector('video').currentTime > 1`);
    await until(display, `!document.querySelector('video').paused && document.querySelector('video').currentTime > 1`);
    const time = session => evaluate(session, `document.querySelector('video').currentTime`);
    let positions = await Promise.all([time(master), time(display)]);
    t.diagnostic(`Initial difference with 45-second clock skew: ${Math.abs(positions[0] - positions[1]).toFixed(3)} seconds`);
    assert.ok(Math.abs(positions[0] - positions[1]) < 0.15, JSON.stringify(positions));
    assert.equal(await evaluate(display, 'window.seekCount'), 0, 'startup should not repeatedly seek');

    await evaluate(display, `document.querySelector('video').currentTime -= 0.2`);
    await until(display, `document.querySelector('video').playbackRate > 1`);
    const seeks = await evaluate(display, 'window.seekCount');
    await until(master, `document.querySelector('video').currentTime > 4`);
    assert.equal(await evaluate(display, 'window.seekCount'), seeks, 'small drift must be corrected without jumps');

    await evaluate(master, `document.querySelector('#pause').click()`);
    await until(display, `document.querySelector('video').paused`);
    await evaluate(master, `document.querySelector('#seek').value=0;document.querySelector('#seek').dispatchEvent(new Event('change'))`);
    await until(master, `document.querySelector('video').currentTime < 0.05 && document.querySelector('#status').textContent === 'Paused'`);
    await until(display, `document.querySelector('video').currentTime < 0.05 && document.querySelector('#status').textContent === 'Paused'`);
    await evaluate(master, `document.querySelector('#play').click()`);
    await until(display, `!document.querySelector('video').paused && document.querySelector('video').currentTime > 1`);
    const late = await page(false, -30000);
    await until(late, `!document.querySelector('video').paused && document.querySelector('video').currentTime > 1`);
    positions = await Promise.all([time(master), time(late)]);
    assert.ok(Math.abs(positions[0] - positions[1]) < 0.2, `Late join: ${positions}`);
    await evaluate(display, 'window.syncSockets.at(-1).close()');
    await until(display, `window.syncSockets.length > 1 && document.querySelector('#join').hidden && !document.querySelector('video').paused`);
    positions = await Promise.all([time(master), time(display)]);
    assert.ok(Math.abs(positions[0] - positions[1]) < 0.2, `Reconnect: ${positions}`);

    await evaluate(master, `document.querySelector('#seek').value=20;document.querySelector('#seek').dispatchEvent(new Event('change'))`);
    await until(display, `!document.querySelector('video').paused && document.querySelector('video').currentTime > 20.5`);
    positions = await Promise.all([time(master), time(display)]);
    assert.ok(Math.abs(positions[0] - positions[1]) < 0.15, `Playing seek: ${positions}`);

    // Simulate a half-open socket: transport stays open, but incoming messages disappear.
    await evaluate(display, 'window.dropInbound = true');
    await until(display, `document.querySelector('video').paused && !document.querySelector('#join').hidden`, 15000);
    await evaluate(display, 'window.dropInbound = false');
    await until(display, `document.querySelector('#join').hidden && !document.querySelector('video').paused`);

    // Exercise the browser's BFCache lifecycle without relying on platform-specific caching policy.
    const socketCount = await evaluate(display, 'window.syncSockets.length');
    await evaluate(display, `window.dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true}));window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}))`);
    await until(display, `window.syncSockets.length > ${socketCount} && document.querySelector('#join').hidden && !document.querySelector('video').paused`);
    positions = await Promise.all([time(master), time(display)]);
    assert.ok(Math.abs(positions[0] - positions[1]) < 0.2, `Page restoration: ${positions}`);
    assert.deepEqual(exceptions, []);
});
