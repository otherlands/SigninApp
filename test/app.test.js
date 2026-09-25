'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createApp } = require('../lib/app');

async function boot(options = {}) {
    const app = createApp({ dataFile: ':memory:', ...options });
    const server = http.createServer((req, res) => app.handle(req, res));
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (method, path, body, headers = {}) => {
        const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
        const text = await res.text();
        let json = null; try { json = JSON.parse(text); } catch { }
        return { status: res.status, json, text, headers: res.headers };
    };
    const close = () => new Promise(r => server.close(() => { app.close(); r(); }));
    return { app, call, close, base };
}

test('staff toggle in/out, roster count and CSV export', async () => {
    const { call, close } = await boot();
    try {
        let r = await call('POST', '/api/people', { name: 'Alan Meade' });
        assert.equal(r.status, 201);
        const alan = r.json.people[0];
        assert.equal(alan.signedIn, false);

        r = await call('POST', '/api/sign', { personId: alan.id, source: 'kiosk', device: 'test' });
        assert.equal(r.status, 200);
        assert.equal(r.json.event.kind, 'in');
        assert.equal(r.json.state.inCount, 1);

        r = await call('GET', '/api/roster');
        assert.equal(r.json.count, 1);
        assert.equal(r.json.staff[0].name, 'Alan Meade');

        r = await call('POST', '/api/sign', { personId: alan.id });
        assert.equal(r.json.event.kind, 'out');
        assert.equal(r.json.state.inCount, 0);

        r = await call('GET', '/api/export');
        assert.equal(r.status, 200);
        assert.match(r.headers.get('content-type'), /text\/csv/);
        const lines = r.text.split('\r\n');
        assert.equal(lines[0], 'Date,Time,Type,Name,Action,Source,Device,Note');
        assert.equal(lines.length, 3);
        assert.match(lines[1], /"staff","Alan Meade","in","kiosk","test"/);
    } finally { await close(); }
});

test('card UID sign-in, unknown card is recorded, duplicate eventKey is idempotent', async () => {
    const { call, close } = await boot({ apiToken: 'secret' });
    try {
        let r = await call('POST', '/api/people', { name: 'Sam' });
        const sam = r.json.people[0];

        r = await call('POST', '/api/sign', { cardUid: '04:a1:b2:c3', source: 'card' });
        assert.equal(r.status, 401, 'card source requires token');

        r = await call('POST', '/api/sign', { cardUid: '04:a1:b2:c3', source: 'card' }, { 'X-Api-Token': 'secret' });
        assert.equal(r.status, 404);
        r = await call('GET', '/api/state');
        assert.equal(r.json.lastUnknownCard.uid, '04A1B2C3');

        r = await call('PATCH', `/api/people/${sam.id}`, { cardUid: '04 a1 b2 c3' });
        assert.equal(r.status, 200);
        assert.equal(r.json.lastUnknownCard, null);

        r = await call('POST', '/api/sign', { cardUid: '04A1B2C3', source: 'card', eventKey: 'reader1-0001' }, { 'X-Api-Token': 'secret' });
        assert.equal(r.status, 200);
        assert.equal(r.json.event.kind, 'in');
        assert.equal(r.json.duplicate, false);

        r = await call('POST', '/api/sign', { cardUid: '04A1B2C3', source: 'card', eventKey: 'reader1-0001' }, { 'X-Api-Token': 'secret' });
        assert.equal(r.json.duplicate, true);
        assert.equal(r.json.state.inCount, 1, 'retry did not toggle the person back out');

        r = await call('POST', '/api/people', { name: 'Other' });
        const other = r.json.people.find(p => p.name === 'Other');
        r = await call('PATCH', `/api/people/${other.id}`, { cardUid: '04A1B2C3' });
        assert.equal(r.status, 409, 'card cannot be assigned twice');
    } finally { await close(); }
});

