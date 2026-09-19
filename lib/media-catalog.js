'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const SUPPORTED = new Set(['.mp4', '.webm', '.mkv', '.mov']);
const natural = new Intl.Collator('en', { numeric: true, sensitivity: 'base', usage: 'sort' });

function compareText(a, b) {
    return natural.compare(a, b) || a.localeCompare(b, 'en');
}
function comparePath(a, b) { return compareText(a.relativePath, b.relativePath); }
function publicItem(item) {
    return {
        id: item.id, name: item.name, collection: item.collection,
        collectionId: item.collectionId, syntheticCollection: item.syntheticCollection,
        sections: [...item.sections], firstSeen: item.firstSeen,
    };
}
function mediaId(relativePath) {
    return crypto.createHash('sha256').update(relativePath).digest('base64url');
}
function isInside(root, candidate) {
    return candidate === root || candidate.startsWith(root + path.sep);
}
function sameFileIdentity(opened, pathname) {
    return typeof opened.dev === 'bigint' && typeof opened.ino === 'bigint'
        && opened.ino !== 0n && opened.dev === pathname.dev && opened.ino === pathname.ino;
}
function displayError(error, fallback = 'Catalog scan failed') {
    if (error instanceof CatalogLimitError) return error.message;
    return error?.code ? `${fallback} (${error.code})` : fallback;
}

class CatalogLimitError extends Error {
    constructor(message) { super(message); this.name = 'CatalogLimitError'; }
}

class MediaCatalog {
    constructor(options = {}) {
        this.root = path.resolve(options.root || path.join(__dirname, '..', 'videosSource'));
        this.dataFile = path.resolve(options.dataFile || path.join(__dirname, '..', 'data', 'media-metadata.json'));
        this.concurrency = options.concurrency ?? 4;
        this.maxEntries = options.maxEntries ?? 50000;
        this.maxDepth = options.maxDepth ?? 16;
        this.settleMs = options.settleMs ?? 30000;
        this.debounceMs = options.debounceMs ?? 1000;
        this.safetyMinMs = options.safetyMinMs ?? 30000;
        this.safetyMaxMs = Math.min(options.safetyMaxMs ?? 600000, 600000);
        this.watchRetryMinMs = options.watchRetryMinMs ?? 5000;
        this.watchRetryMaxMs = Math.min(options.watchRetryMaxMs ?? 600000, 600000);
        this.watchRetryDelay = this.watchRetryMinMs;
        this.watchFn = options.watchFn || fs.watch;
        this.openFn = options.openFn || fsp.open;
        this.setTimeoutFn = options.setTimeoutFn || setTimeout;
        this.clearTimeoutFn = options.clearTimeoutFn || clearTimeout;
        this.watchEnabled = options.watch !== false;
        this.now = options.now || Date.now;
        this.items = new Map();
        this.pendingFiles = new Map();
        this.metadata = { version: 1, sequence: 0, paths: {} };
        this.generation = 0;
        this.generatedAt = null;
        this.lastError = null;
        this.watchError = null;
        this.scanning = false;
        this.dirty = false;
        this.closed = false;
        this.waiters = [];
        this.cooldown = this.safetyMinMs;
        this.watcher = null;
        this.watchRetryTimer = null;
        this.scanTimer = null;
        this.safetyTimer = null;
        this.drainPromise = null;
        this.initialReconciliation = true;
        this.ready = this._initialize();
    }

    async _initialize() {
        await fsp.mkdir(this.root, { recursive: true });
        try {
            const parsed = JSON.parse(await fsp.readFile(this.dataFile, 'utf8'));
            if (parsed?.version === 1 && parsed.paths && typeof parsed.paths === 'object') {
                this.metadata = parsed;
                const recordedMaximum = Object.values(parsed.paths).reduce((maximum, record) =>
                    Number.isSafeInteger(record?.firstSeen) ? Math.max(maximum, record.firstSeen) : maximum, 0);
                this.metadata.sequence = Math.max(Number.isSafeInteger(parsed.sequence) ? parsed.sequence : 0,
                    recordedMaximum);
            }
        } catch (error) {
            if (error.code !== 'ENOENT') this.lastError = displayError(error, 'Metadata could not be read');
        }
        if (this.watchEnabled) this._startWatcher();
        return this.refresh({ immediate: true });
    }

