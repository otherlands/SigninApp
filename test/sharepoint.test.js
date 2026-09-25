'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createApp } = require('../lib/app');

/** Minimal fake of login.microsoftonline.com + graph.microsoft.com, recording every request. */
function fakeGraph({ failUploads = false } = {}) {
    const calls = [];
    const files = new Map();
    const fetch = async (url, init = {}) => {
        const u = String(url);
        const method = init.method || 'GET';
        calls.push({ method, url: u, headers: init.headers || {}, body: init.body });
        const reply = (status, body, type = 'application/json') => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'Content-Type': type } });

        if (u.startsWith('https://login.microsoftonline.com/')) {
            const form = new URLSearchParams(String(init.body));
            if (form.get('client_secret') !== 'sec') return reply(401, { error: 'invalid_client', error_description: 'bad secret' });
            return reply(200, { access_token: 'tok123', expires_in: 3600 });
        }
        if ((init.headers || {}).Authorization !== 'Bearer tok123') return reply(401, { error: 'no token' });
        if (u === 'https://graph.microsoft.com/v1.0/sites/eright.sharepoint.com:/sites/eRIGHT') return reply(200, { id: 'site-1' });
        if (u === 'https://graph.microsoft.com/v1.0/sites/site-1/drive') return reply(200, { id: 'drive-default' });
        if (u === 'https://graph.microsoft.com/v1.0/sites/site-1/drives') return reply(200, { value: [{ id: 'drive-docs', name: 'Documents' }, { id: 'drive-x', name: 'Other' }] });
        const m = u.match(/^https:\/\/graph\.microsoft\.com\/v1\.0\/drives\/([^/]+)\/root:\/(.+):\/content$/);
        if (m && method === 'PUT') {
            if (failUploads) return reply(503, { error: 'service unavailable' });
            files.set(decodeURIComponent(m[2]), { drive: m[1], body: String(init.body), type: init.headers['Content-Type'] });
            return reply(201, { id: 'item', name: m[2] });
        }
        return reply(404, { error: `unhandled ${method} ${u}` });
    };
    return { fetch, calls, files };
}

async function boot(options = {}) {
    const app = createApp({ dataFile: ':memory:', ...options });
    const server = http.createServer((req, res) => app.handle(req, res));
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (method, path, body, headers = {}) => {
        const res = await globalThis.fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
        const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch { }
        return { status: res.status, json, text };
    };
    return { app, call, close: () => new Promise(r => server.close(() => { app.close(); r(); })) };
}

const spConfig = { tenantId: 'tenant-1', clientId: 'client-1', clientSecret: 'sec', site: 'eright.sharepoint.com:/sites/eRIGHT', folder: '/eRIGHT Ltd/Sign-in/' };

test('SharePoint sink: token, site, default drive, three files; snapshots collapse to one upload set', async () => {
    const g = fakeGraph();
    const { app, call, close } = await boot({ fetch: g.fetch, sharepoint: spConfig });
    try {
        let r = await call('POST', '/api/people', { name: 'Alan Meade' });
        const alan = r.json.people[0];
        await call('POST', '/api/sign', { personId: alan.id });            // queues snapshot 1
        await call('POST', '/api/visitors', { name: 'Vis Itor', company: 'ACME', hostId: alan.id }); // snapshot 2
        assert.equal(app.store.outboxDepth(), 2);

        const result = await app.flushOutbox();
        assert.deepEqual(result.errors, {});
        assert.equal(result.remaining, 0, 'both queued snapshots acknowledged');
        assert.equal(result.sent, 1, 'but only one upload set was sent');

        const puts = g.calls.filter(c => c.method === 'PUT');
        assert.equal(puts.length, 3, 'txt + json + csv');
        assert.equal(g.calls.filter(c => c.url.startsWith('https://login.microsoftonline.com/')).length, 1, 'token fetched once');
        assert.ok(g.calls.some(c => c.url.endsWith('/sites/site-1/drive')), 'default library used when SP_DRIVE unset');

        const txt = g.files.get('eRIGHT Ltd/Sign-in/who-is-on-site.txt');
        assert.ok(txt, 'folder slashes trimmed and path preserved');
        assert.equal(txt.drive, 'drive-default');
        assert.match(txt.body, /ON SITE: 2 {3}\(staff 1, visitors 1\)/);
        assert.match(txt.body, /Alan Meade {2}— in since/);
        assert.match(txt.body, /Vis Itor {2}— ACME, visiting Alan Meade, badge 1/);

        const json = JSON.parse(g.files.get('eRIGHT Ltd/Sign-in/roster.json').body);
        assert.equal(json.count, 2);
        assert.equal(json.rollcall, null);

        const csvName = [...g.files.keys()].find(k => /events-\d{4}-\d{2}-\d{2}\.csv$/.test(k));
        assert.ok(csvName, 'daily CSV named by local day');
        assert.match(g.files.get(csvName).body, /^Date,Time,Type,Name,Action,Source,Device,Note\r\n/);
        assert.match(g.files.get(csvName).body, /"Alan Meade","in"/);

        r = await call('GET', '/api/health');
        assert.equal(r.json.sharepoint.configured, true);
        assert.equal(r.json.sharepoint.last.ok, true);
        assert.equal(r.json.sharepoint.last.files.length, 3);
    } finally { await close(); }
});

