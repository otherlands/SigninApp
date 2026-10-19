'use strict';
// Every background job in one place, with its own health: when it last ran, whether it worked, how long it took,
// and the last error. Replaces bare setInterval(() => fn().catch(() => {})) so a dead poller is visible on
// /api/health and /metrics instead of failing silently.

class Scheduler {
    /** @param {{ log?: object, now?: () => number }} [o] */
    constructor(o = {}) {
        this.log = o.log || { error() { }, warn() { }, info() { } };
        this.now = o.now || Date.now;
        this.jobs = new Map();
        this.started = false;
    }
    /**
     * Register a job. It runs every `everyMs` once start() is called (and immediately when `atStart`).
     * A run still in progress is not started again (async jobs cannot pile up behind a slow network).
     */
    every(name, everyMs, fn, { atStart = false } = {}) {
        this.jobs.set(name, { name, everyMs, fn, atStart, timer: null, running: false, runs: 0, failures: 0, lastRun: null, lastOk: null, lastError: null, lastDurationMs: null });
        if (this.started) this._arm(this.jobs.get(name));
        return this;
    }
    start() {
        if (this.started) return this;
        this.started = true;
        for (const job of this.jobs.values()) this._arm(job);
        return this;
    }
    stop() {
        for (const job of this.jobs.values()) { clearInterval(job.timer); job.timer = null; }
        this.started = false;
    }
    _arm(job) {
        job.timer = setInterval(() => { this.run(job.name); }, job.everyMs);
        if (typeof job.timer.unref === 'function') job.timer.unref();
        if (job.atStart) this.run(job.name);
    }
    /** Run a job now (also used by tests and admin "run now"). Never throws; the result is recorded. */
    async run(name) {
        const job = this.jobs.get(name);
        if (!job) throw new Error(`no job ${name}`);
        if (job.running) return { skipped: true, reason: 'still running' };
        job.running = true;
        const t0 = this.now();
        try {
            const result = await job.fn();
            // A job may report a soft failure ({ ok: false, error }) without throwing, e.g. a controller that answered 401.
            if (result && result.ok === false) throw new Error(result.error || 'job reported failure');
            job.lastOk = true; job.lastError = null;
            return result;
        } catch (error) {
            job.lastOk = false; job.failures++; job.lastError = error.message || String(error);
            this.log.error(`job ${name} failed`, { job: name, error: job.lastError });
            return { ok: false, error: job.lastError };
        } finally {
            job.runs++; job.running = false; job.lastRun = new Date(t0).toISOString(); job.lastDurationMs = this.now() - t0;
        }
    }
    health() {
        return [...this.jobs.values()].map(j => ({
            name: j.name, everyS: Math.round(j.everyMs / 1000), runs: j.runs, failures: j.failures, running: j.running,
            lastRun: j.lastRun, lastOk: j.lastOk, lastError: j.lastError, lastDurationMs: j.lastDurationMs
        }));
    }
}

module.exports = { Scheduler };
