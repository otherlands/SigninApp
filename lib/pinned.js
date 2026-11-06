'use strict';
// A minimal GET-only fetch that trusts exactly ONE certificate: the self-signed one a UniFi console ships with
// (CN unifi.local, no IP address in it, so ordinary verification can never pass). The trust store is only that
// PEM, so the TLS handshake fails before any request (and therefore the X-API-KEY header) is written to a server
// presenting anything else. Hostname checking is replaced by an exact fingerprint match against the same PEM.
const https = require('node:https');
const crypto = require('node:crypto');

function fingerprint256(pem) {
    return new crypto.X509Certificate(pem).fingerprint256;
}

/** @param {string|Buffer} pem the controller's own certificate @returns {(url: string, opts?: object) => Promise} */
function pinnedFetch(pem) {
    const want = fingerprint256(pem);
    return (url, { headers = {}, signal } = {}) => new Promise((resolve, reject) => {
        const req = https.request(url, {
            method: 'GET', headers, signal, ca: [pem],
            checkServerIdentity: (_host, cert) => (cert.fingerprint256 === want ? undefined : new Error(`certificate ${cert.fingerprint256} is not the pinned ${want}`))
        }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                const body = Buffer.concat(chunks).toString('utf8');
                resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, json: async () => JSON.parse(body), text: async () => body });
            });
            res.on('error', reject);
        });
        req.on('error', reject);
        req.end();
    });
}

module.exports = { pinnedFetch, fingerprint256 };
