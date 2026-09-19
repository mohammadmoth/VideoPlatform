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
        return { rate: 1 + Math.max(-0.04, Math.min(0.04, drift * 0.12)) };
    }

    const ALIGNMENT_INTERVAL = 100;
    const STABLE_INTERVAL = 1000;
    const ENTER_CORRECTION_DRIFT = 0.05;
    const SETTLED_DRIFT = 0.01;
    const LARGE_DRIFT = 0.8;
    const THRESHOLD_EPSILON = 0.000001;

    function median(values) {
        const ordered = [...values].sort((a, b) => a - b);
        return ordered[Math.floor(ordered.length / 2)];
    }

    // Keeps a short, robust drift history so an individual media-clock sample cannot change rate.
    class CorrectionController {
        constructor() { this.reset(); }
        reset() {
            this.state = 'aligning';
            this.samples = [];
        }
        interval() { return this.state === 'stable' ? STABLE_INTERVAL : ALIGNMENT_INTERVAL; }
        next(actual, target) {
            const drift = target - actual;
            if (!Number.isFinite(drift)) return null;
            // A large discontinuity is actionable immediately; waiting for a filter would delay recovery.
            if (Math.abs(drift) > LARGE_DRIFT) {
                this.reset();
                return { seek: target, rate: 1 };
            }
            this.samples.push(drift);
            if (this.samples.length > 3) this.samples.shift();
            if (this.samples.length < 3) return null;
            const filteredDrift = median(this.samples);
            // Two nearby samples make the median reliable while rejecting a single outlier.
            const reliable = this.samples.filter(sample => Math.abs(sample - filteredDrift) <= 0.06).length >= 2;
            if (!reliable) return null;
            const absoluteDrift = Math.abs(filteredDrift);
            if (this.state === 'correcting') {
                if (absoluteDrift < SETTLED_DRIFT - THRESHOLD_EPSILON) {
                    this.state = 'stable';
                    return { rate: 1, settled: true };
                }
                return correction(0, filteredDrift);
            }
            if (absoluteDrift > ENTER_CORRECTION_DRIFT + THRESHOLD_EPSILON) {
                this.state = 'correcting';
                return correction(0, filteredDrift);
            }
            this.state = 'stable';
            return null;
        }
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

    const api = { Clock, targetTime, correction, CorrectionController, hasRunway, completionAction };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.VideoSync = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
