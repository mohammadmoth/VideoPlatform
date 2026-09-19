'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const os = require('node:os');
const fsp = require('node:fs/promises');
const { mkdtemp, mkdir, writeFile, rename, rm, symlink, utimes } = fsp;
const { MediaCatalog, compareText, sameFileIdentity } = require('../lib/media-catalog');

async function fixture(t, files = {}, options = {}) {
    const base = await mkdtemp(path.join(os.tmpdir(), 'video-catalog-'));
    const root = path.join(base, 'videos');
    await mkdir(root);
    for (const [relative, contents] of Object.entries(files)) {
        const target = path.join(root, relative);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, contents);
    }
    const catalog = new MediaCatalog({ root, dataFile: path.join(base, 'data', 'metadata.json'),
        watch: false, settleMs: 0, safetyMinMs: 600000, safetyMaxMs: 600000, ...options });
    t.after(async () => { await catalog.close(); await rm(base, { recursive: true, force: true }); });
    await catalog.ready;
    return { base, root, catalog };
}

test('fixed-locale natural ordering handles numeric names', () => {
    assert.deepEqual(['18', '2', '10', '1'].sort(compareText), ['1', '2', '10', '18']);
});

test('opened-file identity fails closed when inode identity is missing or mismatched', () => {
    assert.equal(sameFileIdentity({ dev: 1n, ino: 2n }, { dev: 1n, ino: 2n }), true);
    assert.equal(sameFileIdentity({ dev: 1n, ino: 0n }, { dev: 1n, ino: 0n }), false);
    assert.equal(sameFileIdentity({ dev: 1n, ino: 2n }, { dev: 1n, ino: 3n }), false);
    assert.equal(sameFileIdentity({ dev: 1, ino: 2 }, { dev: 1, ino: 2 }), false);
});

test('catalog groups recursive sections and Other, filters formats, and naturally sorts', async t => {
    const { catalog } = await fixture(t, {
        'root.MOV': 'r', 'ignore.txt': 'x', '.hidden.mp4': 'x',
        'Show/Season 2/Episode 10.MKV': '10', 'Show/Season 2/Episode 2.webm': '2',
        'Show/Season 2/Episode 1.mp4': '1', 'Sibling Season 1/18.mov': '18',
    });
    const items = catalog.snapshot('name-asc').items;
    assert.deepEqual(items.map(item => item.name), ['18', 'Episode 1', 'Episode 2', 'Episode 10', 'root']);
    const episode = items.find(item => item.name === 'Episode 1');
    assert.deepEqual(episode, {
        id: episode.id, name: 'Episode 1', collection: 'Show', collectionId: episode.collectionId,
        syntheticCollection: false, sections: ['Season 2'], firstSeen: 1,
    });
    assert.equal(items.find(item => item.name === '18').collection, 'Sibling Season 1');
    assert.equal(items.find(item => item.name === 'root').collection, 'Other');
    assert.equal(items.find(item => item.name === 'root').syntheticCollection, true);
    assert.deepEqual(catalog.snapshot('name-desc').items.map(item => item.name),
        ['root', 'Episode 10', 'Episode 2', 'Episode 1', '18']);
    assert.deepEqual(catalog.snapshot('added-asc').items.map(item => item.name),
        ['root', 'Episode 1', 'Episode 2', 'Episode 10', '18']);
    assert.deepEqual(catalog.snapshot('added-desc').items.map(item => item.name),
        ['root', 'Episode 1', 'Episode 2', 'Episode 10', '18']);
});