test('visitors get a daily badge, appear on the roster, and sign out', async () => {
    const { call, close } = await boot();
    try {
        let r = await call('POST', '/api/people', { name: 'Host Person' });
        const host = r.json.people[0];
        r = await call('POST', '/api/visitors', { name: 'Vis Itor', company: 'ACME', hostId: host.id, vehicle: 'ab12 cde' });
        assert.equal(r.status, 201);
        assert.equal(r.json.visitor.badge, 1);
        assert.equal(r.json.visitor.hostName, 'Host Person');
        assert.equal(r.json.visitor.vehicle, 'AB12 CDE');
        const v1 = r.json.visitor;

        r = await call('POST', '/api/visitors', { name: 'Second' });
        assert.equal(r.json.visitor.badge, 2);

        r = await call('GET', '/api/roster');
        assert.equal(r.json.count, 2);
        assert.equal(r.json.visitors.length, 2);

        r = await call('POST', `/api/visitors/${v1.id}/out`, {});
        assert.equal(r.status, 200);
        assert.ok(r.json.visitor.signedOutAt);
        r = await call('GET', '/api/roster');
        assert.equal(r.json.count, 1);

        r = await call('POST', '/api/visitors', { name: '' });
        assert.equal(r.status, 400);
    } finally { await close(); }
});

test('fire roll call snapshots the roster, tracks safe/missing, and ends with a summary event', async () => {
    const { call, close } = await boot({ apiToken: 'tok' });
    try {
        let r = await call('POST', '/api/people', { name: 'A' });
        const a = r.json.people[0];
        r = await call('POST', '/api/people', { name: 'B' });
        const b = r.json.people.find(p => p.name === 'B');
        await call('POST', '/api/sign', { personId: a.id });
        await call('POST', '/api/sign', { personId: b.id });
        r = await call('POST', '/api/visitors', { name: 'V' });
        const v = r.json.visitor;

        r = await call('POST', '/api/fire/start', { source: 'webhook' });
        assert.equal(r.status, 401, 'webhook button needs token');

        r = await call('POST', '/api/fire/start', { source: 'webhook', by: 'exit button' }, { 'X-Api-Token': 'tok' });
        assert.equal(r.status, 201);
        assert.equal(r.json.rollcall.total, 3);
        assert.equal(r.json.rollcall.unaccounted, 3);

        r = await call('POST', '/api/fire/start', { source: 'fire-page' });
        assert.equal(r.status, 200);
        assert.equal(r.json.alreadyOpen, true);

        // Someone signs out DURING the roll call: the snapshot must not change.
        await call('POST', '/api/sign', { personId: b.id });
        r = await call('GET', '/api/fire');
        assert.equal(r.json.rollcall.total, 3);
        assert.equal(r.json.roster.count, 2);

        r = await call('POST', '/api/fire/mark', { subjectType: 'staff', subjectId: a.id, status: 'safe', by: 'Marshal' });
        assert.equal(r.json.rollcall.safe, 1);
        r = await call('POST', '/api/fire/mark', { subjectType: 'visitor', subjectId: v.id, status: 'missing' });
        assert.equal(r.json.rollcall.missing, 1);
        assert.equal(r.json.rollcall.unaccounted, 1);
        r = await call('POST', '/api/fire/mark', { subjectType: 'visitor', subjectId: v.id, status: 'safe' });
        assert.equal(r.json.rollcall.missing, 0);
        assert.equal(r.json.rollcall.safe, 2);
        r = await call('POST', '/api/fire/mark', { subjectType: 'staff', subjectId: 'nobody', status: 'safe' });
        assert.equal(r.status, 404);

        r = await call('POST', '/api/fire/end', { by: 'Marshal' });
        assert.equal(r.status, 200);
        assert.ok(r.json.rollcall.endedAt);
        r = await call('GET', '/api/state');
        assert.equal(r.json.rollcall, null);

        r = await call('GET', '/api/events?limit=50');
        const kinds = r.json.map(e => e.kind);
        assert.ok(kinds.includes('fire_start') && kinds.includes('fire_end') && kinds.includes('safe') && kinds.includes('missing'));
        const end = r.json.find(e => e.kind === 'fire_end');
        assert.equal(end.note, 'Roll call ended: 2 safe, 0 missing, 1 unaccounted of 3');
    } finally { await close(); }
});

