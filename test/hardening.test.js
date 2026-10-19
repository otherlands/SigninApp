'use strict';
// Regression tests for the 2026-10-19 audit (C1-C12): each test names the finding it pins.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createApp } = require('../lib/app');

const NO_ENV = { adminPin: '', apiToken: '', mirrorUrl: '', mirrorToken: '', teamsWebhookUrl: '', publicUrl: '', replica: false, sharepoint: {}, unifi: {}, backupDir: '', presence: true };
async function boot(options = {}) {
    const app = createApp({ dataFile: ':memory:', ...NO_ENV, ...options });
    const server = http.createServer((req, res) => app.handle(req, res));
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (method, p, body, headers = {}) => {
        const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
        const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch { }
        return { status: res.status, json, text, headers: res.headers };
    };
    return { app, call, close: () => new Promise(r => server.close(() => { app.close(); r(); })) };
}
const T0 = Date.parse('2026-10-19T07:00:00Z');
const at = (min) => new Date(T0 + min * 60_000);
function fakeUnifi() {
    const state = { clients: [] };
    return { state, fetch: async () => new Response(JSON.stringify({ data: state.clients }), { status: 200 }) };
}

test('C1: a phone still on the Wi-Fi does not undo a deliberate sign-out; a real arrival next day still signs in', async () => {
    const u = fakeUnifi();
    const { app, close } = await boot({ unifi: { url: 'https://udm', apiKey: 'k', fetch: u.fetch }, now: () => at(0) });
    try {
        const p = app.store.addPerson('Alice');
        app.store.updatePerson(p.id, { phoneMac: 'AA:BB:CC:DD:EE:FF' });
        u.state.clients = [{ mac: 'aa:bb:cc:dd:ee:ff' }];
        for (let m = 0; m <= 600; m += 0.5) await app.presence.pollWifi(at(m));   // on the Wi-Fi all day, polled every 30 s
        assert.equal(app.store.latestPresenceEvent(p.id).source, 'wifi', 'the morning arrival signed her in');

        app.store.addEvent({ kind: 'out', subjectType: 'staff', subjectId: p.id, subjectName: 'Alice', source: 'kiosk', at: at(600.2).toISOString() });
        await app.presence.pollWifi(at(600.5));
        await app.presence.pollWifi(at(601));
        let last = app.store.latestPresenceEvent(p.id);
        assert.equal(last.kind, 'out', 'phone still associated in the car park: the human sign-out stands');
        assert.equal(last.source, 'kiosk');

        u.state.clients = [];
        for (let m = 602; m < 1440; m += 30) await app.presence.pollWifi(at(m));
        u.state.clients = [{ mac: 'AA:BB:CC:DD:EE:FF' }];
        await app.presence.pollWifi(at(1440));
        last = app.store.latestPresenceEvent(p.id);
        assert.equal(last.kind, 'in', 'next morning the phone ARRIVES again: inference may sign her in');
        assert.equal(last.source, 'wifi');
    } finally { await close(); }
});

test('C1: a tag still heard inside after a deliberate sign-out does not sign the person back in', async () => {
    const { app, close } = await boot({ anchorScanners: ['anchor'], doorScanners: ['front-door'], now: () => at(0) });
    try {
        const p = app.store.addPerson('Bob');
        app.store.updatePerson(p.id, { tagId: 'ibeacon:x:1:1' });
        for (let m = 0; m <= 60; m += 1) app.presence.ingestBle('anchor', [{ tag: 'ibeacon:x:1:1', at: at(m).toISOString() }], at(m));
        assert.equal(app.store.latestPresenceEvent(p.id).kind, 'in');
        app.store.addEvent({ kind: 'out', subjectType: 'staff', subjectId: p.id, subjectName: 'Bob', source: 'card', at: at(60.5).toISOString() });
        for (let m = 61; m <= 70; m += 1) app.presence.ingestBle('anchor', [{ tag: 'ibeacon:x:1:1', at: at(m).toISOString() }], at(m));
        assert.equal(app.store.latestPresenceEvent(p.id).kind, 'out', 'keys left on the desk do not overrule the card');
    } finally { await close(); }
});

