const { $, esc, fmtWhen, sinceLabel, api, adminPin, startClock, notice } = SI;
const noticeEl = $('#notice');
let state = null;
startClock($('#clock'));

function render(data) {
    state = data;
    $('#company').textContent = `Admin · ${data.companyName}`;
    $('#inCount').textContent = data.inCount;
    $('#companyName').value = data.companyName;
    $('#fireNotice').value = data.fireNotice;
    $('#lastCard').textContent = data.lastUnknownCard ? `${data.lastUnknownCard.uid} (${fmtWhen(data.lastUnknownCard.at)})` : 'none';
    $('#useLastCard').classList.toggle('hidden', !data.lastUnknownCard);

    $('#peopleList').replaceChildren(...data.people.map(p => {
        const row = document.createElement('div');
        row.className = 'person-row';
        row.innerHTML = `<div><b>${esc(p.name)}</b><br><small class="muted">${p.signedIn ? 'Signed in ' + esc(sinceLabel(p.since)) + (p.lastSource ? ' · ' + esc(p.lastSource) : '') : 'Signed out'}</small>${presenceChip(p)}
      <input class="card" placeholder="card UID" value="${p.hasCard ? '' : ''}" data-id="${p.id}" style="margin-top:6px" title="${p.hasCard ? 'A card is assigned. Present a new card to replace it, or type CLEAR to remove.' : 'No card assigned'}">
      <small class="muted">${p.hasCard ? 'card ✓' : 'no card'} · ${p.hasPhone ? 'phone ✓' : 'no phone'} · ${p.hasTag ? 'key tag ✓' : 'no key tag'}</small></div>`;
        const actions = document.createElement('div');
        actions.className = 'row';
        const toggle = document.createElement('button'); toggle.className = 'small'; toggle.textContent = p.signedIn ? 'Sign out' : 'Sign in';
        toggle.onclick = () => api('POST', '/api/sign', { personId: p.id, source: 'admin', note: 'admin correction' }).then(d => render(d.state)).catch(showError);
        const safeLink = document.createElement('button'); safeLink.className = 'small ghost'; safeLink.textContent = "I'm SAFE link";
        safeLink.title = 'Issue (or rotate) this person\'s personal "I\'m SAFE" link for their phone';
        safeLink.onclick = () => {
            if (!confirm(`Issue a new "I'm SAFE" link for ${p.name}? Any earlier link for them stops working.`)) return;
            api('POST', `/api/people/${p.id}/safe-link`, {}).then(d => {
                navigator.clipboard?.writeText(d.link);
                notice(noticeEl, `Link for ${p.name} copied — send it to them privately; they open it once on their phone and add it to the home screen (the key is after the #, which never reaches any server log): ${d.link}`, false, 30000);
            }).catch(showError);
        };
        const remove = document.createElement('button'); remove.className = 'small ghost'; remove.textContent = 'Remove';
        remove.onclick = () => { if (confirm(`Remove ${p.name} from the kiosk? Their history is kept.`)) api('DELETE', `/api/people/${p.id}`).then(render).catch(showError); };
        // v4.1: one click gives this person the card that was tapped last and not recognised (no copy/paste).
        const giveCard = document.createElement('button'); giveCard.className = 'small ghost'; giveCard.textContent = 'Give last tapped card';
        giveCard.classList.toggle('hidden', !data.lastUnknownCard);
        giveCard.onclick = () => {
            const uid = state.lastUnknownCard?.uid; if (!uid) return;
            if (!confirm(`Give card ${uid} (tapped ${fmtWhen(state.lastUnknownCard.at)}) to ${p.name}?`)) return;
            api('PATCH', `/api/people/${p.id}`, { cardUid: uid }).then(d => { render(d); notice(noticeEl, `Card ${uid} assigned to ${p.name}.`); }).catch(showError);
        };
        // v4.1: the person's own in/out history, newest first, folded from the event log.
        const history = document.createElement('button'); history.className = 'small ghost'; history.textContent = 'History';
        const timeline = document.createElement('div'); timeline.className = 'timeline hidden';
        history.onclick = async () => {
            if (!timeline.classList.contains('hidden')) { timeline.classList.add('hidden'); return; }
            try {
                const t = await api('GET', `/api/people/${p.id}/timeline`);
                timeline.innerHTML = t.events.length ? t.events.slice(0, 60).map(e => `<div class="event"><span>${esc(e.kind)} <small class="muted">· ${esc(e.source)}${e.device ? ' · ' + esc(e.device) : ''}${e.note ? ' · ' + esc(e.note) : ''}</small></span><time>${esc(fmtWhen(e.at))}</time></div>`).join('') : '<p class="muted">No history yet.</p>';
                timeline.classList.remove('hidden');
            } catch (error) { showError(error); }
        };
        actions.append(toggle, history, giveCard, safeLink, remove);
        row.append(actions, timeline);
        const cardInput = row.querySelector('input.card');
        cardInput.onkeydown = (e) => {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            const value = cardInput.value.trim();
            api('PATCH', `/api/people/${p.id}`, { cardUid: value.toUpperCase() === 'CLEAR' ? '' : value })
                .then(d => { render(d); notice(noticeEl, `Card ${value.toUpperCase() === 'CLEAR' ? 'cleared' : 'assigned'} for ${p.name}.`); })
                .catch(showError);
        };
        return row;
    }));

    const stale = data.people.filter(p => p.stale);
    const staleVisitors = data.visitors.filter(v => v.stale);
    $('#staleList').innerHTML = stale.length || staleVisitors.length ? '' : '<p class="muted">None.</p>';
    $('#closeStale').classList.toggle('hidden', !stale.length && !staleVisitors.length);
    for (const p of stale) {
        const row = document.createElement('div'); row.className = 'visitor-row';
        row.innerHTML = `<span><b>${esc(p.name)}</b><br><small class="muted">in ${esc(sinceLabel(p.since))}</small></span>`;
        const b = document.createElement('button'); b.className = 'small'; b.textContent = 'Close';
        b.onclick = () => api('POST', '/api/stale/close', { personId: p.id, by: 'admin page' }).then(d => render(d.state)).catch(showError);
        row.append(b); $('#staleList').append(row);
    }
    for (const v of staleVisitors) {
        const row = document.createElement('div'); row.className = 'visitor-row';
        row.innerHTML = `<span><b>${esc(v.name)}</b> (visitor, badge ${v.badge})<br><small class="muted">in ${esc(sinceLabel(v.signedInAt))}</small></span>`;
        const b = document.createElement('button'); b.className = 'small'; b.textContent = 'Close';
        b.onclick = () => api('POST', '/api/stale/close', { visitorId: v.id, by: 'admin page' }).then(d => render(d.state)).catch(showError);
        row.append(b); $('#staleList').append(row);
    }

    $('#visitorList').innerHTML = data.visitors.length ? '' : '<p class="muted">None.</p>';
    for (const v of data.visitors) {
        const row = document.createElement('div'); row.className = 'visitor-row';
        row.innerHTML = `<span><b>${esc(v.name)}</b> badge ${v.badge}<br><small class="muted">${esc([v.company, v.hostName, v.vehicle].filter(Boolean).join(' · '))} · ${esc(sinceLabel(v.signedInAt))}</small></span>`;
        const b = document.createElement('button'); b.className = 'small'; b.textContent = 'Sign out';
        b.onclick = () => api('POST', `/api/visitors/${v.id}/out`, { source: 'admin' }).then(d => render(d.state)).catch(showError);
        row.append(b); $('#visitorList').append(row);
    }
    $('#cardTokenState').textContent = localStorage.getItem('cardToken') ? 'token stored on this device' : 'no token stored';
    $('#exHost').replaceChildren($('#exHost').firstElementChild, ...data.people.map(p => { const o = document.createElement('option'); o.value = p.id; o.textContent = p.name; return o; }));
    if (!$('#exDay').value) $('#exDay').value = localToday();
}

