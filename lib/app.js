'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, timingSafeEqual } = require('node:crypto');
const { Store, normaliseUid } = require('./store');
const { SharePointSink } = require('./sharepoint');

const MIME = {
    '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
    '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.png': 'image/png'
};
const PAGES = { '/': 'index.html', '/fire': 'fire.html', '/admin': 'admin.html', '/tap': 'tap.html', '/visitor': 'visitor.html' };

function createApp(options = {}) {
    const cfg = {
        dataFile: options.dataFile || path.join(__dirname, '..', 'data', 'signin.sqlite'),
        publicDir: options.publicDir || path.join(__dirname, '..', 'public'),
        adminPin: options.adminPin ?? process.env.ADMIN_PIN ?? '',
        apiToken: options.apiToken ?? process.env.API_TOKEN ?? '',
        mirrorUrl: options.mirrorUrl ?? process.env.MIRROR_URL ?? '',
        mirrorToken: options.mirrorToken ?? process.env.MIRROR_TOKEN ?? '',
        replica: options.replica ?? process.env.REPLICA === '1',
        timeZone: options.timeZone ?? process.env.TZ_NAME ?? 'Europe/London',
        fetch: options.fetch || globalThis.fetch,
        sharepoint: options.sharepoint ?? {
            tenantId: process.env.SP_TENANT_ID, clientId: process.env.SP_CLIENT_ID, clientSecret: process.env.SP_CLIENT_SECRET,
            site: process.env.SP_SITE, drive: process.env.SP_DRIVE, folder: process.env.SP_FOLDER
        }
    };
    const store = new Store(cfg.dataFile);
    const startedAt = new Date().toISOString();
    const sharepoint = new SharePointSink({ ...cfg.sharepoint, fetch: cfg.fetch });
    const hasOutboxSink = () => !cfg.replica && (Boolean(cfg.mirrorUrl) || sharepoint.configured);

    // ---- time helpers ------------------------------------------------
    const dayFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: cfg.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    const csvDate = new Intl.DateTimeFormat('en-GB', { timeZone: cfg.timeZone, dateStyle: 'short' });
    const csvTime = new Intl.DateTimeFormat('en-GB', { timeZone: cfg.timeZone, timeStyle: 'medium' });
    const localDay = (iso) => dayFormatter.format(new Date(iso));
    /** ISO instant of local midnight for the day containing `iso` (works across BST/GMT). */
    function localDayStart(iso = new Date().toISOString()) {
        const day = localDay(iso);
        let guess = new Date(`${day}T00:00:00Z`);
        for (let i = 0; i < 3; i++) {
            const offsetMs = zoneOffsetMs(guess);
            const corrected = new Date(Date.parse(`${day}T00:00:00Z`) - offsetMs);
            if (corrected.getTime() === guess.getTime()) break;
            guess = corrected;
        }
        return guess.toISOString();
    }
    function zoneOffsetMs(date) {
        const parts = new Intl.DateTimeFormat('en-US', { timeZone: cfg.timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
            .formatToParts(date).reduce((acc, p) => (acc[p.type] = p.value, acc), {});
        const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
        return asUtc - date.getTime();
    }

    // ---- presence / roster ---------------------------------------------
    function staffWithStatus() {
        const todayStart = localDayStart();
        return store.listPeople().map(person => {
            const last = store.latestPresenceEvent(person.id);
            const signedIn = last?.kind === 'in';
            return {
                id: person.id, name: person.name, hasCard: Boolean(person.cardUid), signedIn,
                since: signedIn ? last.at : null, lastSource: last?.source || null,
                stale: signedIn && last.at < todayStart
            };
        });
    }
    function roster() {
        const staff = staffWithStatus().filter(p => p.signedIn);
        const visitors = store.listVisitors({ presentOnly: true });
        return {
            at: new Date().toISOString(),
            staff: staff.map(p => ({ type: 'staff', id: p.id, name: p.name, since: p.since, stale: p.stale })),
            visitors: visitors.map(v => ({ type: 'visitor', id: v.id, name: v.name, company: v.company, hostName: v.hostName, vehicle: v.vehicle, badge: v.badge, since: v.signedInAt })),
            count: staff.length + visitors.length
        };
    }
    function currentRoster() {
        if (cfg.replica) return store.getSetting('replicaRoster', { at: null, staff: [], visitors: [], count: 0, replica: true, stale: true });
        return roster();
    }
    function apiState() {
        const people = staffWithStatus();
        const open = store.openRollcall();
        return {
            companyName: store.getSetting('companyName'),
            fireNotice: store.getSetting('fireNotice'),
            replica: cfg.replica,
            people,
            visitors: store.listVisitors({ presentOnly: true }),
            inCount: people.filter(p => p.signedIn).length + store.listVisitors({ presentOnly: true }).length,
            staleCount: people.filter(p => p.stale).length,
            rollcall: open ? summariseRollcall(open) : null,
            lastUnknownCard: store.getSetting('lastUnknownCard'),
            serverTime: new Date().toISOString()
        };
    }
    function summariseRollcall(rc) {
        const total = rc.roster.staff.length + rc.roster.visitors.length;
        const safe = rc.marks.filter(m => m.status === 'safe').length;
        const missing = rc.marks.filter(m => m.status === 'missing').length;
        return { ...rc, total, safe, missing, unaccounted: total - safe - missing };
    }

    // ---- off-site copies: mirror + SharePoint ------------------------------
    // Every change queues one snapshot per sink. Snapshots supersede each other, so a flush only
    // sends the newest queued item of each type and acknowledges the rest.
    function publishRoster() {
        if (cfg.replica) return;
        if (cfg.mirrorUrl) store.enqueueOutbox({ type: 'roster', roster: roster() });
        if (sharepoint.configured) store.enqueueOutbox({ type: 'sharepoint', at: new Date().toISOString() });
    }
    function rosterText() {
        const r = roster();
        const open = store.openRollcall();
        const when = (iso) => new Intl.DateTimeFormat('en-GB', { timeZone: cfg.timeZone, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
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
        lines.push('STAFF');
        if (!r.staff.length) lines.push('  (none)');
        for (const p of r.staff) lines.push(`  ${p.name}  — in since ${when(p.since)}${p.stale ? '  [signed in before today: may have forgotten to sign out]' : ''}`);
        lines.push('', 'VISITORS');
        if (!r.visitors.length) lines.push('  (none)');
        for (const v of r.visitors) lines.push(`  ${v.name}  — ${[v.company, v.hostName ? 'visiting ' + v.hostName : null, v.vehicle, 'badge ' + v.badge].filter(Boolean).join(', ')} — in since ${when(v.since)}`);
        lines.push('', 'This file is written automatically by the sign-in server after every change.',
            'If it is old, the server may be down: treat the list as "who was inside at that time".');
        return lines.join('\r\n');
    }
    function eventsCsv(from, to) {
        const events = store.listEvents({ from, to, limit: 100_000 }).reverse();
        const lines = ['Date,Time,Type,Name,Action,Source,Device,Note'];
        for (const e of events) {
            const d = new Date(e.at);
            lines.push([csvDate.format(d), csvTime.format(d), e.subjectType || '', e.subjectName || '', e.kind, e.source, e.device || '', e.note || ''].map(csvCell).join(','));
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
    async function flushOutbox() {
        if (!hasOutboxSink()) return { sent: 0, remaining: 0 };
        const items = store.peekOutbox(200);
        const byType = new Map();
        for (const item of items) { if (!byType.has(item.payload.type)) byType.set(item.payload.type, []); byType.get(item.payload.type).push(item); }
        let sent = 0;
        const errors = {};
        for (const [type, group] of byType) {
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
                    store.setSetting('sharepointStatus', { at: new Date().toISOString(), ok: true, files });
                } else {
                    throw new Error(`unknown outbox type ${type}`);
                }
                for (const item of group) store.ackOutbox(item.seq);
                sent++;
            } catch (error) {
                errors[type] = error.message;
                store.failOutbox(newest.seq);
                if (type === 'sharepoint') store.setSetting('sharepointStatus', { at: new Date().toISOString(), ok: false, error: error.message });
            }
        }
        return { sent, remaining: store.outboxDepth(), errors };
    }

    // ---- auth --------------------------------------------------------------
    const safeEqual = (a, b) => {
        const ba = Buffer.from(String(a)); const bb = Buffer.from(String(b));
        return ba.length === bb.length && timingSafeEqual(ba, bb);
    };
    const isAdmin = (req) => !cfg.adminPin || safeEqual(req.headers['x-admin-pin'] || '', cfg.adminPin);
    const hasToken = (req) => !cfg.apiToken || safeEqual(req.headers['x-api-token'] || '', cfg.apiToken);
    const hasMirrorToken = (req) => cfg.mirrorToken ? safeEqual(req.headers['x-api-token'] || '', cfg.mirrorToken) : hasToken(req);

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
            if (text.length > 100_000) throw new Error('Request too large');
        }
        return text ? JSON.parse(text) : {};
    }
    const clean = (v, max = 80) => String(v ?? '').trim().slice(0, max);
    const deviceOf = (req, body) => clean(body.device || req.headers['x-device'] || req.socket?.remoteAddress || 'unknown', 60);
    const csvCell = (v) => `"${String(v ?? '').replaceAll('"', '""')}"`;

    // ---- actions --------------------------------------------------------
    function signStaff({ person, direction, source, device, eventKey, note }) {
        const last = store.latestPresenceEvent(person.id);
        const kind = direction || (last?.kind === 'in' ? 'out' : 'in');
        const { event, duplicate } = store.addEvent({ kind, subjectType: 'staff', subjectId: person.id, subjectName: person.name, source, device, eventKey, note });
        if (!duplicate) publishRoster();
        return { event, duplicate };
    }
    function fireStart({ startedBy, source, device }) {
        const existing = store.openRollcall();
        if (existing) return { rollcall: summariseRollcall(existing), alreadyOpen: true };
        const at = new Date().toISOString();
        const rc = store.startRollcall({ roster: currentRoster(), startedBy, source, at });
        store.addEvent({ kind: 'fire_start', at, source, device, note: `Roll call started (${rc.roster.count} on site)`, subjectName: startedBy || null });
        publishRoster();
        return { rollcall: summariseRollcall(rc), alreadyOpen: false };
    }

    // ---- router ------------------------------------------------------------
    async function handle(req, res) {
        const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
        const p = url.pathname; const m = req.method;
        try {
            if (p === '/api/health' && m === 'GET') {
                return send(res, 200, {
                    ok: true, version: '3.1.0', replica: cfg.replica, startedAt, outbox: store.outboxDepth(), serverTime: new Date().toISOString(),
                    mirror: cfg.mirrorUrl ? { url: cfg.mirrorUrl } : null,
                    sharepoint: sharepoint.configured ? { ...sharepoint.describe(), last: store.getSetting('sharepointStatus') } : null
                });
            }
            if (p === '/api/state' && m === 'GET') return send(res, 200, apiState());
            if (p === '/api/roster' && m === 'GET') return send(res, 200, currentRoster());

            // -- staff sign in / out --
            if (p === '/api/sign' && m === 'POST') {
                const body = await bodyOf(req);
                const source = clean(body.source || 'kiosk', 20);
                if (['card', 'api', 'esp32'].includes(source) && !hasToken(req)) return fail(res, 401, 'API token required');
                if (cfg.replica) return fail(res, 409, 'This is a read-only mirror. Sign in on the main server.');
                let person = null;
                if (body.cardUid) {
                    person = store.getPersonByCard(body.cardUid);
                    if (!person) {
                        const uid = normaliseUid(body.cardUid);
                        store.setSetting('lastUnknownCard', { uid, at: new Date().toISOString(), device: deviceOf(req, body) });
                        store.addEvent({ kind: 'unknown_card', source, device: deviceOf(req, body), note: `Unknown card ${uid}` });
                        return fail(res, 404, `Card ${uid} is not assigned to anyone`);
                    }
                } else if (body.personId) {
                    person = store.getPerson(body.personId);
                    if (person && !person.active) person = null;
                }
                if (!person) return fail(res, 404, 'Person not found');
                const direction = ['in', 'out'].includes(body.direction) ? body.direction : null;
                const { event, duplicate } = signStaff({ person, direction, source, device: deviceOf(req, body), eventKey: body.eventKey ? clean(body.eventKey, 120) : null, note: body.note ? clean(body.note, 200) : null });
                return send(res, 200, { event, duplicate, state: apiState() });
            }

            // -- visitors --
            if (p === '/api/visitors' && m === 'POST') {
                if (cfg.replica) return fail(res, 409, 'Read-only mirror');
                const body = await bodyOf(req);
                const name = clean(body.name);
                if (!name) return fail(res, 400, 'Enter the visitor name');
                const host = body.hostId ? store.getPerson(body.hostId) : null;
                const at = new Date().toISOString();
                const visitor = store.addVisitor({ name, company: clean(body.company), host, vehicle: clean(body.vehicle, 16).toUpperCase(), badge: store.nextBadge(localDayStart(at)), at });
                store.addEvent({ kind: 'in', subjectType: 'visitor', subjectId: visitor.id, subjectName: visitor.name, at, source: clean(body.source || 'kiosk', 20), device: deviceOf(req, body), note: [visitor.company, host ? `visiting ${host.name}` : null, `badge ${visitor.badge}`].filter(Boolean).join(' · ') });
                publishRoster();
                return send(res, 201, { visitor, state: apiState() });
            }
            if (p.startsWith('/api/visitors/') && p.endsWith('/out') && m === 'POST') {
                if (cfg.replica) return fail(res, 409, 'Read-only mirror');
                const id = p.split('/')[3];
                const visitor = store.getVisitor(id);
                if (!visitor) return fail(res, 404, 'Visitor not found');
                if (visitor.signedOutAt) return send(res, 200, { visitor, state: apiState() });
                const body = await bodyOf(req);
                const at = new Date().toISOString();
                const updated = store.signOutVisitor(id, at);
                store.addEvent({ kind: 'out', subjectType: 'visitor', subjectId: id, subjectName: visitor.name, at, source: clean(body.source || 'kiosk', 20), device: deviceOf(req, body), note: `badge ${visitor.badge}` });
                publishRoster();
                return send(res, 200, { visitor: updated, state: apiState() });
            }
            if (p === '/api/visitors/history' && m === 'GET') {
                if (!isAdmin(req)) return fail(res, 401, 'Admin PIN required');
                const since = url.searchParams.get('since') || new Date(Date.now() - 30 * 86400_000).toISOString();
                return send(res, 200, store.listVisitors({ presentOnly: false, since }));
            }

            // -- fire roll call --
            if (p === '/api/fire' && m === 'GET') {
                const open = store.openRollcall();
                return send(res, 200, { rollcall: open ? summariseRollcall(open) : null, roster: currentRoster(), fireNotice: store.getSetting('fireNotice'), companyName: store.getSetting('companyName'), replica: cfg.replica });
            }
            if (p === '/api/fire/start' && m === 'POST') {
                const body = await bodyOf(req);
                const source = clean(body.source || 'fire-page', 30);
                if (['alarm', 'webhook', 'esp32', 'api'].includes(source) && !hasToken(req)) return fail(res, 401, 'API token required');
                const result = fireStart({ startedBy: clean(body.by, 60) || null, source, device: deviceOf(req, body) });
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
                const at = new Date().toISOString();
                if (body.status === 'clear') {
                    store.db.prepare('DELETE FROM rollcall_marks WHERE rollcall_id = ? AND subject_type = ? AND subject_id = ?').run(open.id, subjectType, body.subjectId);
                } else {
                    store.markRollcall(open.id, { subjectType, subjectId: body.subjectId, status: body.status, by: clean(body.by, 60) || null, at });
                    store.addEvent({ kind: body.status === 'safe' ? 'safe' : 'missing', subjectType, subjectId: body.subjectId, subjectName: inRoster.name, at, source: 'fire-page', device: deviceOf(req, body), note: body.by ? `marked by ${clean(body.by, 60)}` : null });
                }
                publishRoster();
                return send(res, 200, { rollcall: summariseRollcall(store.getRollcall(open.id)) });
            }
            if (p === '/api/fire/end' && m === 'POST') {
                const body = await bodyOf(req);
                const open = store.openRollcall();
                if (!open) return fail(res, 409, 'No roll call is running');
                const at = new Date().toISOString();
                const rc = summariseRollcall(store.endRollcall(open.id, at));
                store.addEvent({ kind: 'fire_end', at, source: 'fire-page', device: deviceOf(req, body), subjectName: clean(body.by, 60) || null, note: `Roll call ended: ${rc.safe} safe, ${rc.missing} missing, ${rc.unaccounted} unaccounted of ${rc.total}` });
                publishRoster();
                return send(res, 200, { rollcall: rc });
            }
            if (p === '/api/fire/history' && m === 'GET') {
                if (!isAdmin(req)) return fail(res, 401, 'Admin PIN required');
                return send(res, 200, store.listRollcalls(20).map(summariseRollcall));
            }

            // -- mirror intake --
            if (p === '/api/mirror' && m === 'POST') {
                if (!hasMirrorToken(req)) return fail(res, 401, 'Mirror token required');
                const body = await bodyOf(req);
                if (body.type === 'roster' && body.roster) {
                    store.setSetting('replicaRoster', { ...body.roster, replica: true, receivedAt: new Date().toISOString() });
                    return send(res, 200, { ok: true });
                }
                return fail(res, 400, 'Unknown mirror payload');
            }

            // -- admin --
            if (p.startsWith('/api/people') || p === '/api/company' || p === '/api/fire-notice' || p === '/api/export' || p === '/api/events' || p === '/api/stale/close' || p === '/api/mirror/flush') {
                if (!isAdmin(req)) return fail(res, 401, 'Admin PIN required');
                if (cfg.replica && m !== 'GET') return fail(res, 409, 'Read-only mirror');
            }
            if (p === '/api/people' && m === 'GET') return send(res, 200, store.listPeople(url.searchParams.get('all') === '1'));
            if (p === '/api/people' && m === 'POST') {
                const { name } = await bodyOf(req);
                const cleanName = clean(name);
                if (!cleanName) return fail(res, 400, 'Enter a name');
                store.addPerson(cleanName);
                return send(res, 201, apiState());
            }
            if (p.startsWith('/api/people/') && (m === 'PATCH' || m === 'DELETE')) {
                const id = p.split('/')[3];
                const person = store.getPerson(id);
                if (!person) return fail(res, 404, 'Person not found');
                if (m === 'DELETE') { store.updatePerson(id, { active: false }); publishRoster(); return send(res, 200, apiState()); }
                const body = await bodyOf(req);
                const patch = {};
                if (body.name !== undefined) { patch.name = clean(body.name); if (!patch.name) return fail(res, 400, 'Enter a name'); }
                if (body.cardUid !== undefined) {
                    patch.cardUid = clean(body.cardUid, 40);
                    if (patch.cardUid) {
                        const owner = store.getPersonByCard(patch.cardUid);
                        if (owner && owner.id !== id) return fail(res, 409, `That card already belongs to ${owner.name}`);
                    }
                }
                if (body.active !== undefined) patch.active = Boolean(body.active);
                store.updatePerson(id, patch);
                if (patch.cardUid) store.setSetting('lastUnknownCard', null);
                return send(res, 200, apiState());
            }
            if (p === '/api/company' && m === 'PUT') {
                const name = clean((await bodyOf(req)).companyName);
                if (!name) return fail(res, 400, 'Enter a company name');
                store.setSetting('companyName', name);
                return send(res, 200, apiState());
            }
            if (p === '/api/fire-notice' && m === 'PUT') {
                const text = clean((await bodyOf(req)).fireNotice, 400);
                if (!text) return fail(res, 400, 'Enter the fire notice text');
                store.setSetting('fireNotice', text);
                return send(res, 200, apiState());
            }
            if (p === '/api/stale/close' && m === 'POST') {
                const body = await bodyOf(req);
                const stale = staffWithStatus().filter(x => x.stale && (!body.personId || x.id === body.personId));
                for (const s of stale) {
                    signStaff({ person: store.getPerson(s.id), direction: 'out', source: 'admin', device: deviceOf(req, body), note: `Forgotten sign-out closed by admin${body.by ? ' (' + clean(body.by, 60) + ')' : ''}` });
                }
                return send(res, 200, { closed: stale.length, state: apiState() });
            }
            if (p === '/api/events' && m === 'GET') {
                return send(res, 200, store.listEvents({ from: url.searchParams.get('from'), to: url.searchParams.get('to'), limit: Math.min(Number(url.searchParams.get('limit') || 200), 2000) }));
            }
            if (p === '/api/mirror/flush' && m === 'POST') return send(res, 200, await flushOutbox());
            if (p === '/api/export' && m === 'GET') {
                const csv = eventsCsv(url.searchParams.get('from'), url.searchParams.get('to'));
                return send(res, 200, csv, 'text/csv; charset=utf-8', { 'Content-Disposition': `attachment; filename="signin-log-${localDay(new Date().toISOString())}.csv"` });
            }

            // -- static --
            if (m !== 'GET') return fail(res, 405, 'Method not allowed');
            const requested = PAGES[p] || p.slice(1);
            const file = path.resolve(cfg.publicDir, requested);
            if (!file.startsWith(cfg.publicDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(res, 404, 'Not found', 'text/plain; charset=utf-8');
            return send(res, 200, fs.readFileSync(file), MIME[path.extname(file)] || 'application/octet-stream');
        } catch (error) {
            return fail(res, error instanceof SyntaxError ? 400 : 500, error.message || 'Request failed');
        }
    }

    return { handle, store, cfg, flushOutbox, roster, rosterText, localDayStart, fireStart, sharepoint, hasOutboxSink, close: () => store.close() };
}

module.exports = { createApp };
