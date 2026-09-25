'use strict';
const http = require('node:http');
const { createApp } = require('./lib/app');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';

const app = createApp();
const server = http.createServer((req, res) => app.handle(req, res));

server.listen(PORT, HOST, () => {
  const mode = app.cfg.replica ? 'MIRROR (read-only)' : 'MAIN';
  console.log(`[${new Date().toISOString()}] eRIGHT sign-in v3 ${mode} listening on http://${HOST}:${PORT}`);
  console.log(`  kiosk  http://<ip>:${PORT}/      fire roll call  http://<ip>:${PORT}/fire      admin  http://<ip>:${PORT}/admin`);
  if (!app.cfg.adminPin) console.log('  ADMIN_PIN not set: /admin is open to anyone on the LAN');
  if (app.cfg.mirrorUrl) console.log(`  mirroring roster to ${app.cfg.mirrorUrl}`);
  if (app.sharepoint.configured) console.log(`  SharePoint copy -> ${app.sharepoint.site} / ${app.sharepoint.folder}`);
  if (app.cfg.teamsWebhookUrl) console.log('  Teams webhook: roll-call start / all-safe / end are posted to the channel');
  if (app.cfg.publicUrl) console.log(`  public URL for phones/Teams buttons: ${app.cfg.publicUrl}`);
});

if (app.hasOutboxSink()) {
  setInterval(() => app.flushOutbox().catch(() => { }), 15_000).unref();
  app.flushOutbox().catch(() => { });
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => { server.close(); app.close(); process.exit(0); });
}
