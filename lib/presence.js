'use strict';
// Presence engine (v3.4 Wi-Fi brace · v3.5 BLE brace · v3.6 direction + auto-out).
//
// Two independent carriers per person: the phone on the office Wi-Fi (UniFi controller client list) and a BLE
// beacon tag on their keys (heard by the door scanners and one inside anchor). Rules, in order of authority:
//   1. Deliberate acts (card / kiosk / tap / admin) are truth.
//   2. Inference may SIGN IN (over-count is the safe failure). Sources: 'wifi', 'ble'.
//   3. Inference may SIGN OUT only when the sign-in was itself inferred AND both braces agree the person left
//      (walked-out sequence door→silence, and phone absent >= outAfterMs). "Inference may undo inference;
//      only a human may undo a human."
//   4. Otherwise absence is SHOWN, never acted on: `probablyLeft` badge on kiosk / fire page / who-is-on-site.txt.
// Everything here is pure against injected `now`, so tests drive time explicitly.

const DEFAULTS = {
    wifiPollMs: 30_000,          // controller poll cadence
    wifiAbsentMs: 5 * 60_000,    // phone not in the client list for this long = "phone gone"
    tagAbsentMs: 3 * 60_000,     // tag not heard by any scanner for this long = "tag gone"
    outAfterMs: 10 * 60_000,     // both braces absent for this long before an inferred sign-in may be closed
    sequenceMs: 2 * 60_000,      // door → anchor (or anchor → door) within this window = a direction
    tagBatteryDays: 7            // enrolled tag not heard for this long while its owner has been in = battery/lost
};

class Presence {
    /**
     * @param {object} o
     * @param {import('./store').Store} o.store
     * @param {(person, opts) => void} o.signStaff   app's signStaff({person, direction, source, device, note})
     * @param {() => Array} o.staffWithStatus       app's staffWithStatus()
     * @param {object} o.unifi  {url, apiKey, site, path, fetch, ssid}
     * @param {Set<string>} o.doorScanners  scanner names that sit at doors (e.g. front-door, back-door)
     * @param {Set<string>} o.anchorScanners scanner names inside the building
     */
    constructor(o) {
        this.store = o.store;
        this.signStaff = o.signStaff;
        this.staffWithStatus = o.staffWithStatus;
        this.cfg = { ...DEFAULTS, ...(o.thresholds || {}) };
        this.unifi = { site: 'default', path: '/proxy/network/api/s/{site}/stat/sta', fetch: globalThis.fetch, ...(o.unifi || {}) };
        this.doorScanners = o.doorScanners || new Set(['front-door', 'back-door']);
        this.anchorScanners = o.anchorScanners || new Set(['anchor']);
        this.log = o.log || (() => { });
        this.now = o.now || (() => new Date());   // injectable clock: tests drive time, the server uses the wall clock
        this.lastWifiPoll = null;      // {at, ok, count, error}
        this.wifiSeen = new Map();     // MAC -> {at, ap, hostname}
        this.scanners = new Map();     // scanner -> lastReportAt
        this.enabledWifi = Boolean(this.unifi.url && this.unifi.apiKey);
    }

