'use strict';
// Commands: every change to the register goes through one of these. Each runs in ONE transaction (store.withTx), writes
// events (whose projections update in the same transaction), then publishes off-site copies and wakes open pages.
// Routes validate input and call a command; nothing else writes register facts.

function createCommands(d) {
    const { store, clock, zone, clean } = d;
    const after = () => { d.publishRoster(); d.changed(); };

    /** Sign a member of staff in/out (toggle when no direction). Returns { event, duplicate }. */
    function signStaff({ person, direction, source, device, eventKey, note, at = clock.iso() }) {
        const result = store.withTx(() => {
            const last = store.latestPresenceEvent(person.id);
            const kind = direction || (last?.kind === 'in' ? 'out' : 'in');
            return store.addEvent({ kind, subjectType: 'staff', subjectId: person.id, subjectName: person.name, source, device, eventKey, note, at });
        });
        if (!result.duplicate) after();
        return result;
    }

    /** Walk-in and pre-registered arrivals: badge, visitor row, plan row, event — all or nothing. */
    function admitVisitor({ name, company, host, vehicle, source, device, extraNote = null, expectedId = null, noticeAcknowledged = false }) {
        const at = clock.iso();
        const visitor = store.withTx(() => {
            const v = store.addVisitor({ name, company, host, vehicle: clean(vehicle, 16).toUpperCase(), badge: store.nextBadge(zone.dayStart(at)), at });
            if (expectedId) store.markExpectedArrived(expectedId, v.id, at);
            const ack = noticeAcknowledged ? `fire notice v${store.getSetting('fireNoticeVersion', 1) || 1} acknowledged` : null;
            store.addEvent({ kind: 'in', subjectType: 'visitor', subjectId: v.id, subjectName: v.name, at, source, device, note: [v.company, v.hostName ? `visiting ${v.hostName}` : null, `badge ${v.badge}`, extraNote, ack].filter(Boolean).join(' · ') });
            return v;
        });
        after();
        return visitor;
    }

    function signOutVisitor({ visitor, source, device, note }) {
        store.addEvent({ kind: 'out', subjectType: 'visitor', subjectId: visitor.id, subjectName: visitor.name, at: clock.iso(), source, device, note: note || `badge ${visitor.badge}` });
        after();
        return store.getVisitor(visitor.id);
    }

    function startRollcall({ startedBy, source, device, drill = false }) {
        const existing = store.openRollcall();
        if (existing) return { rollcall: d.summariseRollcall(existing), alreadyOpen: true };
        const at = clock.iso();
        const rc = store.withTx(() => {
            const r = store.startRollcall({ roster: d.currentRoster(), startedBy, source, at, drill });
            store.addEvent({ kind: 'fire_start', at, source, device, ref: r.id, actor: startedBy || null, note: `${drill ? 'Drill' : 'Roll call'} started (${r.roster.count} on site)`, subjectName: startedBy || null });
            return r;
        });
        after();
        d.notifyTeams({
            title: drill ? '🟠 FIRE DRILL — ROLL CALL STARTED' : '🚨 FIRE ROLL CALL STARTED', tone: drill ? 'warning' : 'attention', at, selfMark: true,
            text: `${rc.roster.count} on the register (${rc.roster.staff.length} staff, ${rc.roster.visitors.length} visitors). ${drill ? 'This is a practice. ' : ''}If you are OFF SITE stay away and phone in. At the assembly point press "I'm SAFE" on your own phone (your personal shortcut), or open the roll call and tick people SAFE.`,
            facts: [['Started by', startedBy || '(not given)'], ['From', source], ['On the register', rc.roster.count], ['Who', d.nameList(d.rosterNames(rc))]]
        });
        return { rollcall: d.summariseRollcall(rc), alreadyOpen: false };
    }

    /**
     * Mark one person on the open roll call. `via`: fire-page (a marshal), self (the person, proven by key), list (a tick
     * read back from the Microsoft List). Returns the updated summary, or { error: [status, message] }.
     */
    function mark({ rollcall, subjectType, subjectId, status, by, via = 'fire-page', device = null }) {
        const inRoster = (subjectType === 'staff' ? rollcall.roster.staff : rollcall.roster.visitors).find(s => s.id === subjectId);
        if (!inRoster) return { error: [404, 'That person is not on this roll call'] };
        const at = clock.iso();
        if (status === 'clear') store.clearRollcallMark(rollcall.id, subjectType, subjectId, { subjectName: inRoster.name, by, at, via, device });
        else store.markRollcall(rollcall.id, { subjectType, subjectId, subjectName: inRoster.name, status, by, at, via, device, note: by ? `marked by ${by}` : null });
        after();
        const summary = d.summariseRollcall(store.getRollcall(rollcall.id));
        maybeNotifyAllSafe(summary);
        return { rollcall: summary };
    }

    function maybeNotifyAllSafe(rc) {
        if (!rc.allSafe || store.getState('allSafeNotified') === rc.id) return;
        store.setState('allSafeNotified', rc.id);
        d.notifyTeams({ title: `✅ ALL ${rc.total} ACCOUNTED FOR${rc.drill ? ' (drill)' : ''}`, tone: 'good', text: 'Everyone on the frozen register has been marked SAFE.', facts: [['Roll call started', zone.fmt(rc.startedAt, 'hm')], ['Safe', rc.safe], ['Self-marked', rc.selfMarked]] });
    }

    function endRollcall({ by, device }) {
        const open = store.openRollcall();
        if (!open) return { error: [409, 'No roll call is running'] };
        const at = clock.iso();
        const rc = store.withTx(() => {
            const ended = d.summariseRollcall(store.endRollcall(open.id, at));
            store.addEvent({ kind: 'fire_end', at, source: 'fire-page', device, ref: open.id, actor: by || null, subjectName: by || null, note: `${ended.drill ? 'Drill' : 'Roll call'} ended: ${ended.safe} safe, ${ended.missing} missing, ${ended.unaccounted} unaccounted of ${ended.total}` });
            return ended;
        });
        after();
        const kind = rc.drill ? 'DRILL' : 'ROLL CALL';
        const minutes = Math.max(1, Math.round((Date.parse(at) - Date.parse(rc.startedAt)) / 60000));
        d.notifyTeams({
            title: rc.missing + rc.unaccounted > 0 ? `⚠️ ${kind} ENDED — ${rc.missing + rc.unaccounted} NOT ACCOUNTED FOR` : `✅ ${kind} ENDED — everyone accounted for`,
            tone: rc.missing + rc.unaccounted > 0 ? 'warning' : 'good', at,
            text: `${rc.safe} safe, ${rc.missing} missing, ${rc.unaccounted} not seen, of ${rc.total} on the register.${rc.allSafeAt ? ` All accounted for after ${Math.max(1, Math.round((Date.parse(rc.allSafeAt) - Date.parse(rc.startedAt)) / 60000))} min.` : ''}`,
            facts: [
                ['Ended by', by || '(not given)'], ['Duration', `${minutes} min`],
                ...(rc.missing + rc.unaccounted > 0 ? [['NOT accounted for', d.nameList(d.rosterNames(rc, s => s !== 'safe'))]] : []),
                ['Safe', d.nameList(d.rosterNames(rc, s => s === 'safe'))]
            ]
        });
        return { rollcall: rc };
    }

    /** Close forgotten sign-outs. "All" skips staff whose phone/tag says they are inside now. */
    function closeStale({ personId, visitorId, by, device }) {
        const note = `Forgotten sign-out closed by admin${by ? ' (' + clean(by, 60) + ')' : ''}`;
        const candidates = visitorId ? [] : d.staffWithStatus().filter(x => x.stale && (!personId || x.id === personId));
        const skipped = personId ? [] : candidates.filter(x => d.presence().badge(store.getPerson(x.id))?.state === 'here');
        const stale = candidates.filter(x => !skipped.includes(x));
        const todayStart = zone.dayStart(clock.iso());
        const staleVisitors = personId ? [] : store.listVisitors({ presentOnly: true }).filter(v => v.signedInAt < todayStart && (!visitorId || v.id === visitorId));
        const at = clock.iso();
        store.withTx(() => {
            // Its own source: a bookkeeping close is not the person walking out, so presence may still sign them back in.
            for (const s of stale) store.addEvent({ kind: 'out', subjectType: 'staff', subjectId: s.id, subjectName: s.name, at, source: 'stale-close', device, note });
            for (const v of staleVisitors) store.addEvent({ kind: 'out', subjectType: 'visitor', subjectId: v.id, subjectName: v.name, at, source: 'stale-close', device, note: `${note} · badge ${v.badge}` });
        });
        if (stale.length + staleVisitors.length) after();
        return { closed: stale.length + staleVisitors.length, closedNames: [...stale, ...staleVisitors].map(x => x.name), skipped: skipped.map(s => s.name) };
    }

    return { signStaff, admitVisitor, signOutVisitor, startRollcall, mark, maybeNotifyAllSafe, endRollcall, closeStale };
}

module.exports = { createCommands };
