'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, timingSafeEqual } = require('node:crypto');
const { Store } = require('./store');
const { SharePointSink } = require('./sharepoint');
const { MsListSink } = require('./mslist');
const { Presence } = require('./presence');
const { loadConfig } = require('./config');
const { createClock, LocalTime } = require('./time');
const { Scheduler } = require('./scheduler');
const { createLogger } = require('./log');
const { Router } = require('./router');
const { defineRoutes } = require('./routes');
const { Assistant } = require('./assistant');
const { createCommands } = require('./commands');
const { createOps } = require('./ops');

const MIME = {
    '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
    '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.json': 'application/json; charset=utf-8'
};
// /rollcall is an alias of /fire: printed QR codes say /fire and keep working.
const PAGES = { '/': 'index.html', '/fire': 'fire.html', '/rollcall': 'fire.html', '/admin': 'admin.html', '/tap': 'tap.html', '/visitor': 'visitor.html', '/safe': 'safe.html' };
// What the internet may fetch through the reverse proxy: the roll-call page, the self-marking page, and what they load.
// The proxy (deploy/Caddyfile) enforces the same list; this is the second lock in case the proxy is misconfigured.
const PUBLIC_FILES = new Set(['fire.html', 'safe.html', 'fire.js', 'shared.js', 'style.css', 'favicon.svg', 'sw.js', 'fire.webmanifest']);
const { version: VERSION } = require('../package.json');
const ipv4 = (ip) => String(ip || '').replace(/^::ffff:/, '');
function inCidr(ip, cidr) {
    const [net, bits] = cidr.split('/'); const n = Number(bits);
    const toInt = (a) => a.split('.').reduce((acc, x) => (acc << 8) + Number(x), 0) >>> 0;
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return false;
    const mask = n === 0 ? 0 : (~0 << (32 - n)) >>> 0;
    return (toInt(ip) & mask) === (toInt(net) & mask);
}
/** What the outside world may see of the register: names and marks, never company, host, vehicle or badge. */
function assemblyView(r) {
    if (!r) return r;
    const strip = (x) => ({ type: x.type, id: x.id, name: x.name, since: x.since });
    return { ...r, staff: (r.staff || []).map(strip), visitors: (r.visitors || []).map(strip) };
}

