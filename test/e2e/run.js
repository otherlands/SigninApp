'use strict';
// End-to-end: real headless Chrome/Edge driven over the DevTools protocol against an in-process server.
// Proves, in a real browser, the four journeys unit tests cannot:
//   1. kiosk: name search filters the buttons; tapping signs the person in
//   2. fire page: a marshal's SAFE tick reaches the register
//   3. "I'm SAFE" page: identity from /safe#k=… — the key is never in any URL the server sees, and stays in the
//      address bar (so "Add to Home Screen" keeps it)
//   4. offline: with the service worker installed and the server DOWN, /fire still opens with the last register,
//      a tick is queued on the device, and it lands on the register when the server comes back
// Run: npm run e2e   (CHROME_PATH=... to choose the browser). No npm dependencies: Node's global WebSocket + fetch.
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { createApp } = require('../../lib/app');

const PIN = '135790';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function findBrowser() {
    if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
    const candidates = process.platform === 'win32'
        ? [`${process.env['ProgramFiles(x86)']}\\Microsoft\\Edge\\Application\\msedge.exe`, `${process.env.ProgramFiles}\\Microsoft\\Edge\\Application\\msedge.exe`, `${process.env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe`]
        : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
    for (const c of candidates) if (c && fs.existsSync(c)) return c;
    for (const name of ['google-chrome', 'chromium', 'chromium-browser']) { try { return execFileSync('which', [name]).toString().trim(); } catch { } }
    throw new Error('No Chrome/Edge found: set CHROME_PATH');
}

