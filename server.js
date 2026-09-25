const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const publicDir = path.join(__dirname, 'public');
const dataDir = path.join(__dirname, 'data');
const dataFile = path.join(dataDir, 'sign-in-data.json');

const starterData = {
  companyName: 'Your Company',
  people: [
    { id: '1', name: 'Alex Morgan', active: true },
    { id: '2', name: 'Sam Taylor', active: true },
    { id: '3', name: 'Jordan Lee', active: true }
  ],
  events: []
};

function readData() {
  if (!fs.existsSync(dataFile)) return structuredClone(starterData);
  try { return JSON.parse(fs.readFileSync(dataFile, 'utf8')); }
  catch { return structuredClone(starterData); }
}
function saveData(data) {
  fs.mkdirSync(dataDir, { recursive: true });
  const temporary = `${dataFile}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(data, null, 2));
  fs.renameSync(temporary, dataFile);
}
function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(type.includes('json') ? JSON.stringify(body) : body);
}
function currentStatus(data, personId) {
  const latest = data.events.find(event => event.personId === personId);
  if (latest?.type !== 'in') return { signedIn: false };
  // stale = still signed in from before local midnight today (forgotten sign-out, flagged never auto-closed)
  const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0);
  return { signedIn: true, since: latest.at, stale: new Date(latest.at) < startOfToday };
}
async function bodyOf(req) {
  let text = '';
  for await (const chunk of req) {
    text += chunk;
    if (text.length > 100000) throw new Error('Request too large');
  }
  return text ? JSON.parse(text) : {};
}
function apiState(data) {
  return {
    companyName: data.companyName,
    people: data.people.filter(person => person.active !== false).map(person => ({ ...person, ...currentStatus(data, person.id) })),
    events: data.events
  };
}
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.svg': 'image/svg+xml' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname === '/api/state' && req.method === 'GET') return send(res, 200, apiState(readData()));
    if (url.pathname === '/api/sign' && req.method === 'POST') {
      const { personId } = await bodyOf(req); const data = readData();
      const person = data.people.find(item => item.id === personId && item.active !== false);
      if (!person) return send(res, 404, { error: 'Person not found' });
      const status = currentStatus(data, personId);
      const event = { id: randomUUID(), personId, personName: person.name, type: status.signedIn ? 'out' : 'in', at: new Date().toISOString() };
      data.events.unshift(event); saveData(data); return send(res, 200, { event, state: apiState(data) });
    }
    if (url.pathname === '/api/people' && req.method === 'POST') {
      const { name } = await bodyOf(req); const cleanName = String(name || '').trim().slice(0, 80);
      if (!cleanName) return send(res, 400, { error: 'Enter a name' });
      const data = readData(); data.people.push({ id: randomUUID(), name: cleanName, active: true }); saveData(data); return send(res, 201, apiState(data));
    }
    if (url.pathname.startsWith('/api/people/') && req.method === 'DELETE') {
      const id = url.pathname.split('/').pop(); const data = readData();
      const person = data.people.find(item => item.id === id);
      if (!person) return send(res, 404, { error: 'Person not found' });
      person.active = false; saveData(data); return send(res, 200, apiState(data));
    }
    if (url.pathname === '/api/company' && req.method === 'PUT') {
      const { companyName } = await bodyOf(req); const name = String(companyName || '').trim().slice(0, 80);
      if (!name) return send(res, 400, { error: 'Enter a company name' });
      const data = readData(); data.companyName = name; saveData(data); return send(res, 200, apiState(data));
    }
    if (url.pathname === '/api/export' && req.method === 'GET') {
      const data = readData();
      const lines = ['Date,Time,Name,Action'];
      data.events.slice().reverse().forEach(event => { const date = new Date(event.at); lines.push([date.toLocaleDateString('en-GB'), date.toLocaleTimeString('en-GB'), event.personName, event.type === 'in' ? 'Signed in' : 'Signed out'].map(value => `"${String(value).replaceAll('"', '""')}"`).join(',')); });
      res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="sign-in-log.csv"' }); return res.end(lines.join('\n'));
    }
    const requested = url.pathname === '/' ? '/index.html' : url.pathname === '/admin' ? '/admin.html' : url.pathname === '/tap' ? '/tap.html' : url.pathname === '/rollcall' ? '/rollcall.html' : url.pathname;
    const file = path.resolve(publicDir, `.${requested}`);
    if (!file.startsWith(publicDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(res, 404, 'Not found', 'text/plain; charset=utf-8');
    return send(res, 200, fs.readFileSync(file), mime[path.extname(file)] || 'application/octet-stream');
  } catch (error) { return send(res, 400, { error: error.message || 'Bad request' }); }
});
server.listen(PORT, HOST, () => console.log(`Sign-in system running at http://${HOST}:${PORT}`));