test('firstSeen persists across removal/restart/restore while rename is new', async t => {
    const { base, root, catalog } = await fixture(t, { 'Series/2.mp4': '2', 'Series/10.mp4': '10' });
    const original = catalog.sortedItems('added-asc');
    assert.deepEqual(original.map(item => item.name), ['2', '10']);
    await writeFile(path.join(root, 'Series/18.mp4'), '18');
    await catalog.refresh({ immediate: true });
    assert.ok(catalog.sortedItems('added-asc')[2].firstSeen > original[0].firstSeen);
    await rm(path.join(root, 'Series/2.mp4'));
    await catalog.refresh({ immediate: true });
    await writeFile(path.join(root, 'Series/2.mp4'), 'restored');
    await catalog.refresh({ immediate: true });
    assert.equal(catalog.sortedItems().find(item => item.name === '2').firstSeen, original[0].firstSeen);
    await rename(path.join(root, 'Series/2.mp4'), path.join(root, 'Series/1.mp4'));
    await catalog.refresh({ immediate: true });
    const renamed = catalog.sortedItems().find(item => item.name === '1');
    assert.ok(renamed.firstSeen > original[0].firstSeen);
    await catalog.close();
    const restarted = new MediaCatalog({ root, dataFile: path.join(base, 'data', 'metadata.json'), watch: false,
        settleMs: 0, safetyMinMs: 600000, safetyMaxMs: 600000 });
    t.after(() => restarted.close());
    await restarted.ready;
    assert.equal(restarted.sortedItems().find(item => item.name === '1').firstSeen, renamed.firstSeen);
});

test('symlinks are excluded and delivery revalidates ancestor containment', async t => {
    const { base, root, catalog } = await fixture(t, { 'Safe/inside.mp4': 'safe' });
    const outside = path.join(base, 'outside');
    await mkdir(outside);
    await writeFile(path.join(outside, 'outside.mp4'), 'outside');
    await symlink(path.join(outside, 'outside.mp4'), path.join(root, 'linked.mp4'));
    await symlink(outside, path.join(root, 'linked-directory'), 'dir');
    await catalog.refresh({ immediate: true });
    assert.equal(catalog.sortedItems().some(item => ['linked', 'outside'].includes(item.name)), false);
    const item = catalog.sortedItems().find(entry => entry.name === 'inside');
    const opened = await catalog.openFile(item.id);
    await rename(path.join(root, 'Safe'), path.join(root, 'Safe-old'));
    await symlink(outside, path.join(root, 'Safe'), 'dir');
    assert.equal(await catalog.openFile(item.id), null);
    assert.equal((await opened.handle.readFile()).toString(), 'safe');
    await opened.handle.close();
});

test('opened-handle identity rejects an ancestor retarget restored before post-open validation', async t => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'video-catalog-race-'));
    const root = path.join(base, 'videos');
    const safe = path.join(root, 'Safe');
    const outside = path.join(base, 'outside');
    await mkdir(safe, { recursive: true });
    await mkdir(outside);
    const expected = path.join(safe, 'inside.mp4');
    const replacement = path.join(outside, 'inside.mp4');
    await writeFile(expected, 'same');
    await writeFile(replacement, 'same');
    const fixed = new Date('2020-01-01T00:00:00.000Z');
    await utimes(expected, fixed, fixed);
    await utimes(replacement, fixed, fixed);
    const catalog = new MediaCatalog({ root, dataFile: path.join(base, 'metadata.json'), watch: false,
        settleMs: 0, safetyMinMs: 600000 });
    t.after(async () => { await catalog.close(); await rm(base, { recursive: true, force: true }); });
    await catalog.ready;
    const item = catalog.sortedItems()[0];
    const originalDirectory = path.join(root, 'Safe-original');
    catalog.openFn = async (filename, flags) => {
        await rename(safe, originalDirectory);
        await symlink(outside, safe, 'dir');
        const handle = await fsp.open(filename, flags);
        await rm(safe);
        await rename(originalDirectory, safe);
        return handle;
    };
    assert.equal(await catalog.openFile(item.id), null);
});

test('synthetic Other remains distinct from a real Other folder', async t => {
    const { catalog } = await fixture(t, { 'root.mp4': 'root', 'Other/folder.mp4': 'folder' });
    const rootItem = catalog.sortedItems().find(item => item.name === 'root');
    const folderItem = catalog.sortedItems().find(item => item.name === 'folder');
    assert.equal(rootItem.collection, 'Other');
    assert.equal(folderItem.collection, 'Other');
    assert.notEqual(rootItem.collectionId, folderItem.collectionId);
    assert.equal(rootItem.syntheticCollection, true);
    assert.equal(folderItem.syntheticCollection, false);
});

