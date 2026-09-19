'use strict';
const { performance } = require('node:perf_hooks');
const monotonicNow = () => performance.timeOrigin + performance.now();

// All media positions are seconds; all timestamps are server milliseconds.
class SyncRoom {
    constructor({ now = monotonicNow, startDelay = 800, prepareTimeout = 20000 } = {}) {
        this.now = now;
        this.startDelay = startDelay;
        this.prepareTimeout = prepareTimeout;
        this.clients = new Map();
        this.master = null;
        this.version = 0;
        this.state = { version: 0, playing: false, position: 0, at: now() };
        this.pending = null;
    }

    send(client, message) { client.send(message); }

    broadcast(message) {
        for (const client of this.clients.keys()) this.send(client, message);
    }

    position() {
        return this.state.position + (this.state.playing
            ? Math.max(0, this.now() - this.state.at) / 1000 : 0);
    }

    status() {
        this.broadcast({ type: 'participants', count: this.clients.size, hasMaster: !!this.master });
    }

    join(client, wantsMaster) {
        this.finishScheduled();
        if (this.clients.has(client)) return;
        this.clients.set(client, {});
        if (wantsMaster && !this.master) this.master = client;
        this.send(client, { type: 'welcome', master: this.master === client });
        this.send(client, { type: 'state', ...this.state });
        if (this.pending) {
            if (this.pending.scheduled) {
                this.prepare(this.pending.message.position, this.pending.message.playing);
            } else {
                this.pending.waiting.add(client);
                this.send(client, this.pending.message);
            }
        }
        this.status();
    }

    leave(client) {
        this.finishScheduled();
        this.clients.delete(client);
        if (this.master === client) {
            this.master = null;
            this.pause();
        } else if (this.pending) {
            this.pending.waiting.delete(client);
            this.maybeStart();
        }
        this.status();
    }

    pause(position = this.position(), error) {
        this.pending = null;
        this.state = { version: ++this.version, playing: false, position, at: this.now() };
        this.broadcast({ type: 'state', ...this.state });
        if (error) this.broadcast({ type: 'notice', message: error });
    }

    prepare(position, playing) {
        this.state = { version: ++this.version, playing: false, position, at: this.now() };
        const message = { type: 'prepare', ...this.state, playing };
        this.pending = {
            message, waiting: new Set(this.clients.keys()), deadline: this.now() + this.prepareTimeout,
        };
        this.broadcast(message);
        this.maybeStart();
    }

    maybeStart() {
        if (!this.pending || this.pending.waiting.size || this.pending.scheduled) return;
        const { position, playing, version: preparationVersion } = this.pending.message;
        this.pending.scheduled = true;
        this.state = { version: ++this.version, position, playing, at: this.now() + this.startDelay, preparationVersion };
        // Retain the generation until the deadline so readiness can still be revoked.
        if (!playing) this.pending = null;
        this.broadcast({ type: 'state', ...this.state });
    }

    receive(client, message) {
        if (!message || typeof message !== 'object' || Array.isArray(message)) return;
        if (message.type === 'clock' && Number.isFinite(message.sent)) {
            this.send(client, { type: 'clock', sent: message.sent, serverTime: this.now() });
            return;
        }
        if (message.type === 'hello') {
            this.join(client, message.master === true);
            return;
        }
        if (!this.clients.has(client)) return;
        this.finishScheduled();
        if (message.type === 'ready' && this.pending && message.version === this.pending.message.version) {
            this.pending.waiting.delete(client);
            this.maybeStart();
        } else if (message.type === 'not-ready' && this.pending && message.version === this.pending.message.version) {
            if (this.pending.scheduled) {
                this.prepare(this.pending.message.position, this.pending.message.playing);
            } else this.pending.waiting.add(client);
        } else if (message.type === 'media-error' || (message.type === 'playback-error' && message.version === this.state.version)) {
            // A browser refusing playback must not leave the other screens running alone.
            this.pause(this.position(), 'A screen could not play the video. Check its playback permission or media error, then retry.');
        } else if (message.type === 'command' && client === this.master) {
            if (message.action === 'pause') this.pause();
            else if (message.action === 'play' && !this.state.playing && !this.pending?.message.playing) {
                this.prepare(this.position(), true);
            }
            else if (message.action === 'seek' && Number.isFinite(message.position)
                && message.position >= 0 && message.position <= 7 * 24 * 3600) {
                this.prepare(message.position, this.pending ? this.pending.message.playing : this.state.playing);
            }
        }
    }

    finishScheduled() {
        if (this.pending?.scheduled && this.now() >= this.state.at) this.pending = null;
    }

    tick() {
        this.finishScheduled();
        if (this.pending && !this.pending.scheduled) {
            if (this.now() >= this.pending.deadline) {
                this.pause(this.state.position, 'Start cancelled: a screen was not ready within 20 seconds. Check loading on each screen, then retry.');
            }
        } else this.broadcast({ type: 'state', ...this.state });
    }
}

module.exports = { SyncRoom };