async function cdpPage(port, url) {
    const target = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })).json();
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    let id = 0; const waiting = new Map();
    ws.onmessage = (m) => { const msg = JSON.parse(m.data); if (msg.id && waiting.has(msg.id)) { waiting.get(msg.id)(msg); waiting.delete(msg.id); } };
    const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; waiting.set(i, (msg) => msg.error ? rej(new Error(`${method}: ${msg.error.message}`)) : res(msg.result)); ws.send(JSON.stringify({ id: i, method, params })); });
    const evaluate = async (expression) => {
        const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
        if (r.exceptionDetails) throw new Error(`page threw: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
        return r.result.value;
    };
    const until = async (expression, what, ms = 15_000) => {
        const end = Date.now() + ms; let last;
        while (Date.now() < end) { try { last = await evaluate(expression); if (last) return last; } catch (e) { last = e.message; } await sleep(150); }
        throw new Error(`timed out waiting for ${what} (last: ${JSON.stringify(last)})`);
    };
    await send('Runtime.enable'); await send('Page.enable');
    return { send, evaluate, until, reload: () => send('Page.reload', {}), close: () => ws.close() };
}

async function main() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'signin-e2e-'));
    const app = createApp({ dataFile: path.join(dir, 'e2e.sqlite'), adminPin: PIN, apiToken: '', mirrorUrl: '', mirrorToken: '', teamsWebhookUrl: '', publicUrl: '', replica: false, sharepoint: {}, unifi: {}, backupDir: '', silent: true, env: {} });
    const seenUrls = [];
    let server = null; let port = 0;
    const listen = () => new Promise(r => { server = http.createServer((req, res) => { seenUrls.push(req.url); app.handle(req, res); }); server.listen(port, '127.0.0.1', () => { port = server.address().port; r(); }); });
    const stop = () => new Promise(r => { server.closeAllConnections?.(); server.close(() => r()); });
    await listen();
    const base = `http://127.0.0.1:${port}`;
    const api = async (method, p, body, headers = {}) => { const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', 'X-Admin-Pin': PIN, ...headers }, body: body ? JSON.stringify(body) : undefined }); return res.json(); };

    const profile = path.join(dir, 'profile');
    const browser = spawn(findBrowser(), ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-gpu', ...(process.platform === 'linux' ? ['--no-sandbox'] : []), 'about:blank'], { stdio: 'ignore' });
    const results = [];
    const step = async (name, fn) => { const t0 = Date.now(); try { await fn(); results.push([true, name]); console.log(`  ok   ${name} (${Date.now() - t0} ms)`); } catch (e) { results.push([false, name]); console.log(`  FAIL ${name}\n       ${e.message}`); } };
    try {
        let cdpPort = 0;
        for (let i = 0; i < 100 && !cdpPort; i++) { try { cdpPort = Number(fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch { await sleep(100); } }
        if (!cdpPort) throw new Error('browser did not open its DevTools port');

        const ann = app.store.addPerson('Ann Example'); const bob = app.store.addPerson('Bob Sample'); app.store.addPerson('Cara Third');

        await step('kiosk: search narrows the names, tapping signs in', async () => {
            const page = await cdpPage(cdpPort, `${base}/`);
            await page.until(`document.querySelectorAll('#people .person').length === 3`, 'three staff buttons');
            await page.evaluate(`(() => { const s = document.querySelector('#search'); s.value = 'ann'; s.dispatchEvent(new Event('input')); })()`);
            const visible = await page.evaluate(`[...document.querySelectorAll('#people .person:not(.hidden)')].map(b => b.dataset.name)`);
            if (visible.length !== 1 || visible[0] !== 'ann example') throw new Error(`visible after search: ${JSON.stringify(visible)}`);
            await page.evaluate(`document.querySelector('#people .person:not(.hidden)').click()`);
            await page.until(`document.querySelector('#people .person.in') !== null`, 'Ann shown as in');
            const st = await api('GET', '/api/state');
            if (!st.people.find(p => p.id === ann.id).signedIn) throw new Error('Ann not signed in on the server');
            page.close();
        });
        await api('POST', '/api/sign', { personId: bob.id, source: 'admin' });
        const rc = (await api('POST', '/api/fire/start', { source: 'fire-page', by: 'e2e' })).rollcall;

        await step('fire page: a marshal SAFE tick reaches the register', async () => {
            const page = await cdpPage(cdpPort, `${base}/fire`);
            await page.until(`[...document.querySelectorAll('#staff .roll-row')].length === 2`, 'two rows on the roll call');
            await page.evaluate(`[...document.querySelectorAll('#staff .roll-row')].find(r => r.textContent.includes('Ann Example')).querySelector('button.primary').click()`);
            await page.until(`document.querySelector('#safeCount').textContent === '1'`, 'safe count 1');
            const marks = app.store.getRollcall(rc.id).marks;
            if (!marks.some(m => m.subjectId === ann.id && m.status === 'safe' && m.via === 'fire-page')) throw new Error(JSON.stringify(marks));
            page.close();
        });

        await step('"I\'m SAFE" page: identity from #k=, key never in a URL the server sees, kept in the address bar', async () => {
            const link = (await api('POST', `/api/people/${bob.id}/safe-link`, {})).link;
            const key = new URLSearchParams(link.split('#')[1]).get('k');
            if (!key || !link.startsWith('/safe#k=')) throw new Error(`link ${link}`);
            const page = await cdpPage(cdpPort, `${base}${link}`);
            await page.until(`document.querySelector('#heading').textContent === 'Bob Sample'`, 'the page names Bob');
            await page.evaluate(`document.querySelector('#picker button.person').click()`);
            await page.until(`/marked SAFE/.test(document.querySelector('#message').textContent)`, 'confirmation');
            const hash = await page.evaluate('location.hash');
            if (!hash.includes(key)) throw new Error(`fragment not kept: ${hash}`);
            const leaked = seenUrls.filter(u => u.includes(key));
            if (leaked.length) throw new Error(`key seen in request URLs: ${leaked.join(', ')}`);
            const m = app.store.getRollcall(rc.id).marks.find(x => x.subjectId === bob.id);
            if (m?.status !== 'safe' || m.via !== 'self') throw new Error(JSON.stringify(m));
            page.close();
        });

        await step('offline: server down -> /fire opens from the service worker with the last register; a queued tick lands when it returns', async () => {
            await api('POST', '/api/fire/mark', { subjectType: 'staff', subjectId: bob.id, status: 'clear', by: 'e2e' });
            const page = await cdpPage(cdpPort, `${base}/fire`);
            await page.until(`navigator.serviceWorker && navigator.serviceWorker.ready.then(() => true)`, 'service worker ready');
            await page.reload();
            await page.until(`navigator.serviceWorker.controller !== null`, 'page controlled by the service worker');
            await page.until(`[...document.querySelectorAll('#staff .roll-row')].length === 2`, 'register loaded through the worker');
            await stop();
            await page.reload();
            await page.until(`/SERVER UNREACHABLE/.test(document.querySelector('#offline').textContent) && !document.querySelector('#offline').classList.contains('hidden')`, 'offline banner');
            await page.until(`[...document.querySelectorAll('#staff .roll-row')].some(r => r.textContent.includes('Bob Sample'))`, 'cached register shows Bob');
            await page.evaluate(`[...document.querySelectorAll('#staff .roll-row')].find(r => r.textContent.includes('Bob Sample')).querySelector('button.danger').click()`);
            await page.until(`/1 tick waiting/.test(document.querySelector('#queued')?.textContent || '')`, 'tick queued on the device');
            await listen();
            await page.until(`!document.querySelector('#queued') || document.querySelector('#queued').classList.contains('hidden')`, 'queue drained', 30_000);
            const m = app.store.getRollcall(rc.id).marks.find(x => x.subjectId === bob.id);
            if (m?.status !== 'missing') throw new Error(`Bob's mark after reconnect: ${JSON.stringify(m)}`);
            page.close();
        });
    } finally {
        browser.kill();
        await sleep(300);
        try { await stop(); } catch { }
        app.close();
        for (let i = 0; i < 10; i++) { try { fs.rmSync(dir, { recursive: true, force: true }); break; } catch { await sleep(300); } }
    }
    const failed = results.filter(r => !r[0]).length;
    console.log(`e2e: ${results.length - failed} passed, ${failed} failed`);
    if (failed || !results.length) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
