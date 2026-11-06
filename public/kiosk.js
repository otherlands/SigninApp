const { $, esc, sinceLabel, api, notice, listenForCardWedge } = SI;
const peopleEl = $('#people'); const visitorsEl = $('#visitors'); const noticeEl = $('#notice');
let state = null; let busy = false;

const hue = (name) => { let h = 0; for (const c of String(name)) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
const initials = (name) => { const p = String(name).trim().split(/\s+/); return ((p[0] || '')[0] || '').toUpperCase() + (p.length > 1 ? (p[p.length - 1][0] || '').toUpperCase() : ''); };
const firstName = (name) => String(name).trim().split(/\s+/)[0];
function tickClock() {
    const d = new Date();
    $('#time').textContent = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    $('#clock').textContent = d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
}
tickClock(); setInterval(tickClock, 1000);

function render(data) {
    state = data;
    document.title = `Sign in · ${data.companyName}`;
    $('#company').textContent = data.companyName;
    $('#inCount').textContent = data.inCount;
    const staffIn = data.people.filter(p => p.signedIn).length;
    $('#ringArc').style.strokeDashoffset = String(2 * Math.PI * 34 * (1 - (data.people.length ? staffIn / data.people.length : 0)));
    $('#countPill').classList.toggle('warn', data.staleCount > 0);
    $('#rollcallBanner').classList.toggle('hidden', !data.rollcall);
    document.body.classList.toggle('rc', Boolean(data.rollcall));
    $('#loneBanner').classList.toggle('hidden', !data.loneWorker || Boolean(data.rollcall));
    $('#expectedBanner').classList.toggle('hidden', !data.expectedToday);
    if (data.expectedToday) $('#expectedText').textContent = `${data.expectedToday} visitor${data.expectedToday === 1 ? '' : 's'} expected today`;
    $('#live').className = 'live';

    peopleEl.replaceChildren(...data.people.map(person => {
        const b = document.createElement('button');
        b.className = `person ${person.signedIn ? 'in' : ''} ${person.stale ? 'stale' : ''}`;
        const sub = person.signedIn
            ? (person.stale ? `⚠ In ${sinceLabel(person.since)} — tap to sign out` : `In ${sinceLabel(person.since)}`)
            : 'Tap to sign in';
        const pres = person.signedIn && person.presence ? (person.presence.state === 'here' ? '<span class="badge" title="phone or key tag seen inside">📱</span>' : person.presence.state === 'probably-left' ? `<span class="badge" title="phone and key tag absent">📵 ${SI.fmtTime(person.presence.lastSeen)}</span>` : '') : '';
        b.innerHTML = `<span class="k-av" style="--h:${hue(person.name)}">${esc(initials(person.name))}</span>
            <span class="k-who"><strong>${esc(person.name)}</strong><span>${esc(sub)}</span></span>${pres || (person.hasCard ? '<span class="badge" title="has a card">💳</span>' : '')}`;
        b.onclick = () => sign({ personId: person.id }, person.name);
        b.dataset.name = person.name.toLowerCase();
        return b;
    }));
    applyFilter();

    $('#visitorSub').textContent = data.visitors.length ? `${data.visitors.length} signed in` : '';
    if (!data.visitors.length) {
        visitorsEl.innerHTML = '<p class="k-none">No visitors on site right now.</p>';
    } else {
        visitorsEl.replaceChildren(...data.visitors.map(v => {
            const row = document.createElement('div');
            row.className = 'visitor-row';
            row.innerHTML = `<span class="k-bdg"><small>BADGE</small><b>${esc(v.badge)}</b></span><span class="k-vt"><strong>${esc(v.name)}</strong>${v.stale ? ' <span class="badge" title="signed in before today">⚠ since ' + esc(SI.fmtWhen(v.signedInAt)) + '</span>' : ''}
        <small class="muted">${esc([v.company, v.hostName ? `visiting ${v.hostName}` : null].filter(Boolean).join(' · '))} · ${esc(sinceLabel(v.signedInAt))}</small></span>`;
            const out = document.createElement('button');
            out.textContent = 'Sign out';
            out.onclick = () => visitorOut(v);
            row.append(out);
            return row;
        }));
    }
}

// ---- the moment that matters: a big, friendly confirmation anyone can read from across the hall ----
let welcomeT = null;
function greeting(kind) {
    const h = new Date().getHours();
    if (kind === 'in') return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
    return h < 12 ? 'See you soon' : h < 17 ? 'See you later' : 'Have a good evening';
}
function welcome(event, how) {
    const w = $('#welcome');
    const isIn = event.kind === 'in';
    w.className = `k-welcome ${isIn ? 'in' : 'out'}`;
    $('#wAv').style.setProperty('--h', hue(event.subjectName));
    $('#wAv').textContent = initials(event.subjectName);
    $('#wHi').textContent = `${greeting(event.kind)}, ${firstName(event.subjectName)}`;
    $('#wWhat').textContent = `${isIn ? '✓ Signed IN' : '✓ Signed OUT'} at ${SI.fmtTime(event.at)}${how ? ' · ' + how : ''}`;
    const undo = undoFor(event);
    $('#wUndo').onclick = (e) => { e.stopPropagation(); closeWelcome(); undo.run(); };
    $('#wDone').onclick = (e) => { e.stopPropagation(); closeWelcome(); };
    const bar = $('#wBar'); bar.style.transition = 'none'; bar.style.width = '100%';
    requestAnimationFrame(() => requestAnimationFrame(() => { bar.style.transition = 'width 5s linear'; bar.style.width = '0%'; }));
    clearTimeout(welcomeT); welcomeT = setTimeout(closeWelcome, 5000);
    if (search && document.activeElement === search) search.blur();
}
function closeWelcome() { clearTimeout(welcomeT); $('#welcome').classList.add('hidden'); }
$('#welcome').addEventListener('pointerdown', (e) => { if (e.target === $('#welcome')) closeWelcome(); });

async function load() {
    try { render(await api('GET', '/api/state')); }
    catch { $('#live').className = 'live bad'; notice(noticeEl, 'Unable to reach the sign-in server.', true, 0); }
}

async function sign(body, label) {
    if (busy) return;
    busy = true;
    document.querySelectorAll('.person').forEach(b => b.disabled = true);
    try {
        const data = await api('POST', '/api/sign', { ...body, source: body.cardUid ? 'card' : 'kiosk' });
        render(data.state);
        welcome(data.event, '');
        if (navigator.vibrate) navigator.vibrate(60);
    } catch (error) {
        notice(noticeEl, error.message || `Could not sign ${label || ''}.`, true);
    } finally {
        busy = false;
        document.querySelectorAll('.person').forEach(b => b.disabled = false);
    }
}

/** Wrong name tapped? Undo records the opposite move with a note — nothing is deleted, the log stays honest. */
function undoFor(event) {
    return {
        label: 'Undo', run: () => api('POST', '/api/sign', { personId: event.subjectId, direction: event.kind === 'in' ? 'out' : 'in', source: 'kiosk', note: 'undo: tapped by mistake' })
            .then(d => { render(d.state); notice(noticeEl, `Undone: ${event.subjectName} is signed ${d.event.kind.toUpperCase()} again.`); })
            .catch(error => notice(noticeEl, error.message, true))
    };
}

async function visitorOut(v) {
    if (!confirm(`Sign out visitor ${v.name} (badge ${v.badge})?`)) return;
    try {
        const data = await api('POST', `/api/visitors/${v.id}/out`, {});
        render(data.state);
        notice(noticeEl, `${v.name} signed OUT. Please return badge ${v.badge}.`);
    } catch (error) { notice(noticeEl, error.message, true); }
}

// Card readers plugged into the kiosk tablet/PC behave as a keyboard. If the server has an
// API_TOKEN set, put it in localStorage.cardToken on the kiosk once (admin page has a button).
// Kiosk-mode devices have no address bar, so the Pi installer hands it in once as ?cardToken=…;
// it is stored and stripped from the URL before anything else runs (the server never logs query strings).
{
    const q = new URLSearchParams(location.search);
    if (q.has('cardToken')) {
        const t = q.get('cardToken');
        if (t) localStorage.setItem('cardToken', t); else localStorage.removeItem('cardToken');
        history.replaceState(null, '', location.pathname);
    }
    if (q.has('device') && q.get('device')) localStorage.setItem('deviceName', q.get('device').slice(0, 40));
}
function signByCard(uid) {
    const token = localStorage.getItem('cardToken') || '';
    api('POST', '/api/sign', { cardUid: uid, source: 'card' }, token ? { 'X-Api-Token': token } : {})
        .then(data => { render(data.state); welcome(data.event, 'by card'); })
        .catch(error => notice(noticeEl, error.message, true, 8000));
}
listenForCardWedge(signByCard, $('#cardHint'));

// v4.1: name search. Filters the staff buttons as you type; clears itself after 20 s idle so the next person starts
// clean. A card tapped while the box has focus types its number + Enter into it: that is treated as the card.
const search = $('#search');
let searchIdle = null;
function applyFilter() {
    const q = (search?.value || '').trim().toLowerCase();
    for (const b of peopleEl.querySelectorAll('.person')) b.classList.toggle('hidden', Boolean(q) && !b.dataset.name.includes(q));
}
if (search) {
    search.oninput = () => { applyFilter(); clearTimeout(searchIdle); searchIdle = setTimeout(() => { search.value = ''; applyFilter(); search.blur(); }, 20_000); };
    search.onkeydown = (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        const v = search.value.trim();
        if (/^[0-9a-f:\- ]{8,}$/i.test(v) && /\d/.test(v)) { search.value = ''; applyFilter(); search.blur(); signByCard(v); return; }
        const visible = [...peopleEl.querySelectorAll('.person:not(.hidden)')];
        if (visible.length === 1) { search.value = ''; applyFilter(); search.blur(); visible[0].click(); }
    };
}

load();
SI.live(load, { fallbackMs: 30_000 });
