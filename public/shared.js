// Shared helpers for every page. Plain script, no build step.
window.SI = (() => {
    const $ = (sel, root = document) => root.querySelector(sel);
    const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const fmtTime = (iso) => iso ? new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '';
    const fmtWhen = (iso) => iso ? new Date(iso).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
    const isToday = (iso) => iso && new Date(iso).toDateString() === new Date().toDateString();
    const sinceLabel = (iso) => isToday(iso) ? `since ${fmtTime(iso)}` : `since ${fmtWhen(iso)}`;

    const adminPin = { get: () => sessionStorage.getItem('adminPin') || '', set: (v) => sessionStorage.setItem('adminPin', v) };

    async function api(method, path, body, extraHeaders = {}) {
        const headers = { 'Content-Type': 'application/json', 'X-Device': deviceName(), ...extraHeaders };
        if (adminPin.get()) headers['X-Admin-Pin'] = adminPin.get();
        const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
        const text = await res.text();
        let data = null;
        try { data = JSON.parse(text); } catch { data = { raw: text }; }
        if (!res.ok) {
            const err = new Error(data?.error || `HTTP ${res.status}`);
            err.status = res.status; err.data = data;
            throw err;
        }
        return data;
    }

    function deviceName() {
        let name = localStorage.getItem('deviceName');
        if (!name) {
            name = `${location.pathname.replace('/', '') || 'kiosk'}-${Math.random().toString(36).slice(2, 6)}`;
            localStorage.setItem('deviceName', name);
        }
        return name;
    }

    function startClock(el) {
        const tick = () => { el.textContent = new Date().toLocaleString('en-GB', { weekday: 'long', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); };
        tick(); setInterval(tick, 1000);
    }

    function notice(el, text, isError = false, ms = 5000, action = null) {
        el.textContent = text;
        if (action) {
            const b = document.createElement('button');
            b.className = 'small ghost'; b.style.marginLeft = '12px'; b.textContent = action.label;
            b.onclick = () => { el.textContent = ''; action.run(); };
            el.append(b);
        }
        el.classList.toggle('error', isError);
        clearTimeout(el._t);
        if (ms) el._t = setTimeout(() => { el.textContent = ''; el.classList.remove('error'); }, ms);
    }

    /**
     * Live updates: the server sends "change" over /api/stream whenever the register changes; `onChange` reloads the
     * page's view (debounced). Polling every `fallbackMs` stays on as the safety net if the stream drops.
     */
    function live(onChange, { fallbackMs = 60_000, debounceMs = 150 } = {}) {
        let t = null;
        // debounceMs 0 = act immediately (background tabs clamp timers to >= 1 s, too slow for a roll call).
        const kick = debounceMs ? () => { clearTimeout(t); t = setTimeout(onChange, debounceMs); } : () => onChange();
        // A stream holds one of the browser's ~6 connections to this server, so only VISIBLE tabs keep one open:
        // a pile of hidden tabs (each Teams "Open the roll call" click opens one) must not starve the fire page's ticks.
        let es = null;
        const open = () => {
            if (es || !('EventSource' in window)) return;
            es = new EventSource('/api/stream');
            es.addEventListener('change', kick);
            es.addEventListener('hello', kick);    // (re)connected: catch up at once
        };
        const shut = () => { if (es) { es.close(); es = null; } };
        document.addEventListener('visibilitychange', () => (document.visibilityState === 'visible' ? open() : shut()));
        window.addEventListener('pagehide', shut);
        if (document.visibilityState !== 'hidden') open();
        setInterval(onChange, fallbackMs);
    }

    /**
     * USB "keyboard wedge" card readers type the card UID as fast keystrokes ending in Enter.
     * We collect bursts of ≥4 keys arriving <120 ms apart and hand the UID to onCard.
     * Typing in a real input field is ignored so forms still work.
     */
    function listenForCardWedge(onCard, statusEl) {
        let buffer = ''; let last = 0;
        window.addEventListener('keydown', (e) => {
            const target = e.target;
            if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
            const now = performance.now();
            if (now - last > 120) buffer = '';
            last = now;
            if (e.key === 'Enter') {
                if (buffer.length >= 4) { onCard(buffer); }
                buffer = '';
                return;
            }
            if (e.key.length === 1) buffer += e.key;
        });
        if (statusEl) statusEl.textContent = 'Card reader: ready (USB keyboard-wedge)';
    }

    return { $, esc, fmtTime, fmtWhen, sinceLabel, isToday, api, adminPin, startClock, notice, live, listenForCardWedge, deviceName };
})();