    _startWatcher() {
        if (this.closed || this.watcher) return;
        let watcher;
        try {
            watcher = this.watchFn(this.root, { recursive: true }, () => {
                if (this.watcher === watcher) this.markDirty();
            });
            this.watcher = watcher;
            this.watchError = null;
            this.watchRetryDelay = this.watchRetryMinMs;
            watcher.on?.('error', error => this._watchFailed(watcher, error));
            watcher.on?.('close', () => this._watchClosed(watcher));
            this._clearTimer('watchRetryTimer');
        } catch (error) { this._watchUnavailable(error); }
    }

    _watchFailed(watcher, error) {
        if (this.closed || this.watcher !== watcher) return;
        this.watcher = null;
        try { watcher.close(); } catch {}
        this._watchUnavailable(error);
    }

    _watchClosed(watcher) {
        if (this.closed || this.watcher !== watcher) return;
        this.watcher = null;
        this._watchUnavailable(Error('Watcher closed'));
    }

    _watchUnavailable(error) {
        if (this.closed) return;
        this.watchError = `Filesystem watcher unavailable; polling continues${error?.code ? ` (${error.code})` : ''}`;
        this.markDirty();
        this._clearTimer('watchRetryTimer');
        this.watchRetryTimer = this.setTimeoutFn(() => this._startWatcher(), this.watchRetryDelay);
        this.watchRetryDelay = Math.min(this.watchRetryMaxMs, Math.max(this.watchRetryMinMs, this.watchRetryDelay * 2));
        this.watchRetryTimer.unref?.();
    }

    markDirty() {
        if (this.closed) return;
        this.dirty = true;
        this.cooldown = this.safetyMinMs;
        if (!this.scanning && !this.scanTimer) {
            this.scanTimer = this.setTimeoutFn(() => {
                this.scanTimer = null;
                this._startDrain();
            }, this.debounceMs);
            this.scanTimer.unref?.();
        }
        this._scheduleSafety();
    }

    refresh({ immediate = false } = {}) {
        if (this.closed) return Promise.reject(Error('Catalog is closed'));
        this.dirty = true;
        const result = new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
        if (immediate && this.scanTimer) this._clearTimer('scanTimer');
        if (!this.scanning && (immediate || !this.scanTimer)) {
            if (immediate) queueMicrotask(() => this._startDrain());
            else this.markDirty();
        }
        return result;
    }

    _startDrain() {
        if (this.closed || this.drainPromise) return this.drainPromise;
        this.drainPromise = this._drain().finally(() => { this.drainPromise = null; });
        return this.drainPromise;
    }

    async _drain() {
        if (this.closed || this.scanning) return;
        this.scanning = true;
        let failure = null;
        try {
            while (this.dirty && !this.closed) {
                this.dirty = false;
                try {
                    const changed = await this._reconcile();
                    failure = null;
                    this.lastError = null;
                    this.cooldown = changed || this.pendingFiles.size ? this.safetyMinMs
                        : Math.min(this.safetyMaxMs, Math.max(this.safetyMinMs, this.cooldown * 2));
                } catch (error) {
                    failure = error;
                    this.lastError = displayError(error);
                    this.cooldown = this.safetyMinMs;
                }
            }
        } finally {
            this.scanning = false;
            this._scheduleSafety();
            const waiters = this.waiters.splice(0);
            const finalError = this.closed ? Error('Catalog is closed') : failure;
            for (const waiter of waiters) finalError ? waiter.reject(finalError) : waiter.resolve(this.snapshot());
            if (this.dirty && !this.closed) queueMicrotask(() => this._startDrain());
        }
    }

