'use strict';
// Phase 1 foundations: schema migrations, config validation, clock + local time, scheduler, health checks, logging.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { createApp } = require('../lib/app');
const { Store, SCHEMA_VERSION } = require('../lib/store');
const { loadConfig } = require('../lib/config');
const { createClock, LocalTime } = require('../lib/time');
const { Scheduler } = require('../lib/scheduler');
const { createLogger } = require('../lib/log');

const NO_ENV = { adminPin: '', apiToken: '', mirrorUrl: '', mirrorToken: '', teamsWebhookUrl: '', publicUrl: '', replica: false, sharepoint: {}, unifi: {}, backupDir: '', silent: true, env: {} };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'signin-f-'));

test('migrations: a live v3.6 database (user_version 0) upgrades in place; re-opening is a no-op', () => {
    const dir = tmp(); const file = path.join(dir, 'legacy.sqlite');
    try {
        // As shipped by v3.6: every table already there, phone/tag columns added by the old ALTER-in-try, a decimal card.
        const legacy = new DatabaseSync(file);
        legacy.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE people (id TEXT PRIMARY KEY, name TEXT NOT NULL, card_uid TEXT UNIQUE, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, phone_mac TEXT, tag_id TEXT);
            INSERT INTO people VALUES ('p1', 'Wedge Person', '0174870321', 1, '2026-09-25T00:00:00Z', NULL, NULL);
            INSERT INTO settings VALUES ('companyName', '"Kept Ltd"');`);
        legacy.close();
        const s = new Store(file);
        assert.deepEqual(s.migrationsApplied, Array.from({ length: SCHEMA_VERSION }, (_, i) => i + 1));
        assert.equal(s.schemaVersion(), SCHEMA_VERSION);
        assert.equal(s.getPerson('p1').cardUid, '314F6C0A', 'decimal wedge UID re-keyed once');
        assert.equal(s.getSetting('companyName'), 'Kept Ltd', 'data kept');
        s.close();
        const again = new Store(file);
        assert.deepEqual(again.migrationsApplied, [], 'nothing re-applied');
        again.close();
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('migrations: a pre-presence (v3.3) people table gains the phone and tag columns; a newer schema is refused', () => {
    const dir = tmp(); const file = path.join(dir, 'old.sqlite');
    try {
        const old = new DatabaseSync(file);
        old.exec(`CREATE TABLE people (id TEXT PRIMARY KEY, name TEXT NOT NULL, card_uid TEXT UNIQUE, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);`);
        old.close();
        const s = new Store(file);
        const cols = s.db.prepare('PRAGMA table_info(people)').all().map(c => c.name);
        assert.ok(cols.includes('phone_mac') && cols.includes('tag_id'));
        s.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
        s.close();
        assert.throws(() => new Store(file), /newer than this software/);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('config: errors stop the server, warnings do not, env and options both work', () => {
    let r = loadConfig({}, { TZ_NAME: 'Mars/Olympus', PORT: 'eighty', MIRROR_URL: 'mirror.local', REPLICA: '1' });
    assert.equal(r.errors.length, 4, r.errors.join(' | '));
    assert.match(r.errors.join('\n'), /TZ_NAME/); assert.match(r.errors.join('\n'), /PORT/); assert.match(r.errors.join('\n'), /MIRROR_URL/); assert.match(r.errors.join('\n'), /MIRROR_TOKEN/);
    r = loadConfig({}, { ADMIN_PIN: '12', SP_TENANT_ID: 't', SP_CLIENT_ID: 'c', UNIFI_URL: 'https://udm' });
    assert.deepEqual(r.errors, []);
    assert.match(r.warnings.join('\n'), /shorter than 6/);
    assert.match(r.warnings.join('\n'), /half-configured \(2\/4/);
    assert.match(r.warnings.join('\n'), /UNIFI_URL and UNIFI_API_KEY/);
    assert.throws(() => createApp({ dataFile: ':memory:', ...NO_ENV, timeZone: 'Nowhere/Land' }), (e) => e.code === 'BAD_CONFIG');

    const ok = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'server.js', '--check-config'], { cwd: path.join(__dirname, '..'), env: { PATH: process.env.PATH, ADMIN_PIN: '123456', API_TOKEN: 'x'.repeat(32) }, encoding: 'utf8' });
    assert.equal(ok.status, 0, ok.stdout + ok.stderr); assert.match(ok.stdout, /configuration OK/);
    const bad = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'server.js', '--check-config'], { cwd: path.join(__dirname, '..'), env: { PATH: process.env.PATH, TZ_NAME: 'Bad/Zone' }, encoding: 'utf8' });
    assert.equal(bad.status, 1); assert.match(bad.stdout, /ERROR {4}TZ_NAME/);
});

test('time: one clock for the whole app, LocalTime answers day / midnight / hour across BST and GMT', async () => {
    const z = new LocalTime('Europe/London');
    assert.equal(z.dayStart('2026-07-15T10:00:00Z'), '2026-07-14T23:00:00.000Z');
    assert.equal(z.dayStart('2026-12-15T10:00:00Z'), '2026-12-15T00:00:00.000Z');
    assert.equal(z.dayStart('2026-03-29T12:00:00Z'), '2026-03-29T00:00:00.000Z', 'spring-forward day starts in GMT');
    assert.equal(z.dayStart('2026-10-25T12:00:00Z'), '2026-10-24T23:00:00.000Z', 'fall-back day starts in BST');
    assert.equal(z.hour('2026-07-15T07:30:00Z'), 8);
    assert.equal(z.day('2026-07-14T23:30:00Z'), '2026-07-15');

    const fixed = new Date('2026-08-01T09:00:00Z');
    const clock = createClock(() => fixed);
    assert.equal(clock.iso(), '2026-08-01T09:00:00.000Z');
    const app = createApp({ dataFile: ':memory:', ...NO_ENV, now: () => fixed });
    try {
        const p = app.store.addPerson('Clocked');
        const res = await new Promise(resolve => {
            const req = { url: '/api/sign', method: 'POST', headers: { host: 'x' }, socket: {}, async *[Symbol.asyncIterator]() { yield JSON.stringify({ personId: p.id }); } };
            app.handle(req, { writeHead() { }, end: (b) => resolve(JSON.parse(b)) });
        });
        assert.equal(res.event.at, '2026-08-01T09:00:00.000Z', 'events are stamped by the injected clock');
    } finally { app.close(); }
});

test('scheduler: records success, thrown and soft failures, and never overlaps a slow run', async () => {
    const lines = [];
    const s = new Scheduler({ log: createLogger({ write: (l) => lines.push(l) }) });
    let release; let calls = 0;
    s.every('ok', 60_000, () => 42);
    s.every('throws', 60_000, () => { throw new Error('boom'); });
    s.every('soft', 60_000, () => ({ ok: false, error: 'controller answered 401' }));
    s.every('slow', 60_000, () => { calls++; return new Promise(r => { release = r; }); });
    assert.equal(await s.run('ok'), 42);
    assert.deepEqual(await s.run('throws'), { ok: false, error: 'boom' });
    await s.run('soft');
    const first = s.run('slow');
    assert.deepEqual(await s.run('slow'), { skipped: true, reason: 'still running' });
    release(); await first;
    assert.equal(calls, 1);
    const h = Object.fromEntries(s.health().map(j => [j.name, j]));
    assert.equal(h.ok.lastOk, true); assert.equal(h.throws.lastOk, false); assert.equal(h.throws.failures, 1);
    assert.equal(h.soft.lastError, 'controller answered 401');
    assert.ok(lines.some(l => l.includes('job throws failed')), 'failures are logged, not swallowed');
});

test('health: checks and jobs on /api/health and /metrics; a failing job turns status to degraded', async () => {
    const fetch = async () => new Response('nope', { status: 503 });
    const app = createApp({ dataFile: ':memory:', ...NO_ENV, teamsWebhookUrl: 'https://teams.invalid/hook', fetch });
    try {
        const call = (url) => new Promise(resolve => {
            const req = { url, method: 'GET', headers: { host: 'x' }, socket: {}, async *[Symbol.asyncIterator]() { } };
            app.handle(req, { writeHead() { }, end: (b) => resolve(String(b)) });
        });
        let h = JSON.parse(await call('/api/health'));
        assert.equal(h.ok, true); assert.equal(h.status, 'ok');
        assert.ok(h.checks.some(c => c.name === 'database' && c.ok && /schema v\d+/.test(c.detail)));
        assert.ok(Array.isArray(h.warnings), 'no PIN configured: the warnings are shown');
        app.fireStart({ startedBy: 't', source: 'fire-page' });
        await app.jobs.run('outbox');
        h = JSON.parse(await call('/api/health'));
        assert.equal(h.status, 'degraded');
        assert.ok(h.checks.some(c => c.name === 'job:outbox' && !c.ok && /503/.test(c.detail)));
        const m = await call('/metrics');
        assert.match(m, /^signin_check_ok\{check="job:outbox"\} 0$/m);
        assert.match(m, /^signin_check_ok\{check="database"\} 1$/m);
        assert.match(m, /^signin_job_failures\{job="outbox"\} 1$/m);
    } finally { app.close(); }
});

test('backup schedule: first run at once, then nightly at BACKUP_HOUR local, a failure retried within the hour', async () => {
    const dir = tmp();
    let nowIso = '2026-10-19T12:00:00.000Z';
    const app = createApp({ dataFile: ':memory:', ...NO_ENV, backupDir: dir, backupHour: 2, now: () => new Date(nowIso) });
    try {
        assert.equal((await app.backupIfDue()).ok, true, 'no backup yet: take one now');
        nowIso = '2026-10-19T23:00:00.000Z'; assert.equal((await app.backupIfDue()).skipped, true, 'same night, before 02:00 BST');
        nowIso = '2026-10-20T01:05:00.000Z'; assert.equal((await app.backupIfDue()).ok, true, '02:05 BST next day: nightly backup');
        nowIso = '2026-10-20T03:00:00.000Z'; assert.equal((await app.backupIfDue()).skipped, true, 'already done tonight');
        app.store.setSetting('backupStatus', { at: '2026-10-20T03:00:00.000Z', ok: false, error: 'disk full' });
        nowIso = '2026-10-20T03:30:00.000Z'; assert.equal((await app.backupIfDue()).skipped, true, 'failure: wait an hour');
        nowIso = '2026-10-20T04:01:00.000Z'; assert.equal((await app.backupIfDue()).ok, true, 'then retry');
    } finally { app.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('log: json format is one parseable object per line with fields', () => {
    const lines = [];
    const log = createLogger({ format: 'json', write: (l) => lines.push(l) });
    log.error('request failed', { path: '/api/sign', status: 500 });
    const o = JSON.parse(lines[0]);
    assert.equal(o.level, 'error'); assert.equal(o.msg, 'request failed'); assert.equal(o.path, '/api/sign'); assert.ok(o.at);
});
