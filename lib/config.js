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
        adminLockout: o.adminLockout ?? {},
        logFormat: o.logFormat ?? e.LOG_FORMAT ?? 'text'
    };

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
    return { cfg, errors, warnings };
}

module.exports = { loadConfig };