test('C1 review: closing forgotten sign-outs never strands someone who is visibly inside', async () => {
    const u = fakeUnifi();
    let clockMin = 0;
    const { app, call, close } = await boot({ unifi: { url: 'https://udm', apiKey: 'k', fetch: u.fetch }, now: () => at(clockMin) });
    try {
        const bob = app.store.addPerson('Bob'); const amy = app.store.addPerson('Amy');
        app.store.updatePerson(bob.id, { phoneMac: '10:20:30:40:50:60' });
        for (const p of [bob, amy]) app.store.addEvent({ kind: 'in', subjectType: 'staff', subjectId: p.id, subjectName: p.name, source: 'kiosk', at: at(-24 * 60).toISOString() });
        u.state.clients = [{ mac: '10:20:30:40:50:60' }];
        for (clockMin = 0; clockMin <= 120; clockMin += 0.5) await app.presence.pollWifi(at(clockMin));
        let r = await call('POST', '/api/stale/close', { by: 'Admin' });
        assert.equal(r.json.closed, 1, 'Amy (no signal) is closed');
        assert.deepEqual(r.json.skipped, ['Bob'], 'Bob, whose phone is inside, is left signed in');
        assert.equal(app.store.latestPresenceEvent(amy.id).source, 'stale-close');

        // Closing Bob by name is the admin's explicit call; his phone, still inside, signs him back in on the next poll.
        r = await call('POST', '/api/stale/close', { personId: bob.id, by: 'Admin' });
        assert.equal(r.json.closed, 1);
        assert.equal(app.store.latestPresenceEvent(bob.id).kind, 'out');
        clockMin += 0.5; await app.presence.pollWifi(at(clockMin));
        const last = app.store.latestPresenceEvent(bob.id);
        assert.equal(last.kind, 'in', 'a bookkeeping close is not a departure: present evidence re-signs him in');
        assert.equal(last.source, 'wifi');
    } finally { await close(); }
});

test('C2: wrong admin PINs lock the address out (429), a missing header is not a guess', async () => {
    const { call, close } = await boot({ adminPin: '246810', adminLockout: { max: 3, windowMs: 60_000 } });
    try {
        for (let i = 0; i < 5; i++) assert.equal((await call('GET', '/api/people')).status, 401, 'no header: just "PIN required"');
        for (let i = 0; i < 3; i++) assert.equal((await call('GET', '/api/people', undefined, { 'X-Admin-Pin': `00000${i}` })).status, 401);
        const r = await call('GET', '/api/people', undefined, { 'X-Admin-Pin': '246810' });
        assert.equal(r.status, 429, 'locked even with the right PIN');
        assert.ok(Number(r.headers.get('retry-after')) > 0);
        assert.equal((await call('GET', '/api/state')).status, 200, 'the kiosk is never locked out');
    } finally { await close(); }
});

test('C3: the token is required by what a request claims, not by the source name it chooses', async () => {
    const { app, call, close } = await boot({ apiToken: 'tok', adminPin: 'pin' });
    try {
        const p = app.store.addPerson('Card Holder');
        app.store.updatePerson(p.id, { cardUid: '314F6C0A' });
        assert.equal((await call('POST', '/api/sign', { cardUid: '314F6C0A', source: 'kiosk' })).status, 401, 'a card UID needs the token whatever source says');
        assert.equal((await call('POST', '/api/sign', { cardUid: '314F6C0A', source: 'card' }, { 'X-Api-Token': 'tok' })).status, 200);
        assert.equal((await call('POST', '/api/fire/start', { source: 'x' })).status, 401, 'unknown sources are devices');
        assert.equal((await call('POST', '/api/sign', { personId: p.id, source: 'admin' })).status, 401, 'source admin needs the admin PIN');
        assert.equal((await call('POST', '/api/sign', { personId: p.id, source: 'admin' }, { 'X-Admin-Pin': 'pin' })).status, 200);
        assert.equal((await call('POST', '/api/visitors', { name: 'V', source: 'esp32' })).status, 401);
        assert.equal((await call('POST', '/api/visitors', { name: 'V' })).status, 201, 'a visitor at the tablet needs nothing');
        assert.equal((await call('POST', '/api/fire/start', { source: 'fire-page' })).status, 201, 'anyone may start a roll call');
    } finally { await close(); }
});

test('C4: no page has two elements with the same id (the visitor company field was shadowed by the header)', () => {
    const dir = path.join(__dirname, '..', 'public');
    for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.html'))) {
        const ids = [...fs.readFileSync(path.join(dir, f), 'utf8').matchAll(/\sid="([^"]+)"/g)].map(m => m[1]);
        const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
        assert.deepEqual(dupes, [], `${f} has duplicate ids`);
    }
    assert.match(fs.readFileSync(path.join(dir, 'visitor.html'), 'utf8'), /company: \$\('#visitorCompany'\)\.value/);
});

