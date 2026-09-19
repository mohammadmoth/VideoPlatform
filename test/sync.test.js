'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { SyncRoom } = require('../lib/sync-room');
const { Clock, targetTime, correction, hasRunway } = require('../pub/sync-core');

function setup() {
    let time = 100000;
    const room = new SyncRoom({ now: () => time });
    const master = { messages: [], send(message) { this.messages.push(message); } };
    const display = { messages: [], send(message) { this.messages.push(message); } };
    room.join(master, true);
    room.join(display, false);
    return { room, master, display, advance: ms => { time += ms; } };
}
const command = (room, client, action, extra = {}) => room.receive(client, { type: 'command', action, ...extra });
const ready = (room, client, version = room.pending.message.version) => room.receive(client, { type: 'ready', version });

test('clock removes device clock skew using RTT midpoint, preferring low latency', () => {
    const clock = new Clock();
    clock.record(1000, 1020, 6010);
    assert.equal(clock.now(1050), 6050);
    clock.record(2000, 2200, 7180);
    assert.equal(clock.offset, 5000);
    clock.record(3000, 3002, 7999);
    assert.equal(clock.offset, 4998);
    clock.record(10, 9, 100);
    assert.equal(clock.samples.length, 3);
});

test('target handles zero, future start, paused state and media end without absolute latency', () => {
    const state = { position: 0, playing: true, at: 1000 };
    assert.equal(targetTime(state, 900, 100), 0);
    assert.equal(targetTime(state, 1500, 100), 0.5);
    assert.equal(targetTime({ ...state, playing: false }, 5000, 100), 0);
    assert.equal(targetTime(state, 5000, 2), 2);
});

test('small drift adjusts rate rather than seeking; large drift seeks', () => {
    assert.deepEqual(correction(10, 10.02), { rate: 1 });
    assert.ok(correction(10, 10.2).rate > 1);
    assert.ok(correction(10, 9.8).rate < 1);
    assert.equal(correction(10, 10.7).rate, 1.04);
    assert.equal(correction(10, 9.3).rate, 0.96);
    assert.deepEqual(correction(10, 12), { seek: 12, rate: 1 });
});

test('play waits for every screen then schedules identical future start', () => {
    const { room, master, display, advance } = setup();
    command(room, master, 'play');
    const version = room.pending.message.version;
    ready(room, master);
    assert.equal(room.state.playing, false);
    advance(300);
    ready(room, display);
    assert.equal(room.pending.scheduled, true);
    assert.equal(room.state.playing, true);
    assert.equal(room.state.at, 101100);
    assert.ok(room.state.version > version);
    assert.deepEqual(master.messages.at(-1), display.messages.at(-1));
    assert.equal(room.position(), 0);
    advance(1800);
    assert.equal(room.position(), 1);
});

test('pause cancels a scheduled start, and seek to zero is not dropped', () => {
    const { room, master, display, advance } = setup();
    command(room, master, 'seek', { position: 12 });
    ready(room, master); ready(room, display);
    command(room, master, 'play');
    ready(room, master); ready(room, display);
    command(room, master, 'pause');
    advance(5000);
    assert.equal(room.state.playing, false);
    assert.equal(room.position(), 12);
    command(room, master, 'seek', { position: 0 });
    ready(room, master); ready(room, display);
    assert.equal(room.state.position, 0);
    assert.equal(room.state.playing, false);
});

test('old ready acknowledgements cannot release a newer preparation', () => {
    const { room, master, display } = setup();
    command(room, master, 'play');
    const oldVersion = room.pending.message.version;
    command(room, master, 'seek', { position: 30 });
    ready(room, master, oldVersion); ready(room, display, oldVersion);
    assert.equal(room.pending.waiting.size, 2);
    ready(room, master); ready(room, display);
    assert.equal(room.state.position, 30);
    assert.equal(room.state.playing, true);
});

test('buffer loss revokes readiness while waiting', () => {
    const { room, master, display } = setup();
    command(room, master, 'play');
    ready(room, master);
    room.receive(master, { type: 'not-ready', version: room.pending.message.version });
    ready(room, display);
    assert.equal(room.state.playing, false);
    ready(room, master);
    assert.equal(room.state.playing, true);
});

test('late join gets authoritative position and joins an active readiness barrier', () => {
    const { room, master, display, advance } = setup();
    command(room, master, 'play'); ready(room, master); ready(room, display);
    advance(2800);
    const late = { messages: [], send(message) { this.messages.push(message); } };
    room.join(late, false);
    const snapshot = late.messages.find(message => message.type === 'state');
    assert.equal(targetTime(snapshot, 102800, 100), 2);
    command(room, master, 'seek', { position: 7 });
    ready(room, master); ready(room, display);
    assert.equal(room.pending.waiting.size, 1);
    room.leave(late);
    assert.equal(room.state.playing, true);
});

