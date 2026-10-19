'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { randomUUID, randomBytes, createHash } = require('node:crypto');

const SCHEMA_V1 = `
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
  CREATE TABLE IF NOT EXISTS expected_visitors (
    id TEXT PRIMARY KEY, day TEXT NOT NULL, name TEXT NOT NULL, company TEXT, host_id TEXT, host_name TEXT,
    vehicle TEXT, note TEXT, created_at TEXT NOT NULL, arrived_visitor_id TEXT, arrived_at TEXT
  );
  CREATE INDEX IF NOT EXISTS expected_day ON expected_visitors (day);
  CREATE TABLE IF NOT EXISTS sightings (
    id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, ident TEXT NOT NULL, scanner TEXT NOT NULL,
    rssi INTEGER, at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sightings_ident ON sightings (ident, at DESC);
  CREATE INDEX IF NOT EXISTS sightings_at ON sightings (at);
`;
const hasColumn = (db, table, column) => db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === column);
const addColumn = (db, table, column, type) => { if (!hasColumn(db, table, column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`); };
/**
 * Numbered schema steps, applied in order inside a transaction, recorded in PRAGMA user_version. Append only:
 * never edit a shipped step. Steps are written to be safe on databases from before user_version existed
 * (v3.0-3.6 report version 0 but may already have every table and column).
 */
const MIGRATIONS = [
    { version: 1, name: 'base schema', up: (db) => db.exec(SCHEMA_V1) },
    { version: 2, name: 'people.phone_mac (v3.4 phone signal)', up: (db) => addColumn(db, 'people', 'phone_mac', 'TEXT') },
    { version: 3, name: 'people.tag_id (v3.5 tag signal)', up: (db) => addColumn(db, 'people', 'tag_id', 'TEXT') },
    {
        version: 4, name: 're-key wedge-decimal card UIDs to PN532 hex', up: (db) => {
            for (const r of db.prepare('SELECT id, card_uid FROM people WHERE card_uid IS NOT NULL').all()) {
                const fixed = normaliseUid(r.card_uid);
                if (fixed === r.card_uid) continue;
                try { db.prepare('UPDATE people SET card_uid = ? WHERE id = ?').run(fixed, r.id); } catch { /* hex form already owned by someone else; leave for admin */ }
            }
        }
    },
    {
        version: 5, name: 'devices (per-device API tokens)', up: (db) => db.exec(`
            CREATE TABLE IF NOT EXISTS devices (
                id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, role TEXT NOT NULL, scopes TEXT NOT NULL,
                token_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, last_seen_at TEXT, revoked_at TEXT
            );`)
    },
    // ---- v4.0 ----
    { version: 6, name: 'admin_sessions (survive restarts, audit by session)', up: (db) => db.exec(`
        CREATE TABLE IF NOT EXISTS admin_sessions (token_hash TEXT PRIMARY KEY, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, label TEXT, last_used_at TEXT);`) },
    {
        version: 7, name: 'runtime_state: delivery/health state out of settings', up: (db) => {
            db.exec('CREATE TABLE IF NOT EXISTS runtime_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)');
            for (const key of ['teamsStatus', 'sharepointStatus', 'backupStatus', 'replicaRoster', 'allSafeNotified', 'lastUnknownCard']) {
                const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
                if (row) { db.prepare('INSERT OR REPLACE INTO runtime_state (key, value, updated_at) VALUES (?, ?, ?)').run(key, row.value, new Date().toISOString()); db.prepare('DELETE FROM settings WHERE key = ?').run(key); }
            }
        }
    },
    { version: 8, name: 'rollcalls.drill + rollcall_marks.via', up: (db) => { addColumn(db, 'rollcalls', 'drill', 'INTEGER NOT NULL DEFAULT 0'); addColumn(db, 'rollcall_marks', 'via', 'TEXT'); } },
    {
        // The events table is the write-path truth for attendance; this projection answers "who is in now" in one read
        // and is rebuilt from events by rebuildProjections() (also how a restored or copied database is verified).
        version: 9, name: 'attendance_current projection (folded from events)', up: (db) => {
            db.exec(`CREATE TABLE IF NOT EXISTS attendance_current (
                subject_type TEXT NOT NULL, subject_id TEXT NOT NULL, state TEXT NOT NULL, since TEXT NOT NULL, source TEXT, event_id TEXT,
                PRIMARY KEY (subject_type, subject_id));`);
            db.exec(`INSERT OR REPLACE INTO attendance_current (subject_type, subject_id, state, since, source, event_id)
                SELECT subject_type, subject_id, kind, at, source, id FROM (
                    SELECT e.*, ROW_NUMBER() OVER (PARTITION BY subject_type, subject_id ORDER BY at DESC, rowid DESC) AS rn
                    FROM events e WHERE kind IN ('in', 'out') AND subject_type IS NOT NULL AND subject_id IS NOT NULL
                ) WHERE rn = 1`);
        }
    },
    // Personal key for self-marking ("I'm SAFE" from the person's own phone): a random secret in the person's /safe
    // link, so a self-mark can only ever be for the person who holds it. Issued/rotated from Admin.
    { version: 10, name: 'people.safe_key', up: (db) => { addColumn(db, 'people', 'safe_key', 'TEXT'); db.exec('CREATE UNIQUE INDEX IF NOT EXISTS people_safe_key ON people (safe_key)'); } },
    {
        // v4.1: roll-call marks become events too. `ref` = the roll call an event belongs to, `actor` = who did it.
        // Backfill: every existing mark row was written together with its event at the same instant, so the pair is
        // matched exactly; marks overwritten or cleared earlier simply stay unmatched (only the latest mark counts).
        version: 11, name: 'events.ref + events.actor; marks folded from events', up: (db) => {
            addColumn(db, 'events', 'ref', 'TEXT');
            addColumn(db, 'events', 'actor', 'TEXT');
            db.exec('CREATE INDEX IF NOT EXISTS events_ref ON events (ref)');
            db.exec(`UPDATE events SET
                ref = (SELECT m.rollcall_id FROM rollcall_marks m WHERE m.subject_type = events.subject_type AND m.subject_id = events.subject_id AND m.at = events.at AND m.status = events.kind),
                actor = (SELECT m.by FROM rollcall_marks m WHERE m.subject_type = events.subject_type AND m.subject_id = events.subject_id AND m.at = events.at AND m.status = events.kind)
                WHERE kind IN ('safe', 'missing') AND ref IS NULL`);
        }
    }
];
const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

function migrate(db) {
    const current = Number(db.prepare('PRAGMA user_version').get().user_version);
    if (current > SCHEMA_VERSION) throw new Error(`database schema v${current} is newer than this software (v${SCHEMA_VERSION}); upgrade the software or restore a backup`);
    const applied = [];
    for (const m of MIGRATIONS.filter(x => x.version > current)) {
        db.exec('BEGIN IMMEDIATE');
        try {
            m.up(db);
            db.exec(`PRAGMA user_version = ${m.version}`);
            db.exec('COMMIT');
            applied.push(m.version);
        } catch (error) {
            db.exec('ROLLBACK');
            throw new Error(`schema migration ${m.version} (${m.name}) failed: ${error.message}`);
        }
    }
    return applied;
}

const now = () => new Date().toISOString();

class Store {
    constructor(file) {
        if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
        this.db = new DatabaseSync(file);
        try {
            this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
            this.migrationsApplied = migrate(this.db);
        } catch (error) { this.db.close(); throw error; }
        if (!this.getSetting('companyName')) this.setSetting('companyName', 'eRIGHT Ltd');
        if (!this.getSetting('fireNotice')) {
            this.setSetting('fireNotice', 'On hearing the alarm leave by the nearest exit and go to the assembly point. Do not stop to sign out.');
        }
    }

    // ---- settings (configuration decided by people) and runtime state (what the machine last saw) ----
    schemaVersion() { return Number(this.db.prepare('PRAGMA user_version').get().user_version); }
    getSetting(key, fallback = null) {
        const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
        return row ? JSON.parse(row.value) : fallback;
    }
    setSetting(key, value) {
        this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
            .run(key, JSON.stringify(value));
    }
    getState(key, fallback = null) {
        const row = this.db.prepare('SELECT value FROM runtime_state WHERE key = ?').get(key);
        return row ? JSON.parse(row.value) : fallback;
    }
    setState(key, value) {
        if (value === null || value === undefined) return this.db.prepare('DELETE FROM runtime_state WHERE key = ?').run(key);
        this.db.prepare('INSERT INTO runtime_state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
            .run(key, JSON.stringify(value), now());
    }

    // ---- admin sessions ----------------------------------------------------
    createSession({ token, expiresAt, label = null, at = now() }) {
        this.db.prepare('INSERT INTO admin_sessions (token_hash, created_at, expires_at, label, last_used_at) VALUES (?, ?, ?, ?, ?)').run(hashToken(token), at, expiresAt, label, at);
    }
    /** Returns the session (sans hash) when the token is live, touching last_used_at at most once a minute. */
    sessionByToken(token, at = now()) {
        if (!token) return null;
        const h = hashToken(token);
        const s = this.db.prepare('SELECT * FROM admin_sessions WHERE token_hash = ? AND expires_at > ?').get(h, at);
        if (!s) return null;
        if (!s.last_used_at || Date.parse(at) - Date.parse(s.last_used_at) > 60_000) this.db.prepare('UPDATE admin_sessions SET last_used_at = ? WHERE token_hash = ?').run(at, h);
        return { id: h.slice(0, 12), createdAt: s.created_at, expiresAt: s.expires_at, label: s.label };
    }
    deleteSession(token) { if (token) this.db.prepare('DELETE FROM admin_sessions WHERE token_hash = ?').run(hashToken(token)); }
    pruneSessions(at = now()) { this.db.prepare('DELETE FROM admin_sessions WHERE expires_at <= ?').run(at); }

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
    getPersonByPhone(mac) {
        const row = this.db.prepare('SELECT * FROM people WHERE phone_mac = ? AND active = 1').get(normaliseMac(mac));
        return row ? rowToPerson(row) : null;
    }
    getPersonByTag(tagId) {
        const row = this.db.prepare('SELECT * FROM people WHERE tag_id = ? AND active = 1').get(normaliseTag(tagId));
        return row ? rowToPerson(row) : null;
    }
    /** Whoever holds a credential, active or not (the card_uid UNIQUE constraint spans removed people too). */
    credentialOwner(field, value) {
        const column = { cardUid: ['card_uid', normaliseUid], phoneMac: ['phone_mac', normaliseMac], tagId: ['tag_id', normaliseTag] }[field];
        if (!column) throw new Error(`unknown credential ${field}`);
        const row = this.db.prepare(`SELECT * FROM people WHERE ${column[0]} = ? ORDER BY active DESC LIMIT 1`).get(column[1](value));
        return row ? rowToPerson(row) : null;
    }
    /** The person whose self-marking key this is (active people only). */
    getPersonBySafeKey(key) {
        if (!key || typeof key !== 'string' || key.length < 16) return null;
        const row = this.db.prepare('SELECT * FROM people WHERE safe_key = ? AND active = 1').get(key);
        return row ? rowToPerson(row) : null;
    }
    /** Issue (or rotate) a person's self-marking key. Returns the new key. */
    issueSafeKey(id) {
        const key = randomBytes(18).toString('base64url');
        this.db.prepare('UPDATE people SET safe_key = ? WHERE id = ?').run(key, id);
        return key;
    }
    revokeSafeKey(id) { this.db.prepare('UPDATE people SET safe_key = NULL WHERE id = ?').run(id); }
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
        const phoneMac = patch.phoneMac !== undefined ? (patch.phoneMac ? normaliseMac(patch.phoneMac) : null) : current.phoneMac;
        const tagId = patch.tagId !== undefined ? (patch.tagId ? normaliseTag(patch.tagId) : null) : current.tagId;
        this.db.prepare('UPDATE people SET name = ?, card_uid = ?, active = ?, phone_mac = ?, tag_id = ? WHERE id = ?').run(name, cardUid, active, phoneMac, tagId, id);
        return this.getPerson(id);
    }

    // ---- devices (per-device API tokens) ---------------------------------
    // The token is shown once when issued; only its SHA-256 is stored, so a stolen backup does not leak working tokens.
    addDevice({ name, role, scopes, at = now() }) {
        const token = randomBytes(24).toString('base64url');
        const device = { id: randomUUID(), name, role, scopes, createdAt: at, lastSeenAt: null, revokedAt: null };
        this.db.prepare('INSERT INTO devices (id, name, role, scopes, token_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)')
            .run(device.id, name, role, scopes.join(','), hashToken(token), at);
        return { device, token };
    }
    deviceByToken(token) {
        if (!token) return null;
        const row = this.db.prepare('SELECT * FROM devices WHERE token_hash = ? AND revoked_at IS NULL').get(hashToken(token));
        return row ? rowToDevice(row) : null;
    }
    getDeviceByName(name) {
        const row = this.db.prepare('SELECT * FROM devices WHERE name = ?').get(name);
        return row ? rowToDevice(row) : null;
    }
    listDevices() { return this.db.prepare('SELECT * FROM devices ORDER BY revoked_at IS NOT NULL, name').all().map(rowToDevice); }
    touchDevice(id, at) { this.db.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?').run(at, id); }
    revokeDevice(id, at) {
        this.db.prepare('UPDATE devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(at, id);
        const row = this.db.prepare('SELECT * FROM devices WHERE id = ?').get(id);
        return row ? rowToDevice(row) : null;
    }
    /** A revoked device's name may be reissued; the old row is renamed so history still reads sensibly. */
    retireDeviceName(name, at) {
        this.db.prepare("UPDATE devices SET name = name || ' (revoked ' || ? || ')' WHERE name = ? AND revoked_at IS NOT NULL").run(at.slice(0, 19), name);
    }

    // ---- presence sightings (BLE tags / Wi-Fi phones) ------------------
    addSighting({ kind, ident, scanner, rssi = null, at = now() }) {
        this.db.prepare('INSERT INTO sightings (kind, ident, scanner, rssi, at) VALUES (?, ?, ?, ?, ?)').run(kind, ident, scanner, rssi, at);
    }
    /** Most recent sightings for one identifier, newest first. */
    recentSightings(ident, { since, limit = 50 }) {
        return this.db.prepare('SELECT * FROM sightings WHERE ident = ? AND at >= ? ORDER BY at DESC LIMIT ?').all(ident, since, limit)
            .map(r => ({ kind: r.kind, ident: r.ident, scanner: r.scanner, rssi: r.rssi, at: r.at }));
    }
    /** Distinct identifiers of one kind heard since `since`, with last scanner/time — the enrolment picker. */
    identsSeen(kind, since) {
        return this.db.prepare('SELECT ident, scanner, MAX(at) AS last, COUNT(*) AS n FROM sightings WHERE kind = ? AND at >= ? GROUP BY ident ORDER BY last DESC').all(kind, since)
            .map(r => ({ ident: r.ident, scanner: r.scanner, last: r.last, count: Number(r.n) }));
    }
    lastSighting(ident) {
        const r = this.db.prepare('SELECT * FROM sightings WHERE ident = ? ORDER BY at DESC LIMIT 1').get(ident);
        return r ? { kind: r.kind, ident: r.ident, scanner: r.scanner, rssi: r.rssi, at: r.at } : null;
    }
    pruneSightings(before) { this.db.prepare('DELETE FROM sightings WHERE at < ?').run(before); }
    pruneSightingsOfKind(kind, before) { this.db.prepare('DELETE FROM sightings WHERE kind = ? AND at < ?').run(kind, before); }
    /**
     * True when the identifier's current run of sightings began after `afterIso`: either there is a silence of at
     * least `gapMs` somewhere after `afterIso`, or the first sighting after it follows a silence of `gapMs` (or nothing).
     * A phone still on the Wi-Fi when its owner signs out at the kiosk is one unbroken run, so this is false for it.
     */
    arrivedAfter(ident, afterIso, gapMs) {
        const gaps = this.db.prepare(`WITH r AS (SELECT at, LAG(at) OVER (ORDER BY at) AS prev FROM sightings WHERE ident = ? AND at > ?)
            SELECT COUNT(*) AS n, MIN(at) AS first, SUM(CASE WHEN prev IS NOT NULL AND (julianday(at) - julianday(prev)) * 86400000.0 >= ? THEN 1 ELSE 0 END) AS gaps FROM r`)
            .get(ident, afterIso, gapMs);
        if (!Number(gaps.n)) return false;
        if (Number(gaps.gaps) > 0) return true;
        const before = this.db.prepare('SELECT at FROM sightings WHERE ident = ? AND at <= ? ORDER BY at DESC LIMIT 1').get(ident, afterIso);
        return !before || Date.parse(gaps.first) - Date.parse(before.at) >= gapMs;
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
        // Kept for callers that update the row directly; the event path (addEvent kind 'out') also does this.
        this.db.prepare('UPDATE visitors SET signed_out_at = ? WHERE id = ? AND signed_out_at IS NULL').run(at, id);
        return this.getVisitor(id);
    }
    /** Visitors present now, derived from the attendance projection (the signed_out_at column is kept in step). */
    visitorsPresent() { return this.listVisitors({ presentOnly: true }); }

    // ---- expected (pre-registered) visitors -----------------------------
    // `day` is the local calendar day YYYY-MM-DD the visitor is expected; the app computes it in its time zone.
    listExpected({ day = null, fromDay = null, toDay = null, includeArrived = false } = {}) {
        const where = []; const args = [];
        if (day) { where.push('day = ?'); args.push(day); }
        if (fromDay) { where.push('day >= ?'); args.push(fromDay); }
        if (toDay) { where.push('day <= ?'); args.push(toDay); }
        if (!includeArrived) where.push('arrived_visitor_id IS NULL');
        const sql = `SELECT * FROM expected_visitors ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY day, name`;
        return this.db.prepare(sql).all(...args).map(rowToExpected);
    }
    getExpected(id) {
        const row = this.db.prepare('SELECT * FROM expected_visitors WHERE id = ?').get(id);
        return row ? rowToExpected(row) : null;
    }
    addExpected({ day, name, company, host, vehicle, note }) {
        const e = { id: randomUUID(), day, name, company: company || null, hostId: host?.id || null, hostName: host?.name || null, vehicle: vehicle || null, note: note || null, createdAt: now(), arrivedVisitorId: null, arrivedAt: null };
        this.db.prepare(`INSERT INTO expected_visitors (id, day, name, company, host_id, host_name, vehicle, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(e.id, e.day, e.name, e.company, e.hostId, e.hostName, e.vehicle, e.note, e.createdAt);
        return e;
    }
    deleteExpected(id) { this.db.prepare('DELETE FROM expected_visitors WHERE id = ? AND arrived_visitor_id IS NULL').run(id); }
    markExpectedArrived(id, visitorId, at) {
        this.db.prepare('UPDATE expected_visitors SET arrived_visitor_id = ?, arrived_at = ? WHERE id = ? AND arrived_visitor_id IS NULL').run(visitorId, at, id);
        return this.getExpected(id);
    }

    // ---- events ---------------------------------------------------------
    /** Latest in/out for one staff member: the projection says which event, the events row supplies the detail. */
    latestPresenceEvent(personId) {
        const row = this.db.prepare("SELECT e.* FROM attendance_current a JOIN events e ON e.id = a.event_id WHERE a.subject_type = 'staff' AND a.subject_id = ?").get(personId);
        return row ? rowToEvent(row) : null;
    }
    /**
     * Run `fn` atomically. Nested calls (a command that writes several events) become savepoints inside the outer
     * transaction, so either everything a command did is kept or none of it is. `fn` must be synchronous.
     */
    withTx(fn) {
        const depth = this._txDepth || 0;
        const sp = `sp${depth}`;
        this.db.exec(depth ? `SAVEPOINT ${sp}` : 'BEGIN IMMEDIATE');
        this._txDepth = depth + 1;
        try {
            const result = fn();
            this._txDepth = depth;
            this.db.exec(depth ? `RELEASE ${sp}` : 'COMMIT');
            return result;
        } catch (error) {
            this._txDepth = depth;
            this.db.exec(depth ? `ROLLBACK TO ${sp}; RELEASE ${sp}` : 'ROLLBACK');
            throw error;
        }
    }
    /**
     * The one write path for register facts. Attendance (`in`/`out`) and roll-call marks (`safe`/`missing`/
     * `mark_cleared`, with `ref` = the roll call) update their projections in the same transaction as the event.
     */
    addEvent(event) {
        // node:sqlite refuses to bind undefined, so drop those keys before applying defaults
        const given = Object.fromEntries(Object.entries(event).filter(([, v]) => v !== undefined));
        const full = { id: randomUUID(), eventKey: null, subjectType: null, subjectId: null, subjectName: null, device: null, note: null, ref: null, actor: null, at: now(), ...given };
        if (full.eventKey) {
            const existing = this.db.prepare('SELECT * FROM events WHERE event_key = ?').get(full.eventKey);
            if (existing) return { event: rowToEvent(existing), duplicate: true };
        }
        this.withTx(() => {
            this.db.prepare(`INSERT INTO events (id, event_key, kind, subject_type, subject_id, subject_name, at, source, device, note, ref, actor)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
                .run(full.id, full.eventKey, full.kind, full.subjectType, full.subjectId, full.subjectName, full.at, full.source, full.device, full.note, full.ref, full.actor);
            this._project(full);
        });
        return { event: full, duplicate: false };
    }
    /** Apply one event to the projections: attendance_current (+ visitors.signed_out_at) and rollcall_marks. */
    _project(e) {
        if ((e.kind === 'in' || e.kind === 'out') && e.subjectType && e.subjectId) {
            // Out-of-order arrivals (a reader replaying an old tap) must not overwrite a newer fact.
            const cur = this.db.prepare('SELECT since FROM attendance_current WHERE subject_type = ? AND subject_id = ?').get(e.subjectType, e.subjectId);
            if (!cur || cur.since <= e.at) {
                this.db.prepare(`INSERT INTO attendance_current (subject_type, subject_id, state, since, source, event_id) VALUES (?, ?, ?, ?, ?, ?)
                    ON CONFLICT(subject_type, subject_id) DO UPDATE SET state = excluded.state, since = excluded.since, source = excluded.source, event_id = excluded.event_id`)
                    .run(e.subjectType, e.subjectId, e.kind, e.at, e.source, e.id);
            }
            if (e.subjectType === 'visitor' && e.kind === 'out') this.db.prepare('UPDATE visitors SET signed_out_at = ? WHERE id = ? AND signed_out_at IS NULL').run(e.at, e.subjectId);
        }
        if (['safe', 'missing', 'mark_cleared'].includes(e.kind) && e.ref && e.subjectType && e.subjectId) {
            const cur = this.db.prepare('SELECT at FROM rollcall_marks WHERE rollcall_id = ? AND subject_type = ? AND subject_id = ?').get(e.ref, e.subjectType, e.subjectId);
            if (cur && cur.at > e.at) return;   // a newer mark already stands
            if (e.kind === 'mark_cleared') this.db.prepare('DELETE FROM rollcall_marks WHERE rollcall_id = ? AND subject_type = ? AND subject_id = ?').run(e.ref, e.subjectType, e.subjectId);
            else this.db.prepare(`INSERT INTO rollcall_marks (rollcall_id, subject_type, subject_id, status, at, by, via) VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(rollcall_id, subject_type, subject_id) DO UPDATE SET status = excluded.status, at = excluded.at, by = excluded.by, via = excluded.via`)
                .run(e.ref, e.subjectType, e.subjectId, e.kind, e.at, e.actor, e.source);
        }
    }
    /** Current attendance for every subject in one read: Map "type:id" -> {state, since, source}. */
    attendanceNow() {
        const m = new Map();
        for (const r of this.db.prepare('SELECT * FROM attendance_current').all()) m.set(`${r.subject_type}:${r.subject_id}`, { kind: r.state, at: r.since, source: r.source, id: r.event_id });
        return m;
    }
    /**
     * Rebuild the projections from the event log: attendance_current, and rollcall_marks for every roll call whose
     * marks are recorded as events. Returns 1 if anything differed (and was corrected), 0 if all were faithful.
     */
    rebuildProjections() {
        const marksSnapshot = () => JSON.stringify(this.db.prepare('SELECT rollcall_id, subject_type, subject_id, status, at FROM rollcall_marks WHERE rollcall_id IN (SELECT DISTINCT ref FROM events WHERE ref IS NOT NULL) ORDER BY 1, 2, 3').all());
        const before = JSON.stringify([...this.attendanceNow().entries()].sort()) + marksSnapshot();
        this.withTx(() => {
            this.db.exec('DELETE FROM attendance_current');
            this.db.exec(`INSERT INTO attendance_current (subject_type, subject_id, state, since, source, event_id)
                SELECT subject_type, subject_id, kind, at, source, id FROM (
                    SELECT e.*, ROW_NUMBER() OVER (PARTITION BY subject_type, subject_id ORDER BY at DESC, rowid DESC) AS rn
                    FROM events e WHERE kind IN ('in', 'out') AND subject_type IS NOT NULL AND subject_id IS NOT NULL) WHERE rn = 1`);
            this.db.exec('DELETE FROM rollcall_marks WHERE rollcall_id IN (SELECT DISTINCT ref FROM events WHERE ref IS NOT NULL)');
            this.db.exec(`INSERT INTO rollcall_marks (rollcall_id, subject_type, subject_id, status, at, by, via)
                SELECT ref, subject_type, subject_id, kind, at, actor, source FROM (
                    SELECT e.*, ROW_NUMBER() OVER (PARTITION BY ref, subject_type, subject_id ORDER BY at DESC, rowid DESC) AS rn
                    FROM events e WHERE kind IN ('safe', 'missing', 'mark_cleared') AND ref IS NOT NULL AND subject_id IS NOT NULL) WHERE rn = 1 AND kind <> 'mark_cleared'`);
        });
        const after = JSON.stringify([...this.attendanceNow().entries()].sort()) + marksSnapshot();
        return before === after ? 0 : 1;
    }
    /** Time travel: who was signed in at instant `iso`, folded from the event log (names as recorded then). */
    registerAt(iso) {
        return this.db.prepare(`SELECT subject_type, subject_id, subject_name, at, source FROM (
                SELECT e.*, ROW_NUMBER() OVER (PARTITION BY subject_type, subject_id ORDER BY at DESC, rowid DESC) AS rn
                FROM events e WHERE kind IN ('in', 'out') AND subject_type IS NOT NULL AND at <= ?) WHERE rn = 1 AND kind = 'in' ORDER BY subject_type, subject_name`)
            .all(iso).map(r => ({ type: r.subject_type, id: r.subject_id, name: r.subject_name, since: r.at, source: r.source }));
    }
    /** One subject's in/out history, newest first. */
    timeline(subjectType, subjectId, { from = null, to = null, limit = 200 } = {}) {
        const where = ['subject_type = ?', 'subject_id = ?']; const args = [subjectType, subjectId];
        if (from) { where.push('at >= ?'); args.push(from); }
        if (to) { where.push('at < ?'); args.push(to); }
        return this.db.prepare(`SELECT * FROM events WHERE ${where.join(' AND ')} ORDER BY at DESC, rowid DESC LIMIT ?`).all(...args, limit).map(rowToEvent);
    }

    // ---- retention ------------------------------------------------------
    /**
     * Visitors are personal data with a stated keep period: after it, the row stays (badge numbering, counts) but
     * name, company, vehicle and host are blanked, and so are their event lines. Returns how many were anonymised.
     */
    anonymiseVisitorsBefore(iso) {
        const ids = this.db.prepare("SELECT id FROM visitors WHERE signed_out_at IS NOT NULL AND signed_out_at < ? AND name <> 'Visitor (anonymised)'").all(iso).map(r => r.id);
        if (!ids.length) return 0;
        this.withTx(() => {
            for (const id of ids) {
                this.db.prepare("UPDATE visitors SET name = 'Visitor (anonymised)', company = NULL, vehicle = NULL, host_name = NULL, host_id = NULL WHERE id = ?").run(id);
                this.db.prepare("UPDATE events SET subject_name = 'Visitor (anonymised)', note = NULL WHERE subject_type = 'visitor' AND subject_id = ?").run(id);
            }
            this.db.prepare("DELETE FROM expected_visitors WHERE day < ?").run(iso.slice(0, 10));
        });
        return ids.length;
    }
    /** Events older than the keep period are deleted, except those the projections still stand on. */
    deleteEventsBefore(iso) {
        return Number(this.db.prepare(`DELETE FROM events WHERE at < ?
            AND id NOT IN (SELECT event_id FROM attendance_current WHERE event_id IS NOT NULL)
            AND (ref IS NULL OR ref NOT IN (SELECT id FROM rollcalls WHERE ended_at IS NULL))`).run(iso).changes);
    }
    deleteRollcallsBefore(iso) {
        const ids = this.db.prepare('SELECT id FROM rollcalls WHERE started_at < ? AND ended_at IS NOT NULL').all(iso).map(r => r.id);
        for (const id of ids) { this.db.prepare('DELETE FROM rollcall_marks WHERE rollcall_id = ?').run(id); this.db.prepare('DELETE FROM rollcalls WHERE id = ?').run(id); }
        return ids.length;
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
            .map(m => ({ subjectType: m.subject_type, subjectId: m.subject_id, status: m.status, at: m.at, by: m.by, via: m.via || 'fire-page' }));
        return { id: row.id, startedAt: row.started_at, endedAt: row.ended_at, startedBy: row.started_by, source: row.source, drill: row.drill === 1, roster: JSON.parse(row.roster_json), marks };
    }
    startRollcall({ roster, startedBy, source, at, drill = false }) {
        const id = randomUUID();
        this.db.prepare('INSERT INTO rollcalls (id, started_at, ended_at, started_by, source, roster_json, drill) VALUES (?, ?, NULL, ?, ?, ?, ?)')
            .run(id, at, startedBy || null, source || null, JSON.stringify(roster), drill ? 1 : 0);
        return this.getRollcall(id);
    }
    /** A mark is an event (kind safe|missing, ref = the roll call); the rollcall_marks row is its projection. */
    markRollcall(rollcallId, { subjectType, subjectId, subjectName = null, status, by, at, via = 'fire-page', device = null, note = null }) {
        this.addEvent({ kind: status, subjectType, subjectId, subjectName, at, source: via, device, note, ref: rollcallId, actor: by || null });
        return this.getRollcall(rollcallId);
    }
    endRollcall(id, at) {
        this.db.prepare('UPDATE rollcalls SET ended_at = ? WHERE id = ? AND ended_at IS NULL').run(at, id);
        return this.getRollcall(id);
    }
    clearRollcallMark(rollcallId, subjectType, subjectId, { subjectName = null, by = null, at = now(), via = 'fire-page', device = null } = {}) {
        this.addEvent({ kind: 'mark_cleared', subjectType, subjectId, subjectName, at, source: via, device, ref: rollcallId, actor: by });
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
    oldestOutboxAt() { return this.db.prepare('SELECT MIN(created_at) AS at FROM outbox').get().at || null; }

    /**
     * Consistent copy of the register while the server runs (VACUUM INTO reads one snapshot, WAL included). Presence
     * sightings and the delivery queue are dropped from the copy: one is bulky and re-learnt in minutes, the other
     * would re-send stale messages after a restore. Returns the size in bytes.
     */
    backupTo(file) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        if (fs.existsSync(file)) fs.rmSync(file);
        this.db.prepare('VACUUM INTO ?').run(file);
        const copy = new DatabaseSync(file);
        try {
            copy.exec('PRAGMA journal_mode = DELETE; DELETE FROM sightings; DELETE FROM outbox; DELETE FROM admin_sessions; DELETE FROM runtime_state; VACUUM;');
            const check = copy.prepare('PRAGMA integrity_check').get();
            if (Object.values(check)[0] !== 'ok') throw new Error(`backup integrity check failed: ${JSON.stringify(check)}`);
        } finally { copy.close(); }
        return fs.statSync(file).size;
    }

    close() { this.db.close(); }
}

/**
 * Card UIDs from every reader collapse to the PN532's form: upper-case hex, no separators, PN532 byte order.
 * Keyboard-wedge readers (USB-203, "8H10D" label) type a 4-byte UID as 10 decimal digits in the OPPOSITE
 * byte order: 0174870321 = 0x0A6C4F31 = fob 314F6C0A on the PN532 (proven 2026-10-01 against the live enrolment).
 * A bare 8-char hex UID that happens to be all digits is left alone (it can never be 10 chars).
 */
function normaliseUid(uid) {
    const s = String(uid).replace(/[^0-9a-z]/gi, '').toUpperCase();
    if (/^\d{10}$/.test(s)) {
        const n = Number(s);
        if (n <= 0xFFFFFFFF) return n.toString(16).toUpperCase().padStart(8, '0').match(/.{2}/g).reverse().join('');
    }
    return s;
}
/** aa:bb:cc:dd:ee:ff → AA:BB:CC:DD:EE:FF (accepts dashes, dots, no separators). */
function normaliseMac(mac) {
    const hex = String(mac).replace(/[^0-9a-f]/gi, '').toUpperCase();
    return hex.length === 12 ? hex.match(/.{2}/g).join(':') : hex;
}
/** Tag ids are scanner-formatted (`ibeacon:<uuid>:<major>:<minor>` or `mac:AA:BB:...`); upper-case, trimmed. */
function normaliseTag(tag) {
    return String(tag).trim().toUpperCase();
}
const hashToken = (token) => createHash('sha256').update(String(token)).digest('hex');
function rowToDevice(r) {
    return { id: r.id, name: r.name, role: r.role, scopes: r.scopes ? r.scopes.split(',') : [], createdAt: r.created_at, lastSeenAt: r.last_seen_at, revokedAt: r.revoked_at };
}
function rowToPerson(r) {
    return { id: r.id, name: r.name, cardUid: r.card_uid, phoneMac: r.phone_mac || null, tagId: r.tag_id || null, active: r.active === 1, createdAt: r.created_at, safeKey: r.safe_key || null };
}
function rowToVisitor(r) {
    return { id: r.id, badge: r.badge, name: r.name, company: r.company, hostId: r.host_id, hostName: r.host_name, vehicle: r.vehicle, signedInAt: r.signed_in_at, signedOutAt: r.signed_out_at };
}
function rowToExpected(r) {
    return { id: r.id, day: r.day, name: r.name, company: r.company, hostId: r.host_id, hostName: r.host_name, vehicle: r.vehicle, note: r.note, createdAt: r.created_at, arrivedVisitorId: r.arrived_visitor_id, arrivedAt: r.arrived_at };
}
function rowToEvent(r) {
    return { id: r.id, eventKey: r.event_key, kind: r.kind, subjectType: r.subject_type, subjectId: r.subject_id, subjectName: r.subject_name, at: r.at, source: r.source, device: r.device, note: r.note, ref: r.ref ?? null, actor: r.actor ?? null };
}

module.exports = { Store, normaliseUid, normaliseMac, normaliseTag, SCHEMA_VERSION };