    // ---- Wi-Fi brace ---------------------------------------------------------
    /** Poll the UniFi controller once; records enrolled phones as sightings and applies the rules. */
    async pollWifi(now = this.now()) {
        if (!this.enabledWifi) return { skipped: true };
        const url = this.unifi.url.replace(/\/+$/, '') + this.unifi.path.replace('{site}', encodeURIComponent(this.unifi.site));
        try {
            const res = await this.unifi.fetch(url, { headers: { 'X-API-KEY': this.unifi.apiKey, Accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
            if (!res.ok) throw new Error(`controller answered ${res.status}`);
            const json = await res.json();
            const clients = Array.isArray(json) ? json : (json.data || []);
            this.ingestWifiClients(clients, now);
            this.lastWifiPoll = { at: now.toISOString(), ok: true, count: clients.length };
        } catch (error) {
            this.lastWifiPoll = { at: now.toISOString(), ok: false, error: error.message };
        }
        return this.lastWifiPoll;
    }
    /** Pure: take a controller client list and record enrolled phones. Unenrolled MACs are kept in memory only (for the picker). */
    ingestWifiClients(clients, now = this.now()) {
        const at = now.toISOString();
        this.wifiSeen.clear();
        for (const c of clients) {
            const mac = normaliseMac(c.mac || '');
            if (!mac) continue;
            if (this.unifi.ssid && c.essid && c.essid !== this.unifi.ssid) continue;
            this.wifiSeen.set(mac, { at, ap: c.ap_name || c.ap_mac || null, hostname: c.hostname || c.name || null });
            const person = this.store.getPersonByPhone(mac);
            if (person) this.store.addSighting({ kind: 'wifi', ident: mac, scanner: c.ap_name || c.ap_mac || 'wifi', rssi: c.rssi ?? null, at });
        }
        this.applyRules(now);
    }

    // ---- BLE brace ------------------------------------------------------------
    /** A scanner posted a batch of sightings. Enrolled tags are stored; unknown tags kept only for the enrolment picker (10 min). */
    ingestBle(scanner, sightings, now = this.now()) {
        const name = String(scanner || 'scanner').slice(0, 40);
        this.scanners.set(name, now.toISOString());
        let enrolled = 0;
        for (const s of sightings || []) {
            const ident = normaliseTag(s.tag || '');
            if (!ident) continue;
            const at = s.at && !Number.isNaN(Date.parse(s.at)) ? new Date(s.at).toISOString() : now.toISOString();
            const person = this.store.getPersonByTag(ident);
            this.store.addSighting({ kind: person ? 'ble' : 'ble-unknown', ident, scanner: name, rssi: Number.isFinite(s.rssi) ? s.rssi : null, at });
            if (person) enrolled++;
        }
        this.applyRules(now);
        return { scanner: name, received: (sightings || []).length, enrolled };
    }

    // ---- the rules --------------------------------------------------------------
    /** Per-person evidence: phone/tag last seen, walked-in / walked-out sequence, and the badge. */
    evidence(person, now = this.now()) {
        const nowMs = now.getTime();
        const ev = { phoneSeen: null, phonePresent: false, tagSeen: null, tagScanner: null, tagPresent: false, sequence: null, sequenceAt: null };
        if (person.phoneMac) {
            const last = this.store.lastSighting(person.phoneMac);
            if (last) { ev.phoneSeen = last.at; ev.phonePresent = nowMs - Date.parse(last.at) < this.cfg.wifiAbsentMs; }
        }
        if (person.tagId) {
            const recent = this.store.recentSightings(person.tagId, { since: new Date(nowMs - 30 * 60_000).toISOString(), limit: 200 });
            if (recent.length) {
                ev.tagSeen = recent[0].at; ev.tagScanner = recent[0].scanner;
                ev.tagPresent = nowMs - Date.parse(recent[0].at) < this.cfg.tagAbsentMs;
                Object.assign(ev, this.direction(recent, nowMs));
            }
        }
        return ev;
    }
    /** Walk newest→oldest: door then anchor (within sequenceMs) = 'in'; anchor then door then silence (>= tagAbsentMs) = 'out'. */
    direction(recentDesc, nowMs) {
        const kind = s => this.doorScanners.has(s.scanner) ? 'door' : this.anchorScanners.has(s.scanner) ? 'anchor' : null;
        // collapse consecutive sightings from the same scanner class into segments [{k, first, last}]
        const segs = [];
        for (const s of [...recentDesc].reverse()) {
            const k = kind(s); if (!k) continue;
            const t = Date.parse(s.at);
            if (segs.length && segs[segs.length - 1].k === k) segs[segs.length - 1].last = t; else segs.push({ k, first: t, last: t, scanner: s.scanner });
        }
        if (segs.length < 2) return {};
        const a = segs[segs.length - 2], b = segs[segs.length - 1];
        if (b.first - a.last > this.cfg.sequenceMs) return {};
        if (a.k === 'door' && b.k === 'anchor') return { sequence: 'in', sequenceAt: new Date(b.first).toISOString(), via: a.scanner };
        if (a.k === 'anchor' && b.k === 'door' && nowMs - b.last >= this.cfg.tagAbsentMs) return { sequence: 'out', sequenceAt: new Date(b.last).toISOString(), via: b.scanner };
        return {};
    }
    /** Apply the rules to every active person. Returns the list of actions taken (for tests/logs). */
    applyRules(now = this.now()) {
        const actions = [];
        const nowMs = now.getTime();
        for (const p of this.staffWithStatus()) {
            const person = this.store.getPerson(p.id);
            if (!person.phoneMac && !person.tagId) continue;
            const ev = this.evidence(person, now);
            const inferredIn = p.signedIn && ['wifi', 'ble'].includes(p.lastSource);
            if (!p.signedIn) {
                // Rule 2: any fresh evidence of presence signs in (over-count is safe). Only act on evidence newer than the last sign-out.
                const lastOut = this.store.latestPresenceEvent(person.id);
                const after = lastOut ? Date.parse(lastOut.at) : 0;
                const fresh = (iso) => iso && Date.parse(iso) > after;
                if (ev.sequence === 'in' && fresh(ev.sequenceAt)) {
                    this.signStaff({ person, direction: 'in', source: 'ble', device: ev.via, at: now.toISOString(), note: `walked in: tag heard at ${ev.via} then inside at ${ev.tagScanner} (${hhmm(ev.sequenceAt)})` });
                    actions.push({ person: person.name, action: 'in', by: 'ble-sequence' });
                } else if (ev.phonePresent && fresh(ev.phoneSeen)) {
                    this.signStaff({ person, direction: 'in', source: 'wifi', device: 'wifi', at: now.toISOString(), note: `phone joined the office Wi-Fi ${hhmm(ev.phoneSeen)}` });
                    actions.push({ person: person.name, action: 'in', by: 'wifi' });
                } else if (ev.tagPresent && fresh(ev.tagSeen) && this.anchorScanners.has(ev.tagScanner)) {
                    this.signStaff({ person, direction: 'in', source: 'ble', device: ev.tagScanner, at: now.toISOString(), note: `tag heard inside (${ev.tagScanner}) ${hhmm(ev.tagSeen)}` });
                    actions.push({ person: person.name, action: 'in', by: 'ble-inside' });
                }
                continue;
            }
            // Signed in. Rule 3: inferred sign-in + both braces gone long enough + (if tagged) an out sequence = auto sign-out.
            const phoneGone = !person.phoneMac || (ev.phoneSeen && nowMs - Date.parse(ev.phoneSeen) >= this.cfg.outAfterMs) || (!ev.phoneSeen && person.phoneMac && nowMs - Date.parse(p.since) >= this.cfg.outAfterMs);
            const tagGone = !person.tagId || (ev.tagSeen && nowMs - Date.parse(ev.tagSeen) >= this.cfg.outAfterMs) || (!ev.tagSeen && person.tagId && nowMs - Date.parse(p.since) >= this.cfg.outAfterMs);
            const exitSeen = !person.tagId || ev.sequence === 'out';
            const bothBraces = person.phoneMac && person.tagId;
            if (inferredIn && bothBraces && phoneGone && tagGone && exitSeen) {
                this.signStaff({ person, direction: 'out', source: 'ble+wifi', device: 'presence', at: now.toISOString(), note: `walked out via ${ev.via} ${hhmm(ev.sequenceAt)}; phone last seen ${hhmm(ev.phoneSeen)}, tag last heard ${hhmm(ev.tagSeen)} at ${ev.tagScanner}` });
                actions.push({ person: person.name, action: 'out', by: 'ble+wifi' });
            }
            // Rule 4 (single brace, or a human signed in): nothing is written; the badge is computed on read (see badge()).
        }
        return actions;
    }
    /** Badge for a signed-in person: 'here' (any brace present), 'probably-left' (all enrolled braces absent), or null (nothing enrolled). */
    badge(person, now = this.now()) {
        if (!person.phoneMac && !person.tagId) return null;
        const ev = this.evidence(person, now);
        const present = ev.phonePresent || ev.tagPresent;
        if (present) return { state: 'here', phoneSeen: ev.phoneSeen, tagSeen: ev.tagSeen, tagScanner: ev.tagScanner };
        const lastSeen = [ev.phoneSeen, ev.tagSeen].filter(Boolean).sort().pop() || null;
        return { state: lastSeen ? 'probably-left' : 'unseen', lastSeen, sequence: ev.sequence, phoneSeen: ev.phoneSeen, tagSeen: ev.tagSeen };
    }

    // ---- enrolment pickers + health ------------------------------------------------
    candidates(now = this.now()) {
        const since = new Date(now.getTime() - 10 * 60_000).toISOString();
        const enrolledMacs = new Set(this.store.listPeople(true).map(p => p.phoneMac).filter(Boolean));
        const phones = [...this.wifiSeen.entries()].filter(([mac]) => !enrolledMacs.has(mac)).map(([mac, v]) => ({ mac, ...v }));
        const tags = this.store.identsSeen('ble-unknown', since);
        return { phones, tags, since };
    }
    health(now = this.now()) {
        const nowMs = now.getTime();
        const scanners = [...this.scanners.entries()].map(([name, at]) => ({ name, lastReport: at, ageS: Math.round((nowMs - Date.parse(at)) / 1000) }));
        const tags = this.store.listPeople().filter(p => p.tagId).map(p => {
            const last = this.store.lastSighting(p.tagId);
            return { person: p.name, tagId: p.tagId, lastHeard: last?.at || null, ageS: last ? Math.round((nowMs - Date.parse(last.at)) / 1000) : null };
        });
        return { wifi: { enabled: this.enabledWifi, lastPoll: this.lastWifiPoll, clients: this.wifiSeen.size }, scanners, tags, thresholds: this.cfg };
    }
    /** Keep the sightings table small: 14 days of enrolled evidence, 1 hour of unknown tags. */
    prune(now = this.now()) {
        this.store.pruneSightings(new Date(now.getTime() - 14 * 86400_000).toISOString());
        this.store.db.prepare("DELETE FROM sightings WHERE kind = 'ble-unknown' AND at < ?").run(new Date(now.getTime() - 3600_000).toISOString());
    }
}

const hhmm = iso => iso ? new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' }) : '?';
function normaliseMac(mac) {
    const hex = String(mac).replace(/[^0-9a-f]/gi, '').toUpperCase();
    return hex.length === 12 ? hex.match(/.{2}/g).join(':') : '';
}
function normaliseTag(tag) { return String(tag).trim().toUpperCase(); }

module.exports = { Presence, DEFAULTS, normaliseMac, normaliseTag };