test('stale sign-ins are flagged, never auto-closed, and admin can close them', async () => {
    const { app, call, close } = await boot();
    try {
        let r = await call('POST', '/api/people', { name: 'Forgetful' });
        const f = r.json.people[0];
        const yesterday = new Date(Date.now() - 36 * 3600_000).toISOString();
        app.store.addEvent({ kind: 'in', subjectType: 'staff', subjectId: f.id, subjectName: f.name, at: yesterday, source: 'kiosk' });

        r = await call('GET', '/api/state');
        assert.equal(r.json.people[0].signedIn, true);
        assert.equal(r.json.people[0].stale, true);
        assert.equal(r.json.staleCount, 1);
        r = await call('GET', '/api/roster');
        assert.equal(r.json.staff[0].stale, true, 'fire roster still shows them, flagged');

        r = await call('POST', '/api/stale/close', { by: 'Admin' });
        assert.equal(r.json.closed, 1);
        assert.equal(r.json.state.inCount, 0);
        r = await call('GET', '/api/events');
        assert.match(r.json[0].note, /Forgotten sign-out closed by admin \(Admin\)/);
    } finally { await close(); }
});

test('admin PIN protects admin routes but not the kiosk or fire page', async () => {
    const { call, close } = await boot({ adminPin: '1234' });
    try {
        let r = await call('POST', '/api/people', { name: 'X' });
        assert.equal(r.status, 401);
        r = await call('POST', '/api/people', { name: 'X' }, { 'X-Admin-Pin': '1234' });
        assert.equal(r.status, 201);
        r = await call('GET', '/api/export');
        assert.equal(r.status, 401);
        r = await call('GET', '/api/state');
        assert.equal(r.status, 200);
        r = await call('GET', '/api/fire');
        assert.equal(r.status, 200);
    } finally { await close(); }
});

test('mirror: main queues roster snapshots, replica serves them read-only', async () => {
    const replica = await boot({ replica: true, mirrorToken: 'mt' });
    const main = await boot({ mirrorUrl: replica.base, mirrorToken: 'mt' });
    try {
        let r = await main.call('POST', '/api/people', { name: 'P' });
        const p = r.json.people[0];
        await main.call('POST', '/api/sign', { personId: p.id });
        await main.call('POST', '/api/visitors', { name: 'Guest' });

        r = await main.call('POST', '/api/mirror/flush');
        assert.equal(r.json.remaining, 0);
        assert.ok(r.json.sent >= 1);

        r = await replica.call('GET', '/api/roster');
        assert.equal(r.json.replica, true);
        assert.equal(r.json.count, 2);
        assert.equal(r.json.staff[0].name, 'P');

        r = await replica.call('POST', '/api/sign', { personId: p.id });
        assert.equal(r.status, 409, 'replica refuses writes');

        r = await replica.call('POST', '/api/fire/start', { source: 'fire-page', by: 'Marshal at mirror' });
        assert.equal(r.status, 201, 'replica can still run a roll call from the last roster');
        assert.equal(r.json.rollcall.total, 2);

        r = await replica.call('POST', '/api/mirror', { type: 'roster', roster: { staff: [], visitors: [], count: 0 } });
        assert.equal(r.status, 401, 'mirror intake needs the token');
    } finally { await main.close(); await replica.close(); }
});

test('localDayStart handles BST and GMT', async () => {
    const { app, close } = await boot({ timeZone: 'Europe/London' });
    try {
        assert.equal(app.localDayStart('2026-07-15T10:00:00Z'), '2026-07-14T23:00:00.000Z');
        assert.equal(app.localDayStart('2026-12-15T10:00:00Z'), '2026-12-15T00:00:00.000Z');
        assert.equal(app.localDayStart('2026-07-14T23:30:00Z'), '2026-07-14T23:00:00.000Z', '00:30 BST is already the 15th locally');
    } finally { await close(); }
});

