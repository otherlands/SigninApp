'use strict';
// Declarative routes. Every route states what it needs; the app applies it before the handler runs, so a route
// cannot forget its guard. Shape:
//   { method, path: '/api/people/:id', auth, mutates?, notify?, handler(ctx) }
// auth values:
//   'public'            anyone on the LAN (kiosk, fire page)
//   'admin'             admin session cookie or X-Admin-Pin (rate limited)
//   'mirror'            MIRROR_TOKEN (or the shared token when none is set)
//   'claim:<scope>'     a human source (kiosk/tap/fire-page/visitor/admin) needs nothing; any other claimed source
//                       is a device and must present a token with <scope>. The handler gets ctx.source.
//   'device:<scope>'    a token with <scope> is required outright (scanners)
// mutates: true  -> refused on a REPLICA with 409 before the handler runs
// notify: false  -> successful writes normally wake every page over SSE; set false for chatter (scanners, mirror)

function compile(route) {
    const keys = [];
    const pattern = route.path.replace(/\/:(\w+)/g, (_, k) => { keys.push(k); return '/([^/]+)'; });
    return { ...route, keys, re: new RegExp(`^${pattern}$`) };
}

class Router {
    constructor() { this.routes = []; }
    add(route) { this.routes.push(compile(route)); return this; }
    /** @returns {{route, params}|null} */
    match(method, pathname) {
        for (const r of this.routes) {
            if (r.method !== method) continue;
            const m = r.re.exec(pathname);
            if (!m) continue;
            const params = {};
            r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
            return { route: r, params };
        }
        return null;
    }
    /** Does any route exist for the path with another method? (405 vs 404) */
    pathKnown(pathname) { return this.routes.some(r => r.re.test(pathname)); }
    /** For docs and the auth-matrix test: every route with its declared requirements. */
    table() { return this.routes.map(r => ({ method: r.method, path: r.path, auth: r.auth, mutates: Boolean(r.mutates), public: Boolean(r.public), summary: r.summary || '' })); }
}

module.exports = { Router };
