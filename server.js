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
});

if (app.cfg.mirrorUrl && !app.cfg.replica) {
    setInterval(() => app.flushOutbox().catch(() => { }), 15_000).unref();
}

for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => { server.close(); app.close(); process.exit(0); });
}
