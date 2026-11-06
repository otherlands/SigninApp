'use strict';
// Admin v5 (2026-11-05). One dashboard, six tabs. Every function of the v4 page is kept (PIN session, staff + cards +
// "I'm SAFE" links + history, visitors, forgotten sign-outs, expected visitors, settings, devices & tokens, presence,
// Ask the register, who-was-in-at, event log, CSV export, roll-call history); the register refreshes live over
// /api/stream (SI.live). Everything typed by a person is escaped (esc) before it reaches innerHTML.
const { $, esc, fmtTime, fmtWhen, isToday, api, adminPin, startClock, notice } = SI;
const noticeEl = $('#notice');
const toast = (text, isError = false, ms = 6000, action = null) => notice(noticeEl, text, isError, ms, action);
let state = null, health = null, events = [], expected = [], logKind = '', logView = 'events';
startClock($('#clock'));

// ---------------------------------------------------------------- helpers
const SRC = {
    kiosk: 'door screen', card: 'card', desktop: 'PC', admin: 'admin', esp32: 'back-door reader', 'fire-page': 'fire page',
    self: 'own phone', list: 'Microsoft List', wifi: 'Wi-Fi', ble: 'key tag', 'ble+wifi': 'Wi-Fi + tag', 'stale-close': 'closed by admin',
    visitor: 'visitor screen', webhook: 'wall button', tap: 'phone tap', phone: 'phone app'
};
const srcLabel = (s) => SRC[s] || s || '';
const hue = (name) => { let h = 0; for (const c of String(name)) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
const initials = (name) => { const p = String(name).trim().split(/\s+/); return ((p[0] || '')[0] || '').toUpperCase() + (p.length > 1 ? (p[p.length - 1][0] || '').toUpperCase() : ''); };
const avatar = (name, cls = '') => `<div class="av ${cls}" style="--h:${hue(name)}">${esc(initials(name))}</div>`;
const ago = (iso) => {
    const m = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
    if (m < 1) return 'just now'; if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60); return h < 24 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)}d ${h % 24}h`;
};
const when = (iso) => (isToday(iso) ? fmtTime(iso) : fmtWhen(iso));
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
function localToday() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }

const KIND = {
    in: ['→', 'in', 'signed in'], out: ['←', 'out', 'signed out'], fire_start: ['🔥', 'fire', 'ROLL CALL STARTED'], fire_end: ['🏁', 'fire', 'roll call ended'],
    safe: ['✓', 'safe', 'marked SAFE'], missing: ['!', 'miss', 'marked MISSING'], mark_cleared: ['↺', '', 'roll-call mark cleared'],
    unknown_card: ['💳', 'cardk', 'unknown card tapped'], unknown_time_tap: ['⏳', 'cardk', 'card tapped while the reader was offline (time unknown, not applied)'], admin: ['⚙', 'adm', '']
};
function evRow(e, { fresh = false, noName = false, timeOnly = false } = {}) {
    const [ic, cls, label] = KIND[e.kind] || ['•', '', e.kind];
    const who = !noName && e.subjectName ? `<b>${esc(e.subjectName)}</b> ` : '';
    const what = e.kind === 'admin' ? esc(e.note || 'admin action') : esc(label) + (e.subjectType === 'visitor' ? ' <span class="muted">(visitor)</span>' : '');
    const detail = [srcLabel(e.source), e.device, e.kind === 'admin' ? '' : e.note].filter(Boolean).map(esc).join(' · ');
    const t = timeOnly ? fmtTime(e.at) : when(e.at);
    return `<div class="ev${fresh ? ' fresh' : ''}"><div class="ic ${cls}">${ic}</div><div class="t">${who}${what}${detail ? `<small>${detail}</small>` : ''}</div><time title="${esc(fmtWhen(e.at))}">${esc(t)}</time></div>`;
}
function setLive(ok) { const el = $('#live'); el.className = 'adm-live' + (ok ? '' : ' wait'); el.lastChild.nodeValue = ok ? 'live' : 'reconnecting'; }

// ---------------------------------------------------------------- tabs
const TABS = ['today', 'staff', 'visitors', 'log', 'ask', 'system'];
function showTab(name) {
    if (!TABS.includes(name)) name = 'today';
    document.querySelectorAll('.tab').forEach(s => s.classList.toggle('on', s.dataset.tab === name));
    document.querySelectorAll('#tabs a').forEach(a => a.classList.toggle('on', a.dataset.tab === name));
    if (name === 'log' && logView === 'rollcalls') loadRollcalls();
}
window.addEventListener('hashchange', () => showTab(location.hash.slice(1)));
document.addEventListener('keydown', (e) => {
    if (e.target.closest('input, textarea, select') || e.ctrlKey || e.metaKey || e.altKey) return;
    const n = Number(e.key);
    if (n >= 1 && n <= TABS.length) { location.hash = TABS[n - 1]; return; }
    if (e.key === '/') { const s = document.querySelector('.tab.on .search'); if (s) { e.preventDefault(); s.focus(); } }
});

// ---------------------------------------------------------------- the register (state)
function render(data) {
    const prev = state; state = data;
    $('#company').textContent = data.companyName || 'eRIGHT';
    document.title = `Admin · ${data.companyName || 'Sign in'}`;
    $('#inCount').textContent = data.inCount;
    setField('#companyName', data.companyName); setField('#fireNotice', data.fireNotice);
    renderToday(data, prev);
    renderStaff(data);
    renderVisitors(data);
    $('#cardTokenState').textContent = localStorage.getItem('cardToken') ? 'token stored on this browser' : 'no token stored on this browser';
    const sel = $('#exHost'), cur = sel.value;
    sel.replaceChildren(new Option('—', ''), ...data.people.map(p => new Option(p.name, p.id))); sel.value = cur;
    if (!$('#exDay').value) $('#exDay').value = localToday();
    tabBadges();
}
function setField(sel, value) { const el = $(sel); if (document.activeElement === el || el.dataset.dirty) return; el.value = value ?? ''; }
for (const sel of ['#companyName', '#fireNotice']) $(sel).addEventListener('input', (e) => { e.target.dataset.dirty = '1'; });

function tabBadges() {
    if (!state) return;
    $('#tabStaff').textContent = state.people.filter(p => p.signedIn).length || '';
    const stale = state.staleCount || 0;
    $('#tabVisitors').textContent = stale ? '!' : (state.visitors.length || '');
    $('#tabVisitors').className = stale ? 'warn' : '';
    const bad = health ? (health.checks || []).filter(c => !c.ok).length : 0;
    $('#tabSystem').textContent = bad || ''; $('#tabSystem').className = bad ? 'warn' : '';
}

// ---------------------------------------------------------------- TODAY
function renderToday(d, prev) {
    const staff = d.people;
    const inStaff = staff.filter(p => p.signedIn).sort((a, b) => Date.parse(a.since) - Date.parse(b.since));
    const vis = d.visitors;
    const n = inStaff.length + vis.length;
    $('#kpiOnSite').textContent = n;
    const C = 2 * Math.PI * 52;
    $('#ringArc').style.strokeDashoffset = String(C * (1 - (staff.length ? inStaff.length / staff.length : 0)));
    $('#kpiHeadline').textContent = n === 0 ? 'Nobody is signed in' : (n === 1 ? '1 person in the building' : `${n} people in the building`);
    $('#kpiSub').innerHTML = inStaff.length
        ? `First in today: <b>${esc(inStaff[0].name)}</b> at ${esc(fmtTime(inStaff[0].since))}${d.loneWorker ? ' · <b style="color:var(--amber)">lone worker</b>' : ''}`
        : 'Door screen, cards and PCs update this live.';
    $('#kpiStaffIn').textContent = inStaff.length; $('#kpiStaffAll').textContent = staff.length;
    $('#kpiStack').innerHTML = inStaff.slice(0, 7).map(p => avatar(p.name)).join('') + (inStaff.length > 7 ? `<div class="more">+${inStaff.length - 7}</div>` : '');
    $('#kpiVisitors').textContent = vis.length;
    $('#kpiExpected').innerHTML = d.expectedToday ? `<b>${d.expectedToday}</b> more expected today` : 'none expected today';

    const rc = d.rollcall, fb = $('#fireBanner');
    if (rc) {
        fb.className = 'fire-banner' + (rc.allSafe ? ' safe' : (rc.drill ? ' drill' : ''));
        fb.innerHTML = `<span class="big">${rc.allSafe ? '✅ ALL ACCOUNTED FOR' : (rc.drill ? '🟠 FIRE DRILL in progress' : '🔥 FIRE ROLL CALL in progress')}</span>
            <span class="nums"><span><b>${rc.safe}</b>safe</span><span><b>${rc.missing}</b>missing</span><span><b>${rc.unaccounted}</b>not yet seen</span><span class="muted">of ${rc.total} · started ${esc(fmtTime(rc.startedAt))}</span></span>
            <a class="adm-btn fire" href="/fire">Open roll call →</a>`;
    } else fb.className = 'fire-banner hidden';

    const was = new Set(prev ? [...prev.people.filter(p => p.signedIn).map(p => p.id), ...prev.visitors.map(v => 'v' + v.id)] : []);
    const fresh = (id) => (prev && !was.has(id) ? ' arrive' : '');
    $('#whoGrid').innerHTML = [
        ...inStaff.map(p => `<div class="who${p.stale ? ' stale' : ''}${fresh(p.id)}" title="${esc(p.name)} — signed in ${esc(fmtWhen(p.since))} by ${esc(srcLabel(p.lastSource))}">${avatar(p.name, p.stale ? 'in stale' : 'in')}
            <div style="min-width:0"><div class="nm">${esc(p.name)}${(d.birthdays || []).some(b => b.id === p.id) ? ' 🎂' : ''}</div><div class="tm">${p.stale ? '⚠ since ' + esc(fmtWhen(p.since)) : 'in ' + esc(fmtTime(p.since)) + ' · ' + ago(p.since)} · ${esc(srcLabel(p.lastSource))}</div></div></div>`),
        ...vis.map(v => `<div class="who visitor${fresh('v' + v.id)}" title="Visitor badge ${esc(v.badge)}"><div class="av">${esc(v.badge)}</div>
            <div style="min-width:0"><div class="nm">${esc(v.name)}</div><div class="tm">visitor${v.company ? ' · ' + esc(v.company) : ''}${v.hostName ? ' · for ' + esc(v.hostName) : ''} · in ${esc(fmtTime(v.signedInAt))}</div></div></div>`)
    ].join('') || '<div class="empty">Nobody is signed in right now.</div>';
    const out = staff.filter(p => !p.signedIn);
    $('#whoOut').innerHTML = out.length ? `<span>Not in:</span>${out.map(p => `<span class="p">${esc(p.name)}</span>`).join('')}` : '';
    $('#whoSub').textContent = `${plural(inStaff.length, 'member')} of staff · ${plural(vis.length, 'visitor')}`;
    renderAttention();
}

function renderAttention() {
    const d = state; if (!d) return;
    const rows = [];
    const staleStaff = d.people.filter(p => p.stale), staleVis = d.visitors.filter(v => v.stale);
    if (staleStaff.length + staleVis.length) {
        rows.push(`<div class="att"><div class="ic">⏰</div><div class="tx"><b>${plural(staleStaff.length + staleVis.length, 'forgotten sign-out')}</b> — still signed in from before today, so still on the fire register
            <small>${esc([...staleStaff.map(p => p.name), ...staleVis.map(v => v.name + ' (visitor)')].join(', '))}</small></div>
            <a class="adm-btn" href="#visitors">Review</a><button class="adm-btn warn" data-att="closeAll">Close all</button></div>`);
    }
    const card = d.lastUnknownCard;
    if (card && Date.now() - Date.parse(card.at) < 7 * 86400_000) {
        rows.push(`<div class="att"><div class="ic">💳</div><div class="tx"><b>Card ${esc(card.uid)}</b> was tapped ${esc(when(card.at))} and is not anyone's yet
            <small>${card.device ? 'at ' + esc(card.device) + ' · ' : ''}choose who it belongs to</small></div>
            <select id="attCardWho" aria-label="Give the card to"><option value="">give it to…</option>${d.people.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select>
            <button class="adm-btn go" data-att="giveCard">Give card</button></div>`);
    }
    if (d.loneWorker) rows.push('<div class="att"><div class="ic">🧍</div><div class="tx"><b>Lone worker</b> — only one person is on site<small>Make sure someone knows they are in.</small></div></div>');
    const bad = health ? (health.checks || []).filter(c => !c.ok) : [];
    if (bad.length) {
        rows.push(`<div class="att"><div class="ic">⚠️</div><div class="tx"><b>${plural(bad.length, 'health check')} failing</b><small>${esc(bad.map(c => c.name).join(', '))}</small></div>
            <a class="adm-btn" href="#system">Open System</a></div>`);
    }
    const keepWho = $('#attCardWho')?.value || '';
    $('#attention').classList.toggle('hidden', !rows.length);
    $('#attentionList').innerHTML = rows.join('');
    if (keepWho && $('#attCardWho')) $('#attCardWho').value = keepWho;
    const close = $('#attentionList [data-att=closeAll]'); if (close) close.onclick = closeAllStale;
    const give = $('#attentionList [data-att=giveCard]');
    if (give) give.onclick = () => {
        const id = $('#attCardWho').value, p = state.people.find(x => x.id === id);
        if (!p) return toast('Choose who the card belongs to first.', true);
        giveCard(p);
    };
}

// ---------------------------------------------------------------- STAFF
const openTimelines = new Map();   // personId -> html, so a live refresh keeps an open History open
let staffBirthdays = {};           // personId -> "MM-DD" (admin only; the kiosk never sees this list)
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const bdayLabel = (mmdd) => `${Number(mmdd.slice(3))} ${MONTHS[Number(mmdd.slice(0, 2)) - 1]}`;
function daysUntil(mmdd) {
    const now = new Date(); const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    for (const y of [now.getFullYear(), now.getFullYear() + 1]) {
        let m = Number(mmdd.slice(0, 2)) - 1, dd = Number(mmdd.slice(3));
        if (m === 1 && dd === 29 && new Date(y, 1, 29).getMonth() !== 1) dd = 28;
        const t = new Date(y, m, dd);
        if (t >= today) return Math.round((t - today) / 86400000);
    }
    return 999;
}
function renderBdayNext(d) {
    const el = $('#bdayNext');
    const today = new Set((d.birthdays || []).map(b => b.id));
    const rows = d.people.filter(p => staffBirthdays[p.id] || today.has(p.id))
        .map(p => ({ p, n: today.has(p.id) ? 0 : daysUntil(staffBirthdays[p.id]), when: staffBirthdays[p.id] ? bdayLabel(staffBirthdays[p.id]) : 'today' }))
        .sort((a, b) => a.n - b.n).slice(0, 6);
    el.classList.toggle('hidden', !rows.length);
    el.innerHTML = `<span class="bn-h">🎂 Coming up</span>` + rows.map(r => `<span class="bn${r.n === 0 ? ' now' : ''}"><b>${esc(r.p.name.split(' ')[0])}</b> ${r.n === 0 ? 'today 🎉' : `${esc(r.when)} · ${r.n === 1 ? 'tomorrow' : 'in ' + r.n + ' days'}`}</span>`).join('')
        + `<span class="bn-x">${Object.keys(staffBirthdays).length} of ${d.people.length} birthdays saved</span>`;
}
async function loadBirthdays() {
    try { staffBirthdays = await api('GET', '/api/birthdays'); if (state) renderStaff(state); } catch { }
}
function renderStaff(d) {
    const list = $('#peopleList');
    // Never rebuild under someone typing a card number or choosing a birthday; catch up when they leave the box.
    if (list.contains(document.activeElement) && document.activeElement.matches('input, select')) { list.dataset.pending = '1'; return; }
    delete list.dataset.pending;
    list.replaceChildren(...d.people.map(p => personCard(p, d)));
    applyStaffFilter();
    renderBdayNext(d);
    $('#cardHint').classList.toggle('hidden', !d.lastUnknownCard);
    $('#lastCard').textContent = d.lastUnknownCard ? `${d.lastUnknownCard.uid} · ${fmtWhen(d.lastUnknownCard.at)}${d.lastUnknownCard.device ? ' · ' + d.lastUnknownCard.device : ''}` : 'none';
}
$('#peopleList').addEventListener('focusout', () => setTimeout(() => { if ($('#peopleList').dataset.pending && state) renderStaff(state); }, 50));
function applyStaffFilter() {
    const q = $('#staffSearch').value.trim().toLowerCase();
    document.querySelectorAll('#peopleList .pcard').forEach(c => c.classList.toggle('hidden', Boolean(q) && !c.dataset.name.includes(q)));
}
$('#staffSearch').addEventListener('input', applyStaffFilter);

function personCard(p, d) {
    const el = document.createElement('div');
    el.className = 'pcard' + (p.signedIn ? (p.stale ? ' is-stale' : ' is-in') : '');
    el.dataset.name = p.name.toLowerCase();
    const status = p.signedIn
        ? (p.stale ? `<span class="status stale">⚠ In since ${esc(fmtWhen(p.since))}</span>` : `<span class="status in">● In since ${esc(fmtTime(p.since))} · ${esc(srcLabel(p.lastSource))}</span>`)
        : '<span class="status out">Out</span>';
    const pres = p.signedIn && p.presence
        ? (p.presence.state === 'here' ? '<span class="cred here">📱 seen inside</span>'
            : p.presence.state === 'probably-left' ? `<span class="cred left">📵 probably left ${esc(fmtTime(p.presence.lastSeen))}</span>` : '<span class="cred">no signal yet</span>')
        : '';
    const card = d.lastUnknownCard;
    const bday = (d.birthdays || []).some(b => b.id === p.id);
    const saved = staffBirthdays[p.id] || '';
    el.classList.toggle('is-bday', bday);
    el.innerHTML = `<div class="p-head">${avatar(p.name, 'lg ' + (p.signedIn ? (p.stale ? 'in stale' : 'in') : 'outd'))}
            <div style="min-width:0"><div class="nm">${esc(p.name)}${bday ? ' 🎂' : ''}</div>${status}</div>
            <button class="adm-btn ${p.signedIn ? 'warn' : 'go'} toggle" data-act="toggle">${p.signedIn ? 'Sign out' : 'Sign in'}</button></div>
        <div class="creds"><span class="cred ${p.hasCard ? 'on' : ''}">💳 ${p.hasCard ? 'card' : 'no card'}</span><span class="cred ${p.hasPhone ? 'on' : ''}">📱 ${p.hasPhone ? 'phone' : 'no phone'}</span><span class="cred ${p.hasTag ? 'on' : ''}">🔑 ${p.hasTag ? 'key tag' : 'no tag'}</span>${pres}
            <label class="bday-tick" title="Balloons, ribbons and a Happy Birthday banner on the door screen today; switches itself off at midnight"><input type="checkbox" data-act="bday"${bday ? ' checked' : ''}> 🎂 Celebrate today</label></div>
        <div class="bday-row" title="Saved birthday (day and month only, no year). The door screen celebrates by itself on the day, every year.">
            <span>🎂 Birthday</span>
            <select data-act="bdDay" aria-label="Birthday day for ${esc(p.name)}"><option value="">day</option>${Array.from({ length: 31 }, (_, i) => `<option value="${String(i + 1).padStart(2, '0')}"${saved && Number(saved.slice(3)) === i + 1 ? ' selected' : ''}>${i + 1}</option>`).join('')}</select>
            <select data-act="bdMon" aria-label="Birthday month for ${esc(p.name)}"><option value="">month</option>${MONTHS.map((m, i) => `<option value="${String(i + 1).padStart(2, '0')}"${saved && Number(saved.slice(0, 2)) === i + 1 ? ' selected' : ''}>${m}</option>`).join('')}</select>
            ${saved ? `<span class="bd-saved">✓ ${esc(bdayLabel(saved))} · every year</span><button class="adm-btn ghost bd-clear" data-act="bdClear" title="Forget this birthday">✕</button>` : '<span class="bd-saved muted">not set</span>'}
        </div>
        <input class="card" autocomplete="off" aria-label="Card number for ${esc(p.name)}" placeholder="${p.hasCard ? 'Card set · tap a new one to replace, or CLEAR' : 'Tap a card on the USB reader, then Enter'}">
        <div class="p-actions"><button class="adm-btn" data-act="history">History</button>${card ? `<button class="adm-btn go" data-act="give">Give card ${esc(card.uid)}</button>` : ''}
            <button class="adm-btn" data-act="safe" title="Issue (or rotate) this person's personal &quot;I'm SAFE&quot; link for their phone">I'm SAFE link</button><button class="adm-btn bad" data-act="remove">Remove</button></div>
        <div class="timeline hidden"></div>`;
    const act = (name) => el.querySelector(`[data-act=${name}]`);
    act('toggle').onclick = () => api('POST', '/api/sign', { personId: p.id, source: 'admin', note: 'admin correction' })
        .then(r => { render(r.state); toast(`${p.name} signed ${r.event.kind.toUpperCase()}.`); refreshEvents(); }).catch(showError);
    act('safe').onclick = () => {
        if (!confirm(`Issue a new "I'm SAFE" link for ${p.name}? Any earlier link for them stops working.`)) return;
        api('POST', `/api/people/${p.id}/safe-link`, {}).then(r => {
            navigator.clipboard?.writeText(r.link);
            toast(`Link for ${p.name} copied — send it to them privately; they open it once on their phone and add it to the home screen (the key is after the #, which never reaches any server log). On Android that page also sets up the eRIGHT Door app (download: /app): ${r.link}`, false, 30000);
        }).catch(showError);
    };
    act('remove').onclick = () => { if (confirm(`Remove ${p.name} from the door screen? Their history is kept.`)) api('DELETE', `/api/people/${p.id}`).then(r => { render(r); toast(`${p.name} removed.`); }).catch(showError); };
    act('bday').onchange = (e) => {
        const on = e.target.checked; e.target.blur();
        api('PUT', `/api/people/${p.id}/birthday`, { on }).then(r => {
            render(r);
            toast(on ? `🎉 Happy Birthday ${p.name.split(' ')[0]}! Balloons are up on the door screen until midnight.` : `Birthday celebration for ${p.name} switched off for today.`);
        }).catch(error => { e.target.checked = !on; showError(error); });
    };
    const saveDate = (date) => api('PUT', `/api/people/${p.id}/birthday`, { date }).then(r => {
        staffBirthdays = r.staffBirthdays || {};
        document.activeElement?.blur();
        render(r);
        toast(date ? `🎂 ${p.name}'s birthday saved: ${bdayLabel(date)}. The door screen will celebrate it every year.` : `${p.name}'s birthday removed.`);
    }).catch(showError);
    const pickDate = () => {
        const dd = act('bdDay').value, mm = act('bdMon').value;
        if (dd && mm) saveDate(`${mm}-${dd}`);
    };
    act('bdDay').onchange = pickDate; act('bdMon').onchange = pickDate;
    if (act('bdClear')) act('bdClear').onclick = () => { if (confirm(`Forget ${p.name}'s birthday?`)) saveDate(''); };
    if (act('give')) act('give').onclick = () => giveCard(p);
    const tl = el.querySelector('.timeline');
    const fillTimeline = (t) => {
        const html = t.events.length ? t.events.slice(0, 60).map(e => evRow(e, { noName: true })).join('') : '<div class="empty">No history yet.</div>';
        openTimelines.set(p.id, html); tl.innerHTML = html; tl.classList.remove('hidden');
    };
    if (openTimelines.has(p.id)) { tl.innerHTML = openTimelines.get(p.id); tl.classList.remove('hidden'); }
    act('history').onclick = () => {
        if (!tl.classList.contains('hidden')) { tl.classList.add('hidden'); openTimelines.delete(p.id); return; }
        api('GET', `/api/people/${p.id}/timeline`).then(fillTimeline).catch(showError);
    };
    const input = el.querySelector('input.card');
    input.onkeydown = (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        const value = input.value.trim(); if (!value) return;
        const clear = value.toUpperCase() === 'CLEAR';
        input.blur();
        api('PATCH', `/api/people/${p.id}`, { cardUid: clear ? '' : value })
            .then(r => { render(r); toast(`Card ${clear ? 'cleared' : 'assigned'} for ${p.name}.`); }).catch(showError);
    };
    return el;
}
function giveCard(p) {
    const c = state.lastUnknownCard; if (!c) return;
    if (!confirm(`Give card ${c.uid} (tapped ${fmtWhen(c.at)}) to ${p.name}?`)) return;
    api('PATCH', `/api/people/${p.id}`, { cardUid: c.uid }).then(r => { render(r); toast(`Card ${c.uid} is now ${p.name}'s.`); }).catch(showError);
}
$('#useLastCard').onclick = () => { if (!state?.lastUnknownCard) return; navigator.clipboard?.writeText(state.lastUnknownCard.uid); toast(`Copied ${state.lastUnknownCard.uid}.`); };
$('#personForm').onsubmit = (e) => {
    e.preventDefault();
    api('POST', '/api/people', { name: $('#personName').value }).then(r => { render(r); toast(`${$('#personName').value} added.`); $('#personName').value = ''; }).catch(showError);
};

