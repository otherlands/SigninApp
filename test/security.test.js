'use strict';
// Phase 2 (security model) and Phase 5 (live UI) server behaviour: per-device scoped tokens, admin sessions,
// audit trail, and the /api/stream push channel.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createApp } = require('../lib/app');

const NO_ENV = { adminPin: '', apiToken: '', mirrorUrl: '', mirrorToken: '', teamsWebhookUrl: '', publicUrl: '', replica: false, sharepoint: {}, unifi: {}, backupDir: '', silent: true, env: {}, presence: true };
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
    return { app, call, base, close: () => new Promise(r => { app.close(); server.closeAllConnections?.(); server.close(() => r()); }) };
}

test('device tokens: issued by admin, shown once, scoped, name-binding, revocable, reissuable', async () => {
    const { app, call, close } = await boot({ adminPin: '246810', apiToken: 'shared-token-0123456789' });
    const A = { 'X-Admin-Pin': '246810' };
    try {
        const p = app.store.addPerson('Card Holder');
        app.store.updatePerson(p.id, { cardUid: 'AABBCCDD' });
        assert.equal((await call('POST', '/api/devices', { name: 'back-door-reader', scopes: ['sign'] })).status, 401, 'admin only');
        let r = await call('POST', '/api/devices', { name: 'back door!', scopes: ['sign'] }, A);
        assert.equal(r.status, 400);
        r = await call('POST', '/api/devices', { name: 'back-door-reader', role: 'reader', scopes: ['sign', 'fire', 'bogus'] }, A);
        assert.equal(r.status, 201);
        const reader = r.json.token;
        assert.deepEqual(r.json.device.scopes, ['sign', 'fire']);
        r = await call('POST', '/api/devices', { name: 'anchor', role: 'scanner', scopes: ['presence'] }, A);
        const anchor = r.json.token;
        assert.equal((await call('POST', '/api/devices', { name: 'anchor', scopes: ['presence'] }, A)).status, 409, 'one live token per name');

        r = await call('GET', '/api/devices', undefined, A);
        assert.equal(r.json.length, 2);
        assert.doesNotMatch(r.text, new RegExp(reader), 'tokens are never listed');
        assert.doesNotMatch(r.text, /token_hash|tokenHash/);

        r = await call('POST', '/api/sign', { cardUid: 'AABBCCDD', source: 'esp32', device: 'i-am-the-kiosk' }, { 'X-Api-Token': reader });
        assert.equal(r.status, 200);
        assert.equal(r.json.event.device, 'back-door-reader', 'the token, not the request, names the device');
        assert.equal((await call('POST', '/api/sign', { cardUid: 'AABBCCDD', source: 'esp32' }, { 'X-Api-Token': anchor })).status, 401, 'a scanner token cannot sign people');
        assert.equal((await call('POST', '/api/presence/ble', { scanner: 'anchor', sightings: [] }, { 'X-Api-Token': reader })).status, 401, 'a reader token cannot post sightings');
        assert.equal((await call('POST', '/api/presence/ble', { scanner: 'anchor', sightings: [] }, { 'X-Api-Token': anchor })).status, 200);
        assert.equal((await call('POST', '/api/fire/start', { source: 'esp32', by: 'door button' }, { 'X-Api-Token': reader })).status, 201);
        assert.equal((await call('POST', '/api/sign', { cardUid: 'AABBCCDD', source: 'card' }, { 'X-Api-Token': 'shared-token-0123456789' })).status, 200, 'the shared token still works');
        assert.equal((await call('POST', '/api/mirror', { type: 'roster', roster: { staff: [], visitors: [] } }, { 'X-Api-Token': reader })).status, 401, 'device tokens never feed the mirror');

        const id = (await call('GET', '/api/devices', undefined, A)).json.find(d => d.name === 'back-door-reader').id;
        assert.ok((await call('GET', '/api/devices', undefined, A)).json.find(d => d.name === 'back-door-reader').lastSeenAt, 'last use is recorded');
        assert.equal((await call('DELETE', `/api/devices/${id}`, undefined, A)).status, 200);
        assert.equal((await call('POST', '/api/sign', { cardUid: 'AABBCCDD', source: 'esp32' }, { 'X-Api-Token': reader })).status, 401, 'revoked at once');
        r = await call('POST', '/api/devices', { name: 'back-door-reader', scopes: ['sign'] }, A);
        assert.equal(r.status, 201, 'the name can be reissued after revocation');
        assert.ok((await call('GET', '/api/devices', undefined, A)).json.some(d => /back-door-reader \(revoked/.test(d.name)), 'the old row is kept, renamed');
    } finally { await close(); }
});

test('open mode ends as soon as the first device token exists — and revoking it does not reopen it', async () => {
    const { app, call, close } = await boot();
    try {
        const p = app.store.addPerson('Bench');
        app.store.updatePerson(p.id, { cardUid: '11223344' });
        assert.equal((await call('POST', '/api/sign', { cardUid: '11223344', source: 'card' })).status, 200, 'no API_TOKEN, no devices: bench mode');
        const { token, device } = (await call('POST', '/api/devices', { name: 'reader', scopes: ['sign'] })).json;
        assert.equal((await call('POST', '/api/sign', { cardUid: '11223344', source: 'card' })).status, 401);
        assert.equal((await call('POST', '/api/sign', { cardUid: '11223344', source: 'card' }, { 'X-Api-Token': token })).status, 200);
        await call('DELETE', `/api/devices/${device.id}`);
        assert.equal((await call('POST', '/api/sign', { cardUid: '11223344', source: 'card' })).status, 401, 'revoking the last token locks, never opens');
        assert.equal((await call('POST', '/api/sign', { cardUid: '11223344', source: 'card' }, { 'X-Api-Token': token })).status, 401);
        assert.equal((await call('POST', '/api/fire/start', { source: 'alarm' })).status, 401);
    } finally { await close(); }
});

test('admin session: login sets an HttpOnly SameSite cookie, wrong PINs count toward lockout, logout ends it', async () => {
    const { call, close } = await boot({ adminPin: '246810', adminLockout: { max: 3, windowMs: 60_000 } });
    try {
        let r = await call('POST', '/api/admin/login', { pin: '000000' });
        assert.equal(r.status, 401);
        r = await call('POST', '/api/admin/login', { pin: '246810' });
        assert.equal(r.status, 200);
        const cookie = r.headers.get('set-cookie');
        assert.match(cookie, /^si_admin=[^;]+; HttpOnly; SameSite=Strict; Path=\//);
        const C = { Cookie: cookie.split(';')[0] };
        assert.equal((await call('GET', '/api/people', undefined, C)).status, 200, 'the cookie is the credential');
        r = await call('POST', '/api/admin/login', { pin: '999999' }, C);
        assert.equal(r.status, 401, 'a wrong PIN is answered (not left hanging) even with a live session');
        assert.equal((await call('GET', '/api/people', undefined, { Cookie: 'si_admin=forged' })).status, 401);
        await call('POST', '/api/admin/logout', {}, C);
        assert.equal((await call('GET', '/api/people', undefined, C)).status, 401, 'logged out');
        r = await call('POST', '/api/admin/login', { pin: '222222' });
        assert.equal(r.status, 429, 'the third miss locks the address');
        assert.equal((await call('POST', '/api/admin/login', { pin: '246810' })).status, 429, 'locked even with the right PIN');
    } finally { await close(); }
});

test('audit: admin changes and lockouts are in the event log with who/what', async () => {
    const { app, call, close } = await boot({ adminPin: '246810', adminLockout: { max: 2, windowMs: 60_000 } });
    const A = { 'X-Admin-Pin': '246810', 'X-Device': 'office-pc' };
    try {
        const p = (await call('POST', '/api/people', { name: 'Audited' }, A)).json.people[0];
        await call('PATCH', `/api/people/${p.id}`, { cardUid: 'CAFEBABE', name: 'Audited Person' }, A);
        await call('PUT', '/api/company', { companyName: 'New Co' }, A);
        await call('POST', '/api/devices', { name: 'reader', scopes: ['sign'] }, A);
        await call('DELETE', `/api/people/${p.id}`, undefined, A);
        const notes = (await call('GET', '/api/events?limit=50', undefined, A)).json.filter(e => e.kind === 'admin').map(e => `${e.device}: ${e.note}`);
        assert.deepEqual(notes.reverse(), [
            'office-pc: person added: Audited',
            'office-pc: person changed: Audited (name=Audited Person, cardUid=set)',
            'office-pc: company name set: New Co',
            'office-pc: device token issued: reader (sign)',
            'office-pc: person removed: Audited Person'
        ]);
        await call('GET', '/api/people', undefined, { 'X-Admin-Pin': 'x1' });
        await call('GET', '/api/people', undefined, { 'X-Admin-Pin': 'x2' });
        assert.equal((await call('GET', '/api/events?limit=5', undefined, A)).status, 429, 'this address is now locked out');
        assert.ok(app.store.listEvents({ limit: 5 }).some(e => e.kind === 'admin' && /locked out after 2 wrong PINs/.test(e.note)), 'the lockout itself is logged');
    } finally { await close(); }
});

test('live updates: /api/stream says hello, announces a sign-in, stays quiet for scanner chatter', async () => {
    const { app, base, call, close } = await boot();
    const ctrl = new AbortController();
    try {
        const p = app.store.addPerson('Streamed');
        const res = await fetch(base + '/api/stream', { signal: ctrl.signal });
        assert.match(res.headers.get('content-type'), /text\/event-stream/);
        const reader = res.body.getReader(); const dec = new TextDecoder();
        let buf = ''; let pending = null;   // one outstanding read at a time, or a timed-out wait swallows the next chunk
        const next = async (ms) => {
            const timeout = new Promise(r => setTimeout(() => r('timeout'), ms));
            while (true) {
                const i = buf.indexOf('\n\n');
                if (i >= 0) { const msg = buf.slice(0, i); buf = buf.slice(i + 2); return msg; }
                pending ??= reader.read();
                const chunk = await Promise.race([pending, timeout]);
                if (chunk === 'timeout') return null;
                pending = null;
                if (chunk.done) return null;
                buf += dec.decode(chunk.value);
            }
        };
        assert.match(await next(1000), /event: hello/);
        await call('POST', '/api/presence/ble', { scanner: 'anchor', sightings: [{ tag: 'mac:00:11:22:33:44:55' }] });
        assert.equal(await next(300), null, 'nobody moved: no change event');
        await call('POST', '/api/sign', { personId: p.id });
        assert.match(await next(1000), /event: change\ndata: \{"seq":1\}/);
        await call('POST', '/api/visitors', { name: 'V1' }); await call('POST', '/api/visitors', { name: 'V2' });
        assert.match(await next(1000), /event: change/);
        assert.equal(await next(200), null, 'a burst is coalesced into one change');
    } finally { ctrl.abort(); await close(); }
});