function localToday() {
    const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Chip shown next to a signed-in person: what the phone / key tag say. */
function presenceChip(p) {
    if (!p.signedIn || !p.presence) return '';
    const b = p.presence;
    if (b.state === 'here') return ` <span class="chip green" title="phone or key tag seen inside">📱 here</span>`;
    if (b.state === 'probably-left') return ` <span class="chip amber" title="phone and tag both absent">📵 probably left ${esc(SI.fmtTime(b.lastSeen))}</span>`;
    return ` <span class="chip" title="enrolled but nothing seen yet today">no signal</span>`;
}

/** Presence panel: Wi-Fi/scanner health + tap-to-assign pickers for phones and key tags. */
async function loadPresence() {
    const d = await api('GET', '/api/presence');
    const h = d.health;
    const parts = [];
    parts.push(h.wifi.enabled ? `Wi-Fi brace: <b style="color:var(--in)">on</b> · last poll ${h.wifi.lastPoll ? (h.wifi.lastPoll.ok ? 'ok ' + esc(fmtWhen(h.wifi.lastPoll.at)) + ' (' + h.wifi.lastPoll.count + ' clients)' : '<b style="color:var(--amber)">FAILED</b> ' + esc(h.wifi.lastPoll.error)) : 'not yet'}` : 'Wi-Fi brace: <b style="color:var(--amber)">off</b> (set UNIFI_URL + UNIFI_API_KEY on the server)');
    parts.push(h.scanners.length ? 'BLE scanners: ' + h.scanners.map(s => `<b>${esc(s.name)}</b> ${s.ageS < 120 ? '<span style="color:var(--in)">live</span>' : '<span style="color:var(--amber)">quiet ' + Math.round(s.ageS / 60) + ' min</span>'}`).join(' · ') : 'BLE scanners: none have reported yet');
    if (h.tags.length) parts.push('Key tags: ' + h.tags.map(t => `${esc(t.person)} ${t.ageS === null ? '<span class="muted">never heard</span>' : t.ageS > 7 * 86400 ? '<b style="color:var(--amber)">not heard for ' + Math.round(t.ageS / 86400) + ' days — battery?</b>' : 'heard ' + esc(fmtWhen(t.lastHeard))}`).join(' · '));
    $('#presenceHealth').innerHTML = parts.join('<br>');

    const people = d.people;
    const picker = (items, label, field) => {
        if (!items.length) return `<p class="muted">No unenrolled ${label} seen in the last 10 minutes.</p>`;
        return items.map(it => {
            const id = it.mac || it.ident;
            const sel = `<select data-assign="${field}" data-ident="${esc(id)}"><option value="">assign to…</option>${people.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select>`;
            return `<div class="visitor-row"><span><code>${esc(id)}</code> <small class="muted">${esc(it.hostname || '')} ${it.ap ? '· ' + esc(it.ap) : ''}${it.scanner ? '· heard at ' + esc(it.scanner) : ''} ${it.last ? '· ' + esc(SI.fmtTime(it.last)) : ''}</small></span>${sel}</div>`;
        }).join('');
    };
    $('#phonePicker').innerHTML = picker(d.candidates.phones, 'phones on the office Wi-Fi', 'phoneMac');
    $('#tagPicker').innerHTML = picker(d.candidates.tags, 'key tags', 'tagId');
    document.querySelectorAll('select[data-assign]').forEach(sel => {
        sel.onchange = () => {
            if (!sel.value) return;
            const body = {}; body[sel.dataset.assign] = sel.dataset.ident;
            api('PATCH', `/api/people/${sel.value}`, body).then(() => { notice(noticeEl, `${sel.dataset.assign === 'phoneMac' ? 'Phone' : 'Key tag'} assigned.`); load(); }).catch(showError);
        };
    });
}

function renderExpected(list) {
    const today = localToday();
    $('#expectedCount').textContent = list.filter(e => !e.arrivedVisitorId).length;
    $('#expectedList').innerHTML = list.length ? '' : '<p class="muted">None planned.</p>';
    for (const e of list) {
        const row = document.createElement('div'); row.className = 'visitor-row';
        const when = e.day === today ? 'today' : new Date(e.day + 'T12:00:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
        row.innerHTML = `<span><b>${esc(e.name)}</b> <span class="chip ${e.arrivedVisitorId ? 'green' : (e.day === today ? 'amber' : '')}">${e.arrivedVisitorId ? 'arrived ' + esc(SI.fmtTime(e.arrivedAt)) : when}</span><br>
            <small class="muted">${esc([e.company, e.hostName ? 'visiting ' + e.hostName : null, e.vehicle, e.note].filter(Boolean).join(' · '))}</small></span>`;
        if (!e.arrivedVisitorId) {
            const b = document.createElement('button'); b.className = 'small ghost'; b.textContent = 'Remove';
            b.onclick = () => api('DELETE', `/api/expected/${e.id}`).then(loadExpected).catch(showError);
            row.append(b);
        }
        $('#expectedList').append(row);
    }
}
async function loadExpected() { renderExpected(await api('GET', '/api/expected?all=1')); }

async function loadEvents() {
    const events = await api('GET', '/api/events?limit=100');
    $('#events').replaceChildren(...events.map(e => {
        const item = document.createElement('div'); item.className = 'event';
        const label = { in: 'signed in', out: 'signed out', fire_start: 'ROLL CALL STARTED', fire_end: 'ROLL CALL ENDED', safe: 'marked SAFE', missing: 'marked MISSING', mark_cleared: 'roll-call mark cleared', unknown_card: 'unknown card', unknown_time_tap: 'card tapped while reader was offline (time unknown, not applied)', admin: 'admin:' }[e.kind] || e.kind;
        item.innerHTML = `<span>${e.subjectName ? '<b>' + esc(e.subjectName) + '</b> ' : ''}${esc(label)}${e.subjectType === 'visitor' ? ' (visitor)' : ''} <small class="muted">· ${esc(e.source)}${e.device ? ' · ' + esc(e.device) : ''}${e.note ? ' · ' + esc(e.note) : ''}</small></span><time>${esc(fmtWhen(e.at))}</time>`;
        return item;
    }));
}

function showError(error) {
    if (error.status === 401) { $('#pinPanel').classList.remove('hidden'); notice(noticeEl, 'Admin PIN required.', true); return; }
    notice(noticeEl, error.message, true);
}

async function loadHealth() {
    const h = await api('GET', '/api/health');
    const parts = [];
    if (h.sharepoint) {
        const last = h.sharepoint.last;
        parts.push(`SharePoint → ${esc(h.sharepoint.site)} / ${esc(h.sharepoint.folder)}: ` + (!last ? 'no push yet'
            : last.ok ? `<b style="color:var(--in)">ok</b> at ${esc(fmtWhen(last.at))} (${last.files.length} files)`
                : `<b style="color:var(--amber)">FAILED</b> at ${esc(fmtWhen(last.at))} — ${esc(last.error)}`));
    } else parts.push('SharePoint: not configured (SP_* environment variables)');
    parts.push(h.mirror ? `Mirror → ${esc(h.mirror.url)}` : 'Mirror: not configured');
    if (h.teams) {
        const t = h.teams.last;
        parts.push('Teams channel: ' + (!t ? 'configured, nothing sent yet' : t.ok ? `<b style="color:var(--in)">ok</b> last post ${esc(fmtWhen(t.at))}` : `<b style="color:var(--amber)">FAILED</b> ${esc(fmtWhen(t.at))} — ${esc(t.error)} (retrying)`));
    } else parts.push('Teams channel: not configured (TEAMS_WEBHOOK_URL) — roll-call start / all-safe / end will not be pushed');
    parts.push(`Queued snapshots waiting: ${h.outbox}`);
    if (h.mslist) { const ms = h.mslist.last; parts.push(`Microsoft List "${esc(h.mslist.list)}": ` + (!ms ? 'no sync yet' : ms.ok ? `<b style="color:var(--in)">ok</b> at ${esc(fmtWhen(ms.at))} (${ms.rows} rows)` : `<b style="color:var(--amber)">FAILED</b> at ${esc(fmtWhen(ms.at))} — ${esc(ms.error)}`)); }
    else parts.push('Microsoft List register: not configured (SP_LIST + the SP_* app registration)');
    parts.push(h.retention ? `Retention: ${h.retention.days} days${h.retention.last ? ` · last run ${esc(fmtWhen(h.retention.last.at))}: ${h.retention.last.visitorsAnonymised ?? 0} visitors anonymised, ${h.retention.last.eventsDeleted ?? 0} events deleted` : ''}` : 'Retention: OFF (RETENTION_DAYS) — a data-protection decision owed');
    parts.push(h.tls ? `TLS: on, port ${h.tls.port}` : 'TLS: off (plain HTTP). The offline fire page needs HTTPS.');
    if (!h.backup) parts.push('Backups: off (BACKUP_DIR empty)');
    else if (!h.backup.last) parts.push('Backups: on, none taken yet (first one runs within the hour)');
    else parts.push(`Backups: ${h.backup.last.ok ? '<b style="color:var(--in)">ok</b>' : '<b style="color:var(--amber)">FAILED</b> — ' + esc(h.backup.last.error || '')} at ${esc(fmtWhen(h.backup.last.at))}${h.backup.last.bytes ? ' (' + Math.round(h.backup.last.bytes / 1024) + ' KB)' : ''}${h.backup.last.offsite ? ' · off-site: ' + esc(h.backup.last.offsite) : ''}`);
    if (h.backup?.offbox) { const o = h.backup.offbox.last; parts.push(`Off-box backup → ${esc(h.backup.offbox.target)}: ` + (!o ? 'none pushed yet' : o.ok ? `<b style="color:var(--in)">ok</b> at ${esc(fmtWhen(o.at))}` : `<b style="color:var(--amber)">FAILED</b> at ${esc(fmtWhen(o.at))} — ${esc(o.error)}`)); }
    else if (h.backup) parts.push('Off-box backup: <b style="color:var(--amber)">not configured</b> (BACKUP_PUSH_TARGET) — every copy is on this server\'s own disk');
    if (h.backup?.restoreDrill) { const r = h.backup.restoreDrill; parts.push(`Restore drill: ${r.ok ? `<b style="color:var(--in)">ok</b> ${esc(fmtWhen(r.at))} (${esc(r.file)}, ${r.events} events)` : `<b style="color:var(--amber)">FAILED</b> ${esc(fmtWhen(r.at))} — ${esc(r.error)}`}`); }
    parts.push(h.heartbeat ? `Heartbeat (outside watcher): ${!h.heartbeat.last ? 'not sent yet' : h.heartbeat.last.ok ? `<b style="color:var(--in)">ok</b> ${esc(fmtWhen(h.heartbeat.last.at))}` : `<b style="color:var(--amber)">FAILED</b> — ${esc(h.heartbeat.last.error)}`}` : 'Heartbeat: not configured (HEARTBEAT_URL) — nothing outside notices if this server dies');
    if (h.llm) parts.push(`Assistant model: ${!h.llm.last ? 'not probed yet' : h.llm.last.ok ? '<b style="color:var(--in)">reachable</b>' : `<b style="color:var(--amber)">unreachable</b> — ${esc(h.llm.last.error)}`}`);
    parts.push(`Presence (Wi-Fi/BLE): ${h.presence ? 'on' : 'off (PRESENCE=on to enable)'}`);
    const failing = (h.checks || []).filter(c => !c.ok);
    parts.unshift(failing.length ? `<b style="color:var(--amber)">${failing.length} health check(s) failing:</b> ${failing.map(c => `${esc(c.name)} (${esc(c.detail || '')})`).join(' · ')}` : '<b style="color:var(--in)">All health checks pass.</b>');
    $('#offsiteState').innerHTML = parts.join('<br>');
}

async function load() {
    try {
        render(await api('GET', '/api/state'));
        await loadEvents();
        await loadHealth();
        await loadExpected();
        await loadPresence();
        await loadDevices();
        $('#pinPanel').classList.add('hidden');
    } catch (error) { showError(error); }
}

$('#expectedForm').onsubmit = (e) => {
    e.preventDefault();
    api('POST', '/api/expected', { name: $('#exName').value, company: $('#exCompany').value, hostId: $('#exHost').value, day: $('#exDay').value, vehicle: $('#exVehicle').value, note: $('#exNote').value })
        .then(d => { renderExpected(d.list); for (const id of ['exName', 'exCompany', 'exVehicle', 'exNote']) $('#' + id).value = ''; notice(noticeEl, `${d.expected.name} expected ${d.expected.day}.`); })
        .catch(showError);
};

$('#pinForm').onsubmit = (e) => {
    e.preventDefault();
    // Log in once: the server sets an HttpOnly session cookie, so the PIN is not kept in the browser.
    api('POST', '/api/admin/login', { pin: $('#pin').value })
        .then(() => { sessionStorage.removeItem('adminPin'); $('#pin').value = ''; load(); })
        .catch(showError);
};
$('#logout').onclick = () => api('POST', '/api/admin/logout', {}).then(() => { sessionStorage.removeItem('adminPin'); location.reload(); });

async function loadDevices() {
    const list = await api('GET', '/api/devices');
    $('#deviceList').replaceChildren(...(list.length ? list : [null]).map(d => {
        const row = document.createElement('div'); row.className = 'visitor-row';
        if (!d) { row.innerHTML = '<span class="muted">No per-device tokens yet: devices use the shared API_TOKEN.</span>'; return row; }
        row.innerHTML = `<span><b>${esc(d.name)}</b> <span class="chip ${d.revokedAt ? '' : 'green'}">${d.revokedAt ? 'revoked' : esc(d.scopes.join(' · '))}</span><br>
            <small class="muted">${esc(d.role)} · issued ${esc(fmtWhen(d.createdAt))} · ${d.lastSeenAt ? 'last used ' + esc(fmtWhen(d.lastSeenAt)) : 'never used'}${d.revokedAt ? ' · revoked ' + esc(fmtWhen(d.revokedAt)) : ''}</small></span>`;
        if (!d.revokedAt) {
            const b = document.createElement('button'); b.className = 'small ghost'; b.textContent = 'Revoke';
            b.onclick = () => { if (confirm(`Revoke the token of ${d.name}? It stops working at once.`)) api('DELETE', `/api/devices/${d.id}`).then(loadDevices).catch(showError); };
            row.append(b);
        }
        return row;
    }));
}
$('#deviceForm').onsubmit = (e) => {
    e.preventDefault();
    const scopes = [...document.querySelectorAll('#deviceForm input[name=scope]:checked')].map(c => c.value);
    api('POST', '/api/devices', { name: $('#devName').value, role: $('#devRole').value, scopes })
        .then(d => {
            $('#newToken').classList.remove('hidden');
            $('#newToken').innerHTML = `Token for <b>${esc(d.device.name)}</b> — copy it now, it is not shown again:<br><code style="user-select:all;word-break:break-all">${esc(d.token)}</code>`;
            $('#devName').value = ''; loadDevices();
        })
        .catch(showError);
};

let showingHistory = false;
$('#personForm').onsubmit = (e) => { e.preventDefault(); api('POST', '/api/people', { name: $('#personName').value }).then(d => { render(d); $('#personName').value = ''; }).catch(showError); };
$('#companyForm').onsubmit = (e) => { e.preventDefault(); api('PUT', '/api/company', { companyName: $('#companyName').value }).then(d => { render(d); notice(noticeEl, 'Saved.'); }).catch(showError); };
$('#noticeForm').onsubmit = (e) => { e.preventDefault(); api('PUT', '/api/fire-notice', { fireNotice: $('#fireNotice').value }).then(d => { render(d); notice(noticeEl, 'Saved.'); }).catch(showError); };
$('#closeStale').onclick = () => { if (confirm('Record a sign-out for every forgotten sign-in?')) api('POST', '/api/stale/close', { by: 'admin page' }).then(d => { render(d.state); loadEvents(); notice(noticeEl, `Closed ${d.closed}.${d.skipped?.length ? ` Left signed in (phone or key tag seen inside now): ${d.skipped.join(', ')}.` : ''}`, false, 10000); }).catch(showError); };
$('#useLastCard').onclick = () => { navigator.clipboard?.writeText(state.lastUnknownCard.uid); notice(noticeEl, `Copied ${state.lastUnknownCard.uid} — paste into a staff card box and press Enter.`); };
$('#setCardToken').onclick = () => { const t = prompt('API_TOKEN value from the server (leave blank to clear):', localStorage.getItem('cardToken') || ''); if (t === null) return; if (t) localStorage.setItem('cardToken', t); else localStorage.removeItem('cardToken'); render(state); };
$('#exportCsv').onclick = () => {
    const q = new URLSearchParams();
    if ($('#from').value) q.set('from', new Date($('#from').value).toISOString());
    if ($('#to').value) q.set('to', new Date(new Date($('#to').value).getTime() + 86400_000).toISOString());
    fetch(`/api/export?${q}`, { headers: adminPin.get() ? { 'X-Admin-Pin': adminPin.get() } : {} })
        .then(r => { if (!r.ok) throw new Error('Export refused'); return r.blob(); })
        .then(blob => { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `signin-log.csv`; a.click(); })
        .catch(showError);
};
$('#rollcallHistory').onclick = async () => {
    try {
        const list = await api('GET', '/api/fire/history');
        if (!list.length) return notice(noticeEl, 'No roll calls recorded yet.');
        showingHistory = true;
        $('#events').innerHTML = `<table><tr><th>Started</th><th>Ended</th><th>Type</th><th>By</th><th>Source</th><th>On register</th><th>Safe</th><th>Missing</th><th>Not seen</th><th>All accounted after</th></tr>
      ${list.map(rc => `<tr><td>${esc(fmtWhen(rc.startedAt))}</td><td>${rc.endedAt ? esc(fmtWhen(rc.endedAt)) : '<b>open</b>'}</td><td>${rc.drill ? 'drill' : '<b>roll call</b>'}</td><td>${esc(rc.startedBy || '')}</td><td>${esc(rc.source || '')}</td><td>${rc.total}</td><td>${rc.safe}${rc.selfMarked ? ' <small class="muted">(' + rc.selfMarked + ' self)</small>' : ''}</td><td>${rc.missing}</td><td>${rc.unaccounted}</td><td>${rc.allSafeAt ? Math.max(1, Math.round((Date.parse(rc.allSafeAt) - Date.parse(rc.startedAt)) / 60000)) + ' min' : '—'}</td></tr>`).join('')}</table>
      <p class="muted" style="margin-top:8px">Reload the page to return to the event log.</p>`;
    } catch (error) { showError(error); }
};

load();
$('#askForm').onsubmit = async (e) => {
    e.preventDefault();
    const q = $('#askQ').value.trim(); if (!q) return;
    $('#askState').textContent = 'thinking…'; $('#askA').textContent = '';
    try {
        const r = await api('POST', '/api/ask', { question: q });
        $('#askA').textContent = r.answer;
        $('#askState').textContent = `${r.model} · looked up: ${r.toolCalls.map(t => t.name).join(', ') || 'nothing'}`;
    } catch (error) { $('#askState').textContent = ''; $('#askA').textContent = error.message; }
};
$('#atForm').onsubmit = async (e) => {
    e.preventDefault();
    if (!$('#atWhen').value) return;
    try {
        const r = await api('GET', `/api/register?at=${encodeURIComponent(new Date($('#atWhen').value).toISOString())}`);
        $('#atList').innerHTML = r.onSite.length ? r.onSite.map(p => `<div class="visitor-row"><span><b>${esc(p.name)}</b> <small class="muted">${p.type} · in since ${esc(fmtWhen(p.since))} · ${esc(p.source || '')}</small></span></div>`).join('') : '<p class="muted">Nobody was signed in at that moment.</p>';
    } catch (error) { showError(error); }
};
// Live: refresh when the register changes (not while the PIN form or the roll-call history table is showing).
SI.live(() => { if (!$('#pinPanel').offsetParent && !showingHistory) load(); }, { fallbackMs: 60_000, debounceMs: 1000 });
