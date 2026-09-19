(function (root) {
    'use strict';

    class Clock {
        constructor() { this.samples = []; this.offset = 0; }
        record(sent, received, serverTime) {
            if (![sent, received, serverTime].every(Number.isFinite) || received < sent) return;
            this.samples.push({ rtt: received - sent, offset: serverTime - (sent + received) / 2 });
            if (this.samples.length > 30) this.samples.shift();
            // The lowest-RTT sample is least affected by queueing and Wi-Fi jitter.
            this.offset = this.samples.reduce((best, sample) => sample.rtt < best.rtt ? sample : best).offset;
        }
        now(localTime) { return localTime + this.offset; }
    }

    function targetTime(state, now, duration) {
        const position = state.position + (state.playing ? Math.max(0, now - state.at) / 1000 : 0);
        return Math.max(0, Math.min(position, Number.isFinite(duration) ? duration : Infinity));
    }

    function correction(actual, target) {
        const drift = target - actual;
        if (Math.abs(drift) > 0.8) return { seek: target, rate: 1 };
        if (Math.abs(drift) < 0.04) return { rate: 1 };
        return { rate: 1 + Math.max(-0.04, Math.min(0.04, drift * 0.12)) };
    }

    function hasRunway(buffered, target, duration) {
        if (target >= duration) return true;
        for (let i = 0; i < buffered.length; i++) {
            // MP4 edit lists/audio priming can put the first sample slightly after zero.
            if (buffered.start(i) <= target + 0.15
                && buffered.end(i) >= Math.min(target + 1, duration)) return true;
        }
        return false;
    }

    function completionAction(master, playing) {
        return master && playing ? 'pause' : null;
    }

    const api = { Clock, targetTime, correction, hasRunway, completionAction };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.VideoSync = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
