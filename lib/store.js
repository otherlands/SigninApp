'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { randomUUID } = require('node:crypto');

const SCHEMA = `
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS people (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, card_uid TEXT UNIQUE,
    active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS visitors (
    id TEXT PRIMARY KEY, badge INTEGER NOT NULL, name TEXT NOT NULL, company TEXT,
    host_id TEXT, host_name TEXT, vehicle TEXT, signed_in_at TEXT NOT NULL, signed_out_at TEXT
  );
  CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY, event_key TEXT UNIQUE, kind TEXT NOT NULL,
    subject_type TEXT, subject_id TEXT, subject_name TEXT,
    at TEXT NOT NULL, source TEXT NOT NULL, device TEXT, note TEXT
  );
  CREATE INDEX IF NOT EXISTS events_subject ON events (subject_type, subject_id, at DESC);
  CREATE INDEX IF NOT EXISTS events_at ON events (at);
  CREATE TABLE IF NOT EXISTS rollcalls (
    id TEXT PRIMARY KEY, started_at TEXT NOT NULL, ended_at TEXT, started_by TEXT, source TEXT,
    roster_json TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS rollcall_marks (
    rollcall_id TEXT NOT NULL REFERENCES rollcalls(id), subject_type TEXT NOT NULL, subject_id TEXT NOT NULL,
    status TEXT NOT NULL, at TEXT NOT NULL, by TEXT,
    PRIMARY KEY (rollcall_id, subject_type, subject_id)
  );
  CREATE TABLE IF NOT EXISTS outbox (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, payload TEXT NOT NULL, created_at TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0
  );
`;

const now = () => new Date().toISOString();

class Store {
    constructor(file) {
        if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
        this.db = new DatabaseSync(file);
        this.db.exec(SCHEMA);
        if (!this.getSetting('companyName')) this.setSetting('companyName', 'eRIGHT Ltd');
        if (!this.getSetting('fireNotice')) {
            this.setSetting('fireNotice', 'On hearing the alarm leave by the nearest exit and go to the assembly point. Do not stop to sign out.');
        }
    }

    // ---- settings -------------------------------------------------------
    getSetting(key, fallback = null) {
        const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
        return row ? JSON.parse(row.value) : fallback;
    }
    setSetting(key, value) {
        this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
            .run(key, JSON.stringify(value));
    }

    // ---- people ---------------------------------------------------------
    listPeople(includeInactive = false) {
        const sql = includeInactive ? 'SELECT * FROM people ORDER BY name' : 'SELECT * FROM people WHERE active = 1 ORDER BY name';
        return this.db.prepare(sql).all().map(rowToPerson);
    }
    getPerson(id) {
        const row = this.db.prepare('SELECT * FROM people WHERE id = ?').get(id);
        return row ? rowToPerson(row) : null;
    }
    getPersonByCard(uid) {
        const row = this.db.prepare('SELECT * FROM people WHERE card_uid = ? AND active = 1').get(normaliseUid(uid));
        return row ? rowToPerson(row) : null;
    }
    addPerson(name) {
        const person = { id: randomUUID(), name, cardUid: null, active: true, createdAt: now() };
        this.db.prepare('INSERT INTO people (id, name, card_uid, active, created_at) VALUES (?, ?, NULL, 1, ?)')
            .run(person.id, person.name, person.createdAt);
        return person;
    }
    updatePerson(id, patch) {
        const current = this.getPerson(id);
        if (!current) return null;
        const name = patch.name !== undefined ? patch.name : current.name;
        const cardUid = patch.cardUid !== undefined ? (patch.cardUid ? normaliseUid(patch.cardUid) : null) : current.cardUid;
        const active = patch.active !== undefined ? (patch.active ? 1 : 0) : (current.active ? 1 : 0);
        this.db.prepare('UPDATE people SET name = ?, card_uid = ?, active = ? WHERE id = ?').run(name, cardUid, active, id);
        return this.getPerson(id);
    }

    // ---- visitors -------------------------------------------------------
    listVisitors({ presentOnly = true, since = null } = {}) {
        let sql = 'SELECT * FROM visitors';
        const args = [];
        if (presentOnly) sql += ' WHERE signed_out_at IS NULL';
        else if (since) { sql += ' WHERE signed_in_at >= ?'; args.push(since); }
        sql += ' ORDER BY signed_in_at DESC';
        return this.db.prepare(sql).all(...args).map(rowToVisitor);
    }
    getVisitor(id) {
        const row = this.db.prepare('SELECT * FROM visitors WHERE id = ?').get(id);
        return row ? rowToVisitor(row) : null;
    }
    nextBadge(localDayStartIso) {
        const row = this.db.prepare('SELECT COALESCE(MAX(badge), 0) AS m FROM visitors WHERE signed_in_at >= ?').get(localDayStartIso);
        return Number(row.m) + 1;
    }
    addVisitor({ name, company, host, vehicle, badge, at }) {
        const visitor = {
            id: randomUUID(), badge, name, company: company || null,
            hostId: host?.id || null, hostName: host?.name || null, vehicle: vehicle || null,
            signedInAt: at, signedOutAt: null
        };
        this.db.prepare(`INSERT INTO visitors (id, badge, name, company, host_id, host_name, vehicle, signed_in_at, signed_out_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`)
            .run(visitor.id, visitor.badge, visitor.name, visitor.company, visitor.hostId, visitor.hostName, visitor.vehicle, visitor.signedInAt);
        return visitor;
    }
    signOutVisitor(id, at) {
        this.db.prepare('UPDATE visitors SET signed_out_at = ? WHERE id = ? AND signed_out_at IS NULL').run(at, id);
        return this.getVisitor(id);
    }

