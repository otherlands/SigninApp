'use strict';
// Configuration in one place: options (tests, embedding) override environment variables, which override defaults.
// loadConfig never throws; it returns problems so `node server.js --check-config` can print them all at once and
// the server can refuse to start on errors instead of failing later in the middle of a fire.
const path = require('node:path');

const list = (v, dflt) => String(v ?? dflt).split(',').map(s => s.trim()).filter(Boolean);
const httpUrl = (v) => { try { const u = new URL(v); return ['http:', 'https:'].includes(u.protocol); } catch { return false; } };

/**
 * @param {object} [options] explicit settings (win over env)
 * @param {Record<string, string|undefined>} [env]
 * @returns {{ cfg: object, errors: string[], warnings: string[] }}
 */
function loadConfig(options = {}, env = process.env) {
    const o = options; const e = env;
    const dataFile = o.dataFile || e.DATA_FILE || path.join(__dirname, '..', 'data', 'signin.sqlite');
    const cfg = {
        port: Number(o.port ?? e.PORT ?? 3000),
        host: o.host ?? e.HOST ?? '0.0.0.0',
        dataFile,
        publicDir: o.publicDir || path.join(__dirname, '..', 'public'),
        adminPin: o.adminPin ?? e.ADMIN_PIN ?? '',
        apiToken: o.apiToken ?? e.API_TOKEN ?? '',
        mirrorUrl: o.mirrorUrl ?? e.MIRROR_URL ?? '',
        mirrorToken: o.mirrorToken ?? e.MIRROR_TOKEN ?? '',
        replica: o.replica ?? e.REPLICA === '1',
        timeZone: o.timeZone ?? e.TZ_NAME ?? 'Europe/London',
        fetch: o.fetch || globalThis.fetch,
        // Teams Workflows webhook ("Post to a channel when a webhook request is received").
        teamsWebhookUrl: o.teamsWebhookUrl ?? e.TEAMS_WEBHOOK_URL ?? '',
        // The address staff phones use, e.g. http://192.168.101.40:3000 — gives Teams cards an "Open roll call" button.
        publicUrl: String(o.publicUrl ?? e.PUBLIC_URL ?? '').replace(/\/+$/, ''),
        // Presence: UniFi controller for the phone signal; scanner names for the tag signal.
        unifi: o.unifi ?? {
            url: e.UNIFI_URL, apiKey: e.UNIFI_API_KEY, site: e.UNIFI_SITE || 'default',
            path: e.UNIFI_CLIENTS_PATH || '/proxy/network/api/s/{site}/stat/sta', ssid: e.UNIFI_SSID || ''
        },
        doorScanners: o.doorScanners ?? list(e.DOOR_SCANNERS, 'front-door,back-door'),
        anchorScanners: o.anchorScanners ?? list(e.ANCHOR_SCANNERS, 'anchor'),
        presenceThresholds: o.presenceThresholds ?? {},
        now: o.now,   // injected clock (tests); the server uses the wall clock
        sharepoint: o.sharepoint ?? {
            tenantId: e.SP_TENANT_ID, clientId: e.SP_CLIENT_ID, clientSecret: e.SP_CLIENT_SECRET,
            site: e.SP_SITE, drive: e.SP_DRIVE, folder: e.SP_FOLDER
        },
        // Nightly copies of the register; empty = off (the in-memory test store has nowhere to back up to).
        backupDir: o.backupDir ?? e.BACKUP_DIR ?? (dataFile === ':memory:' ? '' : path.join(path.dirname(dataFile), 'backups')),
        backupKeep: Number(o.backupKeep ?? e.BACKUP_KEEP ?? 30),
        backupHour: Number(o.backupHour ?? e.BACKUP_HOUR ?? 2),
        retentionDays: o.retentionDays ?? (e.RETENTION_DAYS ? Number(e.RETENTION_DAYS) : 0),
        // Read-only register Q&A: an OpenAI-compatible chat endpoint on the LAN (e.g. Ollama's /v1). Empty = off.
        llmUrl: String(o.llmUrl ?? e.LLM_URL ?? '').replace(/\/+$/, ''),
        llmModel: o.llmModel ?? e.LLM_MODEL ?? '',
        // Native TLS (optional, alongside HTTP): a certificate + key, served on TLS_PORT.
        tlsCertFile: o.tlsCertFile ?? e.TLS_CERT_FILE ?? '', tlsKeyFile: o.tlsKeyFile ?? e.TLS_KEY_FILE ?? '', tlsPort: Number(o.tlsPort ?? e.TLS_PORT ?? 3443),
        adminLockout: o.adminLockout ?? {},
        logFormat: o.logFormat ?? e.LOG_FORMAT ?? 'text',
        // ---- v4.1 ----
        // Presence (phone/tag signals) is off unless switched on: no hardware for it exists yet.
        presence: o.presence ?? (e.PRESENCE ? ['on', '1', 'true'].includes(String(e.PRESENCE).toLowerCase()) : false),
        // Off-box backup: rsync target ("user@host:" with a restricted key on the far side), key file, pinned host keys.
        backupPushTarget: o.backupPushTarget ?? e.BACKUP_PUSH_TARGET ?? '',
        backupPushKey: o.backupPushKey ?? e.BACKUP_PUSH_KEY ?? '',
        backupPushKnownHosts: o.backupPushKnownHosts ?? e.BACKUP_PUSH_KNOWN_HOSTS ?? '',
        backupPushCommand: o.backupPushCommand,          // tests only: replaces rsync
        // Dead-man's switch: a URL pinged while the server is alive; the service it belongs to alerts when pings stop.
        heartbeatUrl: o.heartbeatUrl ?? e.HEARTBEAT_URL ?? '',
        heartbeatMinutes: Number(o.heartbeatMinutes ?? e.HEARTBEAT_MINUTES ?? 5),
        // A second Teams webhook for operational messages (drift), so the roll-call channel stays quiet.
        opsWebhookUrl: o.opsWebhookUrl ?? e.OPS_TEAMS_WEBHOOK_URL ?? '',
        // Drift watcher: the public name to check (default: PUBLIC_URL's host if it is a name), expected addresses.
        driftHostname: o.driftHostname ?? e.DRIFT_HOSTNAME ?? '',
        expectPublicIp: o.expectPublicIp ?? e.EXPECT_PUBLIC_IP ?? '',
        expectLanIp: o.expectLanIp ?? e.EXPECT_LAN_IP ?? '',
        driftPublicDns: o.driftPublicDns ?? list(e.DRIFT_PUBLIC_DNS, '1.1.1.1'),
        spSecretExpires: o.spSecretExpires ?? e.SP_SECRET_EXPIRES ?? '',
        expectDevices: o.expectDevices ?? list(e.EXPECT_DEVICES, ''),
        deviceSilentMinutes: Number(o.deviceSilentMinutes ?? e.DEVICE_SILENT_MINUTES ?? 15),
        // Networks trusted with the no-login LAN pages (comma CIDRs). Empty = every network that can reach the port.
        trustedNets: o.trustedNets ?? list(e.TRUSTED_NETS, ''),
        // Live-update streams: a cap in total and per address for requests from outside (proxy / untrusted nets).
        streamMax: Number(o.streamMax ?? e.STREAM_MAX ?? 300),
        streamMaxPerIp: Number(o.streamMaxPerIp ?? e.STREAM_MAX_PER_IP ?? 4),
        // Roll-call chaser: re-post the not-yet-accounted names to Teams every N minutes (0 = off), at most chaserMax times.
        chaserMinutes: Number(o.chaserMinutes ?? e.CHASER_MINUTES ?? 3),
        chaserMax: Number(o.chaserMax ?? e.CHASER_MAX ?? 10)
    };
    if (o.sharepoint === undefined) cfg.sharepoint.list = e.SP_LIST;   // Microsoft List name for the live register (needs the same app registration)

    const errors = []; const warnings = [];
    try { new Intl.DateTimeFormat('en-GB', { timeZone: cfg.timeZone }); } catch { errors.push(`TZ_NAME "${cfg.timeZone}" is not an IANA time zone (e.g. Europe/London)`); }
    if (!Number.isInteger(cfg.port) || cfg.port < 0 || cfg.port > 65535) errors.push(`PORT "${e.PORT ?? o.port}" is not a port number`);
    for (const [name, value] of [['MIRROR_URL', cfg.mirrorUrl], ['PUBLIC_URL', cfg.publicUrl], ['TEAMS_WEBHOOK_URL', cfg.teamsWebhookUrl], ['UNIFI_URL', cfg.unifi?.url]]) {
        if (value && !httpUrl(value)) errors.push(`${name} "${value}" is not an http(s) URL`);
    }
    if (cfg.replica && !cfg.mirrorToken) errors.push('REPLICA=1 needs MIRROR_TOKEN (the same value as on the main server), or anyone could overwrite the mirror');
    if (!Number.isInteger(cfg.backupKeep) || cfg.backupKeep < 1) errors.push(`BACKUP_KEEP "${cfg.backupKeep}" must be a whole number of at least 1`);
    if (!Number.isInteger(cfg.backupHour) || cfg.backupHour < 0 || cfg.backupHour > 23) errors.push(`BACKUP_HOUR "${cfg.backupHour}" must be 0-23`);
    if (!['text', 'json'].includes(cfg.logFormat)) errors.push(`LOG_FORMAT "${cfg.logFormat}" must be text or json`);
    if (!Number.isInteger(cfg.retentionDays) || cfg.retentionDays < 0) errors.push(`RETENTION_DAYS "${e.RETENTION_DAYS}" must be a whole number of days (0 or empty = off)`);
    if (cfg.retentionDays && cfg.retentionDays < 30) errors.push(`RETENTION_DAYS ${cfg.retentionDays} is under 30: refusing to delete a register that young`);
    if (cfg.llmUrl && !httpUrl(cfg.llmUrl)) errors.push(`LLM_URL "${cfg.llmUrl}" is not an http(s) URL`);
    if (cfg.llmUrl && !cfg.llmModel) errors.push('LLM_URL is set but LLM_MODEL is empty');
    if (Boolean(cfg.tlsCertFile) !== Boolean(cfg.tlsKeyFile)) errors.push('TLS_CERT_FILE and TLS_KEY_FILE must both be set');
    for (const [name, value] of [['OPS_TEAMS_WEBHOOK_URL', cfg.opsWebhookUrl], ['HEARTBEAT_URL', cfg.heartbeatUrl]]) if (value && !httpUrl(value)) errors.push(`${name} "${value}" is not an http(s) URL`);
    for (const net of cfg.trustedNets) if (!/^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/.test(net)) errors.push(`TRUSTED_NETS entry "${net}" is not an IPv4 CIDR like 192.168.101.0/24`);
    if (cfg.backupPushTarget && !/^[^@\s]+@[^:\s]+:/.test(cfg.backupPushTarget) && !require('node:path').isAbsolute(cfg.backupPushTarget)) errors.push(`BACKUP_PUSH_TARGET "${cfg.backupPushTarget}" must look like user@host:path/ (rsync over ssh) or be an absolute path (a mounted share)`);
    if (cfg.spSecretExpires && Number.isNaN(Date.parse(cfg.spSecretExpires))) errors.push(`SP_SECRET_EXPIRES "${cfg.spSecretExpires}" is not a date (YYYY-MM-DD)`);
    for (const [name, v] of [['HEARTBEAT_MINUTES', cfg.heartbeatMinutes], ['DEVICE_SILENT_MINUTES', cfg.deviceSilentMinutes], ['STREAM_MAX', cfg.streamMax], ['STREAM_MAX_PER_IP', cfg.streamMaxPerIp], ['CHASER_MINUTES', cfg.chaserMinutes], ['CHASER_MAX', cfg.chaserMax]]) {
        if (!Number.isFinite(v) || v < 0) errors.push(`${name} "${v}" must be a number of 0 or more`);
    }
    if (!Number.isInteger(cfg.tlsPort) || cfg.tlsPort < 0 || cfg.tlsPort > 65535) errors.push(`TLS_PORT "${cfg.tlsPort}" is not a port number`);

    if (!cfg.adminPin) warnings.push('ADMIN_PIN not set: /admin is open to anyone on the LAN');
    else if (String(cfg.adminPin).length < 6) warnings.push('ADMIN_PIN is shorter than 6 characters');
    if (!cfg.apiToken) warnings.push('API_TOKEN not set: any device on the LAN can post card taps and scanner sightings');
    else if (String(cfg.apiToken).length < 16) warnings.push('API_TOKEN is shorter than 16 characters');
    const sp = cfg.sharepoint || {};
    const spSet = ['tenantId', 'clientId', 'clientSecret', 'site'].filter(k => sp[k]);
    if (spSet.length && spSet.length < 4) warnings.push(`SharePoint is half-configured (${spSet.length}/4 of SP_TENANT_ID, SP_CLIENT_ID, SP_CLIENT_SECRET, SP_SITE): the off-site copy stays OFF`);
    if (Boolean(cfg.unifi?.url) !== Boolean(cfg.unifi?.apiKey)) warnings.push('UNIFI_URL and UNIFI_API_KEY must both be set for the phone signal; it stays off');
    if (cfg.teamsWebhookUrl && httpUrl(cfg.teamsWebhookUrl) && !cfg.teamsWebhookUrl.startsWith('https:')) warnings.push('TEAMS_WEBHOOK_URL is not https');
    if (e.REPLICA && !['0', '1'].includes(e.REPLICA)) warnings.push(`REPLICA "${e.REPLICA}" is neither 0 nor 1; treated as 0`);
    if (!cfg.retentionDays) warnings.push('RETENTION_DAYS not set: visitor details and events are kept forever (a retention period is a data-protection decision owed)');
    if (cfg.publicUrl && cfg.publicUrl.startsWith('http:') && !/^http:\/\/(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(cfg.publicUrl)) warnings.push('PUBLIC_URL is a plain-http public address: the admin cookie and tokens cross the internet unencrypted');
    if (sp.list && spSet.length < 4) warnings.push('SP_LIST is set but the app registration is incomplete: the Microsoft List register stays OFF');
    if (!cfg.backupPushTarget && cfg.backupDir) warnings.push('BACKUP_PUSH_TARGET not set: every backup is on the same disk as the register');
    if (!cfg.heartbeatUrl) warnings.push('HEARTBEAT_URL not set: nothing outside this server notices if it stops');
    return { cfg, errors, warnings };
}

module.exports = { loadConfig };