// ---------------------------------------------------------------- VISITORS
function renderVisitors(d) {
    $('#visitorSub').textContent = d.visitors.length ? plural(d.visitors.length, 'visitor') : '';
    $('#visitorList').replaceChildren(...(d.visitors.length ? d.visitors.map(v => {
        const el = document.createElement('div'); el.className = 'vis';
        el.innerHTML = `<div class="bdg"><small>BADGE</small><b>${esc(v.badge)}</b></div>
            <div class="tx"><div class="nm">${esc(v.name)}${v.stale ? ' <span class="tagc today">since ' + esc(fmtWhen(v.signedInAt)) + '</span>' : ''}</div>
            <small>${esc([v.company, v.hostName ? 'visiting ' + v.hostName : '', v.vehicle].filter(Boolean).join(' · '))}${v.company || v.hostName || v.vehicle ? ' · ' : ''}in ${esc(when(v.signedInAt))} · ${ago(v.signedInAt)}</small></div>
            <button class="adm-btn warn">Sign out</button>`;
        el.querySelector('button').onclick = () => api('POST', `/api/visitors/${v.id}/out`, { source: 'admin' }).then(r => { render(r.state); toast(`${v.name} signed out.`); refreshEvents(); }).catch(showError);
        return el;
    }) : [Object.assign(document.createElement('div'), { className: 'empty', textContent: 'No visitors on site.' })]));

    const staleStaff = d.people.filter(p => p.stale), staleVis = d.visitors.filter(v => v.stale);
    $('#closeStale').classList.toggle('hidden', !staleStaff.length && !staleVis.length);
    const rows = [
        ...staleStaff.map(p => ({ name: p.name, sub: `staff · in since ${fmtWhen(p.since)}`, body: { personId: p.id, by: 'admin page' } })),
        ...staleVis.map(v => ({ name: v.name, sub: `visitor, badge ${v.badge} · in since ${fmtWhen(v.signedInAt)}`, body: { visitorId: v.id, by: 'admin page' } }))
    ];
    $('#staleList').replaceChildren(...(rows.length ? rows.map(r => {
        const el = document.createElement('div'); el.className = 'row-item';
        el.innerHTML = `${avatar(r.name, 'in stale')}<div class="tx"><b>${esc(r.name)}</b><small>${esc(r.sub)}</small></div><button class="adm-btn warn">Close</button>`;
        el.querySelector('button').onclick = () => api('POST', '/api/stale/close', r.body).then(x => { render(x.state); refreshEvents(); toast(`${r.name}: sign-out recorded.`); }).catch(showError);
        return el;
    }) : [Object.assign(document.createElement('div'), { className: 'empty', textContent: '✓ None — everyone signed out properly.' })]));
}
function closeAllStale() {
    if (!confirm('Record a sign-out for every forgotten sign-in?')) return;
    api('POST', '/api/stale/close', { by: 'admin page' }).then(r => {
        render(r.state); refreshEvents();
        toast(`Closed ${r.closed}.${r.skipped?.length ? ` Left signed in (phone or key tag seen inside now): ${r.skipped.join(', ')}.` : ''}`, false, 10000);
    }).catch(showError);
}
$('#closeStale').onclick = closeAllStale;

