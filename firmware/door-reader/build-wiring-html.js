#!/usr/bin/env node
'use strict';
// build-wiring-html.js — render WIRING.md into a single self-contained WIRING.html (photos inlined as data URIs
// so the file works on a phone, in e-mail or from the SharePoint folder with nothing else alongside it).
// Tiny purpose-built markdown subset: #/##, paragraphs, **bold**, *italic*, `code`, tables, ordered/unordered
// lists, > quotes, ``` fences, ![img](path) followed by an *italic* caption line. No dependencies.
// Run: node build-wiring-html.js   (from firmware/door-reader)
const fs = require('node:fs');
const path = require('node:path');

const here = __dirname;
const md = fs.readFileSync(path.join(here, 'WIRING.md'), 'utf8').replace(/\r\n/g, '\n');

const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function inline(s) {
    // code first so its contents are not styled
    const codes = [];
    s = esc(s).replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
    s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    s = s.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>');
    return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[i]}</code>`);
}
function dataUri(rel) {
    const p = path.join(here, rel);
    const ext = path.extname(p).slice(1).toLowerCase();
    return `data:image/${ext === 'jpg' ? 'jpeg' : ext};base64,${fs.readFileSync(p).toString('base64')}`;
}

const lines = md.split('\n');
let out = [], i = 0, title = 'Wiring guide';
while (i < lines.length) {
    const l = lines[i];
    if (/^```/.test(l)) { const buf = []; i++; while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]); i++; out.push(`<pre><code>${esc(buf.join('\n'))}</code></pre>`); continue; }
    if (/^# /.test(l)) { title = l.slice(2).trim(); out.push(`<h1>${inline(title)}</h1>`); i++; continue; }
    if (/^## /.test(l)) { out.push(`<h2>${inline(l.slice(3))}</h2>`); i++; continue; }
    if (/^---+$/.test(l.trim())) { out.push('<hr>'); i++; continue; }
    const img = l.match(/^!\[([^\]]*)\]\(([^)]+)\)\s*$/);
    if (img) {
        i++; let cap = '';
        if (i < lines.length && /^\*.*\*\s*$/.test(lines[i])) { cap = inline(lines[i].trim().replace(/^\*|\*$/g, '')); i++; }
        out.push(`<figure><img src="${dataUri(img[2])}" alt="${esc(img[1])}" loading="lazy">${cap ? `<figcaption>${cap}</figcaption>` : ''}</figure>`); continue;
    }
    if (/^\|/.test(l)) {
        const rows = []; while (i < lines.length && /^\|/.test(lines[i])) rows.push(lines[i++]);
        const cells = r => r.replace(/^\||\|$/g, '').split('|').map(c => inline(c.trim()));
        const head = cells(rows[0]); const body = rows.slice(2).map(cells);
        out.push(`<table><thead><tr>${head.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${body.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`); continue;
    }
    if (/^\d+\. /.test(l) || /^[-*] /.test(l)) {
        const ordered = /^\d+\. /.test(l); const items = [];
        while (i < lines.length && (/^\d+\. /.test(lines[i]) || /^[-*] /.test(lines[i]) || /^\s{2,}\S/.test(lines[i]))) {
            if (/^\s{2,}\S/.test(lines[i])) items[items.length - 1] += ' ' + lines[i].trim(); else items.push(lines[i].replace(/^(\d+\. |[-*] )/, ''));
            i++;
        }
        out.push(`<${ordered ? 'ol' : 'ul'}>${items.map(t => `<li>${inline(t)}</li>`).join('')}</${ordered ? 'ol' : 'ul'}>`); continue;
    }
    if (/^> /.test(l)) { const buf = []; while (i < lines.length && /^> ?/.test(lines[i])) buf.push(lines[i++].replace(/^> ?/, '')); out.push(`<blockquote>${inline(buf.join(' '))}</blockquote>`); continue; }
    if (!l.trim()) { i++; continue; }
    const buf = []; while (i < lines.length && lines[i].trim() && !/^(#|\||!\[|```|\d+\. |[-*] |> )/.test(lines[i])) buf.push(lines[i++]);
    out.push(`<p>${inline(buf.join(' '))}</p>`);
}

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  :root { --ink:#1b1f2a; --muted:#5b6478; --line:#e3e6ee; --accent:#5b3fe0; --red:#c9203a; --amber:#b46a00; --green:#14804a; }
  * { box-sizing: border-box; }
  body { margin:0; font: 17px/1.5 'Inter', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; color:var(--ink); background:#fff; }
  main { max-width: 900px; margin: 0 auto; padding: 24px 20px 80px; }
  h1 { font-size: 1.9rem; line-height:1.15; margin: 0 0 6px; }
  h1 + p { color: var(--muted); }
  h2 { font-size: 1.25rem; margin: 40px 0 12px; padding-top: 18px; border-top: 3px solid var(--accent); }
  p { margin: 0 0 12px; }
  code { font: .92em ui-monospace, Consolas, monospace; background:#f2f3f8; padding: 1px 6px; border-radius: 6px; }
  pre { background:#12151f; color:#e8ecf6; padding: 14px 16px; border-radius: 10px; overflow:auto; font-size:.9rem; }
  pre code { background:none; padding:0; color:inherit; }
  table { width:100%; border-collapse: collapse; margin: 12px 0 18px; font-size: .97rem; }
  th, td { text-align:left; padding: 9px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { background:#f6f7fb; font-size:.8rem; letter-spacing:.08em; text-transform: uppercase; color: var(--muted); }
  figure { margin: 14px 0 22px; }
  figure img { width:100%; height:auto; border-radius: 12px; border: 1px solid var(--line); display:block; }
  figcaption { font-size: .92rem; color: var(--muted); margin-top: 8px; line-height: 1.45; }
  blockquote { margin: 12px 0; padding: 10px 16px; border-left: 4px solid var(--accent); background:#f6f7fb; color: var(--muted); border-radius: 0 10px 10px 0; }
  ol, ul { padding-left: 24px; } li { margin: 6px 0; }
  a { color: var(--accent); word-break: break-all; }
  .stamp { font-size:.85rem; color:var(--muted); border-top:1px solid var(--line); margin-top: 40px; padding-top: 12px; }
  @media print { main { max-width:none; padding:0; } h2 { break-after: avoid; } figure, table, pre { break-inside: avoid; } a { color: inherit; text-decoration: none; } }
</style>
</head>
<body><main>
${out.join('\n')}
<p class="stamp">eRIGHT Sign-In · generated from <code>firmware/door-reader/WIRING.md</code> by <code>build-wiring-html.js</code> on ${new Date().toISOString().slice(0, 10)} · photos embedded, nothing else needed.</p>
</main></body></html>
`;
fs.writeFileSync(path.join(here, 'WIRING.html'), html);
console.log(`WIRING.html written: ${(Buffer.byteLength(html) / 1024).toFixed(0)} KB, ${(md.match(/^!\[/gm) || []).length} photos embedded`);