test('C5: presence chatter with no register change publishes nothing off-site; a real change publishes once', async () => {
    const fetch = async () => new Response('{}', { status: 200 });
    const { app, call, close } = await boot({ apiToken: 'tok', mirrorUrl: 'http://mirror.invalid', mirrorToken: 'mt', fetch });
    try {
        const p = app.store.addPerson('Quiet');
        app.publishRoster();
        await app.flushOutbox();
        for (let i = 0; i < 50; i++) await call('POST', '/api/presence/ble', { scanner: 'anchor', sightings: [{ tag: 'mac:11:22:33:44:55:66', rssi: -80 }] }, { 'X-Api-Token': 'tok' });
        assert.equal(app.store.outboxDepth(), 0, '50 scanner posts, nobody moved: nothing queued');
        await call('POST', '/api/sign', { personId: p.id });
        assert.equal(app.store.outboxDepth(), 1, 'a sign-in is one snapshot');
        assert.equal(app.publishRoster(), false, 'publishing again with no change is a no-op');
        const rows = app.store.db.prepare('SELECT COUNT(*) AS n FROM sightings').get().n;
        assert.equal(Number(rows), 1, 'sightings are throttled to one row per tag per scanner per 30 s');
    } finally { await close(); }
});

test('C7: a visitor left signed in from yesterday is flagged on every view and closable by admin', async () => {
    const { app, call, close } = await boot();
    try {
        const v = app.store.addVisitor({ name: 'Yesterday Visitor', badge: 1, at: new Date(Date.now() - 36 * 3600_000).toISOString() });
        let r = await call('GET', '/api/roster');
        assert.equal(r.json.visitors[0].stale, true);
        r = await call('GET', '/api/state');
        assert.equal(r.json.visitors[0].stale, true);
        assert.equal(r.json.staleCount, 1);
        assert.match(app.rosterText(), /Yesterday Visitor.*signed in before today/);
        assert.match((await call('GET', '/metrics')).text, /^signin_stale_visitors 1$/m);
        r = await call('POST', '/api/stale/close', { visitorId: v.id, by: 'Admin' });
        assert.equal(r.json.closed, 1);
        assert.equal(r.json.state.visitors.length, 0);
    } finally { await close(); }
});

