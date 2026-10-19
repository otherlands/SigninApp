'use strict';
// v4.0: declarative routes + auth matrix, event-sourced attendance (projection, rebuild, time travel), persisted
// admin sessions, runtime state, drills, self-marking, retention, Microsoft List sink, the assistant, native TLS.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createApp } = require('../lib/app');
const { Store } = require('../lib/store');
const { MsListSink } = require('../lib/mslist');
const { Assistant } = require('../lib/assistant');

const NO_ENV = { adminPin: '', apiToken: '', mirrorUrl: '', mirrorToken: '', teamsWebhookUrl: '', publicUrl: '', replica: false, sharepoint: {}, unifi: {}, backupDir: '', silent: true, env: {} };
async function boot(options = {}) {
    const app = createApp({ dataFile: ':memory:', ...NO_ENV, ...options });
    const server = http.createServer((req, res) => app.handle(req, res));
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (method, p, body, headers = {}) => {
        const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body && method !== 'GET' ? JSON.stringify(body) : undefined });
        const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch { }
        return { status: res.status, json, text, headers: res.headers };
    };
    return { app, call, base, close: () => new Promise(r => { app.close(); server.closeAllConnections?.(); server.close(() => r()); }) };
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'signin-v4-'));

test('route table: every API route declares its auth; the matrix holds for anonymous / admin / scoped device / mirror', async () => {
    const { app, call, close } = await boot({ adminPin: '246810', apiToken: 'shared-token-0123456789', mirrorToken: 'mirror-token' });
    const A = { 'X-Admin-Pin': '246810' };
    try {
        const table = app.router.table();
        assert.ok(table.length >= 40);
        for (const r of table) assert.match(r.auth, /^(public|admin|mirror|claim:(sign|fire)|device:(presence))$/, `${r.method} ${r.path} declares ${r.auth}`);
        const { token: presenceTok } = (await call('POST', '/api/devices', { name: 'anchor', scopes: ['presence'] }, A)).json;
        // Every admin route refuses anonymous and a device token, and accepts the PIN (status != 401/403)
        for (const r of table.filter(x => x.auth === 'admin')) {
            const p = r.path.replace(':id', 'nothing');
            assert.equal((await call(r.method, p, {})).status, 401, `${r.method} ${p} anonymous`);
            assert.equal((await call(r.method, p, {}, { 'X-Api-Token': presenceTok })).status, 401, `${r.method} ${p} with a device token`);
            assert.notEqual((await call(r.method, p, {}, A)).status, 401, `${r.method} ${p} with the PIN`);
        }
        // Device routes refuse the wrong scope; mirror refuses device tokens
        assert.equal((await call('POST', '/api/presence/ble', { scanner: 'x', sightings: [] })).status, 401);
        assert.equal((await call('POST', '/api/presence/ble', { scanner: 'x', sightings: [] }, { 'X-Api-Token': presenceTok })).status, 200);
        assert.equal((await call('POST', '/api/sign', { cardUid: 'AABBCCDD' }, { 'X-Api-Token': presenceTok })).status, 401);
        assert.equal((await call('POST', '/api/mirror', { type: 'roster', roster: {} }, { 'X-Api-Token': presenceTok })).status, 401);
        assert.equal((await call('POST', '/api/mirror', { type: 'roster', roster: { staff: [], visitors: [] } }, { 'X-Api-Token': 'mirror-token' })).status, 200);
        // Unknown API paths are 404, known paths with the wrong method 405; /api/routes lists the table to the admin
        assert.equal((await call('GET', '/api/nothing')).status, 404);
        assert.equal((await call('DELETE', '/api/state')).status, 405);
        assert.equal((await call('GET', '/api/routes', undefined, A)).json.length, table.length);
        assert.equal((await call('GET', '/rollcall')).status, 200, '/rollcall is an alias of /fire');
    } finally { await close(); }
});