test('SharePoint sink: roll call start/mark/end each republish and the txt shows the roll call', async () => {
    const g = fakeGraph();
    const { app, call, close } = await boot({ fetch: g.fetch, sharepoint: spConfig });
    try {
        let r = await call('POST', '/api/people', { name: 'A' });
        const a = r.json.people[0];
        await call('POST', '/api/sign', { personId: a.id });
        await app.flushOutbox();

        await call('POST', '/api/fire/start', { source: 'fire-page', by: 'Anyone' });
        await call('POST', '/api/fire/mark', { subjectType: 'staff', subjectId: a.id, status: 'safe', by: 'Anyone' });
        assert.equal(app.store.outboxDepth(), 2, 'start and mark both queued');
        await app.flushOutbox();
        const txt = g.files.get('eRIGHT Ltd/Sign-in/who-is-on-site.txt').body;
        assert.match(txt, /\*\*\* FIRE ROLL CALL IN PROGRESS since .* by Anyone \*\*\*/);
        assert.match(txt, /safe 1 \/ missing 0 \/ not yet seen 0 of 1/);
        const json = JSON.parse(g.files.get('eRIGHT Ltd/Sign-in/roster.json').body);
        assert.equal(json.rollcall.safe, 1);

        await call('POST', '/api/fire/end', { by: 'Anyone' });
        await app.flushOutbox();
        assert.doesNotMatch(g.files.get('eRIGHT Ltd/Sign-in/who-is-on-site.txt').body, /ROLL CALL IN PROGRESS/);
    } finally { await close(); }
});

test('SharePoint sink: named library, upload failure keeps the queue and records the error', async () => {
    const g = fakeGraph({ failUploads: true });
    const { app, call, close } = await boot({ fetch: g.fetch, sharepoint: { ...spConfig, drive: 'Documents' } });
    try {
        let r = await call('POST', '/api/people', { name: 'A' });
        await call('POST', '/api/sign', { personId: r.json.people[0].id });
        const result = await app.flushOutbox();
        assert.equal(result.sent, 0);
        assert.equal(result.remaining, 1, 'snapshot stays queued for the next attempt');
        assert.match(result.errors.sharepoint, /503/);
        assert.ok(g.calls.some(c => c.url.endsWith('/sites/site-1/drives')), 'library list consulted for a named drive');
        r = await call('GET', '/api/health');
        assert.equal(r.json.sharepoint.last.ok, false);
        assert.match(r.json.sharepoint.last.error, /503/);
    } finally { await close(); }
});

test('SharePoint sink: wrong secret surfaces as a token error, not a crash', async () => {
    const g = fakeGraph();
    const { app, call, close } = await boot({ fetch: g.fetch, sharepoint: { ...spConfig, clientSecret: 'wrong' } });
    try {
        let r = await call('POST', '/api/people', { name: 'A' });
        await call('POST', '/api/sign', { personId: r.json.people[0].id });
        const result = await app.flushOutbox();
        assert.match(result.errors.sharepoint, /token request failed: 401 bad secret/);
        assert.equal(g.calls.filter(c => c.method === 'PUT').length, 0);
    } finally { await close(); }
});

test('SharePoint sink: not configured means nothing is queued and health says so', async () => {
    const { app, call, close } = await boot({ sharepoint: {} });
    try {
        let r = await call('POST', '/api/people', { name: 'A' });
        await call('POST', '/api/sign', { personId: r.json.people[0].id });
        assert.equal(app.store.outboxDepth(), 0);
        r = await call('GET', '/api/health');
        assert.equal(r.json.sharepoint, null);
    } finally { await close(); }
});
