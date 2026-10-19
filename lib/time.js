'use strict';
// One clock and one time zone for the whole app. Every "now" goes through the clock so tests can drive time;
// every local-calendar question (what day is it, when was midnight, how do we print it) goes through LocalTime.

/** @param {() => Date} [now] injected clock (tests); defaults to the wall clock */
function createClock(now) {
    const read = typeof now === 'function' ? now : () => new Date();
    return { now: () => new Date(read().getTime()), iso: () => read().toISOString(), ms: () => read().getTime() };
}

class LocalTime {
    /** @param {string} zone IANA zone, e.g. Europe/London. Throws RangeError for an unknown zone. */
    constructor(zone) {
        this.zone = zone;
        const f = (opts, locale = 'en-GB') => new Intl.DateTimeFormat(locale, { timeZone: zone, ...opts });
        this._day = f({ year: 'numeric', month: '2-digit', day: '2-digit' }, 'en-CA');
        this._parts = f({ hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }, 'en-US');
        this._hour = f({ hourCycle: 'h23', hour: '2-digit' });
        this.formats = {
            csvDate: f({ dateStyle: 'short' }),
            csvTime: f({ timeStyle: 'medium' }),
            when: f({ weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }),
            whenSeconds: f({ weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' }),
            hm: f({ hour: '2-digit', minute: '2-digit' })
        };
    }
    /** Local calendar day YYYY-MM-DD containing the instant. */
    day(iso) { return this._day.format(new Date(iso)); }
    /** Local hour 0-23. */
    hour(iso) { return Number(this._hour.format(new Date(iso))); }
    /** Format with a named preset: csvDate | csvTime | when | whenSeconds | hm. */
    fmt(iso, preset) { return this.formats[preset].format(new Date(iso)); }
    /** Offset of the zone from UTC at that instant, in ms (BST = +3600000). */
    offsetMs(date) {
        const p = this._parts.formatToParts(date).reduce((acc, x) => (acc[x.type] = x.value, acc), {});
        return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - date.getTime();
    }
    /** ISO instant of local midnight for the day containing `iso` (works across BST/GMT changes). */
    dayStart(iso) {
        const day = this.day(iso);
        const naive = Date.parse(`${day}T00:00:00Z`);
        let guess = new Date(naive);
        for (let i = 0; i < 3; i++) {
            const corrected = new Date(naive - this.offsetMs(guess));
            if (corrected.getTime() === guess.getTime()) break;
            guess = corrected;
        }
        return guess.toISOString();
    }
}

module.exports = { createClock, LocalTime };
