const { $, esc, sinceLabel, api, startClock, notice, listenForCardWedge } = SI;
const peopleEl = $('#people'); const visitorsEl = $('#visitors'); const noticeEl = $('#notice');
let state = null; let busy = false;

startClock($('#clock'));

function render(data) {
    state = data;
    document.title = `Sign in · ${data.companyName}`;
    $('#company').textContent = data.companyName;
    $('#inCount').textContent = data.inCount;
    $('#countPill').classList.toggle('warn', data.staleCount > 0);
    $('#rollcallBanner').classList.toggle('hidden', !data.rollcall);

    peopleEl.replaceChildren(...data.people.map(person => {
        const b = document.createElement('button');
        b.className = `person ${person.signedIn ? 'in' : ''} ${person.stale ? 'stale' : ''}`;
        const sub = person.signedIn
            ? (person.stale ? `⚠ Signed in ${sinceLabel(person.since)} — tap to sign out` : `In ${sinceLabel(person.since)} — tap to sign out`)
            : 'Tap to sign in';
        b.innerHTML = `<strong>${esc(person.name)}</strong><span>${esc(sub)}</span>${person.hasCard ? '<span class="badge">card</span>' : ''}`;
        b.onclick = () => sign({ personId: person.id }, person.name);
        return b;
    }));

    if (!data.visitors.length) {
        visitorsEl.innerHTML = '<p class="muted">No visitors on site.</p>';
    } else {
        visitorsEl.replaceChildren(...data.visitors.map(v => {
            const row = document.createElement('div');
            row.className = 'visitor-row';
            row.innerHTML = `<span><strong>${esc(v.name)}</strong> <span class="badge">badge ${v.badge}</span><br>
        <small class="muted">${esc([v.company, v.hostName ? `visiting ${v.hostName}` : null, v.vehicle].filter(Boolean).join(' · '))} · ${esc(sinceLabel(v.signedInAt))}</small></span>`;
            const out = document.createElement('button');
            out.textContent = 'Sign out';
            out.onclick = () => visitorOut(v);
            row.append(out);
            return row;
        }));
    }
}

async function load() {
    try { render(await api('GET', '/api/state')); }
    catch { notice(noticeEl, 'Unable to reach the sign-in server.', true, 0); }
}

async function sign(body, label) {
    if (busy) return;
    busy = true;
    document.querySelectorAll('.person').forEach(b => b.disabled = true);
    try {
        const data = await api('POST', '/api/sign', { ...body, source: body.cardUid ? 'card' : 'kiosk' });
        render(data.state);
        const verb = data.event.kind === 'in' ? 'signed IN' : 'signed OUT';
        notice(noticeEl, `${data.event.subjectName} ${verb} at ${SI.fmtTime(data.event.at)}.`);
        if (navigator.vibrate) navigator.vibrate(60);
    } catch (error) {
        notice(noticeEl, error.message || `Could not sign ${label || ''}.`, true);
    } finally {
        busy = false;
        document.querySelectorAll('.person').forEach(b => b.disabled = false);
    }
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
listenForCardWedge((uid) => {
    const token = localStorage.getItem('cardToken') || '';
    api('POST', '/api/sign', { cardUid: uid, source: 'card' }, token ? { 'X-Api-Token': token } : {})
        .then(data => { render(data.state); notice(noticeEl, `${data.event.subjectName} signed ${data.event.kind.toUpperCase()} by card.`); })
        .catch(error => notice(noticeEl, error.message, true, 8000));
}, $('#cardHint'));

load();
setInterval(load, 15000);