test('event-sourced attendance: the projection is the read path, is rebuilt from events, and answers "who was in at"', async () => {
    const { app, call, close } = await boot();
    try {
        const a = app.store.addPerson('Ann'); const b = app.store.addPerson('Ben');
        const t = (h) => `2026-10-19T${String(h).padStart(2, '0')}:00:00.000Z`;
        app.store.addEvent({ kind: 'in', subjectType: 'staff', subjectId: a.id, subjectName: 'Ann', source: 'kiosk', at: t(8) });
        app.store.addEvent({ kind: 'in', subjectType: 'staff', subjectId: b.id, subjectName: 'Ben', source: 'card', at: t(9) });
        app.store.addEvent({ kind: 'out', subjectType: 'staff', subjectId: a.id, subjectName: 'Ann', source: 'kiosk', at: t(12) });
        const v = app.store.addVisitor({ name: 'Vis', badge: 1, at: t(10) });
        app.store.addEvent({ kind: 'in', subjectType: 'visitor', subjectId: v.id, subjectName: 'Vis', source: 'kiosk', at: t(10) });
        app.store.addEvent({ kind: 'out', subjectType: 'visitor', subjectId: v.id, subjectName: 'Vis', source: 'kiosk', at: t(11) });
        assert.equal(app.store.getVisitor(v.id).signedOutAt, t(11), 'the visitor row follows the out event');
        const now = app.store.attendanceNow();
        assert.equal(now.get(`staff:${a.id}`).kind, 'out'); assert.equal(now.get(`staff:${b.id}`).kind, 'in');
        assert.deepEqual((await call('GET', `/api/register?at=${t(10)}`)).json.onSite.map(p => p.name).sort(), ['Ann', 'Ben', 'Vis']);
        assert.deepEqual((await call('GET', `/api/register?at=${t(13)}`)).json.onSite.map(p => p.name), ['Ben']);
        // a late-arriving older event (a reader replaying) never overwrites a newer fact
        app.store.addEvent({ kind: 'in', subjectType: 'staff', subjectId: a.id, subjectName: 'Ann', source: 'esp32', at: t(7) });
        assert.equal(app.store.latestPresenceEvent(a.id).kind, 'out');
        // hand-edit the log, prove drift is detected and corrected
        app.store.db.prepare("UPDATE events SET kind = 'in' WHERE subject_id = ? AND at = ?").run(a.id, t(12));
        assert.equal(app.store.rebuildProjections(), 1, 'drift corrected');
        assert.equal(app.store.rebuildProjections(), 0, 'now faithful');
        assert.equal((await call('GET', `/api/people/${a.id}/timeline`)).json.events.length, 3);
    } finally { await close(); }
});

