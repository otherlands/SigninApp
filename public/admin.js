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
        row.innerHTML = `<div><b>${esc(p.name)}</b><br><small class="muted">${p.signedIn ? 'Signed in ' + esc(sinceLabel(p.since)) : 'Signed out'}</small>
      <input class="card" placeholder="card UID" value="${p.hasCard ? '' : ''}" data-id="${p.id}" style="margin-top:6px" title="${p.hasCard ? 'A card is assigned. Present a new card to replace it, or type CLEAR to remove.' : 'No card assigned'}">
      ${p.hasCard ? '<small class="muted">card assigned</small>' : ''}</div>`;
        const actions = document.createElement('div');
        actions.className = 'row';
        const toggle = document.createElement('button'); toggle.className = 'small'; toggle.textContent = p.signedIn ? 'Sign out' : 'Sign in';
        toggle.onclick = () => api('POST', '/api/sign', { personId: p.id, source: 'admin', note: 'admin correction' }).then(d => render(d.state)).catch(showError);
        const remove = document.createElement('button'); remove.className = 'small ghost'; remove.textContent = 'Remove';
        remove.onclick = () => { if (confirm(`Remove ${p.name} from the kiosk? Their history is kept.`)) api('DELETE', `/api/people/${p.id}`).then(render).catch(showError); };
        actions.append(toggle, remove);
        row.append(actions);
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
    $('#staleList').innerHTML = stale.length ? '' : '<p class="muted">None.</p>';
    $('#closeStale').classList.toggle('hidden', !stale.length);
    for (const p of stale) {
        const row = document.createElement('div'); row.className = 'visitor-row';
        row.innerHTML = `<span><b>${esc(p.name)}</b><br><small class="muted">in ${esc(sinceLabel(p.since))}</small></span>`;
        const b = document.createElement('button'); b.className = 'small'; b.textContent = 'Close';
        b.onclick = () => api('POST', '/api/stale/close', { personId: p.id, by: 'admin page' }).then(d => render(d.state)).catch(showError);
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
}

async function loadEvents() {
    const events = await api('GET', '/api/events?limit=100');
    $('#events').replaceChildren(...events.map(e => {
        const item = document.createElement('div'); item.className = 'event';
        const label = { in: 'signed in', out: 'signed out', fire_start: 'ROLL CALL STARTED', fire_end: 'ROLL CALL ENDED', safe: 'marked SAFE', missing: 'marked MISSING', unknown_card: 'unknown card' }[e.kind] || e.kind;
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
    parts.push(`Queued snapshots waiting: ${h.outbox}`);
    $('#offsiteState').innerHTML = parts.join('<br>');
}

async function load() {
    try {
        render(await api('GET', '/api/state'));
        await loadEvents();
        await loadHealth();
        $('#pinPanel').classList.add('hidden');
    } catch (error) { showError(error); }
}

$('#pinForm').onsubmit = (e) => { e.preventDefault(); adminPin.set($('#pin').value); load(); };
$('#personForm').onsubmit = (e) => { e.preventDefault(); api('POST', '/api/people', { name: $('#personName').value }).then(d => { render(d); $('#personName').value = ''; }).catch(showError); };
$('#companyForm').onsubmit = (e) => { e.preventDefault(); api('PUT', '/api/company', { companyName: $('#companyName').value }).then(d => { render(d); notice(noticeEl, 'Saved.'); }).catch(showError); };
$('#noticeForm').onsubmit = (e) => { e.preventDefault(); api('PUT', '/api/fire-notice', { fireNotice: $('#fireNotice').value }).then(d => { render(d); notice(noticeEl, 'Saved.'); }).catch(showError); };
$('#closeStale').onclick = () => { if (confirm('Record a sign-out for every forgotten sign-in?')) api('POST', '/api/stale/close', { by: 'admin page' }).then(d => { render(d.state); loadEvents(); }).catch(showError); };
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
        $('#events').innerHTML = `<table><tr><th>Started</th><th>Ended</th><th>By</th><th>Source</th><th>On register</th><th>Safe</th><th>Missing</th><th>Not seen</th></tr>
      ${list.map(rc => `<tr><td>${esc(fmtWhen(rc.startedAt))}</td><td>${rc.endedAt ? esc(fmtWhen(rc.endedAt)) : '<b>open</b>'}</td><td>${esc(rc.startedBy || '')}</td><td>${esc(rc.source || '')}</td><td>${rc.total}</td><td>${rc.safe}</td><td>${rc.missing}</td><td>${rc.unaccounted}</td></tr>`).join('')}</table>
      <p class="muted" style="margin-top:8px">Reload the page to return to the event log.</p>`;
    } catch (error) { showError(error); }
};

load();
setInterval(() => { if (!$('#pinPanel').offsetParent) load(); }, 20000);
