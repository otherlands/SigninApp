'use strict';
// Pushes files into a SharePoint document library with Microsoft Graph, using an app registration
// (client credentials). Nothing here reads SharePoint back; it is a one-way off-site copy.

const GRAPH = 'https://graph.microsoft.com/v1.0';

class SharePointSink {
    constructor(options = {}) {
        this.tenantId = options.tenantId || '';
        this.clientId = options.clientId || '';
        this.clientSecret = options.clientSecret || '';
        // hostname:/server-relative-path, e.g. "eright.sharepoint.com:/sites/eRIGHT"
        this.site = options.site || '';
        // Library display name; empty = the site's default document library
        this.drive = options.drive || '';
        this.folder = String(options.folder || 'eRIGHT Ltd/Sign-in').replace(/^\/+|\/+$/g, '');
        this.fetch = options.fetch || globalThis.fetch;
        this._token = null;
        this._driveUrl = null;
    }

    get configured() {
        return Boolean(this.tenantId && this.clientId && this.clientSecret && this.site);
    }

    describe() {
        return { configured: this.configured, site: this.site, drive: this.drive || '(default library)', folder: this.folder };
    }

    async token() {
        if (this._token && this._token.expiresAt > Date.now() + 60_000) return this._token.value;
        const body = new URLSearchParams({
            client_id: this.clientId, client_secret: this.clientSecret,
            scope: 'https://graph.microsoft.com/.default', grant_type: 'client_credentials'
        });
        const res = await this.fetch(`https://login.microsoftonline.com/${encodeURIComponent(this.tenantId)}/oauth2/v2.0/token`, {
            method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString(),
            signal: AbortSignal.timeout(10_000)
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok || !json.access_token) throw new Error(`token request failed: ${res.status} ${json.error_description || json.error || ''}`.trim());
        this._token = { value: json.access_token, expiresAt: Date.now() + Number(json.expires_in || 3600) * 1000 };
        return this._token.value;
    }

    async graph(path, init = {}) {
        const res = await this.fetch(path.startsWith('http') ? path : `${GRAPH}${path}`, {
            ...init,
            headers: { Authorization: `Bearer ${await this.token()}`, ...(init.headers || {}) },
            signal: AbortSignal.timeout(15_000)
        });
        if (!res.ok) {
            const text = await res.text().catch(() => '');
            throw new Error(`Graph ${init.method || 'GET'} ${path} -> ${res.status} ${text.slice(0, 200)}`);
        }
        return res;
    }

    /** Resolve and cache the drive URL: /drives/{id} for the chosen library. */
    async driveUrl() {
        if (this._driveUrl) return this._driveUrl;
        const siteRes = await this.graph(`/sites/${this.site}`);
        const siteId = (await siteRes.json()).id;
        if (!siteId) throw new Error('site lookup returned no id');
        if (!this.drive) {
            const d = await (await this.graph(`/sites/${siteId}/drive`)).json();
            this._driveUrl = `/drives/${d.id}`;
        } else {
            const list = await (await this.graph(`/sites/${siteId}/drives`)).json();
            const match = (list.value || []).find(d => d.name === this.drive);
            if (!match) throw new Error(`library "${this.drive}" not found on site; have: ${(list.value || []).map(d => d.name).join(', ')}`);
            this._driveUrl = `/drives/${match.id}`;
        }
        return this._driveUrl;
    }

    /** Simple upload (Graph limit 4 MB). Creates or overwrites the file; folders are created as needed. */
    async upload(name, body, contentType) {
        const drive = await this.driveUrl();
        const itemPath = `${this.folder}/${name}`.split('/').map(encodeURIComponent).join('/');
        await this.graph(`${drive}/root:/${itemPath}:/content`, {
            method: 'PUT', headers: { 'Content-Type': contentType }, body
        });
        return `${this.folder}/${name}`;
    }
}

module.exports = { SharePointSink };
