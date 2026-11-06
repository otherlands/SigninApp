'use strict';
// The eRIGHT Door phone app's one write: POST /api/me/sign with the owner's personal key (X-Safe-Key).
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createApp } = require('../lib/app');

const NO_ENV = { apiToken: '', mirrorUrl: '', mirrorToken: '', teamsWebhookUrl: '', publicUrl: '', replica: false, sharepoint: {}, unifi: {}, backupDir: '', silent: true, env: {} };
async function boot(options = {}) {
    const app = createApp({ dataFile: ':memory:', adminPin: 'pin', ...NO_ENV, ...options });
    const server = http.createServer((req, res) => app.handle(req, res));
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (method, p, body, headers = {}) => {
        const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body && method !== 'GET' ? JSON.stringify(body) : undefined });
        const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch { }
        return { status: res.status, json };
    };
    return { app, call, close: () => new Promise(r => { app.close(); server.closeAllConnections?.(); server.close(() => r()); }) };
}
const A = { 'X-Admin-Pin': 'pin' }, P = { 'X-Public': '1' };
const SK = (k) => ({ 'X-Safe-Key': k, 'X-Device': 'phone:test' });

test('phone app: key decides who; in on the office network only; out from anywhere; idempotent; /api/me reports it', async () => {
    const { app, call, close } = await boot();
    try {
        const george = app.store.addPerson('George Scoley'); const sam = app.store.addPerson('Sam Birch');
        const link = (await call('POST', `/api/people/${george.id}/safe-link`, {}, A)).json.link;
        const k = new URLSearchParams(link.split('#')[1]).get('k');

        assert.equal((await call('POST', '/api/me/sign', { direction: 'in' })).status, 401, 'no key');
        assert.equal((await call('POST', '/api/me/sign', { direction: 'in' }, SK('guess-guess-guess-guess'))).status, 401, 'wrong key');
        assert.equal((await call('POST', '/api/me/sign', { direction: 'sideways' }, SK(k))).status, 400);

        // joined the office Wi-Fi: in, recorded once, source phone, with the reason; personId in the body is ignored
        let r = await call('POST', '/api/me/sign', { direction: 'in', reason: 'wifi-joined', personId: sam.id }, SK(k));
        assert.equal(r.status, 200); assert.equal(r.json.changed, true); assert.equal(r.json.signedIn, true);
        r = await call('POST', '/api/me/sign', { direction: 'in', reason: 'wifi-joined' }, SK(k));
        assert.equal(r.json.changed, false, 'already in: nothing recorded');
        const st = (await call('GET', '/api/state')).json;
        assert.equal(st.people.find(p => p.id === george.id).signedIn, true);
        assert.equal(st.people.find(p => p.id === sam.id).signedIn, false, 'the key decides who, not the body');
        const ev = app.store.listEvents({ limit: 10 }).filter(e => e.subjectId === george.id);
        assert.equal(ev.length, 1);
        assert.equal(ev[0].source, 'phone'); assert.equal(ev[0].device, 'phone:test'); assert.match(ev[0].note, /joined the office network/);

        let me = (await call('GET', '/api/me', undefined, SK(k))).json;
        assert.equal(me.person.signedIn, true); assert.ok(me.person.since);

        // from outside: in is refused, out (left the area) is accepted
        assert.equal((await call('POST', '/api/me/sign', { direction: 'in' }, { ...P, ...SK(k) })).status, 403);
        r = await call('POST', '/api/me/sign', { direction: 'out', reason: 'left-area' }, { ...P, ...SK(k) });
        assert.equal(r.status, 200); assert.equal(r.json.changed, true); assert.equal(r.json.signedIn, false);
        assert.match(app.store.listEvents({ limit: 1 })[0].note, /left the office network and the office area/);
        me = (await call('GET', '/api/me', undefined, SK(k))).json;
        assert.equal(me.person.signedIn, false); assert.equal(me.person.since, null);
        assert.equal((await call('POST', '/api/me/sign', { direction: 'out' }, { ...P, ...SK(k) })).json.changed, false);

        // a rotated key stops the old phone at once
        await call('POST', `/api/people/${george.id}/safe-link`, {}, A);
        assert.equal((await call('POST', '/api/me/sign', { direction: 'in' }, SK(k))).status, 401);
    } finally { await close(); }
});