function renderExpected(list) {
    expected = list;
    const today = localToday();
    $('#expectedCount').textContent = list.filter(e => !e.arrivedVisitorId).length;
    $('#expectedList').replaceChildren(...(list.length ? list.map(e => {
        const el = document.createElement('div'); el.className = 'row-item';
        const day = e.day === today ? 'today' : new Date(e.day + 'T12:00:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
        const tag = e.arrivedVisitorId ? `<span class="tagc done">arrived ${esc(fmtTime(e.arrivedAt))}</span>` : `<span class="tagc ${e.day === today ? 'today' : ''}">${esc(day)}</span>`;
        el.innerHTML = `${avatar(e.name)}<div class="tx"><b>${esc(e.name)}</b>${tag}<small>${esc([e.company, e.hostName ? 'visiting ' + e.hostName : null, e.vehicle, e.note].filter(Boolean).join(' · ')) || '&nbsp;'}</small></div>`;
        if (!e.arrivedVisitorId) {
            const b = document.createElement('button'); b.className = 'adm-btn bad'; b.textContent = 'Remove';
            b.onclick = () => api('DELETE', `/api/expected/${e.id}`).then(loadExpected).catch(showError);
            el.append(b);
        }
        return el;
    }) : [Object.assign(document.createElement('div'), { className: 'empty', textContent: 'Nobody pre-registered for the next 14 days.' })]));
}
async function loadExpected() { renderExpected(await api('GET', '/api/expected?all=1')); }
$('#expectedForm').onsubmit = (e) => {
    e.preventDefault();
    api('POST', '/api/expected', { name: $('#exName').value, company: $('#exCompany').value, hostId: $('#exHost').value, day: $('#exDay').value, vehicle: $('#exVehicle').value, note: $('#exNote').value })
        .then(r => { renderExpected(r.list); for (const id of ['exName', 'exCompany', 'exVehicle', 'exNote']) $('#' + id).value = ''; toast(`${r.expected.name} expected ${r.expected.day}.`); })
        .catch(showError);
};

// ---------------------------------------------------------------- LOG
const GROUPS = {
    inout: (e) => e.kind === 'in' || e.kind === 'out',
    fire: (e) => ['fire_start', 'fire_end', 'safe', 'missing', 'mark_cleared'].includes(e.kind),
    card: (e) => ['unknown_card', 'unknown_time_tap'].includes(e.kind) || ['card', 'esp32'].includes(e.source),
    admin: (e) => e.kind === 'admin' || e.source === 'admin'
};
async function refreshEvents() {
    const list = await api('GET', '/api/events?limit=400');
    const known = events.length ? new Set(events.map(e => e.id)) : null;
    events = list;
    $('#feed').innerHTML = events.slice(0, 18).map(e => evRow(e, { fresh: Boolean(known && !known.has(e.id)) })).join('') || '<div class="empty">Nothing recorded yet.</div>';
    renderLog();
}
function renderLog() {
    const q = $('#logSearch').value.trim().toLowerCase();
    const rows = events.filter(e => (!logKind || GROUPS[logKind](e)) &&
        (!q || [e.subjectName, e.source, srcLabel(e.source), e.device, e.note, e.kind, (KIND[e.kind] || [])[2]].join(' ').toLowerCase().includes(q)));
    let day = null, html = '';
    for (const e of rows) {
        const label = new Date(e.at).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
        if (label !== day) { day = label; html += `<div class="day">${isToday(e.at) ? 'Today' : esc(label)}</div>`; }
        html += evRow(e, { timeOnly: true });
    }
    $('#events').innerHTML = html || '<div class="empty">No matching events in the latest 400.</div>';
}
$('#logSearch').addEventListener('input', renderLog);
document.querySelectorAll('#logKinds button').forEach(b => b.onclick = () => {
    logKind = b.dataset.k; document.querySelectorAll('#logKinds button').forEach(x => x.classList.toggle('on', x === b)); renderLog();
});
document.querySelectorAll('#logSeg button').forEach(b => b.onclick = () => {
    logView = b.dataset.view;
    document.querySelectorAll('#logSeg button').forEach(x => x.classList.toggle('on', x === b));
    $('#events').classList.toggle('hidden', logView !== 'events'); $('#rollcalls').classList.toggle('hidden', logView !== 'rollcalls');
    for (const id of ['#logSearch', '#logKinds']) $(id).classList.toggle('hidden', logView !== 'events');
    if (logView === 'rollcalls') loadRollcalls();
});
async function loadRollcalls() {
    try {
        const list = await api('GET', '/api/fire/history');
        if (!list.length) { $('#rollcalls').innerHTML = '<div class="empty">No roll calls or drills recorded yet.</div>'; return; }
        const pct = (n, t) => (t ? (n / t) * 100 : 0);
        $('#rollcalls').innerHTML = `<table><tr><th>Started</th><th>Type</th><th>Started by</th><th>Outcome</th><th>On register</th><th>Safe</th><th>Missing</th><th>Not seen</th><th>All accounted after</th><th>Ended</th></tr>
            ${list.map(rc => `<tr><td>${esc(fmtWhen(rc.startedAt))}</td><td><span class="rc-type ${rc.drill ? 'drill' : 'real'}">${rc.drill ? 'DRILL' : 'ROLL CALL'}</span></td>
            <td>${esc(rc.startedBy || '')}<br><small class="muted">${esc(srcLabel(rc.source))}</small></td>
            <td><div class="bar-mini" title="${rc.safe} safe · ${rc.missing} missing · ${rc.unaccounted} not seen"><i class="s" style="width:${pct(rc.safe, rc.total)}%"></i><i class="m" style="width:${pct(rc.missing, rc.total)}%"></i><i class="u" style="width:${pct(rc.unaccounted, rc.total)}%"></i></div></td>
            <td>${rc.total}</td><td>${rc.safe}${rc.selfMarked ? ` <small class="muted">(${rc.selfMarked} by phone)</small>` : ''}</td><td>${rc.missing}</td><td>${rc.unaccounted}</td>
            <td>${rc.allSafeAt ? Math.max(1, Math.round((Date.parse(rc.allSafeAt) - Date.parse(rc.startedAt)) / 60000)) + ' min' : '—'}</td>
            <td>${rc.endedAt ? esc(fmtWhen(rc.endedAt)) : '<b style="color:var(--red)">open</b>'}</td></tr>`).join('')}</table>`;
    } catch (error) { showError(error); }
}
$('#exportCsv').onclick = () => {
    const q = new URLSearchParams();
    if ($('#from').value) q.set('from', new Date($('#from').value).toISOString());
    if ($('#to').value) q.set('to', new Date(new Date($('#to').value).getTime() + 86400_000).toISOString());
    fetch(`/api/export?${q}`, { headers: adminPin.get() ? { 'X-Admin-Pin': adminPin.get() } : {} })
        .then(r => { if (!r.ok) throw new Error('Export refused'); return r.blob(); })
        .then(blob => { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'signin-log.csv'; a.click(); toast('CSV downloaded.'); })
        .catch(showError);
};

// ---------------------------------------------------------------- ASK
$('#askForm').onsubmit = async (e) => {
    e.preventDefault();
    const q = $('#askQ').value.trim(); if (!q) return;
    const box = $('#askA');
    box.className = 'answer thinking'; box.innerHTML = `<div class="q">${esc(q)}</div>Looking it up`;
    $('#askState').textContent = 'thinking…';
    try {
        const r = await api('POST', '/api/ask', { question: q });
        box.className = 'answer';
        box.innerHTML = `<div class="q">${esc(q)}</div>${esc(r.answer)}<div class="tools">${esc(r.model)} · looked up: ${esc(r.toolCalls.map(t => t.name).join(', ') || 'nothing')}</div>`;
        $('#askState').textContent = '';
    } catch (error) { box.className = 'answer'; box.innerHTML = `<div class="q">${esc(q)}</div>${esc(error.message)}`; $('#askState').textContent = ''; }
};
document.querySelectorAll('#askSuggest button').forEach(b => b.onclick = () => { $('#askQ').value = b.textContent.trim(); $('#askForm').requestSubmit(); });
$('#atForm').onsubmit = async (e) => {
    e.preventDefault();
    if (!$('#atWhen').value) return;
    try {
        const r = await api('GET', `/api/register?at=${encodeURIComponent(new Date($('#atWhen').value).toISOString())}`);
        $('#atList').innerHTML = r.onSite.length
            ? `<div class="muted small">${plural(r.onSite.length, 'person')} signed in at ${esc(fmtWhen(r.at))}</div>` + r.onSite.map(p => `<div class="row-item">${avatar(p.name, 'in')}<div class="tx"><b>${esc(p.name)}</b><small>${esc(p.type)} · in since ${esc(fmtWhen(p.since))} · ${esc(srcLabel(p.source))}</small></div></div>`).join('')
            : '<div class="empty">Nobody was signed in at that moment.</div>';
    } catch (error) { showError(error); }
};

// ---------------------------------------------------------------- SYSTEM
function healthTiles(h) {
    const T = [];
    const t = (ic, name, cls, text) => T.push(`<div class="tile ${cls}"><div class="ic">${ic}</div><div class="nm"><i></i>${esc(name)}</div><div class="d">${text}</div></div>`);
    const w = (iso) => esc(fmtWhen(iso));
    if (h.teams) { const l = h.teams.last; t('💬', 'Teams channel', !l ? 'off' : l.ok ? 'ok' : 'warn', !l ? 'configured, nothing sent yet' : l.ok ? `last post ${w(l.at)}` : `FAILED ${w(l.at)} — ${esc(l.error)} (retrying)`); }
    else t('💬', 'Teams channel', 'warn', 'not configured (TEAMS_WEBHOOK_URL) — roll-call cards will not be posted');
    if (!h.backup) t('💾', 'Backups', 'warn', 'off (BACKUP_DIR empty)');
    else if (!h.backup.last) t('💾', 'Backups', 'off', 'on — none taken yet (the first runs within the hour)');
    else t('💾', 'Backups', h.backup.last.ok ? 'ok' : 'warn', h.backup.last.ok ? `last ${w(h.backup.last.at)}${h.backup.last.bytes ? ' · ' + Math.round(h.backup.last.bytes / 1024) + ' KB' : ''} · keep ${h.backup.keep}` : `FAILED — ${esc(h.backup.last.error || '')}`);
    if (h.backup?.offbox) { const o = h.backup.offbox.last; t('🛰️', 'Off-box copy', !o ? 'off' : o.ok ? 'ok' : 'warn', !o ? `→ ${esc(h.backup.offbox.target)} · none pushed yet` : o.ok ? `→ ${esc(o.target || h.backup.offbox.target)} · ${w(o.at)}` : `FAILED ${w(o.at)} — ${esc(o.error)}`); }
    else if (h.backup) t('🛰️', 'Off-box copy', 'warn', 'not configured (BACKUP_PUSH_TARGET) — every copy is on this server\'s disk');
    if (h.backup?.restoreDrill) { const r = h.backup.restoreDrill; t('🧪', 'Restore drill', r.ok ? 'ok' : 'warn', r.ok ? `${w(r.at)} · ${r.events} events restored, no drift` : `FAILED ${w(r.at)} — ${esc(r.error)}`); }
    if (h.sharepoint) { const l = h.sharepoint.last; t('☁️', 'SharePoint copy', !l ? 'off' : l.ok ? 'ok' : 'warn', !l ? `${esc(h.sharepoint.site)} · no push yet` : l.ok ? `${w(l.at)} · ${l.files.length} files` : `FAILED ${w(l.at)} — ${esc(l.error)}`); }
    else t('☁️', 'SharePoint copy', 'off', 'not configured (SP_* settings)');
    if (h.mslist) { const l = h.mslist.last; t('📋', 'Microsoft List', !l ? 'off' : l.ok ? 'ok' : 'warn', !l ? `"${esc(h.mslist.list)}" · no sync yet` : l.ok ? `${w(l.at)} · ${l.rows} rows` : `FAILED ${w(l.at)} — ${esc(l.error)}`); }
    else t('📋', 'Microsoft List', 'off', 'not configured (SP_LIST)');
    if (h.heartbeat) { const l = h.heartbeat.last; t('💓', 'Outside heartbeat', !l ? 'off' : l.ok ? 'ok' : 'warn', !l ? 'not sent yet' : l.ok ? `pinged ${w(l.at)}` : `FAILED — ${esc(l.error)}`); }
    else t('💓', 'Outside heartbeat', 'off', 'not configured (HEARTBEAT_URL) — nothing outside notices if this server stops');
    t('🗂️', 'Retention', h.retention ? 'ok' : 'warn', h.retention ? `${h.retention.days} days (${Math.round(h.retention.days / 365)} years)${h.retention.last ? ' · last run ' + w(h.retention.last.at) : ''}` : 'OFF — a data-protection decision is owed');
    t(h.tls ? '🔒' : '🔓', 'HTTPS', h.tls ? 'ok' : 'off', h.tls ? `on, port ${h.tls.port}` : 'plain HTTP on the office LAN (the offline fire page needs HTTPS)');
    if (h.llm) { const l = h.llm.last; t('🧠', 'Assistant model', !l ? 'off' : l.ok ? 'ok' : 'warn', !l ? 'not probed yet' : l.ok ? `${esc(h.llm.model)} reachable` : `unreachable — ${esc(l.error)}`); }
    t('📶', 'Presence (Wi-Fi / tags)', h.presence ? 'ok' : 'off', h.presence ? 'on' : 'off (PRESENCE=on to enable)');
    t('📤', 'Outbox', h.outbox > 0 ? 'warn' : 'ok', h.outbox ? `${h.outbox} waiting to send` : 'empty — everything delivered');
    t('🪞', 'Mirror', h.mirror ? 'ok' : 'off', h.mirror ? esc(h.mirror.url) : 'not configured');
    return T.join('');
}
async function loadHealth() {
    const h = health = await api('GET', '/api/health');
    const bad = (h.checks || []).filter(c => !c.ok);
    $('#healthVerdict').className = 'health-verdict ' + (bad.length ? 'bad' : 'ok');
    $('#healthVerdict').innerHTML = bad.length
        ? `⚠ ${plural(bad.length, 'health check')} failing<small>${esc(bad.map(c => `${c.name}: ${c.detail || ''}`).join(' · '))}</small>`
        : `✓ All ${(h.checks || []).length} health checks pass<small>${esc((h.checks || []).map(c => c.name).join(' · '))}</small>`;
    $('#offsiteState').innerHTML = healthTiles(h);
    $('#healthMeta').textContent = `v${h.version} · up since ${fmtWhen(h.startedAt)}`;
    const k = $('#kpiHealth'), kc = k.parentElement;
    kc.className = 'kpi-num health ' + (bad.length ? 'bad' : 'ok');
    k.textContent = bad.length ? `${plural(bad.length, 'issue')}` : 'All good';
    const tiles = [...$('#offsiteState').querySelectorAll('.tile')];
    const nWarn = tiles.filter(x => x.classList.contains('warn')).length, nOff = tiles.filter(x => x.classList.contains('off')).length;
    $('#kpiHealthSub').textContent = `${(h.checks || []).length} checks · ${tiles.length - nWarn - nOff} services on${nWarn ? ` · ${nWarn} to fix` : ''}${nOff ? ` · ${nOff} not set up` : ''}`;
    renderAttention(); tabBadges();
}

async function loadPresence() {
    const d = await api('GET', '/api/presence');
    const h = d.health, T = [];
    const t = (ic, name, cls, text) => T.push(`<div class="tile ${cls}"><div class="ic">${ic}</div><div class="nm"><i></i>${esc(name)}</div><div class="d">${text}</div></div>`);
    t('📶', 'Wi-Fi (phones)', h.wifi.enabled ? (h.wifi.lastPoll && !h.wifi.lastPoll.ok ? 'warn' : 'ok') : 'off',
        h.wifi.enabled ? (h.wifi.lastPoll ? (h.wifi.lastPoll.ok ? `last poll ${esc(fmtWhen(h.wifi.lastPoll.at))} · ${h.wifi.lastPoll.count} clients` : `FAILED — ${esc(h.wifi.lastPoll.error)}`) : 'not polled yet') : 'off (UNIFI_URL + UNIFI_API_KEY)');
    t('📡', 'Tag scanners', h.scanners.length ? 'ok' : 'off', h.scanners.length ? h.scanners.map(s => `${esc(s.name)} ${s.ageS < 120 ? 'live' : 'quiet ' + Math.round(s.ageS / 60) + ' min'}`).join(' · ') : 'none have reported yet');
    if (h.tags.length) t('🔑', 'Key tags', 'ok', h.tags.map(x => `${esc(x.person)}: ${x.ageS === null ? 'never heard' : x.ageS > 7 * 86400 ? `<b style="color:var(--amber)">not heard for ${Math.round(x.ageS / 86400)} days — battery?</b>` : 'heard ' + esc(fmtWhen(x.lastHeard))}`).join(' · '));
    $('#presenceHealth').innerHTML = T.join('');
    const picker = (items, label, field) => items.length ? items.map(it => {
        const id = it.mac || it.ident;
        return `<div class="picker-row"><code>${esc(id)}</code><span class="muted small">${esc([it.hostname, it.ap, it.scanner ? 'heard at ' + it.scanner : '', it.last ? fmtTime(it.last) : ''].filter(Boolean).join(' · '))}</span>
            <select data-assign="${field}" data-ident="${esc(id)}"><option value="">assign to…</option>${d.people.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select></div>`;
    }).join('') : `<div class="empty">No unassigned ${label} seen in the last 10 minutes.</div>`;
    $('#phonePicker').innerHTML = picker(d.candidates.phones, 'phones', 'phoneMac');
    $('#tagPicker').innerHTML = picker(d.candidates.tags, 'key tags', 'tagId');
    document.querySelectorAll('select[data-assign]').forEach(sel => {
        sel.onchange = () => {
            if (!sel.value) return;
            const body = {}; body[sel.dataset.assign] = sel.dataset.ident;
            api('PATCH', `/api/people/${sel.value}`, body).then(() => { toast(`${sel.dataset.assign === 'phoneMac' ? 'Phone' : 'Key tag'} assigned.`); loadAll(); }).catch(showError);
        };
    });
}

async function loadDevices() {
    const list = await api('GET', '/api/devices');
    $('#deviceList').replaceChildren(...(list.length ? list.map(d => {
        const el = document.createElement('div'); el.className = 'row-item';
        el.innerHTML = `<div class="ic-sq${d.revokedAt ? ' off' : ''}">${d.role === 'scanner' ? '📡' : d.role === 'button' ? '🔘' : '💳'}</div>
            <div class="tx"><b>${esc(d.name)}</b> <span class="tagc ${d.revokedAt ? '' : 'done'}">${d.revokedAt ? 'revoked' : esc(d.scopes.join(' · '))}</span>
            <small>${esc(d.role)} · issued ${esc(fmtWhen(d.createdAt))} · ${d.lastSeenAt ? 'last used ' + esc(fmtWhen(d.lastSeenAt)) : 'never used'}${d.revokedAt ? ' · revoked ' + esc(fmtWhen(d.revokedAt)) : ''}</small></div>`;
        if (!d.revokedAt) {
            const b = document.createElement('button'); b.className = 'adm-btn bad'; b.textContent = 'Revoke';
            b.onclick = () => { if (confirm(`Revoke the token of ${d.name}? It stops working at once.`)) api('DELETE', `/api/devices/${d.id}`).then(() => { loadDevices(); toast(`${d.name} revoked.`); }).catch(showError); };
            el.append(b);
        }
        return el;
    }) : [Object.assign(document.createElement('div'), { className: 'empty', textContent: 'No per-device tokens yet: devices use the shared API_TOKEN.' })]));
}
$('#deviceForm').onsubmit = (e) => {
    e.preventDefault();
    const scopes = [...document.querySelectorAll('#deviceForm input[name=scope]:checked')].map(c => c.value);
    api('POST', '/api/devices', { name: $('#devName').value, role: $('#devRole').value, scopes })
        .then(d => {
            $('#newToken').classList.remove('hidden');
            $('#newToken').innerHTML = `Token for <b>${esc(d.device.name)}</b> — copy it now, it is not shown again:<code>${esc(d.token)}</code>`;
            $('#devName').value = ''; loadDevices();
        })
        .catch(showError);
};
$('#companyForm').onsubmit = (e) => {
    e.preventDefault();
    api('PUT', '/api/company', { companyName: $('#companyName').value }).then(d => { delete $('#companyName').dataset.dirty; render(d); toast('Company name saved.'); }).catch(showError);
};
$('#noticeForm').onsubmit = (e) => {
    e.preventDefault();
    api('PUT', '/api/fire-notice', { fireNotice: $('#fireNotice').value }).then(d => { delete $('#fireNotice').dataset.dirty; render(d); toast('Fire notice saved.'); }).catch(showError);
};
$('#setCardToken').onclick = () => {
    const t = prompt('API token for the USB card reader on THIS browser (leave blank to clear):', localStorage.getItem('cardToken') || '');
    if (t === null) return;
    if (t) localStorage.setItem('cardToken', t); else localStorage.removeItem('cardToken');
    render(state);
};

// ---------------------------------------------------------------- session + loading
const gateShown = () => !$('#pinPanel').classList.contains('hidden');
function showGate() { document.body.classList.add('locked'); $('#pinPanel').classList.remove('hidden'); $('#app').classList.add('hidden'); setTimeout(() => $('#pin').focus(), 50); }
function showError(error) {
    if (error.status === 401) { showGate(); return; }
    toast(error.message, true, 8000);
}
async function refresh() {
    render(await api('GET', '/api/state'));
    await refreshEvents();
    setLive(true);
}
async function loadAll() {
    try {
        await refresh();
        $('#pinPanel').classList.add('hidden'); $('#app').classList.remove('hidden'); document.body.classList.remove('locked');
        await Promise.allSettled([loadHealth(), loadExpected(), loadPresence(), loadDevices(), loadBirthdays()]);
    } catch (error) { if (error.status === 401) showGate(); else { setLive(false); showError(error); } }
}
$('#pinForm').onsubmit = (e) => {
    e.preventDefault();
    // One login: the server sets an HttpOnly session cookie, so the PIN is never kept in the browser.
    api('POST', '/api/admin/login', { pin: $('#pin').value })
        .then(() => { sessionStorage.removeItem('adminPin'); $('#pin').value = ''; loadAll(); })
        .catch(error => { $('#pin').value = ''; toast(error.status === 429 ? error.message : (error.status === 401 ? 'Wrong PIN.' : error.message), true); });
};
$('#logout').onclick = () => api('POST', '/api/admin/logout', {}).then(() => { sessionStorage.removeItem('adminPin'); location.reload(); });

showTab(location.hash.slice(1));
loadAll();
// Live: the register's change stream refreshes the people and the feed at once; the slower panels every minute.
SI.live(() => { if (!gateShown()) refresh().catch(error => { setLive(false); if (error.status === 401) showGate(); }); }, { fallbackMs: 30_000, debounceMs: 600 });
setInterval(() => { if (!gateShown()) Promise.allSettled([loadHealth(), loadExpected(), loadPresence(), loadDevices(), loadBirthdays()]); }, 60_000);
setInterval(() => { if (state && !gateShown()) renderToday(state, null); }, 60_000);   // keep "· 2h 14m" true
