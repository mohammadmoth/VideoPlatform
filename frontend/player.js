/* global VideoSync, VideoNavigation */
(() => {
    'use strict';
    const video = document.getElementById('myVideo');
    const ui = Object.fromEntries(['back', 'join', 'sound', 'fullscreen', 'role', 'participants', 'controller',
        'play', 'pause', 'seek', 'position', 'status', 'notice'].map(id => [id, document.getElementById(id)]));
    const wantsMaster = new URL(location.href).searchParams.get('master') === 'true';
    let returnTo = '/library.html?master=true';
    if (wantsMaster) {
        let saved;
        try { saved = JSON.parse(sessionStorage.getItem('videoLibraryReturn')); } catch {}
        returnTo = VideoNavigation.playerReturn(saved, document.referrer, location.origin);
        history.replaceState({ videoPlatform: 'player', returnTo }, '');
        ui.back.hidden = false;
    }
    // performance.now is monotonic: OS clock changes must not jump the video.
    const localNow = () => performance.timeOrigin + performance.now();
    let clock = new VideoSync.Clock();
    let socket;
    let master = false;
    let joined = false;
    let desired = null;
    let pending = null;
    let startTimer;
    let reconnectTimer;
    let reconnectAttempt = 0;
    let clockTimer;
    let watchdogTimer;
    let lastInbound = 0;
    let resumeConnection = false;
    let initialPings = [];
    let clockRequests = new Set();
    let clockReplies = 0;
    let registered = false;
    let playPromise = null;
    let failedVersion = null;
    let mediaGeneration = -1;
    let mediaLoadVersion = -1;
    let controllerToken = sessionStorage.getItem('videoControllerToken');
    let needsAlignment = true;
    let lastSeek = -Infinity;
    let dragging = false;
    let disposed = false;

    const serverNow = () => clock.now(localNow());
    const connected = () => socket && socket.readyState === WebSocket.OPEN;
    function send(message) { if (connected()) socket.send(JSON.stringify(message)); }
    function status(text) { ui.status.textContent = text; }
    function command(action, extra = {}) { if (master) send({ type: 'command', action, ...extra }); }
    function ping() {
        const sent = localNow();
        clockRequests.add(sent);
        if (clockRequests.size > 40) clockRequests.delete(clockRequests.values().next().value);
        send({ type: 'clock', sent });
    }
    function stopLocal() {
        clearTimeout(startTimer);
        startTimer = null;
        video.pause();
        video.playbackRate = 1;
    }
    function controls(enabled) {
        ui.play.disabled = ui.pause.disabled = ui.seek.disabled = !enabled;
    }
    function seekTo(position) {
        if (!video.readyState || video.seeking) return false;
        try {
            video.currentTime = position;
            lastSeek = localNow();
            return true;
        } catch { return false; }
    }
    function play() {
        if (!video.paused || playPromise || failedVersion === desired?.version) return;
        const version = desired?.version;
        playPromise = video.play();
        playPromise.catch(error => {
            if (error.name === 'AbortError' || desired?.version !== version) return;
            failedVersion = version;
            ui.notice.textContent = 'Playback was blocked. Enable playback in this browser, then press Play on the controller.';
            send({ type: 'playback-error', version, mediaGeneration });
        }).finally(() => { playPromise = null; });
    }

    function prepare() {
        if (!pending || !video.readyState) return;
        const target = VideoSync.targetTime({ ...pending, playing: false }, serverNow(), video.duration);
        if (Math.abs(video.currentTime - target) > 0.03) {
            if (pending.ready) {
                pending.ready = false;
                send({ type: 'not-ready', version: pending.version, mediaGeneration });
            }
            seekTo(target);
            return;
        }
        // Require a little runway rather than just a single decoded frame.
        const buffered = VideoSync.hasRunway(video.buffered, target, video.duration);
        const ready = !video.seeking && (target >= video.duration || (video.readyState >= 3 && buffered));
        if (ready !== !!pending.ready) {
            pending.ready = ready;
            send({ type: ready ? 'ready' : 'not-ready', version: pending.version, mediaGeneration });
            status(ready ? 'Ready. Waiting for the other screens…' : 'Buffering before synchronized start…');
        }
    }

    function synchronize() {
        if (pending) {
            if (desired?.playing && serverNow() >= desired.at) pending = null;
            else { prepare(); if (!desired) return; }
        }
        if (!desired || !video.readyState || !joined) return;
        const now = serverNow();
        const target = VideoSync.targetTime(desired, now, video.duration);
        if (!desired.playing || now < desired.at) {
            needsAlignment = false;
            if (!video.paused) video.pause();
            video.playbackRate = 1;
            if (Math.abs(video.currentTime - target) > 0.04) seekTo(target);
            if (desired.playing && !startTimer) {
                startTimer = setTimeout(() => {
                    startTimer = null;
                    synchronize();
                }, Math.max(1, desired.at - serverNow()));
            }
            status(desired.playing ? 'Starting all screens together…' : 'Paused');
            return;
        }
        if (video.seeking) return;
        // Joining/restoring is an explicit realignment, not steady-state drift.
        // Do not spend seconds rate-correcting a sub-second disconnection gap.
        if (needsAlignment && video.readyState >= 3) {
            needsAlignment = false;
            if (Math.abs(video.currentTime - target) > 0.04 && seekTo(target)) return;
        }
        const adjustment = VideoSync.correction(video.currentTime, target);
        // Large errors (late join, reconnect, stall) need a seek. Small ones only change rate.
        if (adjustment.seek !== undefined && localNow() - lastSeek > 1500) {
            seekTo(adjustment.seek);
            video.playbackRate = 1;
        } else video.playbackRate = adjustment.rate;
        if (video.currentTime >= video.duration && target >= video.duration) {
            status('Finished');
            return;
        }
        if (video.readyState >= 3) {
            play();
            status(`Synchronized · difference ${Math.round((target - video.currentTime) * 1000)} ms`);
        } else status('Buffering… Playback will catch up automatically.');
    }

    function applyMedia(message) {
        if (!Number.isSafeInteger(message.mediaGeneration)) return false;
        controls(master && !!message.media);
        mediaLoadVersion = message.version;
        if (message.mediaGeneration === mediaGeneration) return false;
        stopLocal();
        mediaGeneration = message.mediaGeneration;
        if (message.media?.url) video.src = message.media.url;
        else video.removeAttribute('src');
        video.load();
        controls(master && !!message.media);
        return true;
    }

    function receive(message) {
        if (message.type === 'clock' && clockRequests.delete(message.sent)) {
            clock.record(message.sent, localNow(), message.serverTime);
            if (++clockReplies >= 5 && !registered) {
                registered = true;
                send({ type: 'hello', master: wantsMaster,
                    ...(wantsMaster && controllerToken ? { controllerToken } : {}) });
            }
        } else if (message.type === 'welcome' || message.type === 'role') {
            master = message.master;
            joined = true;
            reconnectAttempt = 0;
            if (master && message.controllerToken) {
                controllerToken = message.controllerToken;
                sessionStorage.setItem('videoControllerToken', controllerToken);
            }
            controls(master && !!desired?.media);
            ui.controller.hidden = !master;
            ui.role.textContent = master ? 'Controller' : 'Display';
            ui.join.hidden = true;
            if (video.error) send({ type: 'media-error', version: mediaLoadVersion, mediaGeneration });
            if (wantsMaster && !master) ui.notice.textContent = 'Waiting for the controller handoff…';
        } else if (message.type === 'participants') {
            ui.participants.textContent = `${message.count} screen(s) connected`;
            if (!message.hasMaster) {
                ui.notice.textContent = wantsMaster ? 'Claiming controller role…'
                    : 'No controller connected. Open /?master=true on the controlling device.';
                if (wantsMaster) send({ type: 'hello', master: true,
                    ...(controllerToken ? { controllerToken } : {}) });
            }
        } else if (message.type === 'notice') {
            ui.notice.textContent = message.message;
        } else if (message.type === 'prepare') {
            if (message.version < Math.max(desired?.version ?? -1, pending?.version ?? -1)) return;
            applyMedia(message);
            stopLocal();
            desired = null;
            pending = { ...message, ready: false };
            ui.notice.textContent = '';
            status('Buffering before synchronized start…');
            prepare();
        } else if (message.type === 'state') {
            if (message.version < Math.max(desired?.version ?? -1, pending?.version ?? -1)) return;
            applyMedia(message);
            const changed = desired?.version !== message.version;
            if (changed) {
                clearTimeout(startTimer);
                startTimer = null;
                failedVersion = null;
            }
            if (!(pending && message.playing && message.preparationVersion === pending.version
                && serverNow() < message.at)) pending = null;
            desired = message;
            synchronize();
        }
    }

    function connectionLost(active) {
        if (socket !== active) return;
        socket = null; // Retire callbacks even if the network cannot complete the close handshake.
        initialPings.forEach(clearTimeout);
        clearInterval(clockTimer);
        clearInterval(watchdogTimer);
        desired = pending = null;
        joined = master = false;
        stopLocal();
        controls(false);
        ui.join.hidden = false;
        ui.join.disabled = false;
        ui.join.textContent = 'Reconnect';
        status('Disconnected. Playback paused; reconnecting…');
        active.close();
        if (!disposed) reconnectTimer = setTimeout(connect, Math.min(1000 * 2 ** reconnectAttempt++, 10000));
    }

    function connect() {
        if (disposed || (socket && socket.readyState < WebSocket.CLOSING)) return;
        clearTimeout(reconnectTimer);
        clock = new VideoSync.Clock();
        clockRequests = new Set();
        clockReplies = 0;
        registered = false;
        needsAlignment = true;
        status('Connecting and measuring server time…');
        const active = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/`, 'echo-protocol');
        socket = active;
        lastInbound = localNow();
        watchdogTimer = setInterval(() => {
            if (localNow() - lastInbound > 10000) connectionLost(active);
        }, 1000);
        active.addEventListener('open', () => {
            if (socket !== active) return;
            initialPings = Array.from({ length: 8 }, (_, i) => setTimeout(ping, i * 80));
            clockTimer = setInterval(ping, 3000);
        });
        active.addEventListener('message', event => {
            if (socket !== active) return;
            lastInbound = localNow();
            let message;
            try { message = JSON.parse(event.data); } catch { return; }
            if (message && typeof message === 'object') receive(message);
        });
        active.addEventListener('close', () => connectionLost(active));
        active.addEventListener('error', () => {
            if (socket === active) status('Connection failed. Check the server and network.');
        });
    }

    ui.back.addEventListener('click', () => {
        if (VideoNavigation.canGoBack(document.referrer, location.origin, history.state)) history.back();
        else location.assign(returnTo);
    });
    ui.join.addEventListener('click', () => { ui.join.disabled = true; connect(); });
    ui.play.addEventListener('click', () => {
        ui.notice.textContent = '';
        if (video.ended) command('seek', { position: 0 });
        command('play');
    });
    ui.pause.addEventListener('click', () => command('pause'));
    ui.seek.addEventListener('input', () => { dragging = true; });
    ui.seek.addEventListener('change', () => {
        dragging = false;
        command('seek', { position: Number(ui.seek.value) });
    });
    ui.sound.addEventListener('click', () => {
        video.muted = !video.muted;
        ui.sound.textContent = video.muted ? 'Enable sound' : 'Mute';
    });
    ui.fullscreen.addEventListener('click', () => {
        const request = video.requestFullscreen?.();
        if (request) request.catch(() => { ui.notice.textContent = 'Fullscreen is unavailable in this browser.'; });
        else ui.notice.textContent = 'Fullscreen is unavailable in this browser.';
    });
    for (const event of ['loadedmetadata', 'canplay', 'seeked', 'progress', 'waiting']) {
        video.addEventListener(event, synchronize);
    }
    video.addEventListener('error', () => {
        ui.notice.textContent = 'The video could not be loaded. Check that the file exists and the browser supports its container and codecs.';
        if (joined) send({ type: 'media-error', version: mediaLoadVersion, mediaGeneration });
    });
    video.addEventListener('ended', () => {
        const action = VideoSync.completionAction(master, desired?.playing);
        if (action) command(action);
    });
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden && connected()) { ping(); synchronize(); }
    });
    function update() {
        synchronize();
        if (Number.isFinite(video.duration)) ui.seek.max = video.duration;
        if (!dragging) ui.seek.value = video.currentTime;
        const seconds = Math.floor(video.currentTime);
        ui.position.textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
    }
    let syncTimer = setInterval(update, 100);
    window.addEventListener('pagehide', () => {
        resumeConnection = !!socket || !!reconnectTimer;
        disposed = true;
        clearInterval(syncTimer);
        clearTimeout(reconnectTimer);
        stopLocal();
        if (socket) connectionLost(socket);
    });
    window.addEventListener('pageshow', event => {
        if (!event.persisted) return;
        disposed = false;
        syncTimer = setInterval(update, 100);
        if (resumeConnection) connect();
    });
})();
