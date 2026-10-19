#!/usr/bin/env node
'use strict';
// signinctl — the operator's tool. Runs on the server (reads /etc/eright-signin.env for the PIN) or anywhere with
// SIGNIN_URL + ADMIN_PIN set. Every command is a thin, scriptable wrapper over the HTTP API or the database file.
//
//   signinctl status                      health, checks, jobs, who is on site (counts)
//   signinctl check-config                validate the environment (same as node server.js --check-config)
//   signinctl backup                      take a backup now
//   signinctl restore <file> [--yes]      stop the service, restore <file> over the live register, start, verify
//   signinctl verify <file>               open a backup read-only: integrity, schema version, counts
//   signinctl people                      staff list with credentials and state
//   signinctl token <name> <scopes>       issue a device token (scopes: sign,presence,fire)
//   signinctl revoke <name>               revoke a device token
//   signinctl drill [by]                  start a practice drill
//   signinctl ask "<question>"            ask the register (needs LLM_URL on the server)
//   signinctl rebuild-projections         refold attendance from the event log and report drift
//   signinctl retention                   run the retention policy now
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const ENV_FILE = process.env.SIGNIN_ENV_FILE || '/etc/eright-signin.env';
function envFile() {
    try { return Object.fromEntries(fs.readFileSync(ENV_FILE, 'utf8').split('\n').filter(l => /^[A-Z_]+=/.test(l)).map(l => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1)]; })); }
    catch { return {}; }
}
const E = { ...envFile(), ...process.env };
const URL_ = (E.SIGNIN_URL || `http://127.0.0.1:${E.PORT || 3000}`).replace(/\/+$/, '');
const PIN = E.ADMIN_PIN || '';
const DATA = E.DATA_FILE || '/opt/eright-signin/data/signin.sqlite';

async function api(method, p, body) {
    const res = await fetch(URL_ + p, { method, headers: { 'Content-Type': 'application/json', ...(PIN ? { 'X-Admin-Pin': PIN } : {}) }, body: body && JSON.stringify(body) });
    const text = await res.text(); let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
    if (!res.ok) throw new Error(`${method} ${p} -> ${res.status} ${json.error || text.slice(0, 200)}`);
    return json;
}
const fmt = (iso) => iso ? new Date(iso).toLocaleString('en-GB') : '—';
const die = (m) => { console.error(m); process.exit(1); };

