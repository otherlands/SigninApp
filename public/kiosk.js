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

// ---- birthdays: ticked in Admin for today only. Pure decoration: pointer-events off, and gone during a roll call ----
const PARTY_COLOURS = ['#ff5f8f', '#ffcc33', '#00d4ff', '#7c5cff', '#2ecc71', '#ff8a3d', '#ff4fd8', '#5ce1e6'];
let partyKey = '';
const bdayIds = () => new Set(state && !state.rollcall ? (state.birthdays || []).map(b => b.id) : []);
const rnd = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const joinNames = (n) => n.length <= 1 ? (n[0] || '') : `${n.slice(0, -1).join(', ')} and ${n[n.length - 1]}`;
function renderParty(data) {
    const list = data.rollcall ? [] : (data.birthdays || []);
    if (data.rollcall && !$('#bdayShow').classList.contains('hidden')) closeShow();
    const key = list.map(b => b.id).join(',');
    document.body.classList.toggle('bday', list.length > 0);
    $('#bday').classList.toggle('hidden', !list.length);
    if (!list.length) { $('#party').replaceChildren(); partyKey = ''; return; }
    $('#bdayText').textContent = `Happy Birthday, ${joinNames(list.map(b => firstName(b.name)))}!`;
    $('#bdayFrom').textContent = `from everyone at ${data.companyName} 🎉`;
    if (key === partyKey) return;
    partyKey = key;
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const bits = [];
    // bunting across the top
    const flags = Array.from({ length: 26 }, (_, i) => `<i style="--c:${PARTY_COLOURS[i % PARTY_COLOURS.length]};--i:${i}"></i>`).join('');
    bits.push(`<div class="k-bunting">${flags}</div>`);
    if (!reduce) {
        for (let i = 0; i < 11; i++) {
            bits.push(`<i class="k-balloon" style="--x:${rnd(2, 94).toFixed(1)}%;--d:${rnd(13, 22).toFixed(1)}s;--dl:-${rnd(0, 20).toFixed(1)}s;--c:${pick(PARTY_COLOURS)};--s:${rnd(.75, 1.25).toFixed(2)};--sw:${rnd(18, 46).toFixed(0)}px"><b></b></i>`);
        }
        for (let i = 0; i < 9; i++) {
            bits.push(`<svg class="k-ribbon" viewBox="0 0 24 140" style="--x:${rnd(2, 96).toFixed(1)}%;--d:${rnd(9, 15).toFixed(1)}s;--dl:-${rnd(0, 14).toFixed(1)}s;--sw:${rnd(30, 80).toFixed(0)}px;color:${pick(PARTY_COLOURS)}"><path d="M12 2 C 24 14, 0 24, 12 36 S 0 58, 12 70 S 24 92, 12 104 S 0 126, 12 138" /></svg>`);
        }
        for (let i = 0; i < 28; i++) {
            bits.push(`<i class="k-confetti" style="--x:${rnd(0, 100).toFixed(1)}%;--d:${rnd(6, 12).toFixed(1)}s;--dl:-${rnd(0, 12).toFixed(1)}s;--c:${pick(PARTY_COLOURS)};--sw:${rnd(-60, 60).toFixed(0)}px;--r:${rnd(360, 1080).toFixed(0)}deg"></i>`);
        }
    }
    $('#party').innerHTML = bits.join('');
}
function burst() {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const el = $('#wBurst');
    el.innerHTML = Array.from({ length: 90 }, () => {
        const a = rnd(0, Math.PI * 2), d = rnd(180, 560);
        return `<i style="--tx:${(Math.cos(a) * d).toFixed(0)}px;--ty:${(Math.sin(a) * d - 120).toFixed(0)}px;--c:${pick(PARTY_COLOURS)};--r:${rnd(180, 900).toFixed(0)}deg;--dl:${rnd(0, .25).toFixed(2)}s"></i>`;
    }).join('');
    setTimeout(() => { el.innerHTML = ''; }, 2600);
}

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
    const bdays = bdayIds();

    peopleEl.replaceChildren(...data.people.map(person => {
        const b = document.createElement('button');
        b.className = `person ${person.signedIn ? 'in' : ''} ${person.stale ? 'stale' : ''} ${bdays.has(person.id) ? 'bday' : ''}`;
        const sub = person.signedIn
            ? (person.stale ? `⚠ In ${sinceLabel(person.since)} — tap to sign out` : `In ${sinceLabel(person.since)}`)
            : 'Tap to sign in';
        const pres = person.signedIn && person.presence ? (person.presence.state === 'here' ? '<span class="badge" title="phone or key tag seen inside">📱</span>' : person.presence.state === 'probably-left' ? `<span class="badge" title="phone and key tag absent">📵 ${SI.fmtTime(person.presence.lastSeen)}</span>` : '') : '';
        b.innerHTML = `<span class="k-av" style="--h:${hue(person.name)}">${esc(initials(person.name))}${bdays.has(person.id) ? '<span class="k-hat">🥳</span>' : ''}</span>
            <span class="k-who"><strong>${esc(person.name)}</strong><span>${esc(bdays.has(person.id) && !person.signedIn ? '🎂 Happy Birthday! Tap to sign in' : sub)}</span></span>${pres || (person.hasCard ? '<span class="badge" title="has a card">💳</span>' : '')}`;
        b.onclick = () => sign({ personId: person.id }, person.name);
        b.dataset.name = person.name.toLowerCase();
        return b;
    }));
    applyFilter();
    renderParty(data);

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
    const party = event.subjectType !== 'visitor' && bdayIds().has(event.subjectId);
    if (party && isIn) return birthdayShow(event, how);
    w.className = `k-welcome ${isIn ? 'in' : 'out'}${party ? ' bday' : ''}`;
    $('#wAv').style.setProperty('--h', hue(event.subjectName));
    $('#wAv').textContent = initials(event.subjectName);
    if (party) $('#wHi').innerHTML = `<span class="e">🎉</span> <span class="g">Happy Birthday, ${esc(firstName(event.subjectName))}!</span> <span class="e">🎂</span>`;
    else $('#wHi').textContent = `${greeting(event.kind)}, ${firstName(event.subjectName)}`;
    $('#wWhat').textContent = `${isIn ? '✓ Signed IN' : '✓ Signed OUT'} at ${SI.fmtTime(event.at)}${how ? ' · ' + how : ''}${party ? (isIn ? ' — have a brilliant day!' : ' — enjoy the rest of your birthday!') : ''}`;
    const ms = party ? 8000 : 5000;
    const undo = undoFor(event);
    $('#wUndo').onclick = (e) => { e.stopPropagation(); closeWelcome(); undo.run(); };
    $('#wDone').onclick = (e) => { e.stopPropagation(); closeWelcome(); };
    const bar = $('#wBar'); bar.style.transition = 'none'; bar.style.width = '100%';
    requestAnimationFrame(() => requestAnimationFrame(() => { bar.style.transition = `width ${ms / 1000}s linear`; bar.style.width = '0%'; }));
    clearTimeout(welcomeT); welcomeT = setTimeout(closeWelcome, ms);
    if (party) burst();
    if (search && document.activeElement === search) search.blur();
}
function closeWelcome() { clearTimeout(welcomeT); $('#welcome').classList.add('hidden'); }
$('#welcome').addEventListener('pointerdown', (e) => { if (e.target === $('#welcome')) closeWelcome(); });