test('static pages and path traversal', async () => {
    const { call, close } = await boot();
    try {
        for (const p of ['/', '/fire', '/admin', '/tap', '/visitor', '/style.css']) {
            const r = await call('GET', p);
            assert.equal(r.status, 200, p);
        }
        const r = await call('GET', '/../package.json');
        assert.notEqual(r.status, 200);
    } finally { await close(); }
});

test('/metrics exposes counts only: lone worker, roll call, all-safe, off-site copy state', async () => {
    const { app, call, close } = await boot({ adminPin: 'pin' });
    const H = { 'X-Admin-Pin': 'pin' };
    try {
        let r = await call('GET', '/metrics');
        assert.equal(r.status, 200, 'no PIN or token needed — Prometheus scrapes it');
        assert.match(r.headers.get('content-type'), /text\/plain/);
        assert.match(r.text, /^signin_up 1$/m);
        assert.match(r.text, /^signin_on_site_total 0$/m);
        assert.match(r.text, /^signin_lone_worker 0$/m);
        assert.match(r.text, /^signin_rollcall_open 0$/m);
        assert.match(r.text, /^signin_local_hour (\d|1\d|2[0-3])$/m);
        assert.match(r.text, /^signin_sharepoint_configured 0$/m);
        assert.doesNotMatch(r.text, /signin_sharepoint_last_push/, 'no push yet = no series, not a fake 0');
        assert.match(r.text, /^signin_info\{version="3\.2\.0",tz="Europe\/London"\} 1$/m);

        r = await call('POST', '/api/people', { name: 'Alone Person' }, H);
        const p = r.json.people[0];
        await call('POST', '/api/sign', { personId: p.id });
        r = await call('GET', '/metrics');
        assert.match(r.text, /^signin_staff_on_site 1$/m);
        assert.match(r.text, /^signin_lone_worker 1$/m, 'one staff, no visitors');
        assert.doesNotMatch(r.text, /Alone Person/, 'names never leave /metrics');
        r = await call('GET', '/api/roster');
        assert.equal(r.json.loneWorker, true);
        assert.match(app.rosterText(), /LONE WORKER/);

        r = await call('POST', '/api/visitors', { name: 'Vis' });
        const v = r.json.visitor;
        r = await call('GET', '/metrics');
        assert.match(r.text, /^signin_lone_worker 0$/m, 'a visitor on site is not lone working');

        r = await call('POST', '/api/fire/start', { source: 'fire-page', by: 'Tester' });
        assert.equal(r.status, 201);
        assert.equal(r.json.rollcall.allSafe, false);
        r = await call('GET', '/metrics');
        assert.match(r.text, /^signin_rollcall_open 1$/m);
        assert.match(r.text, /^signin_rollcall_total 2$/m);
        assert.match(r.text, /^signin_rollcall_unaccounted 2$/m);
        assert.match(r.text, /^signin_rollcall_started_timestamp_seconds \d{10}$/m);

        await call('POST', '/api/fire/mark', { subjectType: 'staff', subjectId: p.id, status: 'safe' });
        r = await call('POST', '/api/fire/mark', { subjectType: 'visitor', subjectId: v.id, status: 'safe' });
        assert.equal(r.json.rollcall.allSafe, true, 'every person on the frozen register marked SAFE');
        r = await call('GET', '/metrics');
        assert.match(r.text, /^signin_rollcall_safe 2$/m);
        assert.match(r.text, /^signin_rollcall_unaccounted 0$/m);

        await call('POST', '/api/fire/end', {});
        r = await call('GET', '/metrics');
        assert.match(r.text, /^signin_rollcall_open 0$/m);
        assert.doesNotMatch(r.text, /signin_rollcall_total/, 'roll-call detail series disappear when none is open');
        assert.match(r.text, /^signin_events_last_24h \d+$/m);
    } finally { await close(); }
});
