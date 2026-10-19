'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, timingSafeEqual } = require('node:crypto');
const { Store, normaliseUid } = require('./store');
const { SharePointSink } = require('./sharepoint');
const { Presence } = require('./presence');
const { loadConfig } = require('./config');
const { createClock, LocalTime } = require('./time');
const { Scheduler } = require('./scheduler');
const { createLogger } = require('./log');

const MIME = {
    '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
    '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.png': 'image/png'
};
const PAGES = { '/': 'index.html', '/fire': 'fire.html', '/admin': 'admin.html', '/tap': 'tap.html', '/visitor': 'visitor.html' };
const { version: VERSION } = require('../package.json');

function createApp(options = {}) {
    const { cfg, errors, warnings } = loadConfig(options, options.env ?? process.env);
    if (errors.length) throw Object.assign(new Error(`invalid configuration:\n  - ${errors.join('\n  - ')}`), { code: 'BAD_CONFIG', errors });
    const log = options.log || createLogger({ format: cfg.logFormat, silent: options.silent });
    const clock = createClock(cfg.now);
    const zone = new LocalTime(cfg.timeZone);
    const store = new Store(cfg.dataFile);
    const startedAt = clock.iso();
    const sharepoint = new SharePointSink({ ...cfg.sharepoint, fetch: cfg.fetch });
    const hasOutboxSink = () => !cfg.replica && (Boolean(cfg.mirrorUrl) || sharepoint.configured || Boolean(cfg.teamsWebhookUrl));

    // ---- time helpers ------------------------------------------------
    const localDay = (iso) => zone.day(iso);
    /** ISO instant of local midnight for the day containing `iso` (works across BST/GMT). */
    const localDayStart = (iso = clock.iso()) => zone.dayStart(iso);

    // ---- presence / roster ---------------------------------------------
    function staffWithStatus() {
        const todayStart = localDayStart();
        return store.listPeople().map(person => {
            const last = store.latestPresenceEvent(person.id);
            const signedIn = last?.kind === 'in';
            return {
                id: person.id, name: person.name, hasCard: Boolean(person.cardUid), hasPhone: Boolean(person.phoneMac), hasTag: Boolean(person.tagId), signedIn,
                since: signedIn ? last.at : null, lastSource: last?.source || null,
                stale: signedIn && last.at < todayStart
            };
        });
    }
    /** staffWithStatus + the presence badge (needs `presence`, so it is built after it). */
    function staffWithPresence() {
        return staffWithStatus().map(p => ({ ...p, presence: presence.badge(store.getPerson(p.id)) }));
    }
    function roster() {
        const staff = staffWithPresence().filter(p => p.signedIn);
        const todayStart = localDayStart();
        const visitors = store.listVisitors({ presentOnly: true });
        return {
            at: clock.iso(),
            staff: staff.map(p => ({ type: 'staff', id: p.id, name: p.name, since: p.since, stale: p.stale, source: p.lastSource, presence: p.presence })),
            // A visitor still signed in from a previous day is flagged exactly like staff: kept on the register, never auto-closed.
            visitors: visitors.map(v => ({ type: 'visitor', id: v.id, name: v.name, company: v.company, hostName: v.hostName, vehicle: v.vehicle, badge: v.badge, since: v.signedInAt, stale: v.signedInAt < todayStart })),
            count: staff.length + visitors.length,
            loneWorker: staff.length === 1 && visitors.length === 0
        };
    }
    function currentRoster() {
        if (cfg.replica) return store.getSetting('replicaRoster', { at: null, staff: [], visitors: [], count: 0, replica: true, stale: true });
        return roster();
    }
    function apiState() {
        const people = staffWithPresence();
        const open = store.openRollcall();
        const todayStart = localDayStart();
        const visitors = store.listVisitors({ presentOnly: true }).map(v => ({ ...v, stale: v.signedInAt < todayStart }));
        const signedIn = people.filter(p => p.signedIn).length;
        return {
            companyName: store.getSetting('companyName'),
            fireNotice: store.getSetting('fireNotice'),
            replica: cfg.replica,
            people,
            visitors,
            inCount: signedIn + visitors.length,
            staleCount: people.filter(p => p.stale).length + visitors.filter(v => v.stale).length,
            probablyLeftCount: people.filter(p => p.signedIn && p.presence?.state === 'probably-left').length,
            loneWorker: signedIn === 1 && visitors.length === 0,
            expectedToday: store.listExpected({ day: localDay(clock.iso()) }).length,
            rollcall: open ? summariseRollcall(open) : null,
            lastUnknownCard: store.getSetting('lastUnknownCard'),
            publicUrl: cfg.publicUrl || null,
            serverTime: clock.iso()
        };
    }
    function summariseRollcall(rc) {
        const total = rc.roster.staff.length + rc.roster.visitors.length;
        const safe = rc.marks.filter(m => m.status === 'safe').length;
        const missing = rc.marks.filter(m => m.status === 'missing').length;
        return { ...rc, total, safe, missing, unaccounted: total - safe - missing, allSafe: total > 0 && safe === total };
    }
    /** Names for the Teams cards: the warden at the assembly point reads WHO, not just how many. */
    function rosterNames(rc, filter = () => true) {
        const all = [...rc.roster.staff, ...rc.roster.visitors];
        const status = (e) => rc.marks.find(m => m.subjectType === e.type && m.subjectId === e.id)?.status || 'not seen';
        return all.filter(e => filter(status(e))).map(e => e.type === 'visitor' ? `${e.name} (visitor${e.company ? ', ' + e.company : ''})` : e.name);
    }
    const nameList = (names) => names.length ? names.join(' · ') : '—';
    /** Local hour (0-23) in cfg.timeZone — the lone-worker rule lives in Prometheus, this is its input. */
    const localHour = (iso = clock.iso()) => zone.hour(iso);

    // ---- Prometheus exposition (counts only — no names leave this endpoint) --------
    // Scraped by the estate's Prometheus on platform-a (llm-cluster ops-config/observability/prometheus.yml job
    // `signin`); alert rules in alert-rules.yml group `signin_safety`. Every value here is read from the same
    // store the kiosk and fire page use, so the alert and the page cannot disagree.
    function metricsText() {
        const r = currentRoster();
        const people = cfg.replica ? [] : staffWithStatus();
        const open = store.openRollcall();
        const sp = store.getSetting('sharepointStatus');
        const nowMs = clock.ms();
        const lines = [];
        const declared = new Set();
        // HELP/TYPE once per metric name; labelled series of one metric follow it (exposition format requirement).
        const g = (name, help, value, labels = '') => {
            if (value === null || value === undefined || Number.isNaN(value)) return;
            if (!declared.has(name)) { declared.add(name); lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`); }
            lines.push(`${name}${labels} ${typeof value === 'boolean' ? (value ? 1 : 0) : value}`);
        };
        g('signin_up', '1 while the sign-in server answers', 1);
        g('signin_replica', '1 on the read-only mirror', cfg.replica);
        g('signin_staff_on_site', 'Staff currently signed in', r.staff.length);
        g('signin_visitors_on_site', 'Visitors currently signed in', r.visitors.length);
        g('signin_on_site_total', 'Staff + visitors currently signed in', r.count);
        g('signin_stale_signins', 'Staff signed in before local midnight and never signed out (forgotten sign-outs)', people.filter(p => p.stale).length);
        g('signin_stale_visitors', 'Visitors signed in before local midnight and never signed out', (r.visitors || []).filter(v => v.stale).length);
        if (!cfg.replica) {
            const ph = presence.health();
            const withPresence = people.map(p => ({ ...p, presence: presence.badge(store.getPerson(p.id)) }));
            g('signin_probably_left', 'Signed-in staff whose phone and tag have both been absent (shown, not acted on)', withPresence.filter(p => p.signedIn && p.presence?.state === 'probably-left').length);
            g('signin_presence_here', 'Signed-in staff with a phone or tag currently seen inside', withPresence.filter(p => p.signedIn && p.presence?.state === 'here').length);
            g('signin_wifi_enabled', '1 when the UniFi Wi-Fi brace is configured', ph.wifi.enabled);
            if (ph.wifi.lastPoll) { g('signin_wifi_last_poll_ok', '1 if the most recent UniFi poll succeeded', Boolean(ph.wifi.lastPoll.ok)); g('signin_wifi_last_poll_age_seconds', 'Seconds since the most recent UniFi poll', Math.max(0, Math.floor((nowMs - Date.parse(ph.wifi.lastPoll.at)) / 1000))); }
            g('signin_wifi_clients', 'Clients in the most recent controller list (all, not just enrolled)', ph.wifi.clients);
            for (const s of ph.scanners) g('signin_scanner_last_report_age_seconds', 'Seconds since a BLE scanner last posted sightings', s.ageS, `{scanner="${s.name.replace(/"/g, '')}"}`);
            for (const t of ph.tags) if (t.ageS !== null) g('signin_tag_last_heard_age_seconds', 'Seconds since an enrolled BLE tag was last heard (battery/lost guard; label is the tag id, not the person)', t.ageS, `{tag="${t.tagId.replace(/"/g, '')}"}`);
        }
        g('signin_lone_worker', '1 when exactly one member of staff is on site with no visitors (time-of-day rule is applied in Prometheus)', r.staff.length === 1 && r.visitors.length === 0);
        g('signin_local_hour', `Hour of day 0-23 in ${cfg.timeZone}, the input for the out-of-hours lone-worker rule`, localHour());
        g('signin_rollcall_open', '1 while a fire roll call is running', Boolean(open));
        if (open) {
            const s = summariseRollcall(open);
            g('signin_rollcall_started_timestamp_seconds', 'Unix time the open roll call started', Math.floor(Date.parse(s.startedAt) / 1000));
            g('signin_rollcall_total', 'People on the frozen roll-call register', s.total);
            g('signin_rollcall_safe', 'Marked SAFE on the open roll call', s.safe);
            g('signin_rollcall_missing', 'Marked MISSING on the open roll call', s.missing);
            g('signin_rollcall_unaccounted', 'Not yet seen on the open roll call', s.unaccounted);
        }
        g('signin_outbox_depth', 'Off-site snapshots still waiting to be sent (mirror + SharePoint + Teams)', store.outboxDepth());
        g('signin_expected_visitors_today', 'Pre-registered visitors expected today who have not yet arrived', store.listExpected({ day: localDay(clock.iso()) }).length);
        g('signin_teams_configured', '1 when the Teams webhook is configured', Boolean(cfg.teamsWebhookUrl));
        const ts = store.getSetting('teamsStatus');
        if (ts) g('signin_teams_last_send_ok', '1 if the most recent Teams post succeeded', Boolean(ts.ok));
        g('signin_sharepoint_configured', '1 when the SharePoint off-site copy is configured', sharepoint.configured);
        if (sp) {
            g('signin_sharepoint_last_push_ok', '1 if the most recent SharePoint push succeeded', Boolean(sp.ok));
            g('signin_sharepoint_last_push_age_seconds', 'Seconds since the most recent SharePoint push attempt', Math.max(0, Math.floor((nowMs - Date.parse(sp.at)) / 1000)));
        }
        g('signin_events_last_24h', 'Register events written in the trailing 24 hours', store.listEvents({ from: new Date(nowMs - 86400_000).toISOString(), limit: 100_000 }).length);
        const bk = store.getSetting('backupStatus');
        g('signin_backup_enabled', '1 when nightly backups of the register are on', Boolean(cfg.backupDir));
        if (bk) {
            g('signin_backup_last_ok', '1 if the most recent backup succeeded', Boolean(bk.ok));
            g('signin_backup_age_seconds', 'Seconds since the most recent backup attempt', Math.max(0, Math.floor((nowMs - Date.parse(bk.at)) / 1000)));
        }
        g('signin_started_timestamp_seconds', 'Unix time this server process started', Math.floor(Date.parse(startedAt) / 1000));
        for (const c of healthChecks()) g('signin_check_ok', '1 when a health check passes (database, jobs, outbox, backup, sharepoint, teams, wifi)', c.ok, `{check="${c.name.replace(/"/g, '')}"}`);
        for (const j of jobs.health()) {
            if (j.lastRun) g('signin_job_last_run_age_seconds', 'Seconds since a background job last ran', Math.max(0, Math.floor((nowMs - Date.parse(j.lastRun)) / 1000)), `{job="${j.name}"}`);
        }
        for (const j of jobs.health()) g('signin_job_failures', 'Failed runs of a background job since the process started', j.failures, `{job="${j.name}"}`);
        g('signin_info', 'Build information', 1, `{version="${VERSION}",tz="${cfg.timeZone}"}`);
        return lines.join('\n') + '\n';
    }

    // ---- off-site copies: mirror + SharePoint + Teams ---------------------
    // Every change queues one snapshot per sink. Snapshots supersede each other, so a flush only
    // sends the newest queued item of each type and acknowledges the rest. Teams messages are the
    // exception: each one is a distinct event and is delivered individually, in order.
    function publishRoster() {
        if (cfg.replica) return false;
        // Only a change worth copying off-site is published: presence scanners post every few seconds and must not
        // turn into a SharePoint upload storm. Called on every write and from the 60 s rules tick (badges age with time).
        const r = roster();
        const open = store.openRollcall();
        const fingerprint = JSON.stringify([
            store.listEvents({ limit: 1 })[0]?.id || null, store.getSetting('companyName'),
            r.staff.map(s => [s.id, s.since, s.stale, s.presence?.state || null]), r.visitors.map(v => [v.id, v.stale]),
            open ? [open.id, open.marks.map(mk => [mk.subjectType, mk.subjectId, mk.status])] : null
        ]);
        if (fingerprint === lastPublished) return false;
        lastPublished = fingerprint;
        if (cfg.mirrorUrl) store.enqueueOutbox({ type: 'roster', roster: r });
        if (sharepoint.configured) store.enqueueOutbox({ type: 'sharepoint', at: clock.iso() });
        return true;
    }
    let lastPublished = null;
    const TEAMS_MAX_ATTEMPTS = 240;    // ~1 h at the 15 s flush cadence; a fire notice older than that is noise
    /** Adaptive Card wrapped for a Teams Workflows webhook. `tone`: attention | good | warning | accent. */
    function teamsCard({ title, text, tone = 'accent', facts = [], at = clock.iso() }) {
        const body = [
            { type: 'TextBlock', text: title, size: 'ExtraLarge', weight: 'Bolder', color: tone, wrap: true },
            { type: 'TextBlock', text, wrap: true, size: 'Medium' }
        ];
        if (facts.length) body.push({ type: 'FactSet', facts: facts.map(([t, v]) => ({ title: t, value: String(v) })) });
        body.push({ type: 'TextBlock', text: `${store.getSetting('companyName')} sign-in · ${zone.fmt(at, 'whenSeconds')}`, size: 'Small', isSubtle: true, wrap: true });
        const card = { type: 'AdaptiveCard', $schema: 'http://adaptivecards.io/schemas/adaptive-card.json', version: '1.4', body, msteams: { width: 'Full' } };
        if (cfg.publicUrl) card.actions = [{ type: 'Action.OpenUrl', title: 'Open the roll call', url: `${cfg.publicUrl}/fire` }];
        return { type: 'message', attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', contentUrl: null, content: card }] };
    }
    function notifyTeams(card) {
        if (cfg.replica || !cfg.teamsWebhookUrl) return false;
        store.enqueueOutbox({ type: 'teams', message: teamsCard(card), at: clock.iso() });
        kickFlush();
        return true;
    }
    let flushTimer = null; let flushing = false; let flushAgain = false;
    /** Deliver soon (next tick), coalescing bursts; the 15 s interval in server.js remains the retry path. */
    function kickFlush() {
        if (!hasOutboxSink()) return;
        clearTimeout(flushTimer);
        flushTimer = setTimeout(() => { flushOutbox().catch(() => { }); }, 20);
        if (typeof flushTimer.unref === 'function') flushTimer.unref();
    }
    function rosterText() {
        const r = roster();
        const open = store.openRollcall();
        const when = (iso) => zone.fmt(iso, 'when');
        const lines = [
            `${store.getSetting('companyName')} — WHO IS ON SITE`,
            `Updated ${when(r.at)} (${cfg.timeZone})`,
            '',
            `ON SITE: ${r.count}   (staff ${r.staff.length}, visitors ${r.visitors.length})`,
            ''
        ];
        if (open) {
            const s = summariseRollcall(open);
            lines.push(`*** FIRE ROLL CALL IN PROGRESS since ${when(s.startedAt)}${s.startedBy ? ' by ' + s.startedBy : ''} ***`,
                `    safe ${s.safe} / missing ${s.missing} / not yet seen ${s.unaccounted} of ${s.total}`, '');
        }
        if (r.loneWorker) lines.push('LONE WORKER: one member of staff on site with no visitors.', '');
        lines.push('STAFF');
        if (!r.staff.length) lines.push('  (none)');
        for (const p of r.staff) lines.push(`  ${p.name}  — in since ${when(p.since)}${p.stale ? '  [signed in before today: may have forgotten to sign out]' : ''}${p.presence?.state === 'probably-left' ? `  [phone/tag last seen ${when(p.presence.lastSeen)}: probably left]` : ''}`);
        lines.push('', 'VISITORS');
        if (!r.visitors.length) lines.push('  (none)');
        for (const v of r.visitors) lines.push(`  ${v.name}  — ${[v.company, v.hostName ? 'visiting ' + v.hostName : null, v.vehicle, 'badge ' + v.badge].filter(Boolean).join(', ')} — in since ${when(v.since)}${v.stale ? '  [signed in before today: may have forgotten to sign out]' : ''}`);
        lines.push('', 'This file is written automatically by the sign-in server after every change.',
            'If it is old, the server may be down: treat the list as "who was inside at that time".');
        return lines.join('\r\n');
    }
    function eventsCsv(from, to) {
        const events = store.listEvents({ from, to, limit: 100_000 }).reverse();
        const lines = ['Date,Time,Type,Name,Action,Source,Device,Note'];
        for (const e of events) {
            const d = new Date(e.at);
            lines.push([zone.fmt(d, 'csvDate'), zone.fmt(d, 'csvTime'), e.subjectType || '', e.subjectName || '', e.kind, e.source, e.device || '', e.note || ''].map(csvCell).join(','));
        }
        return lines.join('\r\n');
    }
    async function pushSharePoint() {
        const today = localDayStart();
        const files = [];
        files.push(await sharepoint.upload('who-is-on-site.txt', rosterText(), 'text/plain; charset=utf-8'));
        files.push(await sharepoint.upload('roster.json', JSON.stringify({ ...roster(), rollcall: store.openRollcall() && summariseRollcall(store.openRollcall()) }, null, 2), 'application/json'));
        files.push(await sharepoint.upload(`events-${localDay(today)}.csv`, eventsCsv(today, null), 'text/csv; charset=utf-8'));
        return files;
    }
    const SP_SIMPLE_UPLOAD_MAX = 4 * 1024 * 1024;   // Graph simple-upload limit
    /** Write a dated backup, keep the newest `backupKeep`, copy it to SharePoint when configured and small enough. */
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
                else {
                    try { status.offsite = await sharepoint.upload(`backups/${name}`, fs.readFileSync(file), 'application/octet-stream'); }
                    catch (error) { status.offsite = `failed: ${error.message}`; }
                }
            }
        } catch (error) { status.error = error.message; }
        store.setSetting('backupStatus', status);
        return status;
    }
    async function flushOutbox() {
        if (!hasOutboxSink()) return { sent: 0, remaining: 0 };
        if (flushing) { flushAgain = true; return { sent: 0, remaining: store.outboxDepth(), busy: true }; }
        flushing = true;
        try {
            const items = store.peekOutbox(200);
            const byType = new Map();
            for (const item of items) { if (!byType.has(item.payload.type)) byType.set(item.payload.type, []); byType.get(item.payload.type).push(item); }
            let sent = 0;
            const errors = {};
            for (const [type, group] of byType) {
                if (type === 'teams') {
                    for (const item of group) {
                        try {
                            if (!cfg.teamsWebhookUrl) throw new Error('Teams not configured');
                            const res = await cfg.fetch(cfg.teamsWebhookUrl, {
                                method: 'POST', headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify(item.payload.message), signal: AbortSignal.timeout(8000)
                            });
                            if (!res.ok) throw new Error(`Teams answered ${res.status}`);
                            store.ackOutbox(item.seq); sent++;
                            store.setSetting('teamsStatus', { at: clock.iso(), ok: true });
                        } catch (error) {
                            errors.teams = error.message;
                            store.setSetting('teamsStatus', { at: clock.iso(), ok: false, error: error.message });
                            if (item.attempts + 1 >= TEAMS_MAX_ATTEMPTS) store.ackOutbox(item.seq); else store.failOutbox(item.seq);
                            break;      // keep order: do not send a later message before an earlier one
                        }
                    }
                    continue;
                }
                const newest = group[group.length - 1];
                try {
                    if (type === 'roster') {
                        if (!cfg.mirrorUrl) throw new Error('mirror not configured');
                        const res = await cfg.fetch(new URL('/api/mirror', cfg.mirrorUrl), {
                            method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Api-Token': cfg.mirrorToken },
                            body: JSON.stringify(newest.payload), signal: AbortSignal.timeout(5000)
                        });
                        if (!res.ok) throw new Error(`mirror answered ${res.status}`);
                    } else if (type === 'sharepoint') {
                        if (!sharepoint.configured) throw new Error('SharePoint not configured');
                        const files = await pushSharePoint();
                        store.setSetting('sharepointStatus', { at: clock.iso(), ok: true, files });
                    } else {
                        throw new Error(`unknown outbox type ${type}`);
                    }
                    for (const item of group) store.ackOutbox(item.seq);
                    sent++;
                } catch (error) {
                    errors[type] = error.message;
                    store.failOutbox(newest.seq);
                    if (type === 'sharepoint') store.setSetting('sharepointStatus', { at: clock.iso(), ok: false, error: error.message });
                }
            }
            return { sent, remaining: store.outboxDepth(), errors };
        } finally {
            flushing = false;
            if (flushAgain) { flushAgain = false; kickFlush(); }
        }
    }

    // ---- auth --------------------------------------------------------------
    const safeEqual = (a, b) => {
        const ba = Buffer.from(String(a)); const bb = Buffer.from(String(b));
        return ba.length === bb.length && timingSafeEqual(ba, bb);
    };
    // Wrong PINs are counted per client address; after `max` misses in `windowMs` that address is refused (429) until
    // the window passes, even with the right PIN. A missing header is not a guess (the admin page probes without one).
    const lockout = { max: 10, windowMs: 15 * 60_000, ...cfg.adminLockout };
    const pinMisses = new Map();     // ip -> [epoch ms of each miss]
    const clientIp = (req) => req.socket?.remoteAddress || 'unknown';
    function adminLocked(req) {
        const recent = (pinMisses.get(clientIp(req)) || []).filter(t => Date.now() - t < lockout.windowMs);
        pinMisses.set(clientIp(req), recent);
        return recent.length >= lockout.max;
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
    function missPin(req) {
        const misses = pinMisses.get(clientIp(req)) || [];
        misses.push(Date.now());
        pinMisses.set(clientIp(req), misses);
        if (misses.length === lockout.max) store.addEvent({ kind: 'admin', at: clock.iso(), source: 'admin', device: clientIp(req), note: `admin locked out after ${lockout.max} wrong PINs` });
    }
    // Admin sessions: the admin page logs in once and gets an HttpOnly cookie, so the PIN is not kept in the browser
    // or sent with every request. In memory: a restart logs everyone out, which is fine.
    const SESSION_MS = 12 * 3600_000;
    const sessions = new Map();      // token -> expiry epoch ms
    const cookieOf = (req, name) => (req.headers.cookie || '').split(';').map(s => s.trim().split('=')).find(([k]) => k === name)?.[1] || '';
    function adminSession(req) {
        const tok = cookieOf(req, 'si_admin');
        const exp = tok && sessions.get(tok);
        if (!exp) return false;
        if (exp < Date.now()) { sessions.delete(tok); return false; }
        return true;
    }
    /** Sends 401 (or 429 while locked out) and returns false when the request is not admin. */
    function requireAdmin(req, res) {
        const lockedBefore = cfg.adminPin && adminLocked(req);
        if (isAdmin(req)) return true;
        if (lockedBefore) {
            send(res, 429, { error: 'Too many wrong PINs from this device. Try again later.' }, undefined, { 'Retry-After': String(Math.ceil(lockout.windowMs / 1000)) });
        } else fail(res, 401, 'Admin PIN required');
        return false;
    }
    // Device credentials: the shared API_TOKEN (every scope, as before v3.7) or a per-device token issued in Admin with
    // only the scopes that device needs. A device token also fixes the device's NAME: what it calls itself is ignored.
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
    // Bench mode (no API_TOKEN and no device token EVER issued) keeps the v3.0 behaviour for a bench or a trusted LAN.
    // Revoked rows count: revoking the last token must lock the door, not open it.
    const openMode = () => !cfg.apiToken && store.listDevices().length === 0;
    const hasToken = (req, scope = null) => {
        if (openMode()) return true;
        const p = principalOf(req);
        return Boolean(p && (!scope || p.scopes.includes(scope)));
    };
    const hasMirrorToken = (req) => cfg.mirrorToken ? safeEqual(req.headers['x-api-token'] || '', cfg.mirrorToken) : (openMode() || principalOf(req)?.kind === 'shared-token');
    // A source is a claim about who acted. People at a screen may claim a human source without a token; any other
    // source (card, esp32, webhook, api, ...) is a device and must present a token with the scope — whatever it calls itself.
    const HUMAN_SOURCES = new Set(['kiosk', 'tap', 'fire-page', 'admin', 'visitor']);
    function sourceOf(req, body, fallback, scope = null) {
        const source = clean(body.source || fallback, 20);
        if (source === 'admin' && !isAdmin(req)) return { error: [401, 'Admin PIN required'] };
        if (!HUMAN_SOURCES.has(source) && !hasToken(req, scope)) return { error: [401, scope ? `API token with the "${scope}" scope required` : 'API token required'] };
        return { source };
    }
    /** Admin actions go into the same event log as everything else, so "who changed what" is answerable. */
    function audit(req, note) {
        store.addEvent({ kind: 'admin', at: clock.iso(), source: 'admin', device: deviceOf(req, {}), note: clean(note, 200) });
    }

    // ---- http helpers -----------------------------------------------------
    function send(res, status, body, type = 'application/json; charset=utf-8', extra = {}) {
        res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra });
        res.end(type.includes('json') ? JSON.stringify(body) : body);
    }
    const fail = (res, status, error) => send(res, status, { error });
    async function bodyOf(req) {
        let text = '';
        for await (const chunk of req) {
            text += chunk;
            if (text.length > 100_000) throw Object.assign(new Error('Request too large'), { code: 'TOO_LARGE' });
        }
        return text ? JSON.parse(text) : {};
    }
    const clean = (v, max = 80) => String(v ?? '').trim().slice(0, max);
    const deviceOf = (req, body) => req._principal?.device || clean(body.device || req.headers['x-device'] || req.socket?.remoteAddress || 'unknown', 60);
    const csvCell = (v) => `"${String(v ?? '').replaceAll('"', '""')}"`;

    // ---- live updates (Server-Sent Events) ----------------------------------
    // Pages hold one /api/stream connection and reload their view when told something changed, instead of polling every
    // few seconds. Bursts are coalesced; a comment line every 25 s keeps proxies and phones from dropping the connection.
    const streams = new Set();
    let changeSeq = 0; let changeTimer = null; let heartbeat = null;
    function changed() {
        if (changeTimer || !streams.size) return;
        changeTimer = setTimeout(() => {
            changeTimer = null; changeSeq++;
            for (const s of streams) s.write(`event: change\ndata: {"seq":${changeSeq}}\n\n`);
        }, 50);
        if (typeof changeTimer.unref === 'function') changeTimer.unref();
    }
    function openStream(req, res) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        res.write(`retry: 3000\nevent: hello\ndata: {"seq":${changeSeq}}\n\n`);
        streams.add(res);
        req.on('close', () => streams.delete(res));
        if (!heartbeat) {
            heartbeat = setInterval(() => { for (const s of streams) s.write(':\n\n'); }, 25_000);
            if (typeof heartbeat.unref === 'function') heartbeat.unref();
        }
    }

    // ---- actions --------------------------------------------------------
    function signStaff({ person, direction, source, device, eventKey, note, at = clock.iso() }) {
        const last = store.latestPresenceEvent(person.id);
        const kind = direction || (last?.kind === 'in' ? 'out' : 'in');
        const { event, duplicate } = store.addEvent({ kind, subjectType: 'staff', subjectId: person.id, subjectName: person.name, source, device, eventKey, note, at });
        if (!duplicate) { publishRoster(); changed(); }
        return { event, duplicate };
    }
    /** Walk-in and pre-registered arrivals share one path: badge, visitor row, event, publish. */
    function admitVisitor({ name, company, host, vehicle, source, device, extraNote = null, expectedId = null }) {
        const at = clock.iso();
        const visitor = store.addVisitor({ name, company, host, vehicle: clean(vehicle, 16).toUpperCase(), badge: store.nextBadge(localDayStart(at)), at });
        if (expectedId) store.markExpectedArrived(expectedId, visitor.id, at);
        store.addEvent({ kind: 'in', subjectType: 'visitor', subjectId: visitor.id, subjectName: visitor.name, at, source, device, note: [visitor.company, visitor.hostName ? `visiting ${visitor.hostName}` : null, `badge ${visitor.badge}`, extraNote].filter(Boolean).join(' · ') });
        publishRoster();
        return visitor;
    }
    // Presence engine: reads the same store, signs people in/out through signStaff under its own rules.
    // Built here so signStaff/staffWithStatus exist; its timers are jobs on the scheduler below.
    const presence = new Presence({
        store, signStaff, staffWithStatus, unifi: { ...cfg.unifi, fetch: cfg.unifi.fetch || cfg.fetch }, now: clock.now,
        doorScanners: new Set(cfg.doorScanners), anchorScanners: new Set(cfg.anchorScanners), thresholds: cfg.presenceThresholds
    });
    function fireStart({ startedBy, source, device }) {
        const existing = store.openRollcall();
        if (existing) return { rollcall: summariseRollcall(existing), alreadyOpen: true };
        const at = clock.iso();
        const rc = store.startRollcall({ roster: currentRoster(), startedBy, source, at });
        store.addEvent({ kind: 'fire_start', at, source, device, note: `Roll call started (${rc.roster.count} on site)`, subjectName: startedBy || null });
        publishRoster();
        notifyTeams({
            title: '🚨 FIRE ROLL CALL STARTED', tone: 'attention', at,
            text: `${rc.roster.count} on the register (${rc.roster.staff.length} staff, ${rc.roster.visitors.length} visitors). If you are OFF SITE stay away and phone in. At the assembly point open the roll call and tick people SAFE.`,
            facts: [['Started by', startedBy || '(not given)'], ['From', source], ['On the register', rc.roster.count], ['Who', nameList(rosterNames(rc))]]
        });
        return { rollcall: summariseRollcall(rc), alreadyOpen: false };
    }
    /** Once per roll call: the first mark that makes everyone SAFE sends the all-clear. */
    function maybeNotifyAllSafe(rc) {
        if (!rc.allSafe || store.getSetting('allSafeNotified') === rc.id) return;
        store.setSetting('allSafeNotified', rc.id);
        notifyTeams({ title: `✅ ALL ${rc.total} ACCOUNTED FOR`, tone: 'good', text: 'Everyone on the frozen register has been marked SAFE at the assembly point.', facts: [['Roll call started', zone.fmt(rc.startedAt, 'hm')], ['Safe', rc.safe]] });
    }

    // ---- background jobs ----------------------------------------------------
    // Registered here, started by start() (server.js). Tests run them by name with jobs.run().
    const jobs = new Scheduler({ log, now: () => Date.now() });
    if (!cfg.replica) {
        if (presence.enabledWifi) jobs.every('wifi-poll', presence.cfg.wifiPollMs, () => presence.pollWifi(), { atStart: true });
        // Rules also run when nothing new arrives, so absence is noticed on time; badges age, so republish if they changed.
        jobs.every('presence-rules', 60_000, () => { presence.applyRules(); if (publishRoster()) changed(); });
        jobs.every('presence-prune', 3600_000, () => presence.prune());
    }
    if (hasOutboxSink()) {
        jobs.every('outbox', 15_000, async () => {
            const r = await flushOutbox();
            const failed = Object.entries(r.errors || {});
            return failed.length ? { ok: false, error: failed.map(([k, v]) => `${k}: ${v}`).join('; ') } : r;
        }, { atStart: true });
    }
    if (cfg.backupDir) jobs.every('backup', 10 * 60_000, () => backupIfDue(), { atStart: true });
    /** Nightly at BACKUP_HOUR local time; a failed backup is retried hourly; a missed night (server off) runs at once. */
    async function backupIfDue() {
        const last = store.getSetting('backupStatus');
        const nowIso = clock.iso();
        const target = new Date(Date.parse(localDayStart(nowIso)) + cfg.backupHour * 3600_000).toISOString();
        const lastAgeMs = last ? Date.parse(nowIso) - Date.parse(last.at) : Infinity;
        const due = !last || (last.ok ? (nowIso >= target && last.at < target) || lastAgeMs > 26 * 3600_000 : lastAgeMs > 3600_000);
        if (!due) return { skipped: true };
        const r = await backup();
        return r.ok ? r : { ok: false, error: r.error };
    }

    // ---- health: one list of checks feeds /api/health, /metrics and the admin page ---------
    function healthChecks() {
        const checks = [];
        const add = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail });
        const nowMs = clock.ms();
        const age = (iso) => iso ? Math.round((nowMs - Date.parse(iso)) / 1000) : null;
        try { store.db.prepare('SELECT 1').get(); add('database', true, `${cfg.dataFile} (schema v${store.schemaVersion()})`); } catch (error) { add('database', false, error.message); }
        for (const j of jobs.health()) if (j.lastOk !== null) add(`job:${j.name}`, j.lastOk, j.lastOk ? `ran ${j.lastRun}` : j.lastError);
        if (hasOutboxSink()) {
            const oldest = store.oldestOutboxAt();
            add('outbox', !oldest || age(oldest) < 600, oldest ? `${store.outboxDepth()} waiting, oldest ${age(oldest)} s` : 'empty');
        }
        if (cfg.backupDir) {
            const b = store.getSetting('backupStatus');
            add('backup', b?.ok && age(b.at) < 26 * 3600, b ? (b.ok ? `last ${b.at}` : `failed ${b.at}: ${b.error}`) : 'none yet');
        }
        if (sharepoint.configured) { const s = store.getSetting('sharepointStatus'); if (s) add('sharepoint', s.ok, s.ok ? `pushed ${s.at}` : s.error); }
        if (cfg.teamsWebhookUrl) { const t = store.getSetting('teamsStatus'); if (t) add('teams', t.ok, t.ok ? `posted ${t.at}` : t.error); }
        if (!cfg.replica && presence.enabledWifi && presence.lastWifiPoll) {
            const w = presence.lastWifiPoll;
            add('wifi', w.ok && age(w.at) < 3 * presence.cfg.wifiPollMs / 1000, w.ok ? `${w.count} clients at ${w.at}` : w.error);
        }
        return checks;
    }
    function start() { jobs.start(); return api; }

    // ---- router ------------------------------------------------------------
    async function handle(req, res) {
        const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
        const p = url.pathname; const m = req.method;
        try {
            if (p === '/api/stream' && m === 'GET') return openStream(req, res);
            if (p === '/metrics' && m === 'GET') return send(res, 200, metricsText(), 'text/plain; version=0.0.4; charset=utf-8');
            if (p === '/api/health' && m === 'GET') {
                const checks = healthChecks();
                return send(res, 200, {
                    ok: true, version: VERSION, replica: cfg.replica, startedAt, outbox: store.outboxDepth(), serverTime: clock.iso(),
                    mirror: cfg.mirrorUrl ? { url: cfg.mirrorUrl } : null,
                    teams: cfg.teamsWebhookUrl ? { configured: true, last: store.getSetting('teamsStatus') } : null,
                    publicUrl: cfg.publicUrl || null,
                    backup: cfg.backupDir ? { dir: cfg.backupDir, keep: cfg.backupKeep, last: store.getSetting('backupStatus') } : null,
                    sharepoint: sharepoint.configured ? { ...sharepoint.describe(), last: store.getSetting('sharepointStatus') } : null,
                    // `ok` = the server answers (installers and readers test it); `status` = whether everything behind it works
                    status: checks.every(c => c.ok) ? 'ok' : 'degraded', checks, jobs: jobs.health(),
                    warnings: isAdmin(req) ? warnings : undefined   // config advice is for the admin, not the whole LAN
                });
            }
            if (p === '/api/state' && m === 'GET') return send(res, 200, apiState());
            if (p === '/api/roster' && m === 'GET') return send(res, 200, currentRoster());

            // -- staff sign in / out --
            if (p === '/api/sign' && m === 'POST') {
                const body = await bodyOf(req);
                // A card UID is a device claim (a reader typed or posted it), so it always needs the token.
                const claimed = sourceOf(req, body, body.cardUid ? 'card' : 'kiosk', 'sign');
                if (claimed.error) return fail(res, ...claimed.error);
                const { source } = claimed;
                if (body.cardUid && !hasToken(req, 'sign')) return fail(res, 401, 'API token with the "sign" scope required');
                if (cfg.replica) return fail(res, 409, 'This is a read-only mirror. Sign in on the main server.');
                let person = null;
                if (body.cardUid) {
                    person = store.getPersonByCard(body.cardUid);
                    if (!person) {
                        const uid = normaliseUid(body.cardUid);
                        store.setSetting('lastUnknownCard', { uid, at: clock.iso(), device: deviceOf(req, body) });
                        store.addEvent({ kind: 'unknown_card', at: clock.iso(), source, device: deviceOf(req, body), note: `Unknown card ${uid}` });
                        return fail(res, 404, `Card ${uid} is not assigned to anyone`);
                    }
                } else if (body.personId) {
                    person = store.getPerson(body.personId);
                    if (person && !person.active) person = null;
                }
                if (!person) return fail(res, 404, 'Person not found');
                const direction = ['in', 'out'].includes(body.direction) ? body.direction : null;
                // A reader that buffered a tap while offline replays it with how long ago it happened (it has no clock).
                const ageMs = !HUMAN_SOURCES.has(source) && Number.isFinite(body.ageMs) ? Math.min(Math.max(body.ageMs, 0), 12 * 3600_000) : 0;
                const at = new Date(clock.ms() - ageMs).toISOString();
                const note = [body.note ? clean(body.note, 200) : null, ageMs >= 60_000 ? `delivered ${Math.round(ageMs / 60_000)} min late (reader was offline)` : null].filter(Boolean).join(' · ') || null;
                const { event, duplicate } = signStaff({ person, direction, source, device: deviceOf(req, body), eventKey: body.eventKey ? clean(body.eventKey, 120) : null, note, at });
                return send(res, 200, { event, duplicate, state: apiState() });
            }

            // -- visitors --
            if (p === '/api/visitors' && m === 'POST') {
                if (cfg.replica) return fail(res, 409, 'Read-only mirror');
                const body = await bodyOf(req);
                const claimed = sourceOf(req, body, 'kiosk');
                if (claimed.error) return fail(res, ...claimed.error);
                const name = clean(body.name);
                if (!name) return fail(res, 400, 'Enter the visitor name');
                const host = body.hostId ? store.getPerson(body.hostId) : null;
                const visitor = admitVisitor({ name, company: clean(body.company), host, vehicle: body.vehicle, source: claimed.source, device: deviceOf(req, body) });
                return send(res, 201, { visitor, state: apiState() });
            }
            if (p.startsWith('/api/visitors/') && p.endsWith('/out') && m === 'POST') {
                if (cfg.replica) return fail(res, 409, 'Read-only mirror');
                const id = p.split('/')[3];
                const visitor = store.getVisitor(id);
                if (!visitor) return fail(res, 404, 'Visitor not found');
                if (visitor.signedOutAt) return send(res, 200, { visitor, state: apiState() });
                const body = await bodyOf(req);
                const claimed = sourceOf(req, body, 'kiosk');
                if (claimed.error) return fail(res, ...claimed.error);
                const at = clock.iso();
                const updated = store.signOutVisitor(id, at);
                store.addEvent({ kind: 'out', subjectType: 'visitor', subjectId: id, subjectName: visitor.name, at, source: claimed.source, device: deviceOf(req, body), note: `badge ${visitor.badge}` });
                publishRoster();
                return send(res, 200, { visitor: updated, state: apiState() });
            }
            if (p === '/api/visitors/history' && m === 'GET') {
                if (!requireAdmin(req, res)) return;
                const since = url.searchParams.get('since') || new Date(clock.ms() - 30 * 86400_000).toISOString();
                return send(res, 200, store.listVisitors({ presentOnly: false, since }));
            }

            // -- expected (pre-registered) visitors --
            // The tablet sees today's not-yet-arrived names (same trust as the staff grid it already shows);
            // the 14-day plan and arrived rows need the admin PIN.
            if (p === '/api/expected' && m === 'GET') {
                const today = localDay(clock.iso());
                if (url.searchParams.get('all') === '1') {
                    if (!requireAdmin(req, res)) return;
                    const to = localDay(new Date(clock.ms() + 14 * 86400_000).toISOString());
                    return send(res, 200, store.listExpected({ fromDay: today, toDay: to, includeArrived: true }));
                }
                return send(res, 200, store.listExpected({ day: today }));
            }
            if (p === '/api/expected' && m === 'POST') {
                if (!requireAdmin(req, res)) return;
                if (cfg.replica) return fail(res, 409, 'Read-only mirror');
                const body = await bodyOf(req);
                const name = clean(body.name);
                if (!name) return fail(res, 400, 'Enter the visitor name');
                const day = /^\d{4}-\d{2}-\d{2}$/.test(String(body.day || '')) ? body.day : localDay(clock.iso());
                const host = body.hostId ? store.getPerson(body.hostId) : null;
                const e = store.addExpected({ day, name, company: clean(body.company), host, vehicle: clean(body.vehicle, 16).toUpperCase(), note: clean(body.note, 200) });
                return send(res, 201, { expected: e, list: store.listExpected({ fromDay: localDay(clock.iso()), toDay: localDay(new Date(clock.ms() + 14 * 86400_000).toISOString()), includeArrived: true }) });
            }
            if (p.startsWith('/api/expected/') && m === 'DELETE') {
                if (!requireAdmin(req, res)) return;
                store.deleteExpected(p.split('/')[3]);
                return send(res, 200, { ok: true });
            }
            if (p.startsWith('/api/expected/') && p.endsWith('/arrive') && m === 'POST') {
                if (cfg.replica) return fail(res, 409, 'Read-only mirror');
                const e = store.getExpected(p.split('/')[3]);
                if (!e) return fail(res, 404, 'Expected visitor not found');
                if (e.arrivedVisitorId) return fail(res, 409, 'Already signed in');
                const body = await bodyOf(req);
                const claimed = sourceOf(req, body, 'kiosk');
                if (claimed.error) return fail(res, ...claimed.error);
                const host = e.hostId ? store.getPerson(e.hostId) : null;
                const visitor = admitVisitor({
                    name: e.name, company: e.company, host: host || (e.hostName ? { id: null, name: e.hostName } : null), vehicle: body.vehicle || e.vehicle || '',
                    source: claimed.source, device: deviceOf(req, body), extraNote: 'pre-registered', expectedId: e.id
                });
                return send(res, 201, { visitor, state: apiState() });
            }

            // -- fire roll call --
            if (p === '/api/fire' && m === 'GET') {
                const open = store.openRollcall();
                return send(res, 200, { rollcall: open ? summariseRollcall(open) : null, roster: currentRoster(), fireNotice: store.getSetting('fireNotice'), companyName: store.getSetting('companyName'), replica: cfg.replica });
            }
            if (p === '/api/fire/start' && m === 'POST') {
                // Anyone may START a roll call (over-starting is the safe failure); devices must still prove who they are.
                const body = await bodyOf(req);
                const claimed = sourceOf(req, body, 'fire-page', 'fire');
                if (claimed.error) return fail(res, ...claimed.error);
                const result = fireStart({ startedBy: clean(body.by, 60) || null, source: claimed.source, device: deviceOf(req, body) });
                return send(res, result.alreadyOpen ? 200 : 201, result);
            }
            if (p === '/api/fire/mark' && m === 'POST') {
                const body = await bodyOf(req);
                const open = store.openRollcall();
                if (!open) return fail(res, 409, 'No roll call is running');
                if (!['safe', 'missing', 'clear'].includes(body.status)) return fail(res, 400, 'status must be safe, missing or clear');
                const subjectType = body.subjectType === 'visitor' ? 'visitor' : 'staff';
                const inRoster = (subjectType === 'staff' ? open.roster.staff : open.roster.visitors).find(s => s.id === body.subjectId);
                if (!inRoster) return fail(res, 404, 'That person is not on this roll call');
                const at = clock.iso();
                if (body.status === 'clear') {
                    store.clearRollcallMark(open.id, subjectType, body.subjectId);
                } else {
                    store.markRollcall(open.id, { subjectType, subjectId: body.subjectId, status: body.status, by: clean(body.by, 60) || null, at });
                    store.addEvent({ kind: body.status === 'safe' ? 'safe' : 'missing', subjectType, subjectId: body.subjectId, subjectName: inRoster.name, at, source: 'fire-page', device: deviceOf(req, body), note: body.by ? `marked by ${clean(body.by, 60)}` : null });
                }
                publishRoster();
                const after = summariseRollcall(store.getRollcall(open.id));
                maybeNotifyAllSafe(after);
                return send(res, 200, { rollcall: after });
            }
            if (p === '/api/fire/end' && m === 'POST') {
                const body = await bodyOf(req);
                const open = store.openRollcall();
                if (!open) return fail(res, 409, 'No roll call is running');
                const at = clock.iso();
                const rc = summariseRollcall(store.endRollcall(open.id, at));
                store.addEvent({ kind: 'fire_end', at, source: 'fire-page', device: deviceOf(req, body), subjectName: clean(body.by, 60) || null, note: `Roll call ended: ${rc.safe} safe, ${rc.missing} missing, ${rc.unaccounted} unaccounted of ${rc.total}` });
                publishRoster();
                notifyTeams({
                    title: rc.missing + rc.unaccounted > 0 ? `⚠️ ROLL CALL ENDED — ${rc.missing + rc.unaccounted} NOT ACCOUNTED FOR` : '✅ ROLL CALL ENDED — everyone accounted for',
                    tone: rc.missing + rc.unaccounted > 0 ? 'warning' : 'good', at,
                    text: `${rc.safe} safe, ${rc.missing} missing, ${rc.unaccounted} not seen, of ${rc.total} on the register.`,
                    facts: [
                        ['Ended by', clean(body.by, 60) || '(not given)'], ['Duration', `${Math.max(1, Math.round((Date.parse(at) - Date.parse(rc.startedAt)) / 60000))} min`],
                        ...(rc.missing + rc.unaccounted > 0 ? [['NOT accounted for', nameList(rosterNames(rc, s => s !== 'safe'))]] : []),
                        ['Safe', nameList(rosterNames(rc, s => s === 'safe'))]
                    ]
                });
                return send(res, 200, { rollcall: rc });
            }
            if (p === '/api/fire/history' && m === 'GET') {
                if (!requireAdmin(req, res)) return;
                return send(res, 200, store.listRollcalls(20).map(summariseRollcall));
            }

            // -- presence (v3.4-3.6): BLE scanners post sightings; admin reads state + enrolment candidates --
            if (p === '/api/presence/ble' && m === 'POST') {
                if (!hasToken(req, 'presence')) return fail(res, 401, 'API token with the "presence" scope required');
                if (cfg.replica) return fail(res, 409, 'Read-only mirror');
                const body = await bodyOf(req);
                const result = presence.ingestBle(clean(body.scanner || deviceOf(req, body), 40), Array.isArray(body.sightings) ? body.sightings.slice(0, 500) : []);
                publishRoster();
                return send(res, 200, result);
            }
            if (p === '/api/presence' && m === 'GET') {
                if (!requireAdmin(req, res)) return;
                return send(res, 200, {
                    health: presence.health(), candidates: presence.candidates(),
                    people: staffWithPresence().map(p => ({ id: p.id, name: p.name, signedIn: p.signedIn, lastSource: p.lastSource, hasPhone: p.hasPhone, hasTag: p.hasTag, presence: p.presence }))
                });
            }
            if (p === '/api/presence/poll' && m === 'POST') {
                if (!requireAdmin(req, res)) return;
                return send(res, 200, await presence.pollWifi());
            }

            // -- mirror intake --
            if (p === '/api/mirror' && m === 'POST') {
                if (!hasMirrorToken(req)) return fail(res, 401, 'Mirror token required');
                const body = await bodyOf(req);
                if (body.type === 'roster' && body.roster) {
                    store.setSetting('replicaRoster', { ...body.roster, replica: true, receivedAt: clock.iso() });
                    return send(res, 200, { ok: true });
                }
                return fail(res, 400, 'Unknown mirror payload');
            }

            // -- admin session --
            if (p === '/api/admin/login' && m === 'POST') {
                if (!cfg.adminPin) return send(res, 200, { ok: true, open: true });
                const tooMany = () => send(res, 429, { error: 'Too many wrong PINs from this device. Try again later.' }, undefined, { 'Retry-After': String(Math.ceil(lockout.windowMs / 1000)) });
                if (adminLocked(req)) return tooMany();
                const { pin } = await bodyOf(req);
                if (!pin || !safeEqual(String(pin), cfg.adminPin)) {
                    if (pin) missPin(req);
                    return adminLocked(req) ? tooMany() : fail(res, 401, 'Wrong PIN');
                }
                const tok = randomUUID() + randomUUID();
                sessions.set(tok, Date.now() + SESSION_MS);
                audit(req, 'admin logged in');
                return send(res, 200, { ok: true }, undefined, { 'Set-Cookie': `si_admin=${tok}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}` });
            }
            if (p === '/api/admin/logout' && m === 'POST') {
                sessions.delete(cookieOf(req, 'si_admin'));
                return send(res, 200, { ok: true }, undefined, { 'Set-Cookie': 'si_admin=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
            }

            // -- admin --
            if (p.startsWith('/api/people') || p.startsWith('/api/devices') || p === '/api/company' || p === '/api/fire-notice' || p === '/api/export' || p === '/api/events' || p === '/api/stale/close' || p === '/api/mirror/flush' || p === '/api/backup') {
                if (!requireAdmin(req, res)) return;
                if (cfg.replica && m !== 'GET') return fail(res, 409, 'Read-only mirror');
            }
            if (p === '/api/backup' && m === 'POST') { const r = await backup(); audit(req, `backup taken by hand: ${r.ok ? r.file : 'FAILED ' + (r.error || r.reason)}`); return send(res, 200, r); }
            if (p === '/api/devices' && m === 'GET') return send(res, 200, store.listDevices());
            if (p === '/api/devices' && m === 'POST') {
                const body = await bodyOf(req);
                const name = clean(body.name, 40);
                if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name)) return fail(res, 400, 'Name the device with letters, digits, dot, dash or underscore (e.g. back-door-reader)');
                const scopes = (Array.isArray(body.scopes) ? body.scopes : []).filter(s => SCOPES.includes(s));
                if (!scopes.length) return fail(res, 400, `Give the device at least one scope: ${SCOPES.join(', ')}`);
                const existing = store.getDeviceByName(name);
                if (existing && !existing.revokedAt) return fail(res, 409, `A device called ${name} already has a token; revoke it first`);
                if (existing) store.retireDeviceName(name, clock.iso());
                const { device, token } = store.addDevice({ name, role: clean(body.role || 'device', 20), scopes, at: clock.iso() });
                audit(req, `device token issued: ${name} (${scopes.join(', ')})`);
                return send(res, 201, { device, token, note: 'Shown once. Put it in the device config (API_TOKEN / SIGNIN_TOKEN / KIOSK_CARD_TOKEN).' });
            }
            if (p.startsWith('/api/devices/') && m === 'DELETE') {
                const d = store.revokeDevice(p.split('/')[3], clock.iso());
                if (!d) return fail(res, 404, 'Device not found');
                audit(req, `device token revoked: ${d.name}`);
                return send(res, 200, d);
            }
            if (p === '/api/people' && m === 'GET') return send(res, 200, store.listPeople(url.searchParams.get('all') === '1'));
            if (p === '/api/people' && m === 'POST') {
                const { name } = await bodyOf(req);
                const cleanName = clean(name);
                if (!cleanName) return fail(res, 400, 'Enter a name');
                // A card swiped while this box had focus types its number + Enter; that is never a person's name.
                if (/^[0-9a-f:\- ]{8,}$/i.test(cleanName) && /\d/.test(cleanName)) return fail(res, 400, 'That looks like a card number, not a name. To assign a card, use the card box on the person.');
                store.addPerson(cleanName);
                audit(req, `person added: ${cleanName}`);
                return send(res, 201, apiState());
            }
            if (p.startsWith('/api/people/') && (m === 'PATCH' || m === 'DELETE')) {
                const id = p.split('/')[3];
                const person = store.getPerson(id);
                if (!person) return fail(res, 404, 'Person not found');
                if (m === 'DELETE') { store.updatePerson(id, { active: false }); audit(req, `person removed: ${person.name}`); publishRoster(); return send(res, 200, apiState()); }
                const body = await bodyOf(req);
                const patch = {};
                if (body.name !== undefined) { patch.name = clean(body.name); if (!patch.name) return fail(res, 400, 'Enter a name'); }
                if (body.active !== undefined) patch.active = Boolean(body.active);
                if (body.cardUid !== undefined) patch.cardUid = clean(body.cardUid, 40);
                if (body.phoneMac !== undefined) patch.phoneMac = clean(body.phoneMac, 40);
                if (body.tagId !== undefined) patch.tagId = clean(body.tagId, 80);
                // One credential, one active person. A removed person's credential is released so it can be reissued.
                for (const [field, label] of [['cardUid', 'card'], ['phoneMac', 'phone'], ['tagId', 'tag']]) {
                    if (!patch[field]) continue;
                    const owner = store.credentialOwner(field, patch[field]);
                    if (!owner || owner.id === id) continue;
                    if (owner.active) return fail(res, 409, `That ${label} already belongs to ${owner.name}`);
                    store.updatePerson(owner.id, { [field]: null });
                }
                store.updatePerson(id, patch);
                audit(req, `person changed: ${person.name} (${Object.entries(patch).map(([k, v]) => `${k}=${k === 'name' ? v : (v ? 'set' : 'cleared')}`).join(', ')})`);
                if (patch.cardUid) store.setSetting('lastUnknownCard', null);
                return send(res, 200, apiState());
            }
            if (p === '/api/company' && m === 'PUT') {
                const name = clean((await bodyOf(req)).companyName);
                if (!name) return fail(res, 400, 'Enter a company name');
                store.setSetting('companyName', name);
                audit(req, `company name set: ${name}`);
                return send(res, 200, apiState());
            }
            if (p === '/api/fire-notice' && m === 'PUT') {
                const text = clean((await bodyOf(req)).fireNotice, 400);
                if (!text) return fail(res, 400, 'Enter the fire notice text');
                store.setSetting('fireNotice', text);
                audit(req, 'fire notice changed');
                return send(res, 200, apiState());
            }
            if (p === '/api/stale/close' && m === 'POST') {
                const body = await bodyOf(req);
                const note = `Forgotten sign-out closed by admin${body.by ? ' (' + clean(body.by, 60) + ')' : ''}`;
                // "Close all" leaves alone anyone whose phone or tag says they are inside right now: they are not a
                // forgotten sign-out, they simply never tapped. Closing one person by name is the admin's explicit call.
                const candidates = body.visitorId ? [] : staffWithStatus().filter(x => x.stale && (!body.personId || x.id === body.personId));
                const skipped = body.personId ? [] : candidates.filter(x => presence.badge(store.getPerson(x.id))?.state === 'here');
                const stale = candidates.filter(x => !skipped.includes(x));
                for (const s of stale) {
                    // Its own source: a bookkeeping close is not the person walking out, so presence may still sign them back in.
                    signStaff({ person: store.getPerson(s.id), direction: 'out', source: 'stale-close', device: deviceOf(req, body), note });
                }
                const todayStart = localDayStart();
                const staleVisitors = body.personId ? [] : store.listVisitors({ presentOnly: true }).filter(v => v.signedInAt < todayStart && (!body.visitorId || v.id === body.visitorId));
                const at = clock.iso();
                for (const v of staleVisitors) {
                    store.signOutVisitor(v.id, at);
                    store.addEvent({ kind: 'out', subjectType: 'visitor', subjectId: v.id, subjectName: v.name, at, source: 'stale-close', device: deviceOf(req, body), note: `${note} · badge ${v.badge}` });
                }
                if (staleVisitors.length) publishRoster();
                return send(res, 200, { closed: stale.length + staleVisitors.length, skipped: skipped.map(s => s.name), state: apiState() });
            }
            if (p === '/api/events' && m === 'GET') {
                return send(res, 200, store.listEvents({ from: url.searchParams.get('from'), to: url.searchParams.get('to'), limit: Math.min(Number(url.searchParams.get('limit') || 200), 2000) }));
            }
            if (p === '/api/mirror/flush' && m === 'POST') return send(res, 200, await flushOutbox());
            if (p === '/api/export' && m === 'GET') {
                const csv = eventsCsv(url.searchParams.get('from'), url.searchParams.get('to'));
                return send(res, 200, csv, 'text/csv; charset=utf-8', { 'Content-Disposition': `attachment; filename="signin-log-${localDay(clock.iso())}.csv"` });
            }

            // -- static --
            if (m !== 'GET') return fail(res, 405, 'Method not allowed');
            const requested = PAGES[p] || p.slice(1);
            const file = path.resolve(cfg.publicDir, requested);
            if (!file.startsWith(cfg.publicDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(res, 404, 'Not found', 'text/plain; charset=utf-8');
            return send(res, 200, fs.readFileSync(file), MIME[path.extname(file)] || 'application/octet-stream');
        } catch (error) {
            if (error instanceof SyntaxError) return fail(res, 400, 'Request body is not valid JSON');
            if (error.code === 'TOO_LARGE') return fail(res, 413, 'Request too large');
            if (/constraint failed/i.test(error.message || '')) return fail(res, 409, 'That conflicts with an existing record');
            log.error('request failed', { method: m, path: p, error: error.stack || String(error) });
            return fail(res, 500, 'Internal error — see the server log');
        } finally {
            // Any successful write tells every open page to refresh. Scanner chatter and mirror intake are not changes
            // a person can see; presence decisions announce themselves through signStaff.
            if (m !== 'GET' && res.statusCode < 400 && !['/api/presence/ble', '/api/mirror', '/api/admin/login', '/api/admin/logout'].includes(p)) changed();
        }
    }

    const api = {
        handle, start, store, cfg, warnings, log, clock, zone, jobs, healthChecks, presence, flushOutbox, kickFlush, publishRoster, backup, backupIfDue,
        roster, rosterText, metricsText, localDayStart, localDay, fireStart, sharepoint, hasOutboxSink,
        close: () => { jobs.stop(); clearTimeout(flushTimer); clearTimeout(changeTimer); clearInterval(heartbeat); for (const s of streams) s.end(); streams.clear(); store.close(); }
    };
    return api;
}

module.exports = { createApp };
