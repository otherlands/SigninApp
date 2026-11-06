const { $, esc, fmtTime, fmtWhen, sinceLabel, api, notice } = SI;
const CACHE_KEY = 'fire-last-known';
let view = null;           // last successful /api/fire response
let offline = false;
let audioArmed = false;

$('#device').textContent = SI.deviceName();
$('#by').value = localStorage.getItem('marshalName') || '';
$('#by').oninput = () => localStorage.setItem('marshalName', $('#by').value);

function marksFor(rc) {
    const map = new Map();
    for (const m of rc?.marks || []) map.set(`${m.subjectType}:${m.subjectId}`, m);
    return map;
}

// ---- the everyday "who is on site" look (same design as the staff hub's "On site now") ----
const SRC = { kiosk: '👆', card: '💳', desktop: '🖥', admin: '⚙', esp32: '💳', 'fire-page': '🔥', self: '📱', list: '📋', wifi: '📶', ble: '🔑', 'ble+wifi': '📶', webhook: '🔘', tap: '📱', visitor: '👆', phone: '📱' };
const SRC_NAME = { kiosk: 'the door screen', card: 'a card', desktop: 'their PC', admin: 'admin', esp32: 'the back-door reader', self: 'their phone', list: 'the Microsoft List', wifi: 'Wi-Fi', ble: 'key tag', 'ble+wifi': 'Wi-Fi + key tag', webhook: 'a wall button', tap: 'a phone tap', phone: 'the phone app' };
const hue = (name) => { let h = 0; for (const c of String(name)) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
const initials = (name) => { const p = String(name).trim().split(/\s+/); return ((p[0] || '')[0] || '').toUpperCase() + (p.length > 1 ? (p[p.length - 1][0] || '').toUpperCase() : ''); };
const ago = (iso) => {
    const m = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
    if (m < 1) return 'just now'; if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60); return h < 24 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)}d ${h % 24}h`;
};
// All staff (in and out) from the kiosk view, office network only. It only adds the dimmed "out" names and the
// "of N staff" figure; who is IN always comes from /api/fire, the register the roll call freezes.
const PEOPLE_KEY = 'fire-people';
let people = JSON.parse(localStorage.getItem(PEOPLE_KEY) || 'null');
let seenIn = null;          // ids on site at the last paint, to animate arrivals
let peopleAt = 0;
function loadPeople() {
    if (!view || view.public) return;
    api('GET', '/api/state').then(s => {
        people = (s.people || []).map(p => ({ id: p.id, name: p.name }));
        localStorage.setItem(PEOPLE_KEY, JSON.stringify(people));
        if (view && !view.rollcall) render(view);
    }).catch(() => { });
}
function setRing(frac) {
    const C = 2 * Math.PI * 48;
    $('#ringArc').style.strokeDashoffset = String(C * (1 - Math.max(0, Math.min(1, frac))));
}

function render(data) {
    view = data;
    const rc = data.rollcall;
    const active = Boolean(rc);
    const list = active ? rc.roster : data.roster;
    const marks = marksFor(rc);

    document.body.classList.toggle('active', active);
    document.body.classList.toggle('drill', active && Boolean(rc.drill));
    document.title = active ? `${rc.drill ? 'DRILL' : 'ROLL CALL'} · ${data.companyName}` : `On site · ${data.companyName}`;
    const staffIn = list.staff, nOn = list.staff.length + list.visitors.length;
    const allStaff = !active && people && !data.public ? people.length : null;
    if (active) {
        $('#title').textContent = rc.allSafe ? `✅ ALL ${rc.total} ACCOUNTED FOR` : (rc.drill ? 'FIRE DRILL (practice)' : '🔥 FIRE ROLL CALL');
        $('#kicker').textContent = rc.drill ? 'practice drill · register frozen when it started' : 'register frozen when it started';
        $('#bigCount').textContent = rc.safe;
        $('#ringLabel').textContent = `of ${rc.total} safe`;
        setRing(rc.total ? rc.safe / rc.total : 0);
    } else {
        $('#title').textContent = nOn === 0 ? 'Nobody is signed in' : (nOn === 1 ? '1 person in the building' : `${nOn} people in the building`);
        $('#kicker').textContent = list.replica ? `mirror copy · last update ${fmtWhen(list.at)}` : 'from the door sign-in screen';
        $('#bigCount').textContent = nOn;
        $('#ringLabel').textContent = 'on site';
        setRing(allStaff ? staffIn.length / allStaff : (nOn ? 1 : 0));
    }
    const first = [...staffIn].filter(p => !p.stale).sort((a, b) => Date.parse(a.since) - Date.parse(b.since))[0];
    $('#subtitle').innerHTML = active
        ? (rc.allSafe
            ? `Everyone on the register is marked SAFE. Started ${esc(fmtWhen(rc.startedAt))}${rc.startedBy ? ' by ' + esc(rc.startedBy) : ''}.`
            : `Started ${esc(fmtWhen(rc.startedAt))}${rc.startedBy ? ' by ' + esc(rc.startedBy) : ''} (${esc(rc.source)}). <b>${rc.total}</b> on the register.`)
        : `<b>${staffIn.length}</b>${allStaff ? ` of ${allStaff}` : ''} staff · <b>${list.visitors.length}</b> visitor${list.visitors.length === 1 ? '' : 's'}${first ? ` · first in ${esc(first.name.split(' ')[0])} at ${esc(fmtTime(first.since))}` : ''}`;
    const chips = [];
    if (!active && list.loneWorker) chips.push('<span class="fx-chip warn">⚠ Lone worker — only one person on site</span>');
    const stale = list.staff.filter(p => p.stale).length + list.visitors.filter(v => v.stale).length;
    if (stale) chips.push(`<span class="fx-chip warn">⚠ <b>${stale}</b> still signed in from before today</span>`);
    $('#chips').innerHTML = chips.join('');
    document.body.classList.toggle('allsafe', active && Boolean(rc.allSafe));
    // Served through the public proxy: read-only. Marshal controls are refused by the server from outside anyway.
    document.body.classList.toggle('public', Boolean(data.public));
    $('#startBtn').classList.toggle('hidden', active || data.public);
    $('#drillBtn').classList.toggle('hidden', active || data.public);
    $('#endBtn').classList.toggle('hidden', !active || data.public);
    $('#stats').classList.toggle('hidden', !active);
    $('#byWrap').classList.toggle('hidden', !active || data.public);
    $('#publicNote').classList.toggle('hidden', !data.public);
    if (active) {
        $('#safeCount').textContent = rc.safe;
        $('#selfCount').textContent = rc.selfMarked ? `(${rc.selfMarked} by phone)` : '';
        $('#missingCount').textContent = rc.missing;
        $('#unaccountedCount').textContent = rc.unaccounted;
    }

    $('#staffHead').textContent = active ? `Staff (${list.staff.length})` : 'Staff';
    $('#visitorHead').textContent = active ? `Visitors (${list.visitors.length})` : 'Visitors on site';
    if (active) {
        $('#staff').className = 'roll'; $('#visitors').className = 'roll';
        renderRows($('#staff'), list.staff, 'staff', marks, active);
        renderRows($('#visitors'), list.visitors, 'visitor', marks, active);
        if (!list.staff.length) $('#staff').innerHTML = '<p class="muted">No staff signed in.</p>';
        if (!list.visitors.length) $('#visitors').innerHTML = '<p class="muted">No visitors signed in.</p>';
        $('#visitorBlock').classList.remove('hidden');
        seenIn = null;
    } else {
        renderCards(list, data.public);
    }
    $('#updated').textContent = `Updated ${fmtTime(new Date().toISOString())}`;
    $('#footNote').textContent = active
        ? 'every marshal\'s SAFE / MISSING tick appears on every phone at once; the list is the register frozen when the roll call started.'
        : 'changes appear the moment someone taps in or out at the door, on a card, or from their PC.';
}

function renderCards(list, isPublic) {
    const now = new Set([...list.staff.map(p => 's' + p.id), ...list.visitors.map(v => 'v' + v.id)]);
    const fresh = (key) => (seenIn && !seenIn.has(key) ? ' arrive' : '');
    const inStaff = [...list.staff].sort((a, b) => Date.parse(a.since) - Date.parse(b.since));
    const inIds = new Set(inStaff.map(p => p.id));
    const out = (people && !isPublic ? people.filter(p => !inIds.has(p.id)) : []).sort((a, b) => a.name.localeCompare(b.name));
    $('#staff').className = 'fx-people';
    $('#staff').innerHTML = inStaff.map(p => {
        const when = p.stale ? `⚠ in since ${fmtWhen(p.since)}` : `in ${fmtTime(p.since)} · ${ago(p.since)}`;
        const pres = p.presence?.state === 'probably-left' ? ` · 📵 left ${fmtTime(p.presence.lastSeen)}?` : '';
        const title = `${p.name} — signed in ${fmtWhen(p.since)}${SRC_NAME[p.source] ? ' by ' + SRC_NAME[p.source] : ''}`;
        return `<div class="pp${p.stale ? ' stale' : ''}${fresh('s' + p.id)}" title="${esc(title)}"><div class="av" style="--h:${hue(p.name)}">${esc(initials(p.name))}</div>
            <div class="who2"><div class="nm">${esc(p.name)}</div><div class="tm">${esc(when + pres)}${SRC[p.source] ? `<span class="src">${SRC[p.source]}</span>` : ''}</div></div></div>`;
    }).join('') + out.map(p => `<div class="pp out" title="${esc(p.name)} — not signed in"><div class="av" style="--h:${hue(p.name)}">${esc(initials(p.name))}</div>
            <div class="who2"><div class="nm">${esc(p.name)}</div><div class="tm">out</div></div></div>`).join('')
        || '<p class="muted">No staff signed in.</p>';
    $('#visitors').className = 'fx-vis';
    $('#visitors').innerHTML = list.visitors.map(v => {
        const det = [v.company, v.hostName ? `visiting ${v.hostName}` : '', v.vehicle, v.stale ? `⚠ since ${fmtWhen(v.since)}` : `in ${fmtTime(v.since)} · ${ago(v.since)}`].filter(Boolean).join(' · ');
        return `<div class="vv${fresh('v' + v.id)}"><div class="bdg"><small>BADGE</small><b>${esc(v.badge ?? '–')}</b></div><div><div class="nm">${esc(v.name)}</div><div class="dt">${esc(det)}</div></div></div>`;
    }).join('');
    $('#visitorBlock').classList.toggle('hidden', !list.visitors.length);
    seenIn = now;
}

function renderRows(el, rows, type, marks, active) {
    // Rows keep a fixed order while ticks arrive: re-sorting under a marshal's finger would put a different person's
    // SAFE button where they were about to tap. Status is shown by colour and the counters, not by position.
    el.replaceChildren(...rows.map(item => {
        const mk = marks.get(`${type}:${item.id}`);
        const row = document.createElement('div');
        row.className = `roll-row ${mk ? mk.status : ''}`;
        const detail = type === 'visitor'
            ? [item.stale ? '⚠ signed in before today — may have forgotten to sign out' : '', item.company, item.hostName ? `visiting ${item.hostName}` : null, item.vehicle, `badge ${item.badge}`].filter(Boolean).join(' · ')
            : [item.stale ? '<span class="stale-tag">⚠ signed in before today — may have forgotten to sign out</span>' : '',
            item.presence?.state === 'probably-left' ? `<span class="stale-tag">📵 phone/tag last seen ${fmtTime(item.presence.lastSeen)} — probably already out</span>` : '',
            item.presence?.state === 'here' ? '<span style="color:var(--in)">📱 phone/tag seen inside</span>' : ''].filter(Boolean).join(' · ');
        row.innerHTML = `<div><strong>${esc(item.name)}</strong><small>${type === 'visitor' ? esc(detail) : detail}${detail ? ' · ' : ''}${esc(sinceLabel(item.since))}</small>
      ${mk ? `<small>${mk.status === 'safe' ? '✔ SAFE' : '✖ MISSING'} at ${fmtTime(mk.at)}${mk.by ? ' by ' + esc(mk.by) : ''}</small>` : ''}</div>`;
        if (active && !view?.public) {
            const marksEl = document.createElement('div');
            marksEl.className = 'marks no-print';
            const queued = queue().find(q => q.subjectType === type && q.subjectId === item.id);
            if (queued) { const s = document.createElement('small'); s.className = 'muted'; s.textContent = `⏳ ${queued.status.toUpperCase()} waiting to send`; marksEl.append(s); }
            const safe = button(mk?.status === 'safe' ? 'Undo' : 'SAFE', mk?.status === 'safe' ? 'ghost' : 'primary', () => mark(type, item.id, mk?.status === 'safe' ? 'clear' : 'safe'));
            const missing = button(mk?.status === 'missing' ? 'Undo' : 'MISSING', mk?.status === 'missing' ? 'ghost' : 'danger', () => mark(type, item.id, mk?.status === 'missing' ? 'clear' : 'missing'));
            marksEl.append(safe, missing);
            row.append(marksEl);
        }
        return row;
    }));
}
function button(text, cls, onClick) {
    const b = document.createElement('button'); b.textContent = text; b.className = cls; b.onclick = onClick; return b;
}

// ---- offline ticks: a mark that cannot reach the server is queued on this device and replayed when it can ----
// Marks are "latest status per person", so replaying is naturally idempotent. The queue survives a closed tab.
const QUEUE_KEY = 'fire-pending-marks';
const queue = () => JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]');
const saveQueue = (q) => { localStorage.setItem(QUEUE_KEY, JSON.stringify(q)); showQueue(); };
function showQueue() {
    const n = queue().length;
    let el = $('#queued');
    if (!el) { el = document.createElement('div'); el.id = 'queued'; el.className = 'offline-warning'; $('#offline').after(el); }
    el.classList.toggle('hidden', n === 0);
    el.textContent = n ? `${n} tick${n === 1 ? '' : 's'} waiting to reach the server — they will be sent automatically. Until then, tell the person running the roll call.` : '';
}
async function replayQueue() {
    const q = queue();
    if (!q.length) return;
    const rest = [];
    for (const item of q) {
        try { await api('POST', '/api/fire/mark', item); }
        catch (error) { if (error.status && error.status < 500 && error.status !== 408 && error.status !== 429) continue; rest.push(item); }   // 4xx = roll call ended / not on it: drop, nothing to replay
    }
    saveQueue(rest);
}
async function mark(subjectType, subjectId, status) {
    const body = { subjectType, subjectId, status, by: $('#by').value, rollcallId: view?.rollcall?.id || null };
    try {
        const data = await api('POST', '/api/fire/mark', body);
        render({ ...view, rollcall: data.rollcall });
        if (navigator.vibrate) navigator.vibrate(40);
    } catch (error) {
        if (error.status) return notice($('#notice'), error.message, true);     // the server answered: a real refusal
        // no answer at all: keep the tick, show it on the row, send it when the server is back
        if (!body.rollcallId) return notice($('#notice'), 'Server unreachable and this phone does not know which roll call is open — tell the person running it.', true, 8000);
        saveQueue([...queue().filter(q => !(q.subjectType === subjectType && q.subjectId === subjectId)), body]);
        if (view?.rollcall) {
            const marks = view.rollcall.marks.filter(m => !(m.subjectType === subjectType && m.subjectId === subjectId));
            if (status !== 'clear') marks.push({ subjectType, subjectId, status, at: new Date().toISOString(), by: `${$('#by').value || 'this phone'} (not yet sent)` });
            render({ ...view, rollcall: { ...view.rollcall, marks } });
        }
        notice($('#notice'), 'Server unreachable — tick kept on this phone and will be sent when it returns.', true, 8000);
    }
}

$('#startBtn').onclick = async () => {
    if (!confirm('Start a fire roll call now? This freezes the current register so people can be ticked off at the assembly point.')) return;
    try {
        await api('POST', '/api/fire/start', { source: 'fire-page', by: $('#by').value || localStorage.getItem('marshalName') || '' });
        await load();
    } catch (error) { notice($('#notice'), error.message, true); }
};
$('#drillBtn').onclick = async () => {
    if (!confirm('Start a practice DRILL? It runs exactly like a roll call (Teams cards say DRILL) and is recorded as a drill.')) return;
    try {
        await api('POST', '/api/fire/start', { source: 'fire-page', by: $('#by').value || localStorage.getItem('marshalName') || '', drill: true });
        await load();
    } catch (error) { notice($('#notice'), error.message, true); }
};
$('#endBtn').onclick = async () => {
    const rc = view?.rollcall;
    const warn = rc && (rc.unaccounted + rc.missing) > 0 ? `\n\n${rc.missing} marked MISSING and ${rc.unaccounted} not yet seen.` : '';
    if (!confirm(`End the roll call?${warn}`)) return;
    try { await api('POST', '/api/fire/end', { by: $('#by').value }); await load(); }
    catch (error) { notice($('#notice'), error.message, true); }
};
$('#printBtn').onclick = () => window.print();

async function load() {
    try {
        const data = await api('GET', '/api/fire');
        if (data.cachedBySw) throw Object.assign(new Error('offline'), { cached: data });
        localStorage.setItem(CACHE_KEY, JSON.stringify({ at: new Date().toISOString(), data }));
        const wasActive = view?.rollcall != null;
        offline = false;
        $('#offline').classList.add('hidden');
        $('#live').className = 'live';
        await replayQueue();
        render(data);
        if (Date.now() - peopleAt > 300_000) { peopleAt = Date.now(); loadPeople(); }
        if (data.rollcall && !wasActive) alertUser();
    } catch {
        // Server unreachable — show the last register we saw, clearly labelled. Never a blank page during a fire.
        offline = true;
        $('#live').className = 'live bad';
        const cached = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
        if (cached) {
            $('#offline').textContent = `SERVER UNREACHABLE — showing the last register this device saw at ${fmtWhen(cached.at)}. Ticks you make now are kept on this phone and sent when it returns.`;
            $('#offline').classList.remove('hidden');
            render(cached.data);
        } else {
            $('#offline').textContent = 'Server unreachable and no register has been seen on this device yet.';
            $('#offline').classList.remove('hidden');
        }
    }
}

function alertUser() {
    if (navigator.vibrate) navigator.vibrate([200, 100, 200, 100, 400]);
    if (!audioArmed) return;
    try {
        const ctx = new AudioContext();
        const osc = ctx.createOscillator(); const gain = ctx.createGain();
        osc.frequency.value = 880; gain.gain.value = 0.2;
        osc.connect(gain).connect(ctx.destination); osc.start(); osc.stop(ctx.currentTime + 0.6);
    } catch { }
}
// Browsers only allow sound after a user gesture; arm it on the first tap anywhere.
window.addEventListener('pointerdown', () => { audioArmed = true; }, { once: true });

load();
showQueue();
// Live push for instant ticks across every phone; the 10 s poll stays as the offline detector and cache refresher.
SI.live(load, { fallbackMs: 10_000, debounceMs: 0 });
setInterval(() => { if (view && !view.rollcall && !offline) render(view); }, 60_000);   // keep "· 1h 56m" true
// Offline shell + last register, only where the browser allows it (HTTPS or localhost). Harmless elsewhere.
if ('serviceWorker' in navigator && (location.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(location.hostname))) {
    navigator.serviceWorker.register('/sw.js').then(() => { $('#swState').textContent = 'offline copy: ready'; }).catch(() => { });
} else { $('#swState').textContent = 'offline copy: needs HTTPS'; }