test('depth and entry limits fail without publishing a partial snapshot', async t => {
    const { catalog } = await fixture(t, { 'A/one.mp4': '1' }, { maxEntries: 2 });
    assert.equal(catalog.items.size, 1);
    // The initial directory and its one file fit; adding another exceeds the bound.
    const root = catalog.root;
    await writeFile(path.join(root, 'A/two.mp4'), '2');
    await assert.rejects(catalog.refresh({ immediate: true }), /entry limit/);
    assert.equal(catalog.items.size, 1);
});

test('hidden entries count toward the traversal bound', async t => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'video-catalog-hidden-'));
    const root = path.join(base, 'videos');
    await mkdir(root);
    await Promise.all(['.one', '.two', '.three'].map(name => writeFile(path.join(root, name), 'x')));
    const catalog = new MediaCatalog({ root, dataFile: path.join(base, 'metadata.json'), watch: false,
        settleMs: 0, maxEntries: 2, safetyMinMs: 600000 });
    t.after(async () => { await catalog.close(); await rm(base, { recursive: true, force: true }); });
    await assert.rejects(catalog.ready, /entry limit/);
    assert.equal(catalog.items.size, 0);
});

test('depth limits preserve the previous complete snapshot', async t => {
    const { root, catalog } = await fixture(t, { 'A/one.mp4': '1' }, { maxDepth: 1 });
    await mkdir(path.join(root, 'A/TooDeep'));
    await writeFile(path.join(root, 'A/TooDeep/two.mp4'), '2');
    await assert.rejects(catalog.refresh({ immediate: true }), /depth limit/);
    assert.deepEqual(catalog.sortedItems().map(item => item.name), ['one']);
});

test('fresh files settle independently and stable observations eventually publish', async t => {
    let now = Date.now();
    const { root, catalog } = await fixture(t, {}, { settleMs: 1000, now: () => now });
    await mkdir(path.join(root, 'Show'));
    const growing = path.join(root, 'Show/growing.mp4');
    const stable = path.join(root, 'Show/old.mp4');
    await writeFile(growing, 'a');
    await writeFile(stable, 'old');
    await utimes(stable, new Date(now - 5000), new Date(now - 5000));
    await catalog.refresh({ immediate: true });
    assert.deepEqual(catalog.sortedItems().map(item => item.name), []);
    now += 500;
    await writeFile(growing, 'larger');
    await catalog.refresh({ immediate: true });
    now += 1001;
    await catalog.refresh({ immediate: true });
    assert.deepEqual(catalog.sortedItems().map(item => item.name), ['growing', 'old']);
});

test('old files present on the initial scan may be accepted immediately', async t => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'video-catalog-startup-'));
    const root = path.join(base, 'videos');
    await mkdir(root);
    const media = path.join(root, 'old.mp4');
    await writeFile(media, 'old');
    const now = Date.now();
    await utimes(media, new Date(now - 5000), new Date(now - 5000));
    const catalog = new MediaCatalog({ root, dataFile: path.join(base, 'metadata.json'), watch: false,
        settleMs: 1000, now: () => now, safetyMinMs: 600000 });
    t.after(async () => { await catalog.close(); await rm(base, { recursive: true, force: true }); });
    await catalog.ready;
    assert.deepEqual(catalog.sortedItems().map(item => item.name), ['old']);
});

