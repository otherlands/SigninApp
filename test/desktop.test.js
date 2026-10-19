'use strict';
// v4.1: the Windows desktop reminder (deploy/desktop/signin-check.ps1) driven for real with Windows PowerShell 5.1
// against an in-process server. Windows only (skipped elsewhere); CI parses the script on Linux with pwsh instead.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { createApp } = require('../lib/app');

const NO_ENV = { adminPin: '', apiToken: '', mirrorUrl: '', mirrorToken: '', teamsWebhookUrl: '', publicUrl: '', replica: false, sharepoint: {}, unifi: {}, backupDir: '', silent: true, env: {} };
const SCRIPT = path.join(__dirname, '..', 'deploy', 'desktop', 'signin-check.ps1');

test('desktop reminder: setup, not-signed-in prompt, Yes signs in as "desktop", No snoozes for the day, off-network stays silent', { skip: process.platform !== 'win32' && 'Windows only' }, async () => {
    const app = createApp({ dataFile: ':memory:', ...NO_ENV });
    const server = http.createServer((req, res) => app.handle(req, res));
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'signin-desktop-'));
    const cfgPath = path.join(dir, 'signin-check.json');
    // Async on purpose: the server runs in this process and must keep answering while PowerShell waits on it.
    const ps = (...args) => new Promise((resolve) => execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, '-ConfigPath', cfgPath, '-WaitForNetworkSeconds', '0', ...args],
        { env: { ...process.env, LOCALAPPDATA: dir, APPDATA: dir }, windowsHide: true, timeout: 60_000 },
        (error, stdout, stderr) => resolve({ code: error ? (error.code ?? 1) : 0, out: String(stdout) + String(stderr) })));
    try {
        const p = app.store.addPerson('Desk Person'); app.store.addPerson('Someone Else');
        let r = await ps('-Setup', '-ConfigOnly', '-Server', base, '-PersonId', p.id, '-OfficeSubnets', '127.0.0.0/8', '-Answer', 'Yes');
        assert.equal(r.code, 0, r.out);
        const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8').replace(/^\uFEFF/, ''));
        assert.equal(cfg.personId, p.id); assert.equal(cfg.personName, 'Desk Person'); assert.deepEqual([].concat(cfg.officeSubnets), ['127.0.0.0/8']);

        r = await ps('-Check');
        assert.equal(r.code, 1, r.out); assert.match(r.out, /NOT SIGNED IN: Desk Person/);

        // "No" = not in the office today: silent for the rest of the day, register untouched
        r = await ps('-Answer', 'No');
        assert.equal(r.code, 0, r.out);
        assert.equal((await (await fetch(base + '/api/state')).json()).people.find(x => x.id === p.id).signedIn, false);
        r = await ps('-Check');
        assert.equal(r.code, 0, r.out); assert.match(r.out, /said not in the office today/);

        // next day (clear the snooze): "Yes" signs in, recorded as a deliberate desktop sign-in from this PC
        fs.writeFileSync(cfgPath, JSON.stringify({ ...cfg, snoozedDay: '' }));
        r = await ps('-Answer', 'Yes');
        assert.equal(r.code, 0, r.out); assert.match(r.out, /signed in: Desk Person/);
        const ev = app.store.listEvents({ limit: 5 }).find(e => e.subjectId === p.id);
        assert.equal(ev.kind, 'in'); assert.equal(ev.source, 'desktop');
        assert.equal(ev.device, `pc-${os.hostname()}`.toLowerCase());
        assert.match(ev.note, /confirmed on PC/);
        r = await ps('-Check');
        assert.equal(r.code, 0, r.out); assert.match(r.out, /ok: Desk Person is signed in/);

        // signed in already: "Yes" changes nothing (never toggles anyone out)
        r = await ps('-Answer', 'Yes');
        assert.equal((await (await fetch(base + '/api/state')).json()).people.find(x => x.id === p.id).signedIn, true);
        assert.equal(app.store.listEvents({ limit: 50 }).filter(e => e.subjectId === p.id).length, 1);

        // off the office network: silent, whatever the register says
        await app.commands.signStaff({ person: app.store.getPerson(p.id), direction: 'out', source: 'kiosk' });
        fs.writeFileSync(cfgPath, JSON.stringify({ ...cfg, snoozedDay: '', officeSubnets: ['203.0.113.0/24'] }));
        r = await ps('-Check');
        assert.equal(r.code, 0, r.out); assert.match(r.out, /not on the office network/);
    } finally {
        app.close(); server.closeAllConnections?.(); await new Promise(r => server.close(r));
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