test('migration v6-v9 on a v3.7-shaped database: state moves out of settings, projection backfilled, sessions table present', () => {
    const dir = tmp(); const file = path.join(dir, 'v37.sqlite');
    try {
        const s1 = new Store(file);
        const p = s1.addPerson('Legacy');
        s1.db.prepare("INSERT INTO events (id, kind, subject_type, subject_id, subject_name, at, source) VALUES ('e1','in','staff',?, 'Legacy','2026-10-18T08:00:00.000Z','kiosk')").run(p.id);
        s1.db.exec('DELETE FROM attendance_current');          // as if v3.7 had never had the projection
        s1.setSetting('teamsStatus', { ok: true, at: 'x' });  // v3.7 kept delivery state in settings
        s1.db.exec('PRAGMA user_version = 5');
        s1.close();
        const s2 = new Store(file);
        assert.deepEqual(s2.migrationsApplied, [6, 7, 8, 9]);
        assert.equal(s2.getSetting('teamsStatus'), null); assert.deepEqual(s2.getState('teamsStatus'), { ok: true, at: 'x' });
        assert.equal(s2.latestPresenceEvent(p.id).kind, 'in', 'projection backfilled from the log');
        s2.createSession({ token: 't', expiresAt: '2999-01-01T00:00:00.000Z' });
        assert.ok(s2.sessionByToken('t'));
        s2.close();
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('admin sessions survive a restart and are pruned when expired; audit names the session', async () => {
    const dir = tmp(); const file = path.join(dir, 'sess.sqlite');
    let app1 = await boot({ dataFile: file, adminPin: '246810' });
    try {
        const r = await app1.call('POST', '/api/admin/login', { pin: '246810' });
        const cookie = r.headers.get('set-cookie').split(';')[0];
        await app1.close();
        app1 = await boot({ dataFile: file, adminPin: '246810' });
        assert.equal((await app1.call('GET', '/api/people', undefined, { Cookie: cookie })).status, 200, 'still logged in after a restart');
        await app1.call('POST', '/api/people', { name: 'Via Session' }, { Cookie: cookie });
        const ev = app1.app.store.listEvents({ limit: 3 }).find(e => e.kind === 'admin' && /person added/.test(e.note));
        assert.match(ev.device, /session [0-9a-f]{12}/);
        app1.app.store.db.exec("UPDATE admin_sessions SET expires_at = '2000-01-01T00:00:00.000Z'");
        assert.equal((await app1.call('GET', '/api/people', undefined, { Cookie: cookie })).status, 401, 'expired');
        app1.app.store.pruneSessions();
        assert.equal(Number(app1.app.store.db.prepare('SELECT COUNT(*) AS n FROM admin_sessions').get().n), 0);
    } finally { await app1.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('drill + self-marking: DRILL cards, via:self marks, /api/me, all-accounted time, history', async () => {
    const posts = [];
    const fetch = async (url, init) => { posts.push(JSON.parse(init.body)); return new Response('1', { status: 200 }); };
    const { app, call, close } = await boot({ fetch, teamsWebhookUrl: 'https://teams.invalid/hook', publicUrl: 'https://signin.eright.co.uk' });
    const settle = () => new Promise(r => setTimeout(r, 80));
    try {
        const p = app.store.addPerson('Self Marker'); const q = app.store.addPerson('Other');
        await call('POST', '/api/sign', { personId: p.id }); await call('POST', '/api/sign', { personId: q.id });
        let r = await call('POST', '/api/fire/start', { source: 'fire-page', by: 'Alan', drill: true });
        assert.equal(r.status, 201); assert.equal(r.json.rollcall.drill, true);
        await settle();
        const card = posts[0].attachments[0].content;
        assert.match(card.body[0].text, /FIRE DRILL/);
        assert.deepEqual(card.actions.map(x => [x.title, x.url]), [["I'm SAFE", 'https://signin.eright.co.uk/safe'], ['Open the roll call', 'https://signin.eright.co.uk/fire']]);
        r = await call('GET', `/api/me?personId=${p.id}`);
        assert.equal(r.json.rollcall.onRegister, true); assert.equal(r.json.rollcall.mark, null);
        assert.equal((await call('POST', '/api/fire/mark', { subjectType: 'staff', subjectId: p.id, status: 'missing', via: 'self' })).status, 400, 'self can only say SAFE');
        r = await call('POST', '/api/fire/mark', { subjectType: 'staff', subjectId: p.id, status: 'safe', via: 'self' });
        assert.equal(r.json.rollcall.selfMarked, 1);
        assert.equal(r.json.rollcall.marks[0].by, 'Self Marker (self)'); assert.equal(r.json.rollcall.marks[0].via, 'self');
        assert.equal((await call('GET', `/api/me?personId=${p.id}`)).json.rollcall.mark, 'safe');
        r = await call('POST', '/api/fire/mark', { subjectType: 'staff', subjectId: q.id, status: 'safe', by: 'Alan' });
        assert.equal(r.json.rollcall.allSafe, true); assert.ok(r.json.rollcall.allSafeAt);
        await settle();
        assert.match(posts[1].attachments[0].content.body[0].text, /ACCOUNTED FOR \(drill\)/);
        r = await call('POST', '/api/fire/end', { by: 'Alan' });
        await settle();
        assert.match(posts[2].attachments[0].content.body[0].text, /DRILL ENDED/);
        assert.match(posts[2].attachments[0].content.body[1].text, /All accounted for after \d+ min/);
        const hist = (await call('GET', '/api/fire/history')).json;
        assert.equal(hist[0].drill, true); assert.equal(hist[0].selfMarked, 1);
        assert.match((await call('GET', '/metrics')).text, /^signin_rollcall_open 0$/m);
        assert.equal((await call('GET', '/safe')).status, 200);
    } finally { await close(); }
});

test('visitor fire-notice acknowledgement is recorded with the notice version', async () => {
    const { call, close } = await boot();
    try {
        await call('PUT', '/api/fire-notice', { fireNotice: 'Leave by the nearest exit.' });
        await call('PUT', '/api/fire-notice', { fireNotice: 'Leave by the nearest exit. Assemble at the car park.' });
        await call('POST', '/api/visitors', { name: 'Ack Visitor', agreed: true });
        await call('POST', '/api/visitors', { name: 'Silent Visitor' });
        const ev = (await call('GET', '/api/events?limit=5')).json.filter(e => e.subjectType === 'visitor');
        assert.match(ev.find(e => e.subjectName === 'Ack Visitor').note, /fire notice v2 acknowledged/);
        assert.doesNotMatch(ev.find(e => e.subjectName === 'Silent Visitor').note, /acknowledged/);
    } finally { await close(); }
});

test('retention: visitors anonymised, old events and roll calls deleted, projection truth kept; off by default; under 30 days refused', async () => {
    const { app, call, close } = await boot({ retentionDays: 365 });
    try {
        const old = '2024-01-10T09:00:00.000Z', recent = new Date(Date.now() - 86400_000).toISOString();
        const v = app.store.addVisitor({ name: 'Old Visitor', company: 'ACME', vehicle: 'AB12', badge: 1, at: old });
        app.store.addEvent({ kind: 'in', subjectType: 'visitor', subjectId: v.id, subjectName: 'Old Visitor', source: 'kiosk', at: old, note: 'ACME · badge 1' });
        app.store.addEvent({ kind: 'out', subjectType: 'visitor', subjectId: v.id, subjectName: 'Old Visitor', source: 'kiosk', at: '2024-01-10T17:00:00.000Z' });
        const p = app.store.addPerson('Long Timer');
        app.store.addEvent({ kind: 'in', subjectType: 'staff', subjectId: p.id, subjectName: 'Long Timer', source: 'kiosk', at: old });   // still "in" since 2024: the projection's event must survive
        app.store.addEvent({ kind: 'in', subjectType: 'staff', subjectId: p.id, subjectName: 'Long Timer', source: 'kiosk', at: recent });
        app.store.addEvent({ kind: 'in', subjectType: 'visitor', subjectId: 'v-recent', subjectName: 'New Visitor', source: 'kiosk', at: recent });
        const rc = app.store.startRollcall({ roster: { staff: [], visitors: [], count: 0 }, startedBy: 'x', source: 'fire-page', at: old }); app.store.endRollcall(rc.id, old);
        const r = await call('POST', '/api/retention/run', {});
        assert.equal(r.json.ok, true);
        assert.equal(r.json.visitorsAnonymised, 1); assert.equal(r.json.rollcallsDeleted, 1);
        assert.equal(r.json.eventsDeleted, 2, "the old visitor's arrival and the superseded staff event; each subject's current-state event is kept (anonymised) so the projection never dangles");
        const vv = app.store.getVisitor(v.id);
        assert.equal(vv.name, 'Visitor (anonymised)'); assert.equal(vv.company, null); assert.equal(vv.vehicle, null);
        assert.equal(app.store.latestPresenceEvent(p.id).at, recent);
        assert.ok(app.store.listEvents({ limit: 10 }).some(e => e.source === 'retention'), 'the run itself is logged');
        assert.match((await call('GET', '/metrics')).text, /^signin_retention_days 365$/m);
    } finally { await close(); }
    assert.throws(() => createApp({ dataFile: ':memory:', ...NO_ENV, retentionDays: 7 }), /under 30/);
    const off = createApp({ dataFile: ':memory:', ...NO_ENV });
    try { assert.ok(off.warnings.some(w => /RETENTION_DAYS not set/.test(w))); assert.equal((await off.runRetention()).skipped, true); } finally { off.close(); }
});

test('Microsoft List sink: creates the list once, then adds / patches / deletes rows to match the register (fake Graph)', async () => {
    const calls = []; let items = []; let nextId = 1;
    const fetch = async (url, init = {}) => {
        const u = String(url); const m = init.method || 'GET'; calls.push(`${m} ${u.replace('https://graph.microsoft.com/v1.0', '')}`);
        const j = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json' } });
        if (u.includes('oauth2')) return j({ access_token: 't', expires_in: 3600 });
        if (/\/sites\/[^/]+$/.test(u)) return j({ id: 'site1' });
        if (u.endsWith('/lists?$select=id,displayName')) return j({ value: items.length || calls.some(c => c.startsWith('POST /sites/site1/lists') && !c.includes('/items')) ? [{ id: 'list1', displayName: 'Sign-in register' }] : [] });
        if (u.endsWith('/lists') && m === 'POST') return j({ id: 'list1', displayName: JSON.parse(init.body).displayName }, 201);
        if (u.includes('/items?$expand')) return j({ value: items });
        if (u.endsWith('/items') && m === 'POST') { const f = JSON.parse(init.body).fields; items.push({ id: String(nextId++), fields: f }); return j({ id: String(nextId - 1) }, 201); }
        if (/\/items\/\d+\/fields$/.test(u) && m === 'PATCH') { const id = u.match(/items\/(\d+)/)[1]; const it = items.find(x => x.id === id); Object.assign(it.fields, JSON.parse(init.body)); return j(it.fields); }
        if (/\/items\/\d+$/.test(u) && m === 'DELETE') { const id = u.match(/items\/(\d+)/)[1]; items = items.filter(x => x.id !== id); return new Response(null, { status: 204 }); }
        return j({ error: 'unexpected ' + m + ' ' + u }, 500);
    };
    const { app, call, close } = await boot({ fetch, sharepoint: { tenantId: 't', clientId: 'c', clientSecret: 's', site: 'eright.sharepoint.com:/sites/eRIGHT', list: 'Sign-in register' } });
    try {
        assert.equal(app.mslist.configured, true);
        const p = app.store.addPerson('Listed');
        await call('POST', '/api/sign', { personId: p.id });
        let r = await app.flushOutbox();
        assert.equal(r.errors.mslist, undefined, JSON.stringify(r.errors));
        assert.ok(calls.some(c => c === 'POST /sites/site1/lists'), 'list created on first sync');
        assert.deepEqual(items.map(i => i.fields.Key).sort(), ['_status', `staff:${p.id}`]);
        assert.equal(items.find(i => i.fields.Key === '_status').fields.Title, '1 on site');
        await call('POST', '/api/fire/start', { source: 'fire-page', by: 'Alan' });
        await call('POST', '/api/fire/mark', { subjectType: 'staff', subjectId: p.id, status: 'safe', by: 'Alan' });
        await app.flushOutbox();
        assert.match(items.find(i => i.fields.Key === '_status').fields.Title, /FIRE ROLL CALL IN PROGRESS — 1 safe/);
        assert.equal(items.find(i => i.fields.Key === `staff:${p.id}`).fields.Status, 'safe');
        await call('POST', '/api/fire/end', {}); await call('POST', '/api/sign', { personId: p.id });
        await app.flushOutbox();
        assert.deepEqual(items.map(i => i.fields.Key), ['_status'], 'signed out: row deleted');
        assert.ok(app.store.getState('mslistStatus').ok);
        assert.match((await call('GET', '/metrics')).text, /^signin_mslist_last_push_ok 1$/m);
    } finally { await close(); }
});

test('assistant: answers only through tools, handles structured and text-form tool calls, never guesses', async () => {
    const seen = [];
    const fakeLlm = async (url, init) => {
        const body = JSON.parse(init.body); seen.push(body);
        const last = body.messages[body.messages.length - 1];
        const reply = (message) => new Response(JSON.stringify({ choices: [{ message }] }), { status: 200 });
        if (last.role === 'user' && /who is on site/i.test(last.content) && !/Result of/.test(last.content)) return reply({ role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'who_is_on_site', arguments: '{}' } }] });
        if (last.role === 'tool') { const d = JSON.parse(last.content); return reply({ role: 'assistant', content: `${d.count} on site: ${d.staff.map(s => s.name).join(', ')}.` }); }
        if (last.role === 'user' && /history/i.test(last.content) && !/Result of/.test(last.content)) return reply({ role: 'assistant', content: '<xml>{"name": "person_timeline", "arguments": {"name": "ann"}}</xml>' });
        if (last.role === 'user' && /Result of person_timeline/.test(last.content)) { const d = JSON.parse(last.content.split('\n')[1]); return reply({ role: 'assistant', content: `${d.person} has ${d.events.length} events.` }); }
        return reply({ role: 'assistant', content: 'I cannot tell.' });
    };
    const { app, call, close } = await boot({ fetch: fakeLlm, llmUrl: 'http://llm.invalid/v1', llmModel: 'fake', adminPin: 'pin' });
    try {
        const a = app.store.addPerson('Ann Example'); await call('POST', '/api/sign', { personId: a.id });
        assert.equal((await call('POST', '/api/ask', { question: 'who is on site?' })).status, 401, 'admin only');
        let r = await call('POST', '/api/ask', { question: 'who is on site?' }, { 'X-Admin-Pin': 'pin' });
        assert.equal(r.json.answer, '1 on site: Ann Example.'); assert.deepEqual(r.json.toolCalls.map(t => t.name), ['who_is_on_site']);
        r = await call('POST', '/api/ask', { question: "Ann's history please" }, { 'X-Admin-Pin': 'pin' });
        assert.equal(r.json.answer, 'Ann Example has 1 events.', 'text-form tool call (GGUF templates without tool support) is honoured');
        assert.ok(seen.every(b => b.tools.length === 5 && b.temperature === 0));
        assert.ok(app.store.listEvents({ limit: 5 }).some(e => e.kind === 'admin' && /asked the assistant/.test(e.note)));
        assert.deepEqual(new Assistant({ url: '', model: '', fetch, log: null, zone: app.zone, clock: app.clock, tools: {} }).run('nope'), { error: 'unknown tool nope' });
    } finally { await close(); }
    const none = await boot({ adminPin: 'pin' });
    try { assert.equal((await none.call('POST', '/api/ask', { question: 'x' }, { 'X-Admin-Pin': 'pin' })).status, 503); } finally { await none.close(); }
});

test('review fixes: stale ticks never land on a later roll call; restored reader taps never toggle; retention spares visitors still in', async () => {
    const { app, call, close } = await boot({ apiToken: 'tok', retentionDays: 365 });
    try {
        const p = app.store.addPerson('Pat'); app.store.updatePerson(p.id, { cardUid: 'CAFE0001' });
        await call('POST', '/api/sign', { personId: p.id });
        const rc1 = (await call('POST', '/api/fire/start', { source: 'fire-page' })).json.rollcall;
        await call('POST', '/api/fire/end', {});
        const rc2 = (await call('POST', '/api/fire/start', { source: 'fire-page' })).json.rollcall;
        let r = await call('POST', '/api/fire/mark', { subjectType: 'staff', subjectId: p.id, status: 'safe', rollcallId: rc1.id });
        assert.equal(r.status, 409, 'a tick queued during roll call 1 is refused on roll call 2');
        r = await call('POST', '/api/fire/mark', { subjectType: 'staff', subjectId: p.id, status: 'safe', rollcallId: rc2.id });
        assert.equal(r.status, 200);
        await call('POST', '/api/fire/end', {});

        // Pat signed IN this morning; the reader then replays a tap it kept through a power cut (time unknown)
        assert.equal(app.store.latestPresenceEvent(p.id).kind, 'in');
        r = await call('POST', '/api/sign', { cardUid: 'CAFE0001', source: 'esp32', eventKey: 'door-99', ageMs: 43200000, restored: true }, { 'X-Api-Token': 'tok' });
        assert.equal(r.status, 200); assert.equal(r.json.recorded, 'note-only'); assert.equal(r.json.event.kind, 'unknown_time_tap');
        assert.equal(app.store.latestPresenceEvent(p.id).kind, 'in', 'still signed in: a tap of unknown time never toggles');
        assert.equal((await call('POST', '/api/sign', { personId: p.id, restored: true })).json.event.kind, 'out', 'a human at a screen cannot use the flag to avoid acting');

        const old = '2024-01-10T09:00:00.000Z';
        const v = app.store.addVisitor({ name: 'Still Here', company: 'ACME', badge: 7, at: old });
        app.store.addEvent({ kind: 'in', subjectType: 'visitor', subjectId: v.id, subjectName: 'Still Here', source: 'kiosk', at: old });
        r = await call('POST', '/api/retention/run', {});
        assert.equal(r.json.visitorsAnonymised, 0, 'a visitor still signed in keeps their name until they are signed out');
        assert.equal(app.store.getVisitor(v.id).name, 'Still Here');
    } finally { await close(); }
});

test('native TLS: server.js serves https alongside http and marks the admin cookie Secure', async () => {
    const dir = tmp();
    try {
        let opensslOk = true;
        try { execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem'), '-days', '2', '-subj', '/CN=localhost'], { stdio: 'ignore' }); } catch { opensslOk = false; }
        if (!opensslOk) { console.log('  (openssl not available: TLS test skipped)'); return; }
        const { spawn } = require('node:child_process');
        const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, PORT: '3296', TLS_PORT: '3396', DATA_FILE: path.join(dir, 'tls.sqlite'), BACKUP_DIR: '', ADMIN_PIN: '246810', TLS_CERT_FILE: path.join(dir, 'c.pem'), TLS_KEY_FILE: path.join(dir, 'k.pem') };
        const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server.js'], { cwd: path.join(__dirname, '..'), env, stdio: ['ignore', 'pipe', 'pipe'] });
        let out = ''; child.stdout.on('data', d => { out += d; }); child.stderr.on('data', d => { out += d; });
        try {
            for (let i = 0; i < 40 && !/TLS listening/.test(out); i++) await new Promise(r => setTimeout(r, 150));
            assert.match(out, /TLS listening on https:\/\/0\.0\.0\.0:3396/);
            const get = (opts, body) => new Promise((resolve, reject) => { const req = https.request({ host: '127.0.0.1', port: 3396, rejectUnauthorized: false, ...opts }, res => { let t = ''; res.on('data', d => t += d); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: t })); }); req.on('error', reject); if (body) req.write(body); req.end(); });
            const h = await get({ path: '/api/health' });
            assert.equal(h.status, 200); assert.equal(JSON.parse(h.text).tls.port, 3396);
            const l = await get({ path: '/api/admin/login', method: 'POST', headers: { 'Content-Type': 'application/json' } }, JSON.stringify({ pin: '246810' }));
            assert.match(l.headers['set-cookie'][0], /; Secure$/);
            const plain = await fetch('http://127.0.0.1:3296/api/health'); assert.equal(plain.status, 200, 'plain HTTP still served');
        } finally { child.kill(); await new Promise(r => setTimeout(r, 300)); }
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