function createApp(options = {}) {
    const { cfg, errors, warnings } = loadConfig(options, options.env ?? process.env);
    if (errors.length) throw Object.assign(new Error(`invalid configuration:\n  - ${errors.join('\n  - ')}`), { code: 'BAD_CONFIG', errors });
    const log = options.log || createLogger({ format: cfg.logFormat, silent: options.silent });
    const clock = createClock(cfg.now);
    const zone = new LocalTime(cfg.timeZone);
    const store = new Store(cfg.dataFile);
    const startedAt = clock.iso();
    const sharepoint = new SharePointSink({ ...cfg.sharepoint, fetch: cfg.fetch });
    const mslist = new MsListSink({ ...cfg.sharepoint, list: cfg.sharepoint?.list, fetch: cfg.fetch });
    const hasOutboxSink = () => !cfg.replica && (Boolean(cfg.mirrorUrl) || sharepoint.configured || mslist.configured || Boolean(cfg.teamsWebhookUrl) || Boolean(cfg.opsWebhookUrl));
    const clean = (v, max = 80) => String(v ?? '').trim().slice(0, max);

    // ---- time helpers ------------------------------------------------
    const localDay = (iso) => zone.day(iso);
    const localDayStart = (iso = clock.iso()) => zone.dayStart(iso);
    const localHour = (iso = clock.iso()) => zone.hour(iso);

    // ---- views ---------------------------------------------------------
    function staffWithStatus() {
        const todayStart = localDayStart();
        const current = store.attendanceNow();          // one read for everyone (projection), not one per person
        return store.listPeople().map(person => {
            const last = current.get(`staff:${person.id}`) || null;
            const signedIn = last?.kind === 'in';
            return {
                id: person.id, name: person.name, hasCard: Boolean(person.cardUid), hasPhone: Boolean(person.phoneMac), hasTag: Boolean(person.tagId), signedIn,
                since: signedIn ? last.at : null, lastSource: last?.source || null,
                stale: signedIn && last.at < todayStart
            };
        });
    }
    function staffWithPresence() {
        const people = store.listPeople(true);
        const byId = new Map(people.map(p => [p.id, p]));
        return staffWithStatus().map(p => ({ ...p, presence: presence.badge(byId.get(p.id)) }));
    }
    function roster() {
        const staff = staffWithPresence().filter(p => p.signedIn);
        const todayStart = localDayStart();
        const visitors = store.listVisitors({ presentOnly: true });
        return {
            at: clock.iso(),
            staff: staff.map(p => ({ type: 'staff', id: p.id, name: p.name, since: p.since, stale: p.stale, source: p.lastSource, presence: p.presence })),
            visitors: visitors.map(v => ({ type: 'visitor', id: v.id, name: v.name, company: v.company, hostName: v.hostName, vehicle: v.vehicle, badge: v.badge, since: v.signedInAt, stale: v.signedInAt < todayStart })),
            count: staff.length + visitors.length,
            loneWorker: staff.length === 1 && visitors.length === 0
        };
    }
    function currentRoster() {
        if (cfg.replica) return store.getState('replicaRoster', { at: null, staff: [], visitors: [], count: 0, replica: true, stale: true });
        return roster();
    }
    function apiState() {
        const people = staffWithPresence();
        const open = store.openRollcall();
        const todayStart = localDayStart();
        const visitors = store.listVisitors({ presentOnly: true }).map(v => ({ ...v, stale: v.signedInAt < todayStart }));
        const signedIn = people.filter(p => p.signedIn).length;
        return {
            companyName: store.getSetting('companyName'), fireNotice: store.getSetting('fireNotice'), replica: cfg.replica,
            people, visitors, inCount: signedIn + visitors.length,
            staleCount: people.filter(p => p.stale).length + visitors.filter(v => v.stale).length,
            probablyLeftCount: people.filter(p => p.signedIn && p.presence?.state === 'probably-left').length,
            loneWorker: signedIn === 1 && visitors.length === 0,
            expectedToday: store.listExpected({ day: localDay(clock.iso()) }).length,
            rollcall: open ? summariseRollcall(open) : null,
            lastUnknownCard: store.getState('lastUnknownCard'),
            publicUrl: cfg.publicUrl || null, serverTime: clock.iso()
        };
    }
    function summariseRollcall(rc) {
        const total = rc.roster.staff.length + rc.roster.visitors.length;
        const safeMarks = rc.marks.filter(m => m.status === 'safe');
        const missing = rc.marks.filter(m => m.status === 'missing').length;
        const allSafe = total > 0 && safeMarks.length === total;
        return { ...rc, total, safe: safeMarks.length, missing, unaccounted: total - safeMarks.length - missing, allSafe, allSafeAt: allSafe ? safeMarks.map(m => m.at).sort().pop() : null, selfMarked: safeMarks.filter(m => m.via === 'self').length };
    }
    function rosterNames(rc, filter = () => true) {
        const all = [...rc.roster.staff, ...rc.roster.visitors];
        const status = (e) => rc.marks.find(m => m.subjectType === e.type && m.subjectId === e.id)?.status || 'not seen';
        return all.filter(e => filter(status(e))).map(e => e.type === 'visitor' ? `${e.name} (visitor${e.company ? ', ' + e.company : ''})` : e.name);
    }
    const nameList = (names) => names.length ? names.join(' · ') : '—';

    // ---- Prometheus exposition (counts only — no names leave this endpoint) --------
    function metricsText() {
        const r = currentRoster();
        const people = cfg.replica ? [] : staffWithStatus();
        const open = store.openRollcall();
        const nowMs = clock.ms();
        const lines = []; const declared = new Set();
        const g = (name, help, value, labels = '') => {
            if (value === null || value === undefined || Number.isNaN(value)) return;
            if (!declared.has(name)) { declared.add(name); lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`); }
            lines.push(`${name}${labels} ${typeof value === 'boolean' ? (value ? 1 : 0) : value}`);
        };
        const ageS = (iso) => Math.max(0, Math.floor((nowMs - Date.parse(iso)) / 1000));
        g('signin_up', '1 while the sign-in server answers', 1);
        g('signin_replica', '1 on the read-only mirror', cfg.replica);
        g('signin_staff_on_site', 'Staff currently signed in', r.staff.length);
        g('signin_visitors_on_site', 'Visitors currently signed in', r.visitors.length);
        g('signin_on_site_total', 'Staff + visitors currently signed in', r.count);
        g('signin_stale_signins', 'Staff signed in before local midnight and never signed out (forgotten sign-outs)', people.filter(p => p.stale).length);
        g('signin_stale_visitors', 'Visitors signed in before local midnight and never signed out', (r.visitors || []).filter(v => v.stale).length);
        if (!cfg.replica) {
            const ph = presence.health();
            const withPresence = staffWithPresence();
            g('signin_probably_left', 'Signed-in staff whose phone and tag have both been absent (shown, not acted on)', withPresence.filter(p => p.signedIn && p.presence?.state === 'probably-left').length);
            g('signin_presence_here', 'Signed-in staff with a phone or tag currently seen inside', withPresence.filter(p => p.signedIn && p.presence?.state === 'here').length);
            g('signin_wifi_enabled', '1 when the UniFi Wi-Fi brace is configured', ph.wifi.enabled);
            if (ph.wifi.lastPoll) { g('signin_wifi_last_poll_ok', '1 if the most recent UniFi poll succeeded', Boolean(ph.wifi.lastPoll.ok)); g('signin_wifi_last_poll_age_seconds', 'Seconds since the most recent UniFi poll', ageS(ph.wifi.lastPoll.at)); }
            g('signin_wifi_clients', 'Clients in the most recent controller list (all, not just enrolled)', ph.wifi.clients);
            for (const s of ph.scanners) g('signin_scanner_last_report_age_seconds', 'Seconds since a BLE scanner last posted sightings', s.ageS, `{scanner="${s.name.replace(/"/g, '')}"}`);
            for (const t of ph.tags) if (t.ageS !== null) g('signin_tag_last_heard_age_seconds', 'Seconds since an enrolled BLE tag was last heard (battery/lost guard; label is the tag id, not the person)', t.ageS, `{tag="${t.tagId.replace(/"/g, '')}"}`);
        }
        g('signin_lone_worker', '1 when exactly one member of staff is on site with no visitors (time-of-day rule is applied in Prometheus)', r.staff.length === 1 && r.visitors.length === 0);
        g('signin_local_hour', `Hour of day 0-23 in ${cfg.timeZone}, the input for the out-of-hours lone-worker rule`, localHour());
        g('signin_rollcall_open', '1 while a fire roll call is running', Boolean(open));
        if (open) {
            const s = summariseRollcall(open);
            g('signin_rollcall_drill', '1 when the open roll call is a practice drill', s.drill);
            g('signin_rollcall_started_timestamp_seconds', 'Unix time the open roll call started', Math.floor(Date.parse(s.startedAt) / 1000));
            g('signin_rollcall_total', 'People on the frozen roll-call register', s.total);
            g('signin_rollcall_safe', 'Marked SAFE on the open roll call', s.safe);
            g('signin_rollcall_self_marked', 'Marked SAFE by the person themselves (phone)', s.selfMarked);
            g('signin_rollcall_missing', 'Marked MISSING on the open roll call', s.missing);
            g('signin_rollcall_unaccounted', 'Not yet seen on the open roll call', s.unaccounted);
        }
        g('signin_outbox_depth', 'Off-site snapshots still waiting to be sent (mirror + SharePoint + Teams)', store.outboxDepth());
        g('signin_expected_visitors_today', 'Pre-registered visitors expected today who have not yet arrived', store.listExpected({ day: localDay(clock.iso()) }).length);
        g('signin_teams_configured', '1 when the Teams webhook is configured', Boolean(cfg.teamsWebhookUrl));
        const ts = store.getState('teamsStatus'); if (ts) g('signin_teams_last_send_ok', '1 if the most recent Teams post succeeded', Boolean(ts.ok));
        g('signin_sharepoint_configured', '1 when the SharePoint off-site copy is configured', sharepoint.configured);
        const sp = store.getState('sharepointStatus');
        if (sp) { g('signin_sharepoint_last_push_ok', '1 if the most recent SharePoint push succeeded', Boolean(sp.ok)); g('signin_sharepoint_last_push_age_seconds', 'Seconds since the most recent SharePoint push attempt', ageS(sp.at)); }
        g('signin_mslist_configured', '1 when the Microsoft List off-site register is configured', mslist.configured);
        const ml = store.getState('mslistStatus'); if (ml) g('signin_mslist_last_push_ok', '1 if the most recent Microsoft List push succeeded', Boolean(ml.ok));
        g('signin_events_last_24h', 'Register events written in the trailing 24 hours', store.listEvents({ from: new Date(nowMs - 86400_000).toISOString(), limit: 100_000 }).length);
        const bk = store.getState('backupStatus');
        g('signin_backup_enabled', '1 when nightly backups of the register are on', Boolean(cfg.backupDir));
        if (bk) { g('signin_backup_last_ok', '1 if the most recent backup succeeded', Boolean(bk.ok)); g('signin_backup_age_seconds', 'Seconds since the most recent backup attempt', ageS(bk.at)); }
        g('signin_retention_days', 'Keep period for visitor details and events (0 = retention off)', cfg.retentionDays || 0);
        g('signin_started_timestamp_seconds', 'Unix time this server process started', Math.floor(Date.parse(startedAt) / 1000));
        for (const c of healthChecks()) g('signin_check_ok', '1 when a health check passes', c.ok, `{check="${c.name.replace(/"/g, '')}"}`);
        for (const j of jobs.health()) if (j.lastRun) g('signin_job_last_run_age_seconds', 'Seconds since a background job last ran', ageS(j.lastRun), `{job="${j.name}"}`);
        for (const j of jobs.health()) g('signin_job_failures', 'Failed runs of a background job since the process started', j.failures, `{job="${j.name}"}`);
        g('signin_info', 'Build information', 1, `{version="${VERSION}",tz="${cfg.timeZone}"}`);
        return lines.join('\n') + '\n';
    }

    // ---- off-site copies: mirror + SharePoint + Microsoft List + Teams ---------------------
    let lastPublished = null;
    function publishRoster() {
        if (cfg.replica) return false;
        const r = roster(); const open = store.openRollcall();
        // What the off-site copies show: the register and the open roll call. Admin audit lines and unknown-card
        // events change nothing there, so they must not trigger an upload.
        const fingerprint = JSON.stringify([
            store.getSetting('companyName'),
            r.staff.map(s => [s.id, s.since, s.stale, s.presence?.state || null]), r.visitors.map(v => [v.id, v.stale]),
            open ? [open.id, open.marks.map(mk => [mk.subjectType, mk.subjectId, mk.status])] : null
        ]);
        if (fingerprint === lastPublished) return false;
        lastPublished = fingerprint;
        if (cfg.mirrorUrl) store.enqueueOutbox({ type: 'roster', roster: r });
        if (sharepoint.configured) store.enqueueOutbox({ type: 'sharepoint', at: clock.iso() });
        if (mslist.configured) store.enqueueOutbox({ type: 'mslist', at: clock.iso() });
        return true;
    }
    const TEAMS_MAX_ATTEMPTS = 240;
    function teamsCard({ title, text, tone = 'accent', facts = [], at = clock.iso(), selfMark = false }) {
        const body = [
            { type: 'TextBlock', text: title, size: 'ExtraLarge', weight: 'Bolder', color: tone, wrap: true },
            { type: 'TextBlock', text, wrap: true, size: 'Medium' }
        ];
        if (facts.length) body.push({ type: 'FactSet', facts: facts.map(([t, v]) => ({ title: t, value: String(v) })) });
        body.push({ type: 'TextBlock', text: `${store.getSetting('companyName')} sign-in · ${zone.fmt(at, 'whenSeconds')}`, size: 'Small', isSubtle: true, wrap: true });
        const card = { type: 'AdaptiveCard', $schema: 'http://adaptivecards.io/schemas/adaptive-card.json', version: '1.4', body, msteams: { width: 'Full' } };
        if (cfg.publicUrl) {
            card.actions = [{ type: 'Action.OpenUrl', title: 'Open the roll call', url: `${cfg.publicUrl}/fire` }];
            // A channel card is the same for everyone, so it cannot carry anyone's key: the page it opens works on a
            // browser that has opened the person's own link before, and otherwise says to use their own shortcut.
            if (selfMark) card.actions.unshift({ type: 'Action.OpenUrl', title: "I'm SAFE", url: `${cfg.publicUrl}/safe` });
        }
        return { type: 'message', attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', contentUrl: null, content: card }] };
    }
    function notifyTeams(card) {
        if (cfg.replica || !cfg.teamsWebhookUrl) return false;
        store.enqueueOutbox({ type: 'teams', message: teamsCard(card), at: clock.iso() });
        kickFlush();
        return true;
    }
    /** Operational messages (drift) go to their own channel when OPS_TEAMS_WEBHOOK_URL is set; otherwise only to health. */
    function notifyOps(card) {
        if (cfg.replica || !cfg.opsWebhookUrl) return false;
        store.enqueueOutbox({ type: 'teams', channel: 'ops', message: teamsCard(card), at: clock.iso() });
        kickFlush();
        return true;
    }
    let flushTimer = null; let flushing = false; let flushAgain = false;
    function kickFlush() {
        if (!hasOutboxSink()) return;
        clearTimeout(flushTimer);
        flushTimer = setTimeout(() => { flushOutbox().catch(() => { }); }, 20);
        if (typeof flushTimer.unref === 'function') flushTimer.unref();
    }
    function rosterText() {
        const r = roster(); const open = store.openRollcall();
        const when = (iso) => zone.fmt(iso, 'when');
        const lines = [`${store.getSetting('companyName')} — WHO IS ON SITE`, `Updated ${when(r.at)} (${cfg.timeZone})`, '', `ON SITE: ${r.count}   (staff ${r.staff.length}, visitors ${r.visitors.length})`, ''];
        if (open) {
            const s = summariseRollcall(open);
            lines.push(`*** ${s.drill ? 'FIRE DRILL' : 'FIRE ROLL CALL'} IN PROGRESS since ${when(s.startedAt)}${s.startedBy ? ' by ' + s.startedBy : ''} ***`, `    safe ${s.safe} / missing ${s.missing} / not yet seen ${s.unaccounted} of ${s.total}`, '');
        }
        if (r.loneWorker) lines.push('LONE WORKER: one member of staff on site with no visitors.', '');
        lines.push('STAFF');
        if (!r.staff.length) lines.push('  (none)');
        for (const p of r.staff) lines.push(`  ${p.name}  — in since ${when(p.since)}${p.stale ? '  [signed in before today: may have forgotten to sign out]' : ''}${p.presence?.state === 'probably-left' ? `  [phone/tag last seen ${when(p.presence.lastSeen)}: probably left]` : ''}`);
        lines.push('', 'VISITORS');
        if (!r.visitors.length) lines.push('  (none)');
        for (const v of r.visitors) lines.push(`  ${v.name}  — ${[v.company, v.hostName ? 'visiting ' + v.hostName : null, v.vehicle, 'badge ' + v.badge].filter(Boolean).join(', ')} — in since ${when(v.since)}${v.stale ? '  [signed in before today: may have forgotten to sign out]' : ''}`);
        lines.push('', 'This file is written automatically by the sign-in server after every change.', 'If it is old, the server may be down: treat the list as "who was inside at that time".');
        return lines.join('\r\n');
    }
    const csvCell = (v) => `"${String(v ?? '').replaceAll('"', '""')}"`;
    function eventsCsv(from, to) {
        const events = store.listEvents({ from, to, limit: 100_000 }).reverse();
        const lines = ['Date,Time,Type,Name,Action,Source,Device,Note'];
        for (const e of events) lines.push([zone.fmt(e.at, 'csvDate'), zone.fmt(e.at, 'csvTime'), e.subjectType || '', e.subjectName || '', e.kind, e.source, e.device || '', e.note || ''].map(csvCell).join(','));
        return lines.join('\r\n');
    }
    async function pushSharePoint() {
        const todayStart = localDayStart();
        const files = [];
        files.push(await sharepoint.upload('who-is-on-site.txt', rosterText(), 'text/plain; charset=utf-8'));
        files.push(await sharepoint.upload('roster.json', JSON.stringify({ ...roster(), rollcall: store.openRollcall() && summariseRollcall(store.openRollcall()) }, null, 2), 'application/json'));
        files.push(await sharepoint.upload(`events-${localDay(todayStart)}.csv`, eventsCsv(todayStart, null), 'text/csv; charset=utf-8'));
        return files;
    }
    const SP_SIMPLE_UPLOAD_MAX = 4 * 1024 * 1024;
    async function backup() {
        if (!cfg.backupDir) return { skipped: true, reason: 'backups are off (BACKUP_DIR empty)' };
        const at = clock.iso();
        const name = `signin-${localDay(at)}-${at.slice(11, 19).replaceAll(':', '')}Z.sqlite`;
        const file = path.join(cfg.backupDir, name);
        const status = { at, file, ok: false };
        try {
            status.bytes = store.backupTo(file);
            const old = fs.readdirSync(cfg.backupDir).filter(f => /^signin-.*\.sqlite$/.test(f)).sort().reverse().slice(Math.max(1, cfg.backupKeep));
            for (const f of old) fs.rmSync(path.join(cfg.backupDir, f));
            status.ok = true;
            if (sharepoint.configured) {
                if (status.bytes > SP_SIMPLE_UPLOAD_MAX) status.offsite = `skipped: ${status.bytes} bytes is over the 4 MB simple-upload limit`;
                else { try { status.offsite = await sharepoint.upload(`backups/${name}`, fs.readFileSync(file), 'application/octet-stream'); } catch (error) { status.offsite = `failed: ${error.message}`; } }
            }
            if (cfg.backupPushTarget) { const pushed = await ops.pushBackup(file); status.offbox = pushed.ok ? pushed.target : `failed: ${pushed.error}`; }
        } catch (error) { status.error = error.message; }
        store.setState('backupStatus', status);
        return status;
    }
    async function flushOutbox() {
        if (!hasOutboxSink()) return { sent: 0, remaining: 0 };
        if (flushing) { flushAgain = true; return { sent: 0, remaining: store.outboxDepth(), busy: true }; }
        flushing = true;
        try {
            const items = store.peekOutbox(200);
            const byType = new Map();
            for (const item of items) { const key = item.payload.channel === 'ops' ? 'ops' : item.payload.type; if (!byType.has(key)) byType.set(key, []); byType.get(key).push(item); }
            let sent = 0; const errors = {};
            for (const [type, group] of byType) {
                if (type === 'teams' || type === 'ops') {
                    // Each card is a distinct message, delivered in order; the ops channel queues separately so a dead
                    // ops webhook can never hold back a roll-call card.
                    const url = type === 'ops' ? cfg.opsWebhookUrl : cfg.teamsWebhookUrl;
                    const stateKey = type === 'ops' ? 'opsStatus' : 'teamsStatus';
                    for (const item of group) {
                        try {
                            if (!url) throw new Error(`${type === 'ops' ? 'ops channel' : 'Teams'} not configured`);
                            const res = await cfg.fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(item.payload.message), signal: AbortSignal.timeout(8000) });
                            if (!res.ok) throw new Error(`Teams answered ${res.status}`);
                            store.ackOutbox(item.seq); sent++;
                            store.setState(stateKey, { at: clock.iso(), ok: true });
                        } catch (error) {
                            errors[type] = error.message;
                            store.setState(stateKey, { at: clock.iso(), ok: false, error: error.message });
                            if (item.attempts + 1 >= TEAMS_MAX_ATTEMPTS) store.ackOutbox(item.seq); else store.failOutbox(item.seq);
                            break;
                        }
                    }
                    continue;
                }
                const newest = group[group.length - 1];
                try {
                    if (type === 'roster') {
                        if (!cfg.mirrorUrl) throw new Error('mirror not configured');
                        const res = await cfg.fetch(new URL('/api/mirror', cfg.mirrorUrl), { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Api-Token': cfg.mirrorToken }, body: JSON.stringify(newest.payload), signal: AbortSignal.timeout(5000) });
                        if (!res.ok) throw new Error(`mirror answered ${res.status}`);
                    } else if (type === 'sharepoint') {
                        if (!sharepoint.configured) throw new Error('SharePoint not configured');
                        const files = await pushSharePoint();
                        store.setState('sharepointStatus', { at: clock.iso(), ok: true, files });
                    } else if (type === 'mslist') {
                        if (!mslist.configured) throw new Error('Microsoft List not configured');
                        const result = await mslist.sync({ roster: roster(), rollcall: store.openRollcall() && summariseRollcall(store.openRollcall()), companyName: store.getSetting('companyName'), at: clock.iso() });
                        store.setState('mslistStatus', { at: clock.iso(), ok: true, ...result });
                    } else throw new Error(`unknown outbox type ${type}`);
                    for (const item of group) store.ackOutbox(item.seq);
                    sent++;
                } catch (error) {
                    errors[type] = error.message;
                    store.failOutbox(newest.seq);
                    if (type === 'sharepoint') store.setState('sharepointStatus', { at: clock.iso(), ok: false, error: error.message });
                    if (type === 'mslist') store.setState('mslistStatus', { at: clock.iso(), ok: false, error: error.message });
                }
            }
            return { sent, remaining: store.outboxDepth(), errors };
        } finally {
            flushing = false;
            if (flushAgain) { flushAgain = false; kickFlush(); }
        }
    }

    // ---- auth --------------------------------------------------------------
    const safeEqual = (x, y) => { const bx = Buffer.from(String(x)); const by = Buffer.from(String(y)); return bx.length === by.length && timingSafeEqual(bx, by); };
    const lockout = { max: 10, windowMs: 15 * 60_000, ...cfg.adminLockout };
    const pinMisses = new Map();
    const clientIp = (req) => req.socket?.remoteAddress || 'unknown';
    function adminLocked(req) {
        const recent = (pinMisses.get(clientIp(req)) || []).filter(t => Date.now() - t < lockout.windowMs);
        pinMisses.set(clientIp(req), recent);
        return recent.length >= lockout.max;
    }
    function missPin(req) {
        const misses = pinMisses.get(clientIp(req)) || [];
        misses.push(Date.now()); pinMisses.set(clientIp(req), misses);
        if (misses.length === lockout.max) store.addEvent({ kind: 'admin', at: clock.iso(), source: 'admin', device: clientIp(req), note: `admin locked out after ${lockout.max} wrong PINs` });
    }
    const SESSION_MS = 12 * 3600_000;
    const cookieOf = (req, name) => (req.headers.cookie || '').split(';').map(s => s.trim().split('=')).find(([k]) => k === name)?.[1] || '';
    const isSecure = (req) => Boolean(req.socket?.encrypted) || req.headers['x-forwarded-proto'] === 'https';
    function adminSession(req) {
        if (req._session !== undefined) return req._session;
        req._session = store.sessionByToken(cookieOf(req, 'si_admin'), clock.iso());
        return req._session;
    }
    const isAdmin = (req) => {
        if (!cfg.adminPin) return true;
        if (adminLocked(req)) return false;
        if (adminSession(req)) return true;
        const given = req.headers['x-admin-pin'] || '';
        if (safeEqual(given, cfg.adminPin)) return true;
        if (given) missPin(req);
        return false;
    };
    const tooMany = (c) => c.send(429, { error: 'Too many wrong PINs from this device. Try again later.' }, undefined, { 'Retry-After': String(Math.ceil(lockout.windowMs / 1000)) });
    function denyAdmin(c) { return (cfg.adminPin && c.req._lockedBefore) ? tooMany(c) : c.fail(401, 'Admin PIN required'); }
    function login(c) {
        if (!cfg.adminPin) return c.send(200, { ok: true, open: true });
        if (adminLocked(c.req)) return tooMany(c);
        const { pin } = c.body;
        if (!pin || !safeEqual(String(pin), cfg.adminPin)) { if (pin) missPin(c.req); return adminLocked(c.req) ? tooMany(c) : c.fail(401, 'Wrong PIN'); }
        const tok = randomUUID() + randomUUID();
        store.createSession({ token: tok, expiresAt: new Date(clock.ms() + SESSION_MS).toISOString(), label: clean(c.req.headers['user-agent'] || '', 80), at: clock.iso() });
        c.req._session = undefined;
        c.audit('admin logged in');
        return c.send(200, { ok: true }, undefined, { 'Set-Cookie': `si_admin=${tok}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}${isSecure(c.req) ? '; Secure' : ''}` });
    }
    function logout(c) {
        store.deleteSession(cookieOf(c.req, 'si_admin'));
        return c.send(200, { ok: true }, undefined, { 'Set-Cookie': 'si_admin=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
    }
    const SCOPES = ['sign', 'presence', 'fire'];
    const lastTouched = new Map();
    function principalOf(req) {
        if (req._principal !== undefined) return req._principal;
        const given = req.headers['x-api-token'] || '';
        let p = null;
        if (given && cfg.apiToken && safeEqual(given, cfg.apiToken)) p = { kind: 'shared-token', scopes: SCOPES };
        else if (given) {
            const d = store.deviceByToken(given);
            if (d) {
                p = { kind: 'device', device: d.name, scopes: d.scopes };
                if (Date.now() - (lastTouched.get(d.id) || 0) > 60_000) { lastTouched.set(d.id, Date.now()); store.touchDevice(d.id, clock.iso()); }
            }
        }
        req._principal = p;
        return p;
    }
    // Bench mode (no API_TOKEN and no device token EVER issued) keeps the v3.0 behaviour; revoked rows count.
    const openMode = () => !cfg.apiToken && store.listDevices().length === 0;
    const hasToken = (req, scope = null) => { if (openMode()) return true; const p = principalOf(req); return Boolean(p && (!scope || scope === 'any' || p.scopes.includes(scope))); };
    const hasMirrorToken = (req) => cfg.mirrorToken ? safeEqual(req.headers['x-api-token'] || '', cfg.mirrorToken) : (openMode() || principalOf(req)?.kind === 'shared-token');
    // 'desktop' (v4.1): a person confirming "sign me in" on their own office PC (deploy/desktop/signin-check.ps1).
    const HUMAN_SOURCES = new Set(['kiosk', 'tap', 'fire-page', 'admin', 'visitor', 'desktop']);
    const deviceOf = (req, body = {}) => req._principal?.device || clean(body.device || req.headers['x-device'] || req.socket?.remoteAddress || 'unknown', 60);
    function audit(req, note) {
        const s = adminSession(req);
        store.addEvent({ kind: 'admin', at: clock.iso(), source: 'admin', device: s ? `${deviceOf(req)} · session ${s.id}` : deviceOf(req), note: clean(note, 200) });
    }

    // ---- http helpers -----------------------------------------------------
    function send(res, status, body, type = 'application/json; charset=utf-8', extra = {}) {
        res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra });
        res.end(type.includes('json') ? JSON.stringify(body) : body);
    }
    async function bodyOf(req) {
        let text = '';
        for await (const chunk of req) { text += chunk; if (text.length > 100_000) throw Object.assign(new Error('Request too large'), { code: 'TOO_LARGE' }); }
        return text ? JSON.parse(text) : {};
    }

    // ---- live updates (Server-Sent Events) ----------------------------------
    // Capped: STREAM_MAX in total, and STREAM_MAX_PER_IP for anything arriving from outside (proxy or untrusted net),
    // so a flood of open connections from the internet cannot take the LAN fire page down with it.
    const streams = new Set();
    let changeSeq = 0; let changeTimer = null; let heartbeat = null;
    function changed() {
        if (changeTimer || !streams.size) return;
        changeTimer = setTimeout(() => { changeTimer = null; changeSeq++; for (const s of streams) s.write(`event: change\ndata: {"seq":${changeSeq}}\n\n`); }, 50);
        if (typeof changeTimer.unref === 'function') changeTimer.unref();
    }
    function openStream(req, res, { untrusted = false, ip = '' } = {}) {
        if (streams.size >= cfg.streamMax) return send(res, 503, { error: 'Too many live connections; the page falls back to polling' }, undefined, { 'Retry-After': '30' });
        if (untrusted && [...streams].filter(s => s._ip === ip).length >= cfg.streamMaxPerIp) return send(res, 429, { error: 'Too many live connections from this address' }, undefined, { 'Retry-After': '30' });
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        res.write(`retry: 3000\nevent: hello\ndata: {"seq":${changeSeq}}\n\n`);
        res._ip = ip;
        streams.add(res);
        req.on('close', () => streams.delete(res));
        if (!heartbeat) { heartbeat = setInterval(() => { for (const s of streams) s.write(':\n\n'); }, 25_000); if (typeof heartbeat.unref === 'function') heartbeat.unref(); }
    }

    // ---- commands (the only writers of register facts) ---------------------------------------------
    let presence = null;
    const commands = createCommands({
        store, clock, zone, clean, publishRoster, changed: () => changed(), notifyTeams, summariseRollcall, rosterNames, nameList, currentRoster,
        staffWithStatus, presence: () => presence
    });
    const { signStaff, admitVisitor, maybeNotifyAllSafe } = commands;
    const fireStart = (o) => {
        const r = commands.startRollcall(o);
        // Read the List at once: leftover ticks are discarded now, so ticks made from here on count (see pullListTicks).
        if (!r.alreadyOpen && mslist.configured && !cfg.replica) pullListTicks().catch(error => log.warn('list ticks at roll-call start failed', { error: error.message }));
        return r;
    };
    presence = new Presence({
        enabled: cfg.presence, store, signStaff, staffWithStatus, unifi: { ...cfg.unifi, fetch: cfg.unifi.fetch || cfg.fetch }, now: clock.now,
        doorScanners: new Set(cfg.doorScanners), anchorScanners: new Set(cfg.anchorScanners), thresholds: cfg.presenceThresholds
    });
    const ops = createOps({ cfg, store, clock, zone, log, startedAt, notifyOps });
    /** Retention: anonymise visitor details and delete events/roll calls older than RETENTION_DAYS (sightings keep their own 14 days). */
    async function runRetention() {
        if (!cfg.retentionDays) return { skipped: true, reason: 'retention is off (RETENTION_DAYS empty)' };
        const before = new Date(clock.ms() - cfg.retentionDays * 86400_000).toISOString();
        const status = { at: clock.iso(), before, ok: false };
        try {
            status.visitorsAnonymised = store.anonymiseVisitorsBefore(before);
            status.eventsDeleted = store.deleteEventsBefore(before);
            status.rollcallsDeleted = store.deleteRollcallsBefore(before);
            status.ok = true;
            if (status.visitorsAnonymised || status.eventsDeleted || status.rollcallsDeleted) store.addEvent({ kind: 'admin', at: clock.iso(), source: 'retention', device: 'server', note: `retention (${cfg.retentionDays} days): ${status.visitorsAnonymised} visitors anonymised, ${status.eventsDeleted} events and ${status.rollcallsDeleted} roll calls deleted` });
        } catch (error) { status.error = error.message; }
        store.setState('retentionStatus', status);
        return status.ok ? status : { ok: false, error: status.error };
    }
    const assistant = cfg.llmUrl ? new Assistant({ url: cfg.llmUrl, model: cfg.llmModel, fetch: cfg.fetch, log, zone, clock, tools: { store, roster, staffWithStatus, summariseRollcall, localDay } }) : null;

    /** Roll-call chaser: while people are unaccounted for, re-post their names to Teams every CHASER_MINUTES (capped). */
    function chase() {
        const open = store.openRollcall();
        if (!open || !cfg.teamsWebhookUrl || !cfg.chaserMinutes) return { skipped: true };
        const rc = summariseRollcall(open);
        if (rc.unaccounted + rc.missing === 0) return { skipped: true, reason: 'all accounted for' };
        const st = store.getState('chaser');
        const mine = st?.rollcallId === rc.id ? st : { rollcallId: rc.id, count: 0, lastAt: rc.startedAt };
        if (mine.count >= cfg.chaserMax || clock.ms() - Date.parse(mine.lastAt) < cfg.chaserMinutes * 60_000) return { skipped: true };
        const names = rosterNames(rc, s => s !== 'safe');
        notifyTeams({ title: `⏱ STILL NOT ACCOUNTED FOR (${names.length})${rc.drill ? ' — drill' : ''}`, tone: 'attention', selfMark: true, text: `${Math.round((clock.ms() - Date.parse(rc.startedAt)) / 60000)} min since the roll call started. If you are one of these and safe, press "I'm SAFE" on your own phone or tell someone at the assembly point.`, facts: [['Not accounted for', nameList(names)], ['Safe so far', `${rc.safe} of ${rc.total}`]] });
        store.setState('chaser', { rollcallId: rc.id, count: mine.count + 1, lastAt: clock.iso() });
        return { ok: true, posted: mine.count + 1 };
    }
    /** Ticks typed into the Microsoft List (on phones, with or without this server) become marks: via 'list'. */
    async function pullListTicks() {
        if (!mslist.configured || cfg.replica) return { skipped: true };
        const ticks = await mslist.readTicks();
        const open = store.openRollcall();
        const seen = store.getState('listTicks');
        if (!open) {
            if (seen?.rollcallId) store.setState('listTicks', { rollcallId: null, at: clock.iso() });
            if (!ticks.length) return { ok: true, applied: 0 };
            const { cleared } = await mslist.clearTicks(ticks);
            return { skipped: true, reason: 'no roll call', cleared };
        }
        // The first read during a roll call happens the moment it starts (fireStart). Anything already in the List
        // then was put there BEFORE this roll call (a drill just ended, a phone syncing late): a SAFE from it is never
        // applied. The same for a SAFE whose time is unknown or earlier than the start. (The app's own Status updates
        // move lastModifiedDateTime, so the time alone cannot prove a tick is recent; the first-read rule can.)
        const first = seen?.rollcallId !== open.id;
        // Rows whose SAFE was discarded but whose clear did not go through (412 because our own sync touched the row,
        // or a Graph error) stay discarded until the clear succeeds: their SAFE is still the old one.
        const pending = new Set(first ? [] : (seen?.pendingDiscard || []));
        let applied = 0; const refused = []; const discarded = [];
        for (const t of ticks) {
            const [subjectType, subjectId] = t.key.split(':');
            const status = t.tick === 'SAFE' ? 'safe' : t.tick === 'MISSING' ? 'missing' : null;
            if (!status || !['staff', 'visitor'].includes(subjectType) || !subjectId) continue;
            const stale = !t.modifiedAt || Date.parse(t.modifiedAt) < Date.parse(open.startedAt);
            if (status === 'safe' && (first || stale || pending.has(t.itemId))) { discarded.push(t.key); pending.add(t.itemId); continue; }
            pending.delete(t.itemId);
            const current = store.openRollcall().marks.find(m => m.subjectType === subjectType && m.subjectId === subjectId);
            if (current?.status === status) continue;
            // Over-count is safe, under-count never: a List tick may always say MISSING, but may only say SAFE for
            // someone nobody has marked yet (or whose last mark also came from the List).
            if (status === 'safe' && current && current.via !== 'list') { refused.push(t.key); continue; }
            const r = commands.mark({ rollcall: store.openRollcall(), subjectType, subjectId, status, by: `${t.modifiedBy || 'someone'} (Microsoft List)`, via: 'list', device: 'microsoft-list' });
            if (!r.error) applied++;
        }
        const result = ticks.length ? await mslist.clearTicks(ticks) : { cleared: 0, failed: [] };
        for (const id of [...pending]) if (!result.failed.includes(id)) pending.delete(id);
        store.setState('listTicks', { rollcallId: open.id, at: clock.iso(), pendingDiscard: [...pending] });
        if (discarded.length) log.warn('Microsoft List: SAFE ticks from before this roll call were discarded (tick again if still true)', { discarded });
        return { ok: true, applied, refused, discarded, cleared: result.cleared, first };
    }
    /** LLM reachability for the assistant: cheap GET /models, so Admin shows the state before anyone asks. */
    async function probeLlm() {
        if (!assistant) return { skipped: true };
        const status = { at: clock.iso(), ok: false };
        try { const res = await cfg.fetch(`${cfg.llmUrl}/models`, { signal: AbortSignal.timeout(5000) }); status.ok = res.ok; if (!res.ok) status.error = `answered ${res.status}`; }
        catch (error) { status.error = error.message; }
        store.setState('llmStatus', status);
        return status.ok ? status : { ok: false, error: status.error };
    }
    /** Remember when each device last talked to us (heartbeat, tap, sightings) for the drift watcher's silence check. */
    const lastSeenWrite = new Map();
    function deviceSeen(name) {
        if (!name || Math.abs(clock.ms() - (lastSeenWrite.get(name) || 0)) < 60_000) return;
        lastSeenWrite.set(name, clock.ms());
        const seen = store.getState('devicesSeen', {}); seen[name] = clock.iso(); store.setState('devicesSeen', seen);
    }

    // ---- background jobs ----------------------------------------------------
    const jobs = new Scheduler({ log, now: () => Date.now() });
    if (!cfg.replica) {
        if (presence.enabledWifi) jobs.every('wifi-poll', presence.cfg.wifiPollMs, () => presence.pollWifi(), { atStart: true });
        if (cfg.presence) {
            jobs.every('presence-rules', 60_000, () => { presence.applyRules(); if (publishRoster()) changed(); });
            jobs.every('presence-prune', 3600_000, () => presence.prune());
        }
        if (cfg.retentionDays) jobs.every('retention', 6 * 3600_000, () => runRetention(), { atStart: true });
        if (cfg.teamsWebhookUrl && cfg.chaserMinutes) jobs.every('chaser', 30_000, () => chase());
        if (mslist.configured) jobs.every('mslist-ticks', 30_000, () => pullListTicks());
    }
    jobs.every('sessions-prune', 3600_000, () => store.pruneSessions(clock.iso()));
    if (hasOutboxSink()) jobs.every('outbox', 15_000, async () => { const r = await flushOutbox(); const failed = Object.entries(r.errors || {}); return failed.length ? { ok: false, error: failed.map(([k, v]) => `${k}: ${v}`).join('; ') } : r; }, { atStart: true });
    if (cfg.backupDir) {
        jobs.every('backup', 10 * 60_000, () => backupIfDue(), { atStart: true });
        jobs.every('restore-drill', 3600_000, () => restoreDrillIfDue(), { atStart: true });
    }
    if (cfg.heartbeatUrl && cfg.heartbeatMinutes) jobs.every('heartbeat', cfg.heartbeatMinutes * 60_000, () => ops.heartbeat(), { atStart: true });
    if (ops.watchedHost() || cfg.spSecretExpires || cfg.expectDevices.length) jobs.every('drift', 3600_000, () => ops.drift(), { atStart: true });
    if (assistant) jobs.every('llm-probe', 10 * 60_000, () => probeLlm(), { atStart: true });
    /** Weekly (and after every restart once a week has passed): prove the newest backup restores. */
    async function restoreDrillIfDue() {
        const last = store.getState('restoreDrillStatus');
        if (last?.ok && clock.ms() - Date.parse(last.at) < 7 * 86400_000) return { skipped: true };
        if (last && !last.ok && clock.ms() - Date.parse(last.at) < 3600_000) return { skipped: true };
        return ops.restoreDrill();
    }
    async function backupIfDue() {
        const last = store.getState('backupStatus');
        const nowIso = clock.iso();
        const target = new Date(Date.parse(localDayStart(nowIso)) + cfg.backupHour * 3600_000).toISOString();
        const lastAgeMs = last ? Date.parse(nowIso) - Date.parse(last.at) : Infinity;
        const due = !last || (last.ok ? (nowIso >= target && last.at < target) || lastAgeMs > 26 * 3600_000 : lastAgeMs > 3600_000);
        if (!due) return { skipped: true };
        const r = await backup();
        return r.ok ? r : { ok: false, error: r.error };
    }

    // ---- health --------------------------------------------------------------
    function healthChecks() {
        const checks = [];
        const add = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail });
        const nowMs = clock.ms();
        const age = (iso) => iso ? Math.round((nowMs - Date.parse(iso)) / 1000) : null;
        try { store.db.prepare('SELECT 1').get(); add('database', true, `${cfg.dataFile} (schema v${store.schemaVersion()})`); } catch (error) { add('database', false, error.message); }
        for (const j of jobs.health()) if (j.lastOk !== null) add(`job:${j.name}`, j.lastOk, j.lastOk ? `ran ${j.lastRun}` : j.lastError);
        if (hasOutboxSink()) { const oldest = store.oldestOutboxAt(); add('outbox', !oldest || age(oldest) < 600, oldest ? `${store.outboxDepth()} waiting, oldest ${age(oldest)} s` : 'empty'); }
        if (cfg.backupDir) { const b = store.getState('backupStatus'); add('backup', b?.ok && age(b.at) < 26 * 3600, b ? (b.ok ? `last ${b.at}` : `failed ${b.at}: ${b.error}`) : 'none yet'); }
        if (sharepoint.configured) { const s = store.getState('sharepointStatus'); if (s) add('sharepoint', s.ok, s.ok ? `pushed ${s.at}` : s.error); }
        if (mslist.configured) { const s = store.getState('mslistStatus'); if (s) add('mslist', s.ok, s.ok ? `synced ${s.at}` : s.error); }
        if (cfg.teamsWebhookUrl) { const t = store.getState('teamsStatus'); if (t) add('teams', t.ok, t.ok ? `posted ${t.at}` : t.error); }
        if (cfg.opsWebhookUrl) { const t = store.getState('opsStatus'); if (t) add('ops-channel', t.ok, t.ok ? `posted ${t.at}` : t.error); }
        if (!cfg.replica && presence.enabledWifi && presence.lastWifiPoll) { const w = presence.lastWifiPoll; add('wifi', w.ok && age(w.at) < 3 * presence.cfg.wifiPollMs / 1000, w.ok ? `${w.count} clients at ${w.at}` : w.error); }
        if (cfg.backupPushTarget) { const b = store.getState('backupPushStatus'); add('backup-offbox', b?.ok && age(b.at) < 26 * 3600, b ? (b.ok ? `${b.target} at ${b.at}` : `failed ${b.at}: ${b.error}`) : 'none yet'); }
        if (cfg.backupDir) { const r = store.getState('restoreDrillStatus'); if (r) add('restore-drill', r.ok && age(r.at) < 8 * 86400, r.ok ? `${r.file} restored ${r.at} (schema v${r.schema}, ${r.events} events, no drift)` : `failed ${r.at}: ${r.error}`); }
        if (cfg.heartbeatUrl) { const h = store.getState('heartbeatStatus'); if (h) add('heartbeat', h.ok, h.ok ? `pinged ${h.at}` : h.error); }
        const drift = store.getState('driftStatus');
        if (drift) for (const x of drift.checks) add(`drift:${x.name}`, x.ok, x.detail);
        if (assistant) { const l = store.getState('llmStatus'); if (l) add('llm', l.ok, l.ok ? `${cfg.llmModel} reachable ${l.at}` : `${cfg.llmUrl}: ${l.error}`); }
        return checks;
    }
    function start() { jobs.start(); return api; }

    // ---- router + middleware ----------------------------------------------------
    const router = new Router();
    const a = {
        VERSION, startedAt, store, cfg, clock, zone, presence, sharepoint, mslist, jobs, warnings, clean, router, assistant, tls: options.tls || null,
        openStream, metricsText, healthChecks, apiState, currentRoster, roster, summariseRollcall, rosterNames, nameList, staffWithStatus, staffWithPresence,
        commands, signStaff, admitVisitor, fireStart, maybeNotifyAllSafe, notifyTeams, publishRoster, flushOutbox, backup, runRetention, eventsCsv, localDayStart,
        hasToken, HUMAN_SOURCES, SCOPES, login, logout, denyAdmin, assemblyView, ops, deviceSeen
    };
    for (const route of defineRoutes(a)) router.add(route);

    async function handle(req, res) {
        const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
        const p = url.pathname; const m = req.method;
        // Was this address already locked out before this request's PIN (if any) is judged? Decides 401 vs 429.
        req._lockedBefore = Boolean(cfg.adminPin) && adminLocked(req);
        // The reverse proxy marks requests that came from the internet. Nothing on the LAN sets this header; a LAN
        // client that does only restricts itself.
        const isPublic = req.headers['x-public'] === '1';
        // TRUSTED_NETS (v4.1): a LAN address outside them (e.g. the IoT Wi-Fi) is treated like the internet for the
        // no-login pages; devices there still reach their own routes with their token. A request arriving on loopback
        // WITH X-Forwarded-For came through the local reverse proxy (Caddy overwrites that header with the real client
        // address), so it is judged on that address — otherwise an IoT client would be trusted just by using the
        // domain name. Loopback without the header (signinctl, curl on the box) is trusted.
        const socketIp = ipv4(req.socket?.remoteAddress);
        const viaProxy = (/^127\./.test(socketIp) || socketIp === '::1') && Boolean(req.headers['x-forwarded-for']);
        // The LAST entry is the one our own proxy wrote (an older proxy that appends would otherwise let a client spoof it).
        const ip = isPublic || viaProxy ? ipv4(String(req.headers['x-forwarded-for'] || '').split(',').pop().trim()) : socketIp;
        const lanIp = viaProxy ? ip : socketIp;
        const untrustedLan = !isPublic && cfg.trustedNets.length > 0 && !/^127\./.test(lanIp) && lanIp !== '::1' && !cfg.trustedNets.some(n => inCidr(lanIp, n));
        const untrusted = isPublic || untrustedLan;
        let route = null;
        const c = {
            req, res, url, params: {}, body: {}, source: null, public: untrusted, ip,
            get principal() { return principalOf(req); },
            get admin() { return isAdmin(req); },
            send: (status, body, type, extra) => send(res, status, body, type, extra),
            fail: (status, error) => send(res, status, { error }),
            device: (body = c.body) => deviceOf(req, body),
            audit: (note) => audit(req, note)
        };
        const refuse = () => c.fail(403, isPublic ? 'Not available from outside the office' : 'Not available from this network');
        try {
            const hit = router.match(m, p);
            if (!hit) {
                if (p.startsWith('/api/') || p === '/metrics') return untrusted ? refuse() : c.fail(router.pathKnown(p) ? 405 : 404, router.pathKnown(p) ? 'Method not allowed' : 'Not found');
                if (m !== 'GET') return c.fail(405, 'Method not allowed');
                const requested = PAGES[p] || p.slice(1);
                if (untrusted && !PUBLIC_FILES.has(requested)) return send(res, 403, isPublic ? 'Not available from outside the office' : 'Not available from this network', 'text/plain; charset=utf-8');
                const file = path.resolve(cfg.publicDir, requested);
                if (!file.startsWith(cfg.publicDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(res, 404, 'Not found', 'text/plain; charset=utf-8');
                const extra = requested === 'sw.js' ? { 'Service-Worker-Allowed': '/' } : {};
                return send(res, 200, fs.readFileSync(file), MIME[path.extname(file)] || 'application/octet-stream', extra);
            }
            route = hit.route; c.params = hit.params;
            const [kind, scope] = String(route.auth).split(':');
            if (isPublic && !route.public) return refuse();
            // An untrusted LAN address may use public routes, and device/mirror routes WITH a credential — never the
            // no-login human routes (kiosk sign-in, start/end roll call, marshal ticks) and never Admin, PIN or not.
            if (untrustedLan && !route.public && !((kind === 'device' || kind === 'claim') && principalOf(req)) && !(kind === 'mirror' && hasMirrorToken(req))) return refuse();
            if (m !== 'GET') c.body = await bodyOf(req);
            // 1. auth, from the route's declaration
            if (kind === 'admin' && !isAdmin(req)) return denyAdmin(c);
            if (kind === 'mirror' && !hasMirrorToken(req)) return c.fail(401, 'Mirror token required');
            if (kind === 'device' && !hasToken(req, scope)) return c.fail(401, `API token with the "${scope}" scope required`);
            if (kind === 'claim') {
                const fallback = route.path === '/api/fire/start' ? 'fire-page' : (c.body.cardUid ? 'card' : 'kiosk');
                const source = clean(c.body.source || fallback, 20);
                if (source === 'admin' && !isAdmin(req)) return c.fail(401, 'Admin PIN required');
                if (!HUMAN_SOURCES.has(source) && !hasToken(req, scope)) return c.fail(401, `API token with the "${scope}" scope required`);
                if (untrustedLan && HUMAN_SOURCES.has(source)) return refuse();
                c.source = source;
            }
            if (principalOf(req)) deviceSeen(deviceOf(req, c.body));
            // 2. a replica never accepts writes to the register
            if (route.mutates && cfg.replica) return c.fail(409, cfg.replica && route.path === '/api/sign' ? 'This is a read-only mirror. Sign in on the main server.' : 'Read-only mirror');
            // 3. the handler
            return await route.handler(c);
        } catch (error) {
            if (error instanceof SyntaxError) return c.fail(400, 'Request body is not valid JSON');
            if (error.code === 'TOO_LARGE') return c.fail(413, 'Request too large');
            if (/constraint failed/i.test(error.message || '')) return c.fail(409, 'That conflicts with an existing record');
            log.error('request failed', { method: m, path: p, error: error.stack || String(error) });
            return c.fail(500, 'Internal error — see the server log');
        } finally {
            // 4. a successful write wakes every open page, unless the route is chatter
            if (route && m !== 'GET' && res.statusCode < 400 && route.notify !== false) changed();
        }
    }

    const api = {
        handle, start, store, cfg, warnings, log, clock, zone, jobs, router, healthChecks, presence, flushOutbox, kickFlush, publishRoster, backup, backupIfDue, runRetention,
        roster, rosterText, metricsText, localDayStart, localDay, fireStart, sharepoint, mslist, assistant, hasOutboxSink, commands, ops, chase, pullListTicks, probeLlm, restoreDrillIfDue,
        close: () => { jobs.stop(); clearTimeout(flushTimer); clearTimeout(changeTimer); clearInterval(heartbeat); for (const s of streams) s.end(); streams.clear(); store.close(); }
    };
    return api;
}

module.exports = { createApp };
