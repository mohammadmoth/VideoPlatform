'use strict';
const { performance } = require('node:perf_hooks');
const crypto = require('node:crypto');
const monotonicNow = () => performance.timeOrigin + performance.now();

// All media positions are seconds; all timestamps are server milliseconds.
class SyncRoom {
    constructor({ now = monotonicNow, startDelay = 800, prepareTimeout = 20000, resolveMedia = null } = {}) {
        this.now = now;
        this.startDelay = startDelay;
        this.prepareTimeout = prepareTimeout;
        this.resolveMedia = resolveMedia;
        this.clients = new Map();
        this.master = null;
        this.controllerToken = null;
        this.version = 0;
        this.mediaGeneration = 0;
        this.state = {
            version: 0, playing: false, position: 0, at: now(),
            media: null, mediaGeneration: 0,
        };
        this.pending = null;
    }

    send(client, message) { client.send(message); }
    broadcast(message) { for (const client of this.clients.keys()) this.send(client, message); }
    position() {
        return this.state.position + (this.state.playing
            ? Math.max(0, this.now() - this.state.at) / 1000 : 0);
    }
    status() {
        const count = [...this.clients.values()].filter(client => client.playback).length;
        this.broadcast({ type: 'participants', count, hasMaster: !!this.master });
    }
    isControllerToken(token) {
        return !!this.master && typeof token === 'string' && token === this.controllerToken;
    }

    join(client, wantsMaster, suppliedToken, playback = true) {
        this.finishScheduled();
        const existing = this.clients.has(client);
        if (!existing) this.clients.set(client, { playback });
        if (wantsMaster && (!this.master || this.isControllerToken(suppliedToken))) {
            const previousMaster = this.master;
            this.master = client;
            if (previousMaster !== client) {
                this.controllerToken = crypto.randomBytes(32).toString('base64url');
            }
            if (previousMaster && previousMaster !== client) {
                this.clients.delete(previousMaster);
                this.send(previousMaster, { type: 'role', master: false });
                this.pending?.waiting.delete(previousMaster);
            }
        }
        this.send(client, {
            type: existing ? 'role' : 'welcome', master: this.master === client,
            ...(this.master === client ? { controllerToken: this.controllerToken } : {}),
        });
        if (!existing) {
            this.send(client, { type: 'state', ...this.state });
            if (this.pending && playback) {
                if (this.pending.scheduled) this.prepare(this.pending.message.position, this.pending.message.playing);
                else {
                    this.pending.waiting.add(client);
                    this.send(client, this.pending.message);
                }
            }
        }
        this.maybeStart();
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

    baseState() { return { media: this.state.media, mediaGeneration: this.state.mediaGeneration }; }
    pause(position = this.position(), error) {
        this.pending = null;
        this.state = { version: ++this.version, playing: false, position, at: this.now(), ...this.baseState() };
        this.broadcast({ type: 'state', ...this.state });
        if (error) this.broadcast({ type: 'notice', message: error });
    }

    select(media) {
        this.pending = null;
        this.state = {
            version: ++this.version, playing: false, position: 0, at: this.now(),
            media, mediaGeneration: ++this.mediaGeneration,
        };
        this.broadcast({ type: 'state', ...this.state });
    }

    prepare(position, playing) {
        this.state = {
            version: ++this.version, playing: false, position, at: this.now(), ...this.baseState(),
        };
        const message = { type: 'prepare', ...this.state, playing };
        this.pending = {
            message, waiting: new Set([...this.clients].filter(([, details]) => details.playback)
                .map(([client]) => client)), deadline: this.now() + this.prepareTimeout,
        };
        this.broadcast(message);
        this.maybeStart();
    }

    maybeStart() {
        if (!this.pending || this.pending.waiting.size || this.pending.scheduled) return;
        const { position, playing, version: preparationVersion } = this.pending.message;
        this.pending.scheduled = true;
        this.state = {
            version: ++this.version, position, playing, at: this.now() + this.startDelay,
            preparationVersion, ...this.baseState(),
        };
        if (!playing) this.pending = null;
        this.broadcast({ type: 'state', ...this.state });
    }

    samePendingMedia(message) {
        return message.mediaGeneration === this.pending?.message.mediaGeneration;
    }

    receive(client, message) {
        if (!message || typeof message !== 'object' || Array.isArray(message)) return;
        if (message.type === 'clock' && Number.isFinite(message.sent)) {
            this.send(client, { type: 'clock', sent: message.sent, serverTime: this.now() });
            return;
        }
        if (message.type === 'hello') {
            this.join(client, message.master === true,
                typeof message.controllerToken === 'string' ? message.controllerToken : null,
                message.screen !== false);
            return;
        }
        if (!this.clients.has(client)) return;
        this.finishScheduled();
        if (message.type === 'ready' && this.pending && message.version === this.pending.message.version
            && this.samePendingMedia(message)) {
            this.pending.waiting.delete(client);
            this.maybeStart();
        } else if (message.type === 'not-ready' && this.pending && message.version === this.pending.message.version
            && this.samePendingMedia(message)) {
            if (this.pending.scheduled) this.prepare(this.pending.message.position, this.pending.message.playing);
            else this.pending.waiting.add(client);
        } else if (message.type === 'media-error' && message.mediaGeneration === this.state.mediaGeneration
            && message.version === this.state.version) {
            this.pause(this.position(), 'A screen could not load the selected video. Check its format and availability, then retry.');
        } else if (message.type === 'playback-error' && message.version === this.state.version
            && message.mediaGeneration === this.state.mediaGeneration) {
            this.pause(this.position(), 'A screen could not play the video. Check its playback permission or media error, then retry.');
        } else if (message.type === 'command' && client === this.master) {
            if (message.action === 'select' && typeof message.mediaId === 'string' && this.resolveMedia) {
                const media = this.resolveMedia(message.mediaId);
                if (media) this.select(media);
            } else if (message.action === 'pause') this.pause();
            else if (message.action === 'play' && (!this.resolveMedia || this.state.media)
                && !this.state.playing && !this.pending?.message.playing) {
                this.prepare(this.position(), true);
            } else if (message.action === 'seek' && (!this.resolveMedia || this.state.media)
                && Number.isFinite(message.position)
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
