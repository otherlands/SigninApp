'use strict';
// UniFi console behind its own self-signed certificate: the API key is sent only to a server presenting exactly
// the pinned certificate. Fixtures are throwaway test-only certificates (CN unifi.local, like a real console).
const test = require('node:test');
const assert = require('node:assert/strict');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const { pinnedFetch } = require('../lib/pinned');
const { createApp } = require('../lib/app');
const { loadConfig } = require('../lib/config');

const A = path.join(__dirname, 'fixtures', 'pinned-a.pem');
const B = path.join(__dirname, 'fixtures', 'pinned-b.pem');
const pemOf = (file) => fs.readFileSync(file);

async function controller(file) {
    const seen = [];
    const server = https.createServer({ cert: pemOf(file), key: pemOf(file) }, (req, res) => {
        seen.push({ url: req.url, key: req.headers['x-api-key'] });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [
            { mac: 'aa:bb:cc:dd:ee:01', essid: 'eRIGHT-Corporate', hostname: 'Galaxy-S25-Ultra', ap_name: 'Office AP' },
            { mac: 'aa:bb:cc:dd:ee:02', is_wired: true, hostname: 'PRINT' },
            { mac: 'aa:bb:cc:dd:ee:03', essid: 'IOT', hostname: 'shelly' }
        ] }));
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    return { url: `https://127.0.0.1:${server.address().port}`, seen, close: () => new Promise(r => server.close(() => r())) };
}

test('pinned fetch: talks to the pinned certificate; a different certificate gets nothing, not even the request', async () => {
    const ctl = await controller(A);
    try {
        const r = await pinnedFetch(pemOf(A))(`${ctl.url}/proxy/network/api/s/default/stat/sta`, { headers: { 'X-API-KEY': 'secret-key' } });
        assert.equal(r.status, 200);
        assert.equal((await r.json()).data.length, 3);
        assert.deepEqual(ctl.seen, [{ url: '/proxy/network/api/s/default/stat/sta', key: 'secret-key' }]);

        ctl.seen.length = 0;
        await assert.rejects(pinnedFetch(pemOf(B))(`${ctl.url}/x`, { headers: { 'X-API-KEY': 'secret-key' } }));
        assert.deepEqual(ctl.seen, [], 'the server with the wrong certificate never received a request (so never saw the key)');
    } finally { await ctl.close(); }
});

test('UNIFI_CA_FILE: presence polls a self-signed console through the pin; config refuses a bad file', async () => {
    const ctl = await controller(A);
    const app = createApp({ dataFile: ':memory:', adminPin: '', apiToken: '', mirrorUrl: '', mirrorToken: '', teamsWebhookUrl: '', publicUrl: '', replica: false, sharepoint: {}, backupDir: '', silent: true, env: {}, presence: true,
        unifi: { url: ctl.url, apiKey: 'k', site: 'default', path: '/proxy/network/api/s/{site}/stat/sta', ssid: 'eRIGHT-Corporate', caFile: A } });
    try {
        const poll = await app.presence.pollWifi();
        assert.equal(poll.ok, true, JSON.stringify(poll));
        assert.equal(poll.count, 3);
        assert.deepEqual(app.presence.candidates().phones.map(c => c.hostname), ['Galaxy-S25-Ultra'], 'only wireless clients on UNIFI_SSID are phone candidates');
    } finally { app.close(); await ctl.close(); }

    const bad = loadConfig({}, { UNIFI_URL: 'https://192.168.101.1', UNIFI_API_KEY: 'k', UNIFI_CA_FILE: path.join(__dirname, 'no-such.pem') });
    assert.ok(bad.errors.some(e => /UNIFI_CA_FILE/.test(e)), bad.errors.join('; '));
    const plain = loadConfig({}, { UNIFI_URL: 'http://192.168.101.1', UNIFI_API_KEY: 'k', UNIFI_CA_FILE: A });
    assert.ok(plain.errors.some(e => /not https/.test(e)), plain.errors.join('; '));
    const good = loadConfig({}, { UNIFI_URL: 'https://192.168.101.1', UNIFI_API_KEY: 'k', UNIFI_CA_FILE: A });
    assert.ok(!good.errors.some(e => /UNIFI/.test(e)), good.errors.join('; '));
});
