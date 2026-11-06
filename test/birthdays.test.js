'use strict';
// Birthdays on the door screen: saved per person as day + month (no year), celebrated by itself every year;
// an admin can tick someone for today or untick an automatic one; the kiosk view only ever carries TODAY's names.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createApp } = require('../lib/app');

const NO_ENV = { apiToken: '', mirrorUrl: '', mirrorToken: '', teamsWebhookUrl: '', publicUrl: '', replica: false, sharepoint: {}, unifi: {}, backupDir: '', silent: true, env: {} };
async function boot(options = {}) {
    const app = createApp({ dataFile: ':memory:', adminPin: 'pin', ...NO_ENV, ...options });
    const server = http.createServer((req, res) => app.handle(req, res));
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (method, p, body, headers = {}) => {
        const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body && method !== 'GET' ? JSON.stringify(body) : undefined });
        const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch { }
        return { status: res.status, json, text };
    };
    return { app, call, close: () => new Promise(r => { app.close(); server.closeAllConnections?.(); server.close(() => r()); }) };
}
const A = { 'X-Admin-Pin': 'pin' };
const names = (st) => st.birthdays.map(b => b.name).sort();

test('birthdays: saved day+month celebrates every year by itself; today tick/untick; 29 Feb; privacy; admin only', async () => {
    let now = '2026-11-06T12:00:00Z';
    const { app, call, close } = await boot({ now: () => new Date(now) });
    try {
        const george = app.store.addPerson('George Scoley'); const sam = app.store.addPerson('Sam Birch'); const ann = app.store.addPerson('Ann Leap');

        // admin only
        assert.equal((await call('PUT', `/api/people/${george.id}/birthday`, { date: '11-06' })).status, 401);
        assert.equal((await call('GET', '/api/birthdays')).status, 401);

        // validation: MM-DD and a real day of that month (29 Feb allowed)
        for (const bad of ['6/11', '11-6', '13-01', '02-30', '04-31', '00-10']) assert.equal((await call('PUT', `/api/people/${george.id}/birthday`, { date: bad }, A)).status, 400, bad);

        let r = await call('PUT', `/api/people/${george.id}/birthday`, { date: '11-06' }, A);
        assert.equal(r.status, 200);
        assert.deepEqual(r.json.staffBirthdays, { [george.id]: '11-06' });
        await call('PUT', `/api/people/${sam.id}/birthday`, { date: '12-14' }, A);
        await call('PUT', `/api/people/${ann.id}/birthday`, { date: '02-29' }, A);
        assert.deepEqual(await (await call('GET', '/api/birthdays', undefined, A)).json, { [george.id]: '11-06', [sam.id]: '12-14', [ann.id]: '02-29' });

        // today: George, automatically. The public kiosk view names only today's birthday, never the saved dates.
        let st = (await call('GET', '/api/state')).json;
        assert.deepEqual(names(st), ['George Scoley']);
        const text = (await call('GET', '/api/state')).text;
        assert.ok(!text.includes('12-14') && !text.includes('02-29') && !text.includes('staffBirthdays'), 'saved dates never reach the kiosk view');

        // untick today's automatic celebration; tick Sam for today as a one-off
        await call('PUT', `/api/people/${george.id}/birthday`, { on: false }, A);
        await call('PUT', `/api/people/${sam.id}/birthday`, { on: true }, A);
        st = (await call('GET', '/api/state')).json;
        assert.deepEqual(names(st), ['Sam Birch']);
        const log = app.store.listEvents({ limit: 20 }).map(e => e.note).join(' | ');
        assert.match(log, /birthday saved for George Scoley/);
        assert.match(log, /birthday celebration off for George Scoley \(today only\)/);
        assert.match(log, /birthday celebration ON for Sam Birch \(today only\)/);

        // the manual switches are today only
        now = '2026-11-07T08:00:00Z';
        assert.deepEqual(names((await call('GET', '/api/state')).json), []);
        // Sam's real day
        now = '2026-12-14T09:00:00Z';
        assert.deepEqual(names((await call('GET', '/api/state')).json), ['Sam Birch']);
        // next year George is celebrated again with nobody touching anything
        now = '2027-11-06T09:00:00Z';
        assert.deepEqual(names((await call('GET', '/api/state')).json), ['George Scoley']);
        // 29 Feb: on 28 Feb in a non-leap year, on the 29th in a leap year (and not on the 28th)
        now = '2027-02-28T12:00:00Z';
        assert.deepEqual(names((await call('GET', '/api/state')).json), ['Ann Leap']);
        now = '2028-02-28T12:00:00Z';
        assert.deepEqual(names((await call('GET', '/api/state')).json), []);
        now = '2028-02-29T12:00:00Z';
        assert.deepEqual(names((await call('GET', '/api/state')).json), ['Ann Leap']);

        // clearing and removing forget the date
        await call('PUT', `/api/people/${sam.id}/birthday`, { date: '' }, A);
        await call('DELETE', `/api/people/${ann.id}`, undefined, A);
        assert.deepEqual((await call('GET', '/api/birthdays', undefined, A)).json, { [george.id]: '11-06' });

        // a roll call still carries the names (the kiosk hides the party while one is open)
        now = '2028-11-06T09:00:00Z';
        assert.deepEqual(names((await call('GET', '/api/state')).json), ['George Scoley']);
    } finally { await close(); }
});