// ---- the birthday person signs IN: a full-screen show (12 s, or "Thank you!"). Visual only: the door Pi's
// panel has no speakers we can rely on (HDMI audio, no EDID), so there is deliberately no sound. ----
let showT = null; const showTimers = [];
const SHOW_MS = 12000;
const FIREWORKS = [[22, 30], [78, 26], [50, 16], [30, 72], [70, 70], [50, 46], [12, 52], [88, 50], [36, 20], [64, 40]];
function closeShow() {
    clearTimeout(showT); showTimers.splice(0).forEach(clearTimeout);
    $('#bdayShow').classList.add('hidden'); $('#bdayShow').classList.remove('go');
    $('#sFx').replaceChildren(); $('#sStars').replaceChildren();
}
function firework(x, y) {
    const fx = $('#sFx');
    const el = document.createElement('div');
    el.className = 'k-fw'; el.style.left = x + '%'; el.style.top = y + '%';
    const c = pick(PARTY_COLOURS), c2 = pick(PARTY_COLOURS);
    el.innerHTML = '<b></b>' + Array.from({ length: 30 }, (_, i) => {
        const a = (i / 30) * Math.PI * 2 + rnd(-.08, .08), d = rnd(110, 210);
        return `<i style="--tx:${(Math.cos(a) * d).toFixed(0)}px;--ty:${(Math.sin(a) * d).toFixed(0)}px;--c:${i % 3 ? c : c2}"></i>`;
    }).join('');
    el.style.setProperty('--c', c);
    fx.append(el);
    showTimers.push(setTimeout(() => el.remove(), 1900));
}
function birthdayShow(event, how) {
    closeWelcome(); closeShow();
    const s = $('#bdayShow');
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    s.querySelector('.k-show-av').style.setProperty('--h', hue(event.subjectName));
    $('#sAv').textContent = initials(event.subjectName);
    $('#sHb').innerHTML = [...'Happy Birthday'].map((ch, i) => ch === ' ' ? '<span class="sp"> </span>' : `<span style="--i:${i}">${esc(ch)}</span>`).join('');
    $('#sName').textContent = `${firstName(event.subjectName)}!`;
    $('#sWhat').textContent = `✓ Signed IN at ${SI.fmtTime(event.at)}${how ? ' · ' + how : ''} — have a brilliant day!`;
    $('#sFrom').textContent = `from everyone at ${state?.companyName || 'the office'} 💜`;
    $('#sStars').innerHTML = Array.from({ length: 36 }, () => `<i style="left:${rnd(0, 100).toFixed(1)}%;top:${rnd(0, 100).toFixed(1)}%;--d:${rnd(1.2, 2.8).toFixed(2)}s;--dl:-${rnd(0, 2.8).toFixed(2)}s;--s:${rnd(.5, 1.4).toFixed(2)}"></i>`).join('');
    s.classList.remove('hidden'); void s.offsetWidth; s.classList.add('go');
    if (!reduce) {
        FIREWORKS.forEach(([x, y], i) => showTimers.push(setTimeout(() => firework(x, y), 250 + i * 520)));
        // a rush of balloons from the bottom of the screen, once
        const rush = Array.from({ length: 16 }, () => `<i class="k-rush" style="--x:${rnd(2, 95).toFixed(1)}%;--d:${rnd(4.5, 7.5).toFixed(1)}s;--dl:${rnd(0, 1.6).toFixed(2)}s;--c:${pick(PARTY_COLOURS)};--s:${rnd(.8, 1.35).toFixed(2)}"></i>`).join('');
        $('#sFx').insertAdjacentHTML('beforeend', `<div class="k-rushes">${rush}</div>`);
    }
    const bar = $('#sBar'); bar.style.transition = 'none'; bar.style.width = '100%';
    requestAnimationFrame(() => requestAnimationFrame(() => { bar.style.transition = `width ${SHOW_MS / 1000}s linear`; bar.style.width = '0%'; }));
    const undo = undoFor(event);
    $('#sUndo').onclick = (e) => { e.stopPropagation(); closeShow(); undo.run(); };
    $('#sDone').onclick = (e) => { e.stopPropagation(); closeShow(); };
    showT = setTimeout(closeShow, SHOW_MS);
    if (search && document.activeElement === search) search.blur();
}
$('#bdayShow').addEventListener('pointerdown', (e) => { if (!e.target.closest('button')) closeShow(); });

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
