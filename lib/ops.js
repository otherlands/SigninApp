'use strict';
// Operations that keep the register alive and honest without anyone remembering to look:
//   pushBackup   copy the nightly backup OFF this box (rsync over a restricted SSH key) into 7 rolling weekday files
//   heartbeat    ping an external dead-man's-switch URL while the server is alive; silence = the service alerts
//   drift        verify the outside facts this deployment depends on (DNS, certificate, secret expiry, devices)
//   restoreDrill open the newest backup in a scratch copy, migrate, integrity-check, refold, count: a backup that
//                cannot be restored is found on a quiet Tuesday, not during a fire
// Every function records its result in runtime_state and returns it; app.js turns them into jobs and health checks.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const dns = require('node:dns');
const tls = require('node:tls');
const { execFile } = require('node:child_process');

function createOps(d) {
    const { cfg, store, clock, zone, log } = d;
    const run = (cmd, args, timeoutMs) => new Promise((resolve, reject) => {
        execFile(cmd, args, { timeout: timeoutMs, windowsHide: true }, (error, stdout, stderr) => error ? reject(Object.assign(error, { stderr: String(stderr || '').trim() })) : resolve(String(stdout)));
    });

    // ---- off-box backup ------------------------------------------------------------------------------
    const weekday = (iso) => new Intl.DateTimeFormat('en-GB', { timeZone: cfg.timeZone, weekday: 'short' }).format(new Date(iso));
    async function pushBackup(file) {
        if (!cfg.backupPushTarget) return { skipped: true, reason: 'BACKUP_PUSH_TARGET not set' };
        const at = clock.iso();
        const target = cfg.backupPushTarget + (/[:/]$/.test(cfg.backupPushTarget) ? '' : '/') + `signin-${weekday(at)}.sqlite`;
        const ssh = ['ssh', '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'ConnectTimeout=15'];
        if (cfg.backupPushKey) ssh.push('-i', cfg.backupPushKey);
        if (cfg.backupPushKnownHosts) ssh.push('-o', `UserKnownHostsFile=${cfg.backupPushKnownHosts}`, '-o', 'StrictHostKeyChecking=yes');
        const [cmd, ...pre] = cfg.backupPushCommand || ['rsync'];
        const status = { at, target, ok: false };
        try {
            await run(cmd, [...pre, '-t', '--timeout=60', '-e', ssh.join(' '), file, target], 120_000);
            status.ok = true; status.bytes = fs.statSync(file).size;
        } catch (error) { status.error = (error.stderr || error.message || String(error)).split('\n').slice(-3).join(' ').slice(0, 300); }
        store.setState('backupPushStatus', status);
        return status;
    }

    // ---- heartbeat -------------------------------------------------------------------------------------
    async function heartbeat() {
        if (!cfg.heartbeatUrl) return { skipped: true };
        const status = { at: clock.iso(), ok: false };
        try {
            store.db.prepare('SELECT 1').get();   // only claim to be alive if the register answers
            const res = await cfg.fetch(cfg.heartbeatUrl, { method: 'GET', signal: AbortSignal.timeout(10_000) });
            status.ok = res.ok; if (!res.ok) status.error = `heartbeat URL answered ${res.status}`;
        } catch (error) { status.error = error.message; }
        store.setState('heartbeatStatus', status);
        return status.ok ? status : { ok: false, error: status.error };
    }

    // ---- drift ----------------------------------------------------------------------------------------
    const ownAddresses = () => Object.values(os.networkInterfaces()).flat().filter(Boolean).map(i => i.address);
    const isIp = (h) => /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(':');
    function watchedHost() {
        if (cfg.driftHostname) return cfg.driftHostname;
        try { const h = new URL(cfg.publicUrl).hostname; return isIp(h) || h === 'localhost' ? '' : h; } catch { return ''; }
    }
    function certDaysLeft(host) {
        return new Promise((resolve) => {
            const sock = tls.connect({ host, port: 443, servername: host, rejectUnauthorized: false, timeout: 8000 }, () => {
                const cert = sock.getPeerCertificate(); sock.end();
                resolve(cert?.valid_to ? { days: Math.floor((Date.parse(cert.valid_to) - clock.ms()) / 86400_000), issuer: cert.issuer?.O || cert.issuer?.CN || '', authorized: sock.authorized } : { error: 'no certificate' });
            });
            sock.on('error', (e) => resolve({ error: e.code || e.message }));
            sock.on('timeout', () => { sock.destroy(); resolve({ error: 'timeout' }); });
        });
    }
    async function drift() {
        const checks = [];
        const add = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail });
        const host = watchedHost();
        if (host) {
            const mine = ownAddresses();
            try {
                const lan = (await dns.promises.lookup(host, { all: true, family: 4 })).map(a => a.address);
                add('dns-lan', lan.some(a => mine.includes(a)) || (cfg.expectLanIp && lan.includes(cfg.expectLanIp)),
                    `${host} -> ${lan.join(', ')} on the office DNS; this server is ${mine.filter(a => !a.startsWith('127.') && a !== '::1').join(', ')}`);
            } catch (error) { add('dns-lan', false, `${host} does not resolve on the office DNS (${error.code || error.message})`); }
            try {
                const r = new dns.promises.Resolver(); r.setServers(cfg.driftPublicDns);
                const pub = await r.resolve4(host);
                add('dns-public', cfg.expectPublicIp ? pub.includes(cfg.expectPublicIp) : pub.length > 0, `${host} -> ${pub.join(', ')} in public DNS${cfg.expectPublicIp ? ` (expected ${cfg.expectPublicIp})` : ''}`);
            } catch (error) { add('dns-public', false, `${host} has no public A record (${error.code || error.message}) via ${cfg.driftPublicDns.join(', ')}`); }
            if (String(cfg.publicUrl).startsWith('https:')) {
                const c = await certDaysLeft(host);
                add('certificate', !c.error && c.days >= 14, c.error ? `TLS to ${host}:443 failed: ${c.error}` : `${c.days} days left (${c.issuer})`);
            }
        }
        if (cfg.spSecretExpires) {
            const days = Math.floor((Date.parse(cfg.spSecretExpires) - clock.ms()) / 86400_000);
            add('sp-secret', days >= 30, `SharePoint client secret expires ${cfg.spSecretExpires} (${days} days)`);
        }
        const seen = store.getState('devicesSeen', {});
        const uptimeMin = (clock.ms() - Date.parse(d.startedAt)) / 60000;
        for (const name of cfg.expectDevices) {
            const last = seen[name];
            const ageMin = last ? (clock.ms() - Date.parse(last)) / 60000 : null;
            if (ageMin === null && uptimeMin < cfg.deviceSilentMinutes) continue;   // just restarted: give it time
            add(`device:${name}`, ageMin !== null && ageMin <= cfg.deviceSilentMinutes, last ? `last heard ${Math.round(ageMin)} min ago` : 'not heard since the server started');
        }
        const previous = store.getState('driftStatus');
        const status = { at: clock.iso(), host: host || null, checks };
        store.setState('driftStatus', status);
        // Tell the ops channel only when something CHANGES (a fact goes bad or recovers), never every hour.
        const sig = (s) => JSON.stringify((s?.checks || []).map(x => [x.name, x.ok]));
        if (previous && sig(previous) !== sig(status)) {
            const bad = checks.filter(x => !x.ok);
            d.notifyOps({ title: bad.length ? `⚠️ Sign-in: ${bad.length} outside check${bad.length === 1 ? '' : 's'} failing` : '✅ Sign-in: all outside checks back to normal', tone: bad.length ? 'warning' : 'good', text: bad.length ? 'Something this server depends on has changed.' : 'Recovered.', facts: checks.map(x => [`${x.ok ? 'ok' : 'FAIL'} ${x.name}`, x.detail]) });
        }
        return status;
    }

    // ---- restore drill -----------------------------------------------------------------------------------
    async function restoreDrill() {
        if (!cfg.backupDir || !fs.existsSync(cfg.backupDir)) return { skipped: true, reason: 'no backup directory' };
        const files = fs.readdirSync(cfg.backupDir).filter(f => /^signin-.*\.sqlite$/.test(f)).sort();
        if (!files.length) return { skipped: true, reason: 'no backups yet' };
        const newest = path.join(cfg.backupDir, files[files.length - 1]);
        const scratch = path.join(os.tmpdir(), `signin-restore-drill-${process.pid}.sqlite`);
        const status = { at: clock.iso(), file: newest, ok: false };
        let s = null;
        try {
            fs.copyFileSync(newest, scratch);
            const { Store } = require('./store');
            s = new Store(scratch);
            const integrity = Object.values(s.db.prepare('PRAGMA integrity_check').get())[0];
            const driftFound = s.rebuildProjections();
            const n = (t) => Number(s.db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c);
            Object.assign(status, { integrity, schema: s.schemaVersion(), projectionDrift: driftFound, people: n('people'), events: n('events'), rollcalls: n('rollcalls') });
            status.ok = integrity === 'ok' && driftFound === 0;
            if (!status.ok) status.error = integrity !== 'ok' ? `integrity: ${integrity}` : 'projections did not match the event log in the backup';
        } catch (error) { status.error = error.message; }
        finally { try { s?.close(); } catch { } for (const f of [scratch, scratch + '-wal', scratch + '-shm']) fs.rmSync(f, { force: true }); }
        store.setState('restoreDrillStatus', status);
        if (!status.ok) log.error('restore drill failed', { file: newest, error: status.error });
        return status.ok ? status : { ok: false, error: status.error };
    }

    return { pushBackup, heartbeat, drift, restoreDrill, watchedHost };
}

module.exports = { createOps };
