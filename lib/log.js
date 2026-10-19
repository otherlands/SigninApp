'use strict';
// Structured logging. LOG_FORMAT=json writes one JSON object per line (for journald → Loki/Promtail);
// the default text format stays readable in `journalctl -u eright-signin`.

function createLogger({ format = 'text', silent = false, write = (line) => process.stdout.write(line + '\n') } = {}) {
    const emit = (level, msg, fields = {}) => {
        if (silent) return;
        const at = new Date().toISOString();
        if (format === 'json') return write(JSON.stringify({ at, level, msg, ...fields }));
        const extra = Object.entries(fields).map(([k, v]) => `${k}=${typeof v === 'string' && !/\s/.test(v) ? v : JSON.stringify(v)}`).join(' ');
        write(`[${at}] ${level === 'info' ? '' : level.toUpperCase() + ' '}${msg}${extra ? ' ' + extra : ''}`);
    };
    return { info: (m, f) => emit('info', m, f), warn: (m, f) => emit('warn', m, f), error: (m, f) => emit('error', m, f) };
}

module.exports = { createLogger };