    // ---- events ---------------------------------------------------------
    latestPresenceEvent(personId) {
        const row = this.db.prepare(
            `SELECT * FROM events WHERE subject_type = 'staff' AND subject_id = ? AND kind IN ('in','out') ORDER BY at DESC, rowid DESC LIMIT 1`
        ).get(personId);
        return row ? rowToEvent(row) : null;
    }
    addEvent(event) {
        // node:sqlite refuses to bind undefined, so drop those keys before applying defaults
        const given = Object.fromEntries(Object.entries(event).filter(([, v]) => v !== undefined));
        const full = { id: randomUUID(), eventKey: null, subjectType: null, subjectId: null, subjectName: null, device: null, note: null, at: now(), ...given };
        if (full.eventKey) {
            const existing = this.db.prepare('SELECT * FROM events WHERE event_key = ?').get(full.eventKey);
            if (existing) return { event: rowToEvent(existing), duplicate: true };
        }
        this.db.prepare(`INSERT INTO events (id, event_key, kind, subject_type, subject_id, subject_name, at, source, device, note)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(full.id, full.eventKey, full.kind, full.subjectType, full.subjectId, full.subjectName, full.at, full.source, full.device, full.note);
        return { event: full, duplicate: false };
    }
    listEvents({ from = null, to = null, limit = 200 } = {}) {
        const where = [];
        const args = [];
        if (from) { where.push('at >= ?'); args.push(from); }
        if (to) { where.push('at < ?'); args.push(to); }
        const sql = `SELECT * FROM events ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY at DESC, rowid DESC LIMIT ?`;
        return this.db.prepare(sql).all(...args, limit).map(rowToEvent);
    }

    // ---- roll calls -----------------------------------------------------
    openRollcall() {
        const row = this.db.prepare('SELECT * FROM rollcalls WHERE ended_at IS NULL ORDER BY started_at DESC LIMIT 1').get();
        return row ? this.rollcallWithMarks(row) : null;
    }
    getRollcall(id) {
        const row = this.db.prepare('SELECT * FROM rollcalls WHERE id = ?').get(id);
        return row ? this.rollcallWithMarks(row) : null;
    }
    rollcallWithMarks(row) {
        const marks = this.db.prepare('SELECT * FROM rollcall_marks WHERE rollcall_id = ?').all(row.id)
            .map(m => ({ subjectType: m.subject_type, subjectId: m.subject_id, status: m.status, at: m.at, by: m.by }));
        return { id: row.id, startedAt: row.started_at, endedAt: row.ended_at, startedBy: row.started_by, source: row.source, roster: JSON.parse(row.roster_json), marks };
    }
    startRollcall({ roster, startedBy, source, at }) {
        const id = randomUUID();
        this.db.prepare('INSERT INTO rollcalls (id, started_at, ended_at, started_by, source, roster_json) VALUES (?, ?, NULL, ?, ?, ?)')
            .run(id, at, startedBy || null, source || null, JSON.stringify(roster));
        return this.getRollcall(id);
    }
    markRollcall(rollcallId, { subjectType, subjectId, status, by, at }) {
        this.db.prepare(`INSERT INTO rollcall_marks (rollcall_id, subject_type, subject_id, status, at, by) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(rollcall_id, subject_type, subject_id) DO UPDATE SET status = excluded.status, at = excluded.at, by = excluded.by`)
            .run(rollcallId, subjectType, subjectId, status, at, by || null);
        return this.getRollcall(rollcallId);
    }
    endRollcall(id, at) {
        this.db.prepare('UPDATE rollcalls SET ended_at = ? WHERE id = ? AND ended_at IS NULL').run(at, id);
        return this.getRollcall(id);
    }
    listRollcalls(limit = 20) {
        return this.db.prepare('SELECT * FROM rollcalls ORDER BY started_at DESC LIMIT ?').all(limit).map(r => this.rollcallWithMarks(r));
    }

    // ---- outbox (mirror queue) -----------------------------------------
    enqueueOutbox(payload) {
        this.db.prepare('INSERT INTO outbox (payload, created_at) VALUES (?, ?)').run(JSON.stringify(payload), now());
    }
    peekOutbox(limit = 20) {
        return this.db.prepare('SELECT * FROM outbox ORDER BY seq LIMIT ?').all(limit).map(r => ({ seq: r.seq, payload: JSON.parse(r.payload), attempts: r.attempts }));
    }
    ackOutbox(seq) { this.db.prepare('DELETE FROM outbox WHERE seq = ?').run(seq); }
    failOutbox(seq) { this.db.prepare('UPDATE outbox SET attempts = attempts + 1 WHERE seq = ?').run(seq); }
    outboxDepth() { return Number(this.db.prepare('SELECT COUNT(*) AS c FROM outbox').get().c); }

    close() { this.db.close(); }
}

function normaliseUid(uid) {
    return String(uid).replace(/[^0-9a-z]/gi, '').toUpperCase();
}
function rowToPerson(r) {
    return { id: r.id, name: r.name, cardUid: r.card_uid, active: r.active === 1, createdAt: r.created_at };
}
function rowToVisitor(r) {
    return { id: r.id, badge: r.badge, name: r.name, company: r.company, hostId: r.host_id, hostName: r.host_name, vehicle: r.vehicle, signedInAt: r.signed_in_at, signedOutAt: r.signed_out_at };
}
function rowToEvent(r) {
    return { id: r.id, eventKey: r.event_key, kind: r.kind, subjectType: r.subject_type, subjectId: r.subject_id, subjectName: r.subject_name, at: r.at, source: r.source, device: r.device, note: r.note };
}

module.exports = { Store, normaliseUid };
