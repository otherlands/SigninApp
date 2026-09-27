'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createApp } = require('../lib/app');

const T0 = Date.parse('2026-09-28T07:55:00Z');
const at = (min) => new Date(T0 + min * 60_000);

/** Fake UniFi controller: returns whatever client list the test sets, requires the API key. */
function fakeUnifi() {
    const state = { clients: [], calls: 0, lastHeaders: null };
    const fetch = async (url, init = {}) => {
        state.calls++; state.lastHeaders = init.headers;
        if (init.headers['X-API-KEY'] !== 'ro-key') return new Response('{"error":"unauthorized"}', { status: 401 });
        if (!String(url).includes('/proxy/network/api/s/default/stat/sta')) return new Response('{}', { status: 404 });
        return new Response(JSON.stringify({ data: state.clients }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    return { state, fetch };
}

async function boot(options = {}) {
    const app = createApp({ dataFile: ':memory:', adminPin: '', apiToken: 'tok', mirrorUrl: '', mirrorToken: '', teamsWebhookUrl: '', publicUrl: '', replica: false, sharepoint: {}, ...options });
    const server = http.createServer((req, res) => app.handle(req, res));
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (method, path, body, headers = {}) => {
        const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
        const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch { }
        return { status: res.status, json, text };
    };
    return { app, call, close: () => new Promise(r => server.close(() => { app.close(); r(); })) };
}

test('presence: phone enrolment, Wi-Fi auto sign-in, probably-left badge (never auto-out for a single brace), metrics', async () => {
    const u = fakeUnifi();
    const { app, call, close } = await boot({ unifi: { url: 'https://udm.example', apiKey: 'ro-key', site: 'default', path: '/proxy/network/api/s/{site}/stat/sta', fetch: u.fetch } });
    try {
        let r = await call('POST', '/api/people', { name: 'Director' });
        const d = r.json.people[0];
        r = await call('PATCH', `/api/people/${d.id}`, { phoneMac: 'aa-bb-cc-11-22-33' });
        assert.equal(r.status, 200);
        assert.equal(app.store.getPerson(d.id).phoneMac, 'AA:BB:CC:11:22:33', 'MAC normalised');
        r = await call('POST', '/api/people', { name: 'Other' });
        const o = r.json.people.find(p => p.name === 'Other');
        r = await call('PATCH', `/api/people/${o.id}`, { phoneMac: 'AA:BB:CC:11:22:33' });
        assert.equal(r.status, 409, 'one phone, one person');

        // 07:55 nobody; 08:00 the director's phone joins the office Wi-Fi
        u.state.clients = [{ mac: 'aa:bb:cc:11:22:33', hostname: 'Directors-iPhone', ap_name: 'office-ap-1', essid: 'eRIGHT' }, { mac: '00:11:22:33:44:55', hostname: 'visitor-laptop' }];
        const poll = await app.presence.pollWifi(at(5));
        assert.equal(poll.ok, true); assert.equal(poll.count, 2);
        assert.equal(u.state.lastHeaders['X-API-KEY'], 'ro-key');
        let state = (await call('GET', '/api/state')).json;
        const dir = state.people.find(p => p.id === d.id);
        assert.equal(dir.signedIn, true, 'auto signed in from Wi-Fi');
        assert.equal(dir.lastSource, 'wifi');
        assert.equal(dir.presence.state, 'here');
        r = await call('GET', '/api/events?limit=3');
        assert.match(r.json[0].note, /phone joined the office Wi-Fi/);

        // enrolment picker shows the unenrolled laptop, not the director's phone
        r = await call('GET', '/api/presence');
        assert.deepEqual(r.json.candidates.phones.map(p => p.mac), ['00:11:22:33:44:55']);
        assert.equal(r.json.health.wifi.enabled, true);

        // 08:06 -> 08:30 phone gone: badge flips to probably-left, but ONE brace never signs out
        u.state.clients = [];
        await app.presence.pollWifi(at(11));
        app.presence.now = () => at(35);
        app.presence.applyRules();
        const badge = app.presence.badge(app.store.getPerson(d.id));
        assert.equal(badge.state, 'probably-left');
        assert.equal(app.store.latestPresenceEvent(d.id).kind, 'in', 'still signed in: phone alone cannot sign out');
        assert.match(app.rosterText(), /probably left/);

        // phone back at 08:40 -> here again, no new event
        u.state.clients = [{ mac: 'AA:BB:CC:11:22:33', ap_name: 'office-ap-2' }];
        app.presence.now = () => at(45);
        await app.presence.pollWifi();
        assert.equal(app.presence.badge(app.store.getPerson(d.id)).state, 'here');
        assert.equal(app.store.listEvents({ limit: 10 }).filter(e => e.kind === 'in').length, 1, 'no duplicate sign-in while signed in');

        r = await call('GET', '/metrics');
        assert.match(r.text, /^signin_wifi_enabled 1$/m);
        assert.match(r.text, /^signin_wifi_last_poll_ok 1$/m);
        assert.match(r.text, /^signin_presence_here 1$/m);
        assert.doesNotMatch(r.text, /Director/, 'no names on /metrics');

        // wrong key surfaces as a failed poll, not a crash
        app.presence.unifi.apiKey = 'bad';
        const bad = await app.presence.pollWifi(at(46));
        assert.equal(bad.ok, false); assert.match(bad.error, /401/);
    } finally { await close(); }
});

test('presence: BLE tags, door->anchor = walked in, anchor->door->silence + phone gone = auto out ONLY for an inferred sign-in', async () => {
    const u = fakeUnifi();
    const { app, call, close } = await boot({ unifi: { url: 'https://udm.example', apiKey: 'ro-key', fetch: u.fetch }, doorScanners: ['front-door', 'back-door'], anchorScanners: ['anchor'] });
    const H = { 'X-Api-Token': 'tok' };
    try {
        let r = await call('POST', '/api/people', { name: 'Keys Person' });
        const k = r.json.people[0];
        // unknown tag heard at the back door -> appears in the picker, is not stored as enrolled evidence
        r = await call('POST', '/api/presence/ble', { scanner: 'back-door', sightings: [{ tag: 'ibeacon:E2C5-1', rssi: -61 }] });
        assert.equal(r.status, 401, 'scanners need the API token');
        r = await call('POST', '/api/presence/ble', { scanner: 'back-door', sightings: [{ tag: 'ibeacon:e2c5-1', rssi: -61 }] }, H);
        assert.equal(r.status, 200); assert.equal(r.json.enrolled, 0);
        r = await call('GET', '/api/presence');
        assert.equal(r.json.candidates.tags[0].ident, 'IBEACON:E2C5-1');
        assert.equal(r.json.health.scanners[0].name, 'back-door');

        r = await call('PATCH', `/api/people/${k.id}`, { tagId: 'ibeacon:e2c5-1', phoneMac: '10:20:30:40:50:60' });
        assert.equal(r.status, 200);

        // 08:00 tag at back door, 08:01 tag at anchor => walked in (BLE sequence), phone also joins
        app.presence.ingestBle('back-door', [{ tag: 'ibeacon:e2c5-1', rssi: -60, at: at(5).toISOString() }], at(5));
        assert.equal(app.store.latestPresenceEvent(k.id), null, 'door alone is not a decision');
        app.presence.ingestBle('anchor', [{ tag: 'ibeacon:e2c5-1', rssi: -70, at: at(6).toISOString() }], at(6));
        let last = app.store.latestPresenceEvent(k.id);
        assert.equal(last?.kind, 'in'); assert.equal(last.source, 'ble'); assert.match(last.note, /walked in/);
        u.state.clients = [{ mac: '10:20:30:40:50:60', ap_name: 'office-ap-1' }];
        await app.presence.pollWifi(at(7));
        assert.equal(app.presence.badge(app.store.getPerson(k.id), at(7)).state, 'here');

        // 17:30 anchor, 17:31 back door, then silence; phone leaves the Wi-Fi at 17:32
        const E = 9 * 60 + 35; // minutes after T0 = 17:30
        app.presence.ingestBle('anchor', [{ tag: 'ibeacon:e2c5-1', at: at(E).toISOString() }], at(E));
        app.presence.ingestBle('back-door', [{ tag: 'ibeacon:e2c5-1', at: at(E + 1).toISOString() }], at(E + 1));
        u.state.clients = [];
        await app.presence.pollWifi(at(E + 2));
        app.presence.applyRules(at(E + 5));
        assert.equal(app.store.latestPresenceEvent(k.id).kind, 'in', 'not yet: outAfter not reached');
        assert.equal(app.presence.badge(app.store.getPerson(k.id), at(E + 5)).state, 'probably-left');
        app.presence.applyRules(at(E + 15));
        last = app.store.latestPresenceEvent(k.id);
        assert.equal(last.kind, 'out', 'both braces gone + exit sequence + inferred sign-in => auto out');
        assert.equal(last.source, 'ble+wifi');
        assert.match(last.note, /walked out/);

        // Next day: signs in DELIBERATELY by card; same departure pattern must NOT sign out
        const D = 24 * 60 + 5;
        await call('PATCH', `/api/people/${k.id}`, { cardUid: '314F6C0A' });
        r = await call('POST', '/api/sign', { cardUid: '314F6C0A', source: 'card' }, H);
        assert.equal(r.json.event.kind, 'in');
        // fabricate the card event's time into "the day after" so the presence timeline is consistent
        app.store.db.prepare('UPDATE events SET at = ? WHERE id = ?').run(at(D).toISOString(), r.json.event.id);
        app.presence.ingestBle('anchor', [{ tag: 'ibeacon:e2c5-1', at: at(D + 60).toISOString() }], at(D + 60));
        app.presence.ingestBle('back-door', [{ tag: 'ibeacon:e2c5-1', at: at(D + 61).toISOString() }], at(D + 61));
        await app.presence.pollWifi(at(D + 62));
        app.presence.now = () => at(D + 90);
        app.presence.applyRules();
        last = app.store.latestPresenceEvent(k.id);
        assert.equal(last.kind, 'in', 'a human signed in: only a human (or admin) may sign out');
        assert.equal(app.presence.badge(app.store.getPerson(k.id)).state, 'probably-left', '...but the register SHOWS it');
        assert.equal((await call('GET', '/api/state')).json.probablyLeftCount, 1);

        r = await call('GET', '/metrics');
        assert.match(r.text, /^signin_probably_left 1$/m);
        assert.match(r.text, /^signin_scanner_last_report_age_seconds\{scanner="back-door"\} \d+$/m);
        assert.match(r.text, /^signin_tag_last_heard_age_seconds\{tag="IBEACON:E2C5-1"\} \d+$/m);
        assert.doesNotMatch(r.text, /Keys Person/);
    } finally { await close(); }
});