test('C10: /metrics declares HELP/TYPE once per metric and keeps each metric\'s series together', async () => {
    const { app, call, close } = await boot();
    try {
        const t = app.store.addPerson('Tagged');
        app.store.updatePerson(t.id, { tagId: 'ibeacon:t:1:1' });
        app.presence.ingestBle('front-door', [{ tag: 'ibeacon:t:1:1' }]);
        app.presence.ingestBle('anchor', [{ tag: 'ibeacon:t:1:1' }]);
        const text = (await call('GET', '/metrics')).text;
        const types = text.split('\n').filter(l => l.startsWith('# TYPE ')).map(l => l.split(' ')[2]);
        assert.deepEqual(types.filter((n, i) => types.indexOf(n) !== i), [], 'no metric declared twice');
        const names = text.split('\n').filter(l => l && !l.startsWith('#')).map(l => l.split(/[{ ]/)[0]);
        const runs = names.filter((n, i) => i === 0 || names[i - 1] !== n);
        assert.deepEqual(runs.filter((n, i) => runs.indexOf(n) !== i), [], 'samples of one metric are contiguous');
        assert.match(text, /^signin_scanner_last_report_age_seconds\{scanner="anchor"\} \d+$/m);
    } finally { await close(); }
});

test('C11: a removed person\'s card can be reissued; card-number names are refused; conflicts never leak SQL', async () => {
    const { app, call, close } = await boot();
    try {
        const leaver = app.store.addPerson('Leaver');
        app.store.updatePerson(leaver.id, { cardUid: 'C3621F39' });
        await call('DELETE', `/api/people/${leaver.id}`);
        const newbie = app.store.addPerson('Newbie');
        let r = await call('PATCH', `/api/people/${newbie.id}`, { cardUid: 'C3621F39' });
        assert.equal(r.status, 200, 'released from the leaver, assigned to the newcomer');
        assert.equal(app.store.getPerson(leaver.id).cardUid, null);
        assert.equal(app.store.getPersonByCard('C3621F39').id, newbie.id);

        const other = app.store.addPerson('Other');
        r = await call('PATCH', `/api/people/${other.id}`, { cardUid: 'C3621F39' });
        assert.equal(r.status, 409);
        assert.match(r.json.error, /belongs to Newbie/);

        r = await call('POST', '/api/people', { name: '0174870321' });
        assert.equal(r.status, 400, 'a wedge swipe into the name box is not a person');
        assert.equal((await call('POST', '/api/people', { name: 'Ada Lovelace' })).status, 201);

        app.store.db.exec("UPDATE people SET card_uid = 'DEADBEEF' WHERE id = '" + other.id + "'");
        r = await call('PATCH', `/api/people/${leaver.id}`, { active: true, cardUid: 'DEADBEEF' });
        assert.equal(r.status, 409);
        assert.doesNotMatch(r.text, /UNIQUE|constraint|people\./i);
    } finally { await close(); }
});

test('C12: backups are consistent, drop sightings + outbox, rotate, and report on health and metrics', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'signin-backup-'));
    const { app, call, close } = await boot({ backupDir: dir, backupKeep: 2, adminPin: 'pin' });
    try {
        const p = app.store.addPerson('Backed Up');
        app.store.addEvent({ kind: 'in', subjectType: 'staff', subjectId: p.id, subjectName: p.name, source: 'kiosk' });
        app.store.addSighting({ kind: 'ble', ident: 'X', scanner: 'anchor' });
        app.store.enqueueOutbox({ type: 'roster' });
        assert.equal((await call('POST', '/api/backup')).status, 401);
        let r = await call('POST', '/api/backup', {}, { 'X-Admin-Pin': 'pin' });
        assert.equal(r.status, 200);
        assert.equal(r.json.ok, true, r.json.error);
        const copy = new DatabaseSync(r.json.file);
        try {
            assert.equal(Number(copy.prepare('SELECT COUNT(*) AS n FROM events').get().n), 1);
            assert.equal(copy.prepare('SELECT name FROM people').get().name, 'Backed Up');
            assert.equal(Number(copy.prepare('SELECT COUNT(*) AS n FROM sightings').get().n), 0);
            assert.equal(Number(copy.prepare('SELECT COUNT(*) AS n FROM outbox').get().n), 0);
        } finally { copy.close(); }
        for (let i = 0; i < 3; i++) { await new Promise(res => setTimeout(res, 1100)); await app.backup(); }
        assert.equal(fs.readdirSync(dir).filter(f => f.endsWith('.sqlite')).length, 2, 'keeps the newest BACKUP_KEEP');
        r = await call('GET', '/api/health');
        assert.equal(r.json.backup.last.ok, true);
        const m = (await call('GET', '/metrics')).text;
        assert.match(m, /^signin_backup_last_ok 1$/m);
        assert.match(m, /^signin_backup_age_seconds \d+$/m);
    } finally { await close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('C8: a reader replaying a buffered tap is back-dated by ageMs; people at a screen cannot back-date', async () => {
    const { app, call, close } = await boot({ apiToken: 'tok' });
    try {
        const p = app.store.addPerson('Offline Tap');
        app.store.updatePerson(p.id, { cardUid: 'AABBCCDD' });
        const before = Date.now();
        let r = await call('POST', '/api/sign', { cardUid: 'AABBCCDD', source: 'esp32', eventKey: 'door-7', ageMs: 10 * 60_000 }, { 'X-Api-Token': 'tok' });
        assert.equal(r.status, 200);
        assert.ok(Math.abs(Date.parse(r.json.event.at) - (before - 10 * 60_000)) < 5000, 'recorded when the card was tapped');
        assert.match(r.json.event.note, /delivered 10 min late/);
        r = await call('POST', '/api/sign', { personId: p.id, source: 'kiosk', ageMs: 3600_000 });
        assert.ok(Date.now() - Date.parse(r.json.event.at) < 5000, 'kiosk taps are always "now"');
        r = await call('POST', '/api/sign', { cardUid: 'AABBCCDD', source: 'esp32', eventKey: 'door-7', ageMs: 10 * 60_000 }, { 'X-Api-Token': 'tok' });
        assert.equal(r.json.duplicate, true, 'the replay of the same tap is idempotent');
    } finally { await close(); }
});
