// Read-only roll call for the fire marshal: who is signed in right now, in big text, from any LAN device.
// No buttons that change the register. If the server is unreachable, shows the last list this device saw.
const CACHE = 'rollcall-last-known';
const roll = document.querySelector('#roll'); const offline = document.querySelector('#offline');
function clock() { document.querySelector('#clock').textContent = new Date().toLocaleString('en-GB', { weekday: 'long', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); } clock(); setInterval(clock, 1000);
function esc(v) { return String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function when(iso) { const d = new Date(iso); const today = d.toDateString() === new Date().toDateString(); return today ? d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : d.toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); }
function render(data, fetchedAt) {
    document.title = `Roll call · ${data.companyName}`; document.querySelector('#company').textContent = data.companyName;
    const inside = data.people.filter(p => p.signedIn).sort((a, b) => a.name.localeCompare(b.name));
    document.querySelector('#in-count').textContent = inside.length;
    roll.replaceChildren(...inside.map(p => {
        const row = document.createElement('div'); row.className = `roll-row ${p.stale ? 'stale' : ''}`;
        row.innerHTML = `<strong>${esc(p.name)}</strong><small>${p.stale ? '⚠ signed in before today — may have forgotten to sign out · ' : ''}since ${esc(when(p.since))}</small>`; return row;
    }));
    if (!inside.length) roll.innerHTML = '<p class="hint">Nobody is signed in.</p>';
    document.querySelector('#updated').textContent = `updated ${new Date(fetchedAt).toLocaleTimeString('en-GB')}`;
}
async function load() {
    try {
        const response = await fetch('/api/state', { cache: 'no-store' }); if (!response.ok) throw Error(); const data = await response.json(); const at = new Date().toISOString();
        localStorage.setItem(CACHE, JSON.stringify({ at, data })); offline.hidden = true; render(data, at);
    }
    catch {
        const cached = JSON.parse(localStorage.getItem(CACHE) || 'null'); offline.hidden = false;
        if (cached) { offline.textContent = `SERVER UNREACHABLE — showing the last list this device saw at ${new Date(cached.at).toLocaleString('en-GB')}.`; render(cached.data, cached.at); }
        else offline.textContent = 'Server unreachable and no list has been seen on this device yet.';
    }
}
document.querySelector('#print').onclick = () => window.print();
load(); setInterval(load, 10000);
