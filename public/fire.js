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

function render(data) {
    view = data;
    const rc = data.rollcall;
    const active = Boolean(rc);
    const list = active ? rc.roster : data.roster;
    const marks = marksFor(rc);

    document.body.classList.toggle('active', active);
    document.title = active ? `ROLL CALL · ${data.companyName}` : `On site · ${data.companyName}`;
    $('#title').textContent = active ? 'FIRE ROLL CALL' : `${data.companyName} — who is on site`;
    $('#bigCount').textContent = active ? rc.total : list.count;
    $('#subtitle').textContent = active
        ? (rc.allSafe
            ? `ALL ${rc.total} ACCOUNTED FOR — everyone on the register is marked SAFE. Started ${fmtWhen(rc.startedAt)}${rc.startedBy ? ' by ' + rc.startedBy : ''}.`
            : `Started ${fmtWhen(rc.startedAt)}${rc.startedBy ? ' by ' + rc.startedBy : ''} (${rc.source}). Register frozen at that moment.`)
        : (list.replica ? `Mirror copy — last update from main server ${fmtWhen(list.at)}` : `Live register at ${fmtTime(list.at)}${list.loneWorker ? ' — LONE WORKER: one member of staff on site' : ''}`);
    document.body.classList.toggle('allsafe', active && Boolean(rc.allSafe));
    $('#startBtn').classList.toggle('hidden', active);
    $('#endBtn').classList.toggle('hidden', !active);
    $('#stats').classList.toggle('hidden', !active);
    $('#byWrap').classList.toggle('hidden', !active);
    if (active) {
        $('#safeCount').textContent = rc.safe;
        $('#missingCount').textContent = rc.missing;
        $('#unaccountedCount').textContent = rc.unaccounted;
    }

    $('#staffHead').textContent = `Staff (${list.staff.length})`;
    $('#visitorHead').textContent = `Visitors (${list.visitors.length})`;
    renderRows($('#staff'), list.staff, 'staff', marks, active);
    renderRows($('#visitors'), list.visitors, 'visitor', marks, active);
    if (!list.staff.length) $('#staff').innerHTML = '<p class="muted">No staff signed in.</p>';
    if (!list.visitors.length) $('#visitors').innerHTML = '<p class="muted">No visitors signed in.</p>';
    $('#updated').textContent = `updated ${fmtTime(new Date().toISOString())}`;
}

function renderRows(el, rows, type, marks, active) {
    el.replaceChildren(...rows.map(item => {
        const mk = marks.get(`${type}:${item.id}`);
        const row = document.createElement('div');
        row.className = `roll-row ${mk ? mk.status : ''}`;
        const detail = type === 'visitor'
            ? [item.company, item.hostName ? `visiting ${item.hostName}` : null, item.vehicle, `badge ${item.badge}`].filter(Boolean).join(' · ')
            : (item.stale ? '<span class="stale-tag">⚠ signed in before today — may have forgotten to sign out</span>' : '');
        row.innerHTML = `<div><strong>${esc(item.name)}</strong><small>${type === 'visitor' ? esc(detail) : detail}${detail ? ' · ' : ''}${esc(sinceLabel(item.since))}</small>
      ${mk ? `<small>${mk.status === 'safe' ? '✔ SAFE' : '✖ MISSING'} at ${fmtTime(mk.at)}${mk.by ? ' by ' + esc(mk.by) : ''}</small>` : ''}</div>`;
        if (active && !offline) {
            const marksEl = document.createElement('div');
            marksEl.className = 'marks no-print';
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

async function mark(subjectType, subjectId, status) {
    try {
        const data = await api('POST', '/api/fire/mark', { subjectType, subjectId, status, by: $('#by').value });
        render({ ...view, rollcall: data.rollcall });
        if (navigator.vibrate) navigator.vibrate(40);
    } catch (error) { notice($('#notice'), error.message, true); }
}

$('#startBtn').onclick = async () => {
    if (!confirm('Start a fire roll call now? This freezes the current register so people can be ticked off at the assembly point.')) return;
    try {
        await api('POST', '/api/fire/start', { source: 'fire-page', by: $('#by').value || localStorage.getItem('marshalName') || '' });
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
        localStorage.setItem(CACHE_KEY, JSON.stringify({ at: new Date().toISOString(), data }));
        const wasActive = view?.rollcall != null;
        offline = false;
        $('#offline').classList.add('hidden');
        $('#live').className = 'live';
        render(data);
        if (data.rollcall && !wasActive) alertUser();
    } catch {
        // Server unreachable — show the last register we saw, clearly labelled. Never a blank page during a fire.
        offline = true;
        $('#live').className = 'live bad';
        const cached = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
        if (cached) {
            $('#offline').textContent = `SERVER UNREACHABLE — showing the last register this device saw at ${fmtWhen(cached.at)}. Ticks are disabled until it returns.`;
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
setInterval(load, 5000);