test('master disconnect pauses everyone and replacement can claim control', () => {
    const { room, master, display } = setup();
    command(room, master, 'play'); ready(room, master); ready(room, display);
    room.leave(master);
    assert.equal(room.state.playing, false);
    assert.equal(room.pending, null);
    assert.equal(room.master, null);
    const replacement = { send() {} };
    room.join(replacement, true);
    assert.equal(room.master, replacement);
});

test('preparation times out instead of hanging indefinitely', () => {
    const { room, master, advance } = setup();
    command(room, master, 'play');
    ready(room, master);
    advance(20000);
    room.tick();
    assert.equal(room.pending, null);
    assert.equal(room.state.playing, false);
    assert.match(master.messages.at(-1).message, /not ready/);
});

test('invalid commands and non-controller play/seek commands are ignored', () => {
    const { room, master, display } = setup();
    for (const message of [null, [], 'text', { type: 'command', action: 'seek', position: -1 },
        { type: 'command', action: 'seek', position: '4' }, { type: 'command', action: 'seek', position: Infinity }]) {
        room.receive(master, message);
    }
    command(room, display, 'play');
    command(room, display, 'seek', { position: 10 });
    assert.equal(room.pending, null);
    assert.equal(room.state.position, 0);
    room.join(display, true);
    assert.equal(room.master, master);
});

test('scheduled start can still be cancelled by readiness revocation', () => {
    const { room, master, display, advance } = setup();
    command(room, master, 'play');
    const preparationVersion = room.pending.message.version;
    ready(room, master); ready(room, display);
    advance(400);
    room.receive(display, { type: 'not-ready', version: preparationVersion });
    assert.equal(room.state.playing, false);
    assert.ok(room.pending.message.version > preparationVersion);
    ready(room, master, preparationVersion);
    assert.equal(room.pending.waiting.size, 2);
    ready(room, master); ready(room, display);
    advance(800);
    room.tick();
    assert.equal(room.pending, null);
    assert.equal(room.state.playing, true);
});

test('play is idempotent during preparation, scheduled start, and playback', () => {
    const { room, master, display, advance } = setup();
    command(room, master, 'play');
    const preparation = room.pending;
    command(room, master, 'play');
    assert.equal(room.pending, preparation);
    ready(room, master); ready(room, display);
    const state = room.state;
    command(room, master, 'play');
    assert.equal(room.state, state);
    advance(2000);
    command(room, master, 'play');
    assert.equal(room.state, state);
});

test('a new screen during the countdown renews the readiness barrier', () => {
    const { room, master, display } = setup();
    command(room, master, 'play'); ready(room, master); ready(room, display);
    const late = { send() {} };
    room.join(late, false);
    assert.equal(room.state.playing, false);
    assert.equal(room.pending.waiting.size, 3);
    ready(room, master); ready(room, display);
    assert.equal(room.state.playing, false);
    ready(room, late);
    assert.equal(room.state.playing, true);
});

test('stale playback failures do not cancel a newer operation', () => {
    const { room, master, display } = setup();
    command(room, master, 'play'); ready(room, master); ready(room, display);
    const version = room.state.version;
    command(room, master, 'seek', { position: 10 });
    room.receive(display, { type: 'playback-error', version });
    assert.equal(room.pending.message.position, 10);
    ready(room, master); ready(room, display);
    assert.equal(room.state.playing, true);
});

test('server default clock is not affected by wall-clock adjustments', () => {
    const room = new SyncRoom();
    const before = room.now();
    const original = Date.now;
    try {
        Date.now = () => 0;
        assert.ok(room.now() >= before);
        assert.ok(room.now() - before < 1000);
    } finally { Date.now = original; }
});

test('readiness accepts MP4 timestamp priming but requires a buffered runway', () => {
    const ranges = (start, end) => ({ length: 1, start: () => start, end: () => end });
    assert.equal(hasRunway(ranges(0.083422, 2.25), 0, 100), true);
    assert.equal(hasRunway(ranges(0, 0.2), 0, 100), false);
    assert.equal(hasRunway(ranges(5, 10), 0, 100), false);
    assert.equal(hasRunway(ranges(98, 100), 99.5, 100), true);
    assert.equal(hasRunway({ length: 0 }, 100, 100), true);
});

test('playback rejection pauses all screens', () => {
    const { room, master, display } = setup();
    command(room, master, 'play'); ready(room, master); ready(room, display);
    room.receive(display, { type: 'playback-error', version: room.state.version });
    assert.equal(room.state.playing, false);
    assert.match(master.messages.at(-1).message, /could not play/);
});
