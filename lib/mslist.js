'use strict';
// Keeps a Microsoft List ("who is on site") in step with the register through Microsoft Graph, using the same app
// registration as the SharePoint copy (SP_* + SP_LIST). Unlike the files, a List is readable AND editable on every
// staff phone in the Teams/SharePoint app with the building dark — the first step towards off-site ticking.
// One row per person on site (Key = type:id) and one `_status` row for the roll call. Idempotent: rows are patched,
// added or deleted to match; nothing is appended on every change.
// NOT yet exercised against a real tenant (the app registration does not exist at the time of writing); the Graph
// calls are the documented v1.0 list-item endpoints and are pinned by test/v4.test.js against a fake Graph.
const { SharePointSink } = require('./sharepoint');

const COLUMNS = [
    { name: 'Key', text: {} }, { name: 'Kind', text: {} }, { name: 'Status', text: {} },
    { name: 'Since', text: {} }, { name: 'Detail', text: {} }, { name: 'UpdatedAt', text: {} }
];

class MsListSink extends SharePointSink {
    constructor(options = {}) {
        super(options);
        this.list = String(options.list || '').trim();
        this._listUrl = null;
    }
    get configured() { return super.configured && Boolean(this.list); }
    describe() { return { configured: this.configured, site: this.site, list: this.list }; }

    async listUrl() {
        if (this._listUrl) return this._listUrl;
        const siteId = (await (await this.graph(`/sites/${this.site}`)).json()).id;
        if (!siteId) throw new Error('site lookup returned no id');
        const lists = (await (await this.graph(`/sites/${siteId}/lists?$select=id,displayName`)).json()).value || [];
        let match = lists.find(l => l.displayName === this.list);
        if (!match) {
            match = await (await this.graph(`/sites/${siteId}/lists`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ displayName: this.list, columns: COLUMNS, list: { template: 'genericList' } })
            })).json();
        }
        this._listUrl = `/sites/${siteId}/lists/${match.id}`;
        return this._listUrl;
    }

    /** Desired rows from the roster + roll call. */
    static rows({ roster, rollcall, companyName, at }) {
        const rows = new Map();
        const title = rollcall ? `${rollcall.drill ? 'DRILL' : 'FIRE ROLL CALL'} IN PROGRESS — ${rollcall.safe} safe / ${rollcall.missing} missing / ${rollcall.unaccounted} not seen of ${rollcall.total}` : `${roster.count} on site`;
        rows.set('_status', { Title: title, Kind: 'status', Status: rollcall ? 'rollcall' : 'normal', Since: rollcall ? rollcall.startedAt : roster.at, Detail: `${companyName} · staff ${roster.staff.length}, visitors ${roster.visitors.length}`, UpdatedAt: at });
        const markOf = (type, id) => rollcall?.marks.find(m => m.subjectType === type && m.subjectId === id)?.status || null;
        for (const s of roster.staff) rows.set(`staff:${s.id}`, { Title: s.name, Kind: 'staff', Status: markOf('staff', s.id) || (s.stale ? 'overdue sign-out' : 'on site'), Since: s.since, Detail: s.presence?.state === 'probably-left' ? 'phone/tag absent: probably left' : (s.source || ''), UpdatedAt: at });
        for (const v of roster.visitors) rows.set(`visitor:${v.id}`, { Title: v.name, Kind: 'visitor', Status: markOf('visitor', v.id) || (v.stale ? 'overdue sign-out' : 'on site'), Since: v.since, Detail: [v.company, v.hostName ? `visiting ${v.hostName}` : null, `badge ${v.badge}`].filter(Boolean).join(' · '), UpdatedAt: at });
        // People on a frozen register who have since signed out stay listed until the roll call ends.
        if (rollcall) for (const e of [...rollcall.roster.staff, ...rollcall.roster.visitors]) {
            const key = `${e.type}:${e.id}`;
            if (!rows.has(key)) rows.set(key, { Title: e.name, Kind: e.type, Status: markOf(e.type, e.id) || 'on register (signed out since)', Since: e.since, Detail: 'on the frozen roll-call register', UpdatedAt: at });
        }
        return rows;
    }

    async sync(view) {
        const base = await this.listUrl();
        const wanted = MsListSink.rows(view);
        const existing = (await (await this.graph(`${base}/items?$expand=fields($select=Key,Title,Kind,Status,Since,Detail)&$top=999`)).json()).value || [];
        const byKey = new Map(existing.filter(i => i.fields?.Key).map(i => [i.fields.Key, i]));
        let added = 0, updated = 0, removed = 0;
        for (const [key, fields] of wanted) {
            const cur = byKey.get(key);
            if (!cur) { await this.graph(`${base}/items`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fields: { Key: key, ...fields } }) }); added++; continue; }
            const diff = ['Title', 'Kind', 'Status', 'Since', 'Detail'].some(k => (cur.fields[k] || '') !== (fields[k] || ''));
            if (diff) { await this.graph(`${base}/items/${cur.id}/fields`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(fields) }); updated++; }
        }
        for (const [key, item] of byKey) if (!wanted.has(key)) { await this.graph(`${base}/items/${item.id}`, { method: 'DELETE' }); removed++; }
        return { added, updated, removed, rows: wanted.size };
    }
}

module.exports = { MsListSink };