const commands = {
    async status() {
        const h = await api('GET', '/api/health'); const r = await api('GET', '/api/roster');
        console.log(`eRIGHT sign-in v${h.version} ${h.replica ? '(mirror)' : ''}  status: ${h.status.toUpperCase()}  up since ${fmt(h.startedAt)}`);
        console.log(`on site: ${r.count} (staff ${r.staff.length}, visitors ${r.visitors.length})${r.loneWorker ? '  LONE WORKER' : ''}`);
        for (const c of h.checks) console.log(`  ${c.ok ? 'ok  ' : 'FAIL'} ${c.name.padEnd(22)} ${c.detail || ''}`);
        for (const j of h.jobs) console.log(`  job  ${j.name.padEnd(22)} every ${j.everyS}s  runs ${j.runs} fail ${j.failures}  last ${fmt(j.lastRun)}${j.lastError ? '  ' + j.lastError : ''}`);
        if (h.backup) console.log(`  backup: ${h.backup.last ? (h.backup.last.ok ? 'ok ' : 'FAILED ') + fmt(h.backup.last.at) + ' ' + (h.backup.last.file || '') : 'none yet'} (keep ${h.backup.keep})`);
        if (h.warnings?.length) for (const w of h.warnings) console.log(`  warning: ${w}`);
    },
    async 'check-config'() { execSync(`"${process.execPath}" --disable-warning=ExperimentalWarning "${path.join(__dirname, '..', 'server.js')}" --check-config`, { stdio: 'inherit' }); },
    async backup() { const b = await api('POST', '/api/backup', {}); console.log(b.ok ? `backed up: ${b.file} (${b.bytes} bytes)${b.offsite ? ' off-site: ' + b.offsite : ''}` : `FAILED: ${b.error || b.reason}`); if (!b.ok) process.exit(1); },
    async verify(file) {
        if (!file) die('verify <file>');
        const { DatabaseSync } = require('node:sqlite');
        const db = new DatabaseSync(file, { readOnly: true });
        const one = (sql) => Object.values(db.prepare(sql).get())[0];
        console.log(`integrity: ${one('PRAGMA integrity_check')}  schema v${one('PRAGMA user_version')}`);
        for (const t of ['people', 'visitors', 'events', 'rollcalls', 'devices']) { try { console.log(`  ${t.padEnd(10)} ${one(`SELECT COUNT(*) FROM ${t}`)}`); } catch { console.log(`  ${t.padEnd(10)} (no table)`); } }
        try { console.log(`  newest event ${one('SELECT MAX(at) FROM events')}`); } catch { }
        db.close();
    },
    async restore(file, flag) {
        if (!file) die('restore <file> [--yes]');
        if (!fs.existsSync(file)) die(`${file} not found`);
        await commands.verify(file);
        if (flag !== '--yes') die(`\nThis REPLACES the live register ${DATA} with ${file}.\nRe-run with --yes to do it. The current file is kept as ${DATA}.replaced-<time>.`);
        const stamp = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15);
        execSync('systemctl stop eright-signin', { stdio: 'inherit' });
        const moved = [];
        try {
            // Copy in beside the live file first; only when that succeeded is the live file moved aside and the copy
            // renamed into place. A failed copy therefore leaves the register exactly as it was.
            fs.copyFileSync(file, DATA + '.incoming');
            for (const suffix of ['', '-wal', '-shm']) if (fs.existsSync(DATA + suffix)) { fs.renameSync(DATA + suffix, `${DATA}${suffix}.replaced-${stamp}`); moved.push(suffix); }
            fs.renameSync(DATA + '.incoming', DATA);
            try { execSync(`chown signin:signin "${DATA}"`); } catch { }
        } catch (error) {
            for (const suffix of moved) { try { fs.renameSync(`${DATA}${suffix}.replaced-${stamp}`, DATA + suffix); } catch { } }
            try { fs.rmSync(DATA + '.incoming', { force: true }); } catch { }
            console.error(`restore FAILED, live register left untouched: ${error.message}`);
        } finally { execSync('systemctl start eright-signin', { stdio: 'inherit' }); }
        await new Promise(r => setTimeout(r, 2500));
        await commands.status();
    },
    async people() {
        const list = await api('GET', '/api/people?all=1'); const st = await api('GET', '/api/state');
        for (const p of list) { const s = st.people.find(x => x.id === p.id); console.log(`${p.active ? ' ' : 'x'} ${p.name.padEnd(24)} ${p.cardUid ? 'card ' : '     '}${p.phoneMac ? 'phone ' : '      '}${p.tagId ? 'tag ' : '    '} ${s ? (s.signedIn ? 'IN since ' + fmt(s.since) : 'out') : ''}`); }
    },
    async token(name, scopes) {
        if (!name || !scopes) die('token <name> <scopes e.g. sign,fire>');
        const r = await api('POST', '/api/devices', { name, role: 'device', scopes: scopes.split(',') });
        console.log(`token for ${r.device.name} (${r.device.scopes.join(',')}) — shown once:\n${r.token}`);
    },
    async revoke(name) {
        const d = (await api('GET', '/api/devices')).find(x => x.name === name && !x.revokedAt);
        if (!d) die(`no live device called ${name}`);
        await api('DELETE', `/api/devices/${d.id}`); console.log(`revoked ${name}`);
    },
    async drill(by = 'signinctl') { const r = await api('POST', '/api/fire/start', { source: 'fire-page', by, drill: true }); console.log(r.alreadyOpen ? 'a roll call is already open' : `drill started: ${r.rollcall.total} on the register`); },
    async ask(...q) { const r = await api('POST', '/api/ask', { question: q.join(' ') }); console.log(r.answer); console.log(`\n[${r.model}; looked up: ${r.toolCalls.map(t => t.name).join(', ') || 'nothing'}]`); },
    async 'rebuild-projections'() { const r = await api('POST', '/api/projections/rebuild', {}); console.log(r.drift ? 'projection DRIFT found and corrected' : 'projection matched the event log'); },
    async retention() { const r = await api('POST', '/api/retention/run', {}); console.log(JSON.stringify(r)); }
};

const [cmd, ...args] = process.argv.slice(2);
if (!cmd || !commands[cmd]) { console.log(fs.readFileSync(__filename, 'utf8').split('\n').filter(l => l.startsWith('//')).map(l => l.slice(3)).join('\n')); process.exit(cmd ? 1 : 0); }
commands[cmd](...args).catch(e => die(e.message));