    async _scan() {
        const rootReal = await fsp.realpath(this.root);
        const found = [];
        const directories = [{ absolute: this.root, parts: [], depth: 0 }];
        let count = 0;
        while (directories.length) {
            const batch = directories.splice(0, this.concurrency);
            const additions = await Promise.all(batch.map(async directory => {
                const children = [];
                if (directory.depth > 0) {
                    const directoryStat = await fsp.lstat(directory.absolute);
                    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) return children;
                    const directoryReal = await fsp.realpath(directory.absolute);
                    if (!isInside(rootReal, directoryReal)) return children;
                }
                const handle = await fsp.opendir(directory.absolute);
                for await (const entry of handle) {
                    if (++count > this.maxEntries) throw new CatalogLimitError(`Catalog entry limit of ${this.maxEntries} exceeded`);
                    if (entry.name.startsWith('.')) continue;
                    const parts = [...directory.parts, entry.name];
                    const absolute = path.join(directory.absolute, entry.name);
                    if (entry.isSymbolicLink()) continue;
                    if (entry.isDirectory()) {
                        if (directory.depth + 1 > this.maxDepth) {
                            throw new CatalogLimitError(`Catalog depth limit of ${this.maxDepth} exceeded`);
                        }
                        children.push({ absolute, parts, depth: directory.depth + 1 });
                    } else if (entry.isFile() && SUPPORTED.has(path.extname(entry.name).toLowerCase())) {
                        const stat = await fsp.lstat(absolute, { bigint: true });
                        if (!stat.isFile() || stat.isSymbolicLink()) continue;
                        const relativePath = parts.join('/');
                        const syntheticCollection = parts.length === 1;
                        found.push({
                            relativePath, name: path.basename(entry.name, path.extname(entry.name)),
                            collection: syntheticCollection ? 'Other' : parts[0],
                            collectionId: syntheticCollection ? 'other' : `folder-${mediaId(parts[0]).slice(0, 16)}`,
                            syntheticCollection,
                            sections: parts.length <= 2 ? [] : parts.slice(1, -1),
                            size: stat.size.toString(), mtimeNs: stat.mtimeNs.toString(),
                            mtimeMs: Number(stat.mtimeNs / 1000000n),
                        });
                    }
                }
                return children;
            }));
            for (const children of additions) directories.push(...children);
            await new Promise(resolve => setImmediate(resolve));
        }
        found.sort(comparePath);
        return found;
    }

    async _reconcile() {
        const discovered = await this._scan();
        if (this.closed) return false;
        const accepted = [];
        const now = this.now();
        const seenPaths = new Set(discovered.map(item => item.relativePath));
        for (const key of this.pendingFiles.keys()) if (!seenPaths.has(key)) this.pendingFiles.delete(key);
        for (const item of discovered) {
            const signature = `${item.size}:${item.mtimeNs}`;
            const previous = this.items.get(mediaId(item.relativePath));
            const unchangedPublished = previous && previous.size === item.size && previous.mtimeNs === item.mtimeNs;
            const oldAtStartup = this.initialReconciliation && now - item.mtimeMs >= this.settleMs;
            if (this.settleMs <= 0 || unchangedPublished || oldAtStartup) {
                this.pendingFiles.delete(item.relativePath);
                accepted.push(item);
                continue;
            }
            const pending = this.pendingFiles.get(item.relativePath);
            if (pending?.signature === signature && now - pending.since >= this.settleMs) {
                this.pendingFiles.delete(item.relativePath);
                accepted.push(item);
            } else {
                this.pendingFiles.set(item.relativePath, {
                    signature, since: pending?.signature === signature ? pending.since : now,
                });
            }
        }
        if (this.closed) return false;
        const unknown = accepted.filter(item => !this.metadata.paths[item.relativePath]);
        if (unknown.length) {
            const previousSequence = this.metadata.sequence;
            const firstSeen = ++this.metadata.sequence;
            for (const item of unknown) this.metadata.paths[item.relativePath] = { firstSeen };
            try { await this._persistMetadata(); }
            catch (error) {
                this.metadata.sequence = previousSequence;
                for (const item of unknown) delete this.metadata.paths[item.relativePath];
                throw error;
            }
        }
        const next = new Map();
        for (const item of accepted) {
            item.id = mediaId(item.relativePath);
            item.firstSeen = this.metadata.paths[item.relativePath].firstSeen;
            next.set(item.id, item);
        }
        const before = [...this.items.values()].map(item => `${item.relativePath}:${item.size}:${item.mtimeNs}`).sort().join('\n');
        const after = [...next.values()].map(item => `${item.relativePath}:${item.size}:${item.mtimeNs}`).sort().join('\n');
        if (this.closed) return false;
        this.items = next;
        this.generation++;
        this.initialReconciliation = false;
        this.generatedAt = new Date(now).toISOString();
        return before !== after;
    }

    async _persistMetadata() {
        await fsp.mkdir(path.dirname(this.dataFile), { recursive: true });
        const temporary = `${this.dataFile}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
        await fsp.writeFile(temporary, JSON.stringify(this.metadata, null, 2) + '\n', { mode: 0o600 });
        await fsp.rename(temporary, this.dataFile);
    }

    sortedItems(sort = 'name-asc') {
        const items = [...this.items.values()];
        const direction = sort.endsWith('-desc') ? -1 : 1;
        if (sort.startsWith('added-')) {
            items.sort((a, b) => direction * (a.firstSeen - b.firstSeen) || comparePath(a, b));
        } else {
            items.sort((a, b) => direction * compareText(a.name, b.name) || comparePath(a, b));
        }
        return items.map(publicItem);
    }

    snapshot(sort = 'name-asc') {
        return {
            generation: this.generation, generatedAt: this.generatedAt,
            scanning: this.scanning, pendingCount: this.pendingFiles.size,
            watcherActive: !!this.watcher, error: this.lastError || this.watchError,
            items: this.sortedItems(sort),
        };
    }

    get(id) { return this.items.get(id) || null; }
    descriptor(id) {
        const item = this.get(id);
        return item ? { id: item.id, name: item.name, url: `/media/${encodeURIComponent(item.id)}` } : null;
    }

    async openFile(id) {
        const item = this.get(id);
        if (!item) return null;
        const parts = item.relativePath.split('/');
        let cursor = this.root;
        let handle;
        try {
            for (const part of parts) {
                cursor = path.join(cursor, part);
                const stat = await fsp.lstat(cursor);
                if (stat.isSymbolicLink()) return null;
            }
            const rootReal = await fsp.realpath(this.root);
            const real = await fsp.realpath(cursor);
            if (!isInside(rootReal, real)) return null;
            handle = await this.openFn(real, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
            const [openedStat, pathStat, openedReal] = await Promise.all([
                handle.stat({ bigint: true }),
                fsp.lstat(real, { bigint: true }),
                fsp.realpath(real),
            ]);
            if (!openedStat.isFile() || !pathStat.isFile() || pathStat.isSymbolicLink()
                || !sameFileIdentity(openedStat, pathStat) || openedReal !== real || !isInside(rootReal, openedReal)
                || openedStat.size.toString() !== item.size || openedStat.mtimeNs.toString() !== item.mtimeNs) {
                await handle.close();
                this.markDirty();
                return null;
            }
            return { handle, path: real, size: Number(openedStat.size), item };
        } catch (error) {
            if (handle) await handle.close().catch(() => {});
            if (['ENOENT', 'ENOTDIR', 'ELOOP'].includes(error.code)) return null;
            throw error;
        }
    }

    _scheduleSafety() {
        if (this.closed) return;
        this._clearTimer('safetyTimer');
        this.safetyTimer = this.setTimeoutFn(() => this.refresh({ immediate: true }).catch(() => {}), this.cooldown);
        this.safetyTimer.unref?.();
    }
    _clearTimer(name) { if (this[name]) this.clearTimeoutFn(this[name]); this[name] = null; }
    async close() {
        if (this.closed) return this.drainPromise;
        this.closed = true;
        this.dirty = false;
        for (const timer of ['scanTimer', 'safetyTimer', 'watchRetryTimer']) this._clearTimer(timer);
        const watcher = this.watcher;
        this.watcher = null;
        if (watcher) { try { watcher.close(); } catch {} }
        if (this.drainPromise) await this.drainPromise;
        const waiters = this.waiters.splice(0);
        for (const waiter of waiters) waiter.reject(Error('Catalog is closed'));
    }
}

module.exports = { MediaCatalog, CatalogLimitError, compareText, mediaId, sameFileIdentity, SUPPORTED };
