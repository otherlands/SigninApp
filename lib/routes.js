'use strict';
// The route table. Handlers receive one `c` (context) built by app.js per request:
//   c.req c.res c.url c.params c.body (parsed JSON for non-GET) c.source (for 'claim:' routes) c.principal c.admin
//   c.send(status, body, type?, headers?)  c.fail(status, message)  c.device()  c.audit(note)
// plus everything in `a` (the app internals) by closure. Order matters only for the static catch-all in app.js.

const { normaliseUid } = require('./store');

function defineRoutes(a) {
    const { store, cfg, clock, zone, presence, sharepoint } = a;
    const clean = a.clean;
    const routes = [];
    const r = (method, path, auth, handler, extra = {}) => routes.push({ method, path, auth, handler, ...extra });
    const DAY = 86400_000;

    // ---- system -----------------------------------------------------------------------------------
    r('GET', '/api/stream', 'public', (c) => a.openStream(c.req, c.res), { summary: 'Server-Sent Events: change notifications' });
    r('GET', '/metrics', 'public', (c) => c.send(200, a.metricsText(), 'text/plain; version=0.0.4; charset=utf-8'), { summary: 'Prometheus exposition, counts only' });
    r('GET', '/api/health', 'public', (c) => {
        const checks = a.healthChecks();
        return c.send(200, {
            ok: true, version: a.VERSION, replica: cfg.replica, startedAt: a.startedAt, outbox: store.outboxDepth(), serverTime: clock.iso(),
            mirror: cfg.mirrorUrl ? { url: cfg.mirrorUrl } : null,
            teams: cfg.teamsWebhookUrl ? { configured: true, last: store.getState('teamsStatus') } : null,
            publicUrl: cfg.publicUrl || null,
            backup: cfg.backupDir ? { dir: cfg.backupDir, keep: cfg.backupKeep, last: store.getState('backupStatus') } : null,
            sharepoint: sharepoint.configured ? { ...sharepoint.describe(), last: store.getState('sharepointStatus') } : null,
            mslist: a.mslist.configured ? { ...a.mslist.describe(), last: store.getState('mslistStatus') } : null,
            retention: cfg.retentionDays ? { days: cfg.retentionDays, last: store.getState('retentionStatus') } : null,
            llm: cfg.llmUrl ? { url: cfg.llmUrl, model: cfg.llmModel } : null,
            tls: a.tls || null,
            status: checks.every(x => x.ok) ? 'ok' : 'degraded', checks, jobs: a.jobs.health(),
            warnings: c.admin ? a.warnings : undefined
        });
    }, { summary: 'Liveness + every health check' });
    r('GET', '/api/routes', 'admin', (c) => c.send(200, a.router.table()), { summary: 'This table' });
    r('GET', '/api/state', 'public', (c) => c.send(200, a.apiState()), { summary: 'Kiosk view' });
    r('GET', '/api/roster', 'public', (c) => c.send(200, a.currentRoster()), { summary: 'Who is on site now' });
    r('GET', '/api/register', 'admin', (c) => {
        const at = c.url.searchParams.get('at');
        if (!at || Number.isNaN(Date.parse(at))) return c.fail(400, 'Give ?at=<ISO instant>');
        return c.send(200, { at: new Date(at).toISOString(), onSite: store.registerAt(new Date(at).toISOString()) });
    }, { summary: 'Time travel: who was signed in at an instant (folded from the event log)' });

    // ---- staff attendance ----------------------------------------------------------------------------
    r('POST', '/api/sign', 'claim:sign', (c) => {
        const { body, source } = c;
        if (body.cardUid && !a.hasToken(c.req, 'sign')) return c.fail(401, 'API token with the "sign" scope required');
        let person = null;
        if (body.cardUid) {
            person = store.getPersonByCard(body.cardUid);
            if (!person) {
                const uid = normaliseUid(body.cardUid);
                store.setState('lastUnknownCard', { uid, at: clock.iso(), device: c.device() });
                store.addEvent({ kind: 'unknown_card', at: clock.iso(), source, device: c.device(), note: `Unknown card ${uid}` });
                return c.fail(404, `Card ${uid} is not assigned to anyone`);
            }
        } else if (body.personId) {
            person = store.getPerson(body.personId);
            if (person && !person.active) person = null;
        }
        if (!person) return c.fail(404, 'Person not found');
        // A reader replaying a tap it kept through a power cut cannot say when it happened. Record that the card was
        // tapped, but never toggle today's register on it: a lost tap over-counts (safe), a guessed one under-counts.
        if (body.restored === true && !a.HUMAN_SOURCES.has(source)) {
            const { event, duplicate } = store.addEvent({ kind: 'unknown_time_tap', subjectType: 'staff', subjectId: person.id, subjectName: person.name, at: clock.iso(), source, device: c.device(), eventKey: body.eventKey ? clean(body.eventKey, 120) : null, note: 'card tapped while the reader was cut off; time unknown, register not changed' });
            return c.send(200, { event, duplicate, recorded: 'note-only', state: a.apiState() });
        }
        const direction = ['in', 'out'].includes(body.direction) ? body.direction : null;
        // A reader that buffered a tap while offline replays it with how long ago it happened (it has no clock).
        const ageMs = !a.HUMAN_SOURCES.has(source) && Number.isFinite(body.ageMs) ? Math.min(Math.max(body.ageMs, 0), 12 * 3600_000) : 0;
        const at = new Date(clock.ms() - ageMs).toISOString();
        const note = [body.note ? clean(body.note, 200) : null, ageMs >= 60_000 ? `delivered ${Math.round(ageMs / 60_000)} min late (reader was offline)` : null].filter(Boolean).join(' · ') || null;
        const { event, duplicate } = a.signStaff({ person, direction, source, device: c.device(), eventKey: body.eventKey ? clean(body.eventKey, 120) : null, note, at });
        return c.send(200, { event, duplicate, state: a.apiState() });
    }, { mutates: true, summary: 'Sign a member of staff in/out (toggle unless direction given)' });

    // ---- visitors --------------------------------------------------------------------------------------
    r('POST', '/api/visitors', 'claim:sign', (c) => {
        const name = clean(c.body.name);
        if (!name) return c.fail(400, 'Enter the visitor name');
        const host = c.body.hostId ? store.getPerson(c.body.hostId) : null;
        const visitor = a.admitVisitor({ name, company: clean(c.body.company), host, vehicle: c.body.vehicle, source: c.source, device: c.device(), noticeAcknowledged: c.body.agreed === true });
        return c.send(201, { visitor, state: a.apiState() });
    }, { mutates: true, summary: 'Walk-in visitor sign-in (daily badge number)' });
    r('POST', '/api/visitors/:id/out', 'claim:sign', (c) => {
        const visitor = store.getVisitor(c.params.id);
        if (!visitor) return c.fail(404, 'Visitor not found');
        if (visitor.signedOutAt) return c.send(200, { visitor, state: a.apiState() });
        const at = clock.iso();
        store.addEvent({ kind: 'out', subjectType: 'visitor', subjectId: visitor.id, subjectName: visitor.name, at, source: c.source, device: c.device(), note: `badge ${visitor.badge}` });
        a.publishRoster();
        return c.send(200, { visitor: store.getVisitor(visitor.id), state: a.apiState() });
    }, { mutates: true, summary: 'Visitor sign-out' });
    r('GET', '/api/visitors/history', 'admin', (c) => {
        const since = c.url.searchParams.get('since') || new Date(clock.ms() - 30 * DAY).toISOString();
        return c.send(200, store.listVisitors({ presentOnly: false, since }));
    }, { summary: 'Visitor log (30 days by default)' });

    // ---- expected (pre-registered) visitors -----------------------------------------------------------
    const today = () => zone.day(clock.iso());
    const plan = () => store.listExpected({ fromDay: today(), toDay: zone.day(new Date(clock.ms() + 14 * DAY).toISOString()), includeArrived: true });
    r('GET', '/api/expected', 'public', (c) => {
        if (c.url.searchParams.get('all') === '1') return c.admin ? c.send(200, plan()) : a.denyAdmin(c);
        return c.send(200, store.listExpected({ day: today() }));
    }, { summary: "Today's expected visitors (tablet); ?all=1 + admin: 14-day plan" });
    r('POST', '/api/expected', 'admin', (c) => {
        const name = clean(c.body.name);
        if (!name) return c.fail(400, 'Enter the visitor name');
        const day = /^\d{4}-\d{2}-\d{2}$/.test(String(c.body.day || '')) ? c.body.day : today();
        const host = c.body.hostId ? store.getPerson(c.body.hostId) : null;
        const e = store.addExpected({ day, name, company: clean(c.body.company), host, vehicle: clean(c.body.vehicle, 16).toUpperCase(), note: clean(c.body.note, 200) });
        c.audit(`visitor pre-registered: ${name} for ${day}`);
        return c.send(201, { expected: e, list: plan() });
    }, { mutates: true, summary: 'Pre-register a visitor' });
    r('DELETE', '/api/expected/:id', 'admin', (c) => { store.deleteExpected(c.params.id); return c.send(200, { ok: true }); }, { mutates: true, summary: 'Remove an unarrived plan row' });
    r('POST', '/api/expected/:id/arrive', 'claim:sign', (c) => {
        const e = store.getExpected(c.params.id);
        if (!e) return c.fail(404, 'Expected visitor not found');
        if (e.arrivedVisitorId) return c.fail(409, 'Already signed in');
        const host = e.hostId ? store.getPerson(e.hostId) : null;
        const visitor = a.admitVisitor({
            name: e.name, company: e.company, host: host || (e.hostName ? { id: null, name: e.hostName } : null), vehicle: c.body.vehicle || e.vehicle || '',
            source: c.source, device: c.device(), extraNote: 'pre-registered', expectedId: e.id, noticeAcknowledged: c.body.agreed === true
        });
        return c.send(201, { visitor, state: a.apiState() });
    }, { mutates: true, summary: 'One-tap arrival of a pre-registered visitor' });

    // ---- fire roll call ------------------------------------------------------------------------------
    // Anyone on the LAN may start, tick and end: there is no designated marshal. Every action records its device.
    r('GET', '/api/fire', 'public', (c) => {
        const open = store.openRollcall();
        return c.send(200, { rollcall: open ? a.summariseRollcall(open) : null, roster: a.currentRoster(), fireNotice: store.getSetting('fireNotice'), companyName: store.getSetting('companyName'), replica: cfg.replica, publicUrl: cfg.publicUrl || null });
    }, { summary: 'Open roll call + live roster' });
    r('POST', '/api/fire/start', 'claim:fire', (c) => {
        const result = a.fireStart({ startedBy: clean(c.body.by, 60) || null, source: c.source, device: c.device(), drill: c.body.drill === true });
        return c.send(result.alreadyOpen ? 200 : 201, result);
    }, { summary: 'Start a roll call (idempotent while one is open); {drill:true} for a practice' });
    r('POST', '/api/fire/mark', 'public', (c) => {
        const { body } = c;
        const open = store.openRollcall();
        if (!open) return c.fail(409, 'No roll call is running');
        if (!['safe', 'missing', 'clear'].includes(body.status)) return c.fail(400, 'status must be safe, missing or clear');
        const subjectType = body.subjectType === 'visitor' ? 'visitor' : 'staff';
        const inRoster = (subjectType === 'staff' ? open.roster.staff : open.roster.visitors).find(s => s.id === body.subjectId);
        if (!inRoster) return c.fail(404, 'That person is not on this roll call');
        const via = body.via === 'self' ? 'self' : 'fire-page';
        if (via === 'self' && body.status !== 'safe') return c.fail(400, 'You can only mark yourself SAFE');
        // A tick carries the id of the roll call it was made for; one queued on a phone during an earlier roll call
        // must never land on a later one (that would mark someone SAFE nobody has seen).
        if (body.rollcallId && body.rollcallId !== open.id) return c.fail(409, 'That tick was for an earlier roll call and has been discarded');
        const at = clock.iso();
        const by = via === 'self' ? `${inRoster.name} (self)` : (clean(body.by, 60) || null);
        if (body.status === 'clear') {
            store.clearRollcallMark(open.id, subjectType, body.subjectId);
        } else {
            store.markRollcall(open.id, { subjectType, subjectId: body.subjectId, status: body.status, by, at, via });
            store.addEvent({ kind: body.status === 'safe' ? 'safe' : 'missing', subjectType, subjectId: body.subjectId, subjectName: inRoster.name, at, source: via, device: c.device(), note: by ? `marked by ${by}` : null });
        }
        a.publishRoster();
        const after = a.summariseRollcall(store.getRollcall(open.id));
        a.maybeNotifyAllSafe(after);
        return c.send(200, { rollcall: after });
    }, { summary: 'Mark SAFE / MISSING / clear; {via:"self"} = the person marking themselves' });
    r('POST', '/api/fire/end', 'public', (c) => {
        const open = store.openRollcall();
        if (!open) return c.fail(409, 'No roll call is running');
        const at = clock.iso();
        const rc = a.summariseRollcall(store.endRollcall(open.id, at));
        const kind = rc.drill ? 'DRILL' : 'ROLL CALL';
        store.addEvent({ kind: 'fire_end', at, source: 'fire-page', device: c.device(), subjectName: clean(c.body.by, 60) || null, note: `${rc.drill ? 'Drill' : 'Roll call'} ended: ${rc.safe} safe, ${rc.missing} missing, ${rc.unaccounted} unaccounted of ${rc.total}` });
        a.publishRoster();
        const minutes = Math.max(1, Math.round((Date.parse(at) - Date.parse(rc.startedAt)) / 60000));
        a.notifyTeams({
            title: rc.missing + rc.unaccounted > 0 ? `⚠️ ${kind} ENDED — ${rc.missing + rc.unaccounted} NOT ACCOUNTED FOR` : `✅ ${kind} ENDED — everyone accounted for`,
            tone: rc.missing + rc.unaccounted > 0 ? 'warning' : 'good', at,
            text: `${rc.safe} safe, ${rc.missing} missing, ${rc.unaccounted} not seen, of ${rc.total} on the register.${rc.allSafeAt ? ` All accounted for after ${Math.max(1, Math.round((Date.parse(rc.allSafeAt) - Date.parse(rc.startedAt)) / 60000))} min.` : ''}`,
            facts: [
                ['Ended by', clean(c.body.by, 60) || '(not given)'], ['Duration', `${minutes} min`],
                ...(rc.missing + rc.unaccounted > 0 ? [['NOT accounted for', a.nameList(a.rosterNames(rc, s => s !== 'safe'))]] : []),
                ['Safe', a.nameList(a.rosterNames(rc, s => s === 'safe'))]
            ]
        });
        return c.send(200, { rollcall: rc });
    }, { summary: 'End the roll call; posts the summary card' });
    r('GET', '/api/fire/history', 'admin', (c) => c.send(200, store.listRollcalls(Math.min(Number(c.url.searchParams.get('limit') || 20), 200)).map(a.summariseRollcall)), { summary: 'Past roll calls and drills' });
    r('GET', '/api/me', 'public', (c) => {
        // The self-marking page: who this phone says it is, whether a roll call is open, and whether they are on it.
        const person = c.url.searchParams.get('personId') ? store.getPerson(c.url.searchParams.get('personId')) : null;
        const open = store.openRollcall();
        const onRegister = person && open ? open.roster.staff.find(s => s.id === person.id) : null;
        const mark = onRegister ? open.marks.find(m => m.subjectType === 'staff' && m.subjectId === person.id) : null;
        return c.send(200, { companyName: store.getSetting('companyName'), person: person && person.active ? { id: person.id, name: person.name } : null, rollcall: open ? { id: open.id, startedAt: open.startedAt, drill: open.drill, onRegister: Boolean(onRegister), mark: mark?.status || null } : null, people: store.listPeople().map(p => ({ id: p.id, name: p.name })) });
    }, { summary: 'Self-marking page state' });

    // ---- presence --------------------------------------------------------------------------------------
    r('POST', '/api/presence/ble', 'device:presence', (c) => {
        const result = presence.ingestBle(clean(c.body.scanner || c.device(), 40), Array.isArray(c.body.sightings) ? c.body.sightings.slice(0, 500) : []);
        a.publishRoster();
        return c.send(200, result);
    }, { mutates: true, notify: false, summary: 'Tag scanners post sightings' });
    r('GET', '/api/presence', 'admin', (c) => c.send(200, {
        health: presence.health(), candidates: presence.candidates(),
        people: a.staffWithPresence().map(p => ({ id: p.id, name: p.name, signedIn: p.signedIn, lastSource: p.lastSource, hasPhone: p.hasPhone, hasTag: p.hasTag, presence: p.presence }))
    }), { summary: 'Presence health + enrolment candidates' });
    r('POST', '/api/presence/poll', 'admin', async (c) => c.send(200, await presence.pollWifi()), { summary: 'Force one UniFi poll' });

    // ---- mirror --------------------------------------------------------------------------------------
    r('POST', '/api/mirror', 'mirror', (c) => {
        if (c.body.type === 'roster' && c.body.roster) {
            store.setState('replicaRoster', { ...c.body.roster, replica: true, receivedAt: clock.iso() });
            return c.send(200, { ok: true });
        }
        return c.fail(400, 'Unknown mirror payload');
    }, { notify: false, summary: 'Standby intake' });

    // ---- admin session ---------------------------------------------------------------------------------
    r('POST', '/api/admin/login', 'public', (c) => a.login(c), { notify: false, summary: 'PIN -> HttpOnly session cookie' });
    r('POST', '/api/admin/logout', 'public', (c) => a.logout(c), { notify: false, summary: 'End the session' });

    // ---- admin: people -----------------------------------------------------------------------------------
    r('GET', '/api/people', 'admin', (c) => c.send(200, store.listPeople(c.url.searchParams.get('all') === '1')), { summary: 'Staff list' });
    r('POST', '/api/people', 'admin', (c) => {
        const name = clean(c.body.name);
        if (!name) return c.fail(400, 'Enter a name');
        // A card swiped while this box had focus types its number + Enter; that is never a person's name.
        if (/^[0-9a-f:\- ]{8,}$/i.test(name) && /\d/.test(name)) return c.fail(400, 'That looks like a card number, not a name. To assign a card, use the card box on the person.');
        store.addPerson(name);
        c.audit(`person added: ${name}`);
        return c.send(201, a.apiState());
    }, { mutates: true, summary: 'Add a member of staff' });
    r('GET', '/api/people/:id/timeline', 'admin', (c) => {
        const person = store.getPerson(c.params.id);
        if (!person) return c.fail(404, 'Person not found');
        return c.send(200, { person: { id: person.id, name: person.name }, events: store.timeline('staff', person.id, { from: c.url.searchParams.get('from'), to: c.url.searchParams.get('to'), limit: 500 }) });
    }, { summary: "One person's in/out history" });
    r('PATCH', '/api/people/:id', 'admin', (c) => {
        const person = store.getPerson(c.params.id);
        if (!person) return c.fail(404, 'Person not found');
        const { body } = c; const patch = {};
        if (body.name !== undefined) { patch.name = clean(body.name); if (!patch.name) return c.fail(400, 'Enter a name'); }
        if (body.active !== undefined) patch.active = Boolean(body.active);
        if (body.cardUid !== undefined) patch.cardUid = clean(body.cardUid, 40);
        if (body.phoneMac !== undefined) patch.phoneMac = clean(body.phoneMac, 40);
        if (body.tagId !== undefined) patch.tagId = clean(body.tagId, 80);
        // One credential, one active person. A removed person's credential is released so it can be reissued.
        for (const [field, label] of [['cardUid', 'card'], ['phoneMac', 'phone'], ['tagId', 'tag']]) {
            if (!patch[field]) continue;
            const owner = store.credentialOwner(field, patch[field]);
            if (!owner || owner.id === person.id) continue;
            if (owner.active) return c.fail(409, `That ${label} already belongs to ${owner.name}`);
            store.updatePerson(owner.id, { [field]: null });
        }
        store.updatePerson(person.id, patch);
        c.audit(`person changed: ${person.name} (${Object.entries(patch).map(([k, v]) => `${k}=${k === 'name' ? v : (v ? 'set' : 'cleared')}`).join(', ')})`);
        if (patch.cardUid) store.setState('lastUnknownCard', null);
        return c.send(200, a.apiState());
    }, { mutates: true, summary: 'Rename / assign card, phone, tag / activate' });
    r('DELETE', '/api/people/:id', 'admin', (c) => {
        const person = store.getPerson(c.params.id);
        if (!person) return c.fail(404, 'Person not found');
        store.updatePerson(person.id, { active: false });
        c.audit(`person removed: ${person.name}`);
        a.publishRoster();
        return c.send(200, a.apiState());
    }, { mutates: true, summary: 'Remove (deactivate) a member of staff' });

    // ---- admin: devices -------------------------------------------------------------------------------------
    r('GET', '/api/devices', 'admin', (c) => c.send(200, store.listDevices()), { summary: 'Device tokens (never the token itself)' });
    r('POST', '/api/devices', 'admin', (c) => {
        const name = clean(c.body.name, 40);
        if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name)) return c.fail(400, 'Name the device with letters, digits, dot, dash or underscore (e.g. back-door-reader)');
        const scopes = (Array.isArray(c.body.scopes) ? c.body.scopes : []).filter(s => a.SCOPES.includes(s));
        if (!scopes.length) return c.fail(400, `Give the device at least one scope: ${a.SCOPES.join(', ')}`);
        const existing = store.getDeviceByName(name);
        if (existing && !existing.revokedAt) return c.fail(409, `A device called ${name} already has a token; revoke it first`);
        if (existing) store.retireDeviceName(name, clock.iso());
        const { device, token } = store.addDevice({ name, role: clean(c.body.role || 'device', 20), scopes, at: clock.iso() });
        c.audit(`device token issued: ${name} (${scopes.join(', ')})`);
        return c.send(201, { device, token, note: 'Shown once. Put it in the device config (API_TOKEN / SIGNIN_TOKEN / KIOSK_CARD_TOKEN).' });
    }, { mutates: true, summary: 'Issue a scoped device token (shown once)' });
    r('DELETE', '/api/devices/:id', 'admin', (c) => {
        const d = store.revokeDevice(c.params.id, clock.iso());
        if (!d) return c.fail(404, 'Device not found');
        c.audit(`device token revoked: ${d.name}`);
        return c.send(200, d);
    }, { mutates: true, summary: 'Revoke a device token' });

    // ---- admin: settings, hygiene, data -----------------------------------------------------------------------
    r('PUT', '/api/company', 'admin', (c) => {
        const name = clean(c.body.companyName);
        if (!name) return c.fail(400, 'Enter a company name');
        store.setSetting('companyName', name); c.audit(`company name set: ${name}`);
        return c.send(200, a.apiState());
    }, { mutates: true, summary: 'Company name' });
    r('PUT', '/api/fire-notice', 'admin', (c) => {
        const text = clean(c.body.fireNotice, 400);
        if (!text) return c.fail(400, 'Enter the fire notice text');
        store.setSetting('fireNotice', text); store.setSetting('fireNoticeVersion', (store.getSetting('fireNoticeVersion', 0) || 0) + 1); c.audit('fire notice changed');
        return c.send(200, a.apiState());
    }, { mutates: true, summary: 'Fire notice shown to visitors (versioned)' });
    r('POST', '/api/stale/close', 'admin', (c) => {
        const { body } = c;
        const note = `Forgotten sign-out closed by admin${body.by ? ' (' + clean(body.by, 60) + ')' : ''}`;
        // "Close all" leaves alone anyone whose phone or tag says they are inside right now: they are not a
        // forgotten sign-out, they simply never tapped. Closing one person by name is the admin's explicit call.
        const candidates = body.visitorId ? [] : a.staffWithStatus().filter(x => x.stale && (!body.personId || x.id === body.personId));
        const skipped = body.personId ? [] : candidates.filter(x => presence.badge(store.getPerson(x.id))?.state === 'here');
        const stale = candidates.filter(x => !skipped.includes(x));
        for (const s of stale) a.signStaff({ person: store.getPerson(s.id), direction: 'out', source: 'stale-close', device: c.device(), note });
        const todayStart = a.localDayStart();
        const staleVisitors = body.personId ? [] : store.listVisitors({ presentOnly: true }).filter(v => v.signedInAt < todayStart && (!body.visitorId || v.id === body.visitorId));
        const at = clock.iso();
        for (const v of staleVisitors) store.addEvent({ kind: 'out', subjectType: 'visitor', subjectId: v.id, subjectName: v.name, at, source: 'stale-close', device: c.device(), note: `${note} · badge ${v.badge}` });
        if (staleVisitors.length) a.publishRoster();
        if (stale.length + staleVisitors.length) c.audit(`forgotten sign-outs closed: ${[...stale, ...staleVisitors].map(x => x.name).join(', ')}`);
        return c.send(200, { closed: stale.length + staleVisitors.length, skipped: skipped.map(s => s.name), state: a.apiState() });
    }, { mutates: true, summary: 'Close forgotten sign-outs (all, {personId} or {visitorId}); "all" skips people whose signal says they are inside' });
    r('GET', '/api/events', 'admin', (c) => c.send(200, store.listEvents({ from: c.url.searchParams.get('from'), to: c.url.searchParams.get('to'), limit: Math.min(Number(c.url.searchParams.get('limit') || 200), 2000) })), { summary: 'Event log' });
    r('POST', '/api/mirror/flush', 'admin', async (c) => c.send(200, await a.flushOutbox()), { summary: 'Deliver the outbox now' });
    r('POST', '/api/backup', 'admin', async (c) => { const b = await a.backup(); c.audit(`backup taken by hand: ${b.ok ? b.file : 'FAILED ' + (b.error || b.reason)}`); return c.send(200, b); }, { mutates: true, summary: 'Back up now' });
    r('POST', '/api/projections/rebuild', 'admin', (c) => { const drift = store.rebuildProjections(); c.audit(`projections rebuilt (${drift ? 'DRIFT corrected' : 'no drift'})`); return c.send(200, { drift }); }, { mutates: true, summary: 'Refold attendance from the event log; reports drift' });
    r('POST', '/api/retention/run', 'admin', async (c) => c.send(200, await a.runRetention()), { mutates: true, summary: 'Apply the retention policy now' });
    r('GET', '/api/export', 'admin', (c) => c.send(200, a.eventsCsv(c.url.searchParams.get('from'), c.url.searchParams.get('to')), 'text/csv; charset=utf-8', { 'Content-Disposition': `attachment; filename="signin-log-${zone.day(clock.iso())}.csv"` }), { summary: 'CSV export' });
    r('POST', '/api/ask', 'admin', async (c) => {
        if (!a.assistant) return c.fail(503, 'No LLM configured (LLM_URL)');
        const q = clean(c.body.question, 500);
        if (!q) return c.fail(400, 'Ask a question');
        const answer = await a.assistant.ask(q);
        c.audit(`asked the assistant: ${q.slice(0, 80)}`);
        return c.send(200, answer);
    }, { summary: 'Read-only register Q&A on the local LLM (tool calls only; the model never sees the database)' });

    return routes;
}

module.exports = { defineRoutes };