test('refresh calls serialize and coalesce changes made during a scan', async t => {
    const { root, catalog } = await fixture(t, { 'A/one.mp4': '1' });
    const original = catalog._scan.bind(catalog);
    let active = 0;
    let maximum = 0;
    let scans = 0;
    catalog._scan = async () => {
        active++;
        maximum = Math.max(maximum, active);
        scans++;
        await new Promise(resolve => setTimeout(resolve, 20));
        const value = await original();
        active--;
        return value;
    };
    const first = catalog.refresh({ immediate: true });
    await writeFile(path.join(root, 'A/two.mp4'), '2');
    const second = catalog.refresh({ immediate: true });
    const third = catalog.refresh({ immediate: true });
    await Promise.all([first, second, third]);
    assert.equal(maximum, 1);
    assert.ok(scans <= 2);
    assert.equal(catalog.items.size, 2);
});

test('watcher-free safety scans converge automatically and back off within bounds', async t => {
    const tasks = [];
    const setTimeoutFn = (callback, delay) => {
        const task = { callback, delay, cleared: false, unref() {} };
        tasks.push(task);
        return task;
    };
    const clearTimeoutFn = task => { task.cleared = true; };
    const nextTask = () => tasks.find(task => !task.cleared);
    const runNext = async catalog => {
        const task = nextTask();
        assert.ok(task, 'expected a scheduled safety scan');
        task.cleared = true;
        task.callback();
        await new Promise(resolve => setImmediate(resolve));
        if (catalog.drainPromise) await catalog.drainPromise;
        return task.delay;
    };
    const { root, catalog } = await fixture(t, { 'A/one.mp4': '1' }, {
        watch: false, safetyMinMs: 10, safetyMaxMs: 40, setTimeoutFn, clearTimeoutFn,
    });
    assert.equal(nextTask().delay, 10);
    await writeFile(path.join(root, 'A/two.mp4'), '2');
    assert.equal(await runNext(catalog), 10);
    assert.equal(catalog.items.size, 2);
    assert.equal(catalog.cooldown, 10);
    assert.equal(await runNext(catalog), 10);
    assert.equal(catalog.cooldown, 20);
    assert.equal(await runNext(catalog), 20);
    assert.equal(catalog.cooldown, 40);
    assert.equal(await runNext(catalog), 40);
    assert.equal(catalog.cooldown, 40);
    assert.equal(nextTask().delay, 40);
});

test('unexpected watcher closure retries and obsolete watcher events are ignored', async t => {
    let calls = 0;
    const watchers = [];
    const watchFn = () => {
        calls++;
        const watcher = new EventEmitter();
        watcher.close = () => watcher.emit('close');
        watchers.push(watcher);
        return watcher;
    };
    const { catalog } = await fixture(t, {}, { watch: true, watchFn, watchRetryMinMs: 1 });
    const first = watchers[0];
    first.emit('close');
    const deadline = Date.now() + 1000;
    while (calls < 2 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok(calls >= 2);
    const replacement = catalog.watcher;
    first.emit('error', Error('late obsolete error'));
    assert.equal(catalog.watcher, replacement);
});

test('close awaits an active scan and prevents post-close publication', async t => {
    const { root, catalog } = await fixture(t, { 'A/one.mp4': '1' });
    const generation = catalog.generation;
    const original = catalog._scan.bind(catalog);
    catalog._scan = async () => {
        await new Promise(resolve => setTimeout(resolve, 30));
        return original();
    };
    await writeFile(path.join(root, 'A/two.mp4'), '2');
    const refresh = catalog.refresh({ immediate: true });
    await new Promise(resolve => setTimeout(resolve, 5));
    await catalog.close();
    await assert.rejects(refresh, /closed/);
    assert.equal(catalog.generation, generation);
});

test('watcher setup failure degrades to polling/manual refresh and closes timers', async t => {
    const { root, catalog } = await fixture(t, {}, {
        watch: true, watchFn() { throw Error('watch unavailable'); }, watchRetryMinMs: 10,
    });
    assert.equal(catalog.watcher, null);
    assert.match(catalog.snapshot().error, /polling continues/);
    await writeFile(path.join(root, 'manual.mp4'), 'x');
    await catalog.refresh({ immediate: true });
    assert.equal(catalog.items.size, 1);
});
