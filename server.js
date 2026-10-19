'use strict';
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const { createApp } = require('./lib/app');
const { loadConfig } = require('./lib/config');

// `node server.js --check-config` prints every configuration problem and exits 0 (fine) or 1 (errors).
if (process.argv.includes('--check-config')) {
    const { errors, warnings } = loadConfig();
    for (const e of errors) console.log(`ERROR    ${e}`);
    for (const w of warnings) console.log(`warning  ${w}`);
    console.log(errors.length ? `${errors.length} error(s): the server will refuse to start` : 'configuration OK');
    process.exit(errors.length ? 1 : 0);
}

const { cfg: pre } = loadConfig();
let tls = null;
if (pre.tlsCertFile) {
    try { tls = { cert: fs.readFileSync(pre.tlsCertFile), key: fs.readFileSync(pre.tlsKeyFile), port: pre.tlsPort }; }
    catch (error) { console.error(`eRIGHT sign-in will not start: cannot read TLS files: ${error.message}`); process.exit(1); }
}
let app;
try { app = createApp({ tls: tls ? { port: tls.port, cert: pre.tlsCertFile } : null }); } catch (error) {
    console.error(error.code === 'BAD_CONFIG' ? `eRIGHT sign-in will not start: ${error.message}` : error);
    process.exit(1);
}
const { cfg, log } = app;
const onRequest = (req, res) => app.handle(req, res);
const server = http.createServer(onRequest);
const secure = tls ? https.createServer({ cert: tls.cert, key: tls.key }, onRequest) : null;

server.listen(cfg.port, cfg.host, () => {
    const mode = cfg.replica ? 'MIRROR (read-only)' : 'MAIN';
    log.info(`eRIGHT sign-in v${require('./package.json').version} ${mode} listening on http://${cfg.host}:${cfg.port}`);
    log.info(`kiosk http://<ip>:${cfg.port}/   fire roll call http://<ip>:${cfg.port}/fire   admin http://<ip>:${cfg.port}/admin`);
    for (const w of app.warnings) log.warn(w);
    if (cfg.mirrorUrl) log.info(`mirroring roster to ${cfg.mirrorUrl}`);
    if (app.sharepoint.configured) log.info(`SharePoint copy -> ${app.sharepoint.site} / ${app.sharepoint.folder}`);
    if (app.mslist.configured) log.info(`Microsoft List register -> ${app.mslist.site} / ${app.mslist.list}`);
    if (cfg.teamsWebhookUrl) log.info('Teams webhook: roll-call start / all-safe / end are posted to the channel');
    if (cfg.publicUrl) log.info(`public URL for phones/Teams buttons: ${cfg.publicUrl}`);
    if (app.presence.enabledWifi) log.info(`presence: phone signal polling ${cfg.unifi.url} every ${app.presence.cfg.wifiPollMs / 1000} s`);
    else log.info('presence: phone signal off (set UNIFI_URL + UNIFI_API_KEY); tag scanners may still post to /api/presence/ble');
    log.info(cfg.backupDir ? `backups: ${cfg.backupDir}, nightly at ${String(cfg.backupHour).padStart(2, '0')}:00 ${cfg.timeZone}, keep ${cfg.backupKeep}` : 'backups: OFF (BACKUP_DIR empty)');
    log.info(cfg.retentionDays ? `retention: visitor details anonymised and events deleted after ${cfg.retentionDays} days` : 'retention: OFF');
    if (app.assistant) log.info(`assistant: ${cfg.llmModel} at ${cfg.llmUrl} (read-only tools, admin only)`);
    app.start();
    log.info(`background jobs: ${[...app.jobs.jobs.keys()].join(', ') || 'none'}`);
});
if (secure) secure.listen(tls.port, cfg.host, () => log.info(`TLS listening on https://${cfg.host}:${tls.port} (${pre.tlsCertFile})`));

for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => { server.close(); secure?.close(); app.close(); process.exit(0); });
}
