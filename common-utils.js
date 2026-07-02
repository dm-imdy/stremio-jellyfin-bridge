import { readFileSync } from 'fs';

// ===== BEGIN: console timestamping =====
// Wrap the common message-logging methods so every call is prefixed with a local
// timestamp (and an emoji marker for warn/error). Adding/removing a level is now just
// editing LOG_METHODS, and per-level decoration lives in PREFIX.
//
// We intentionally do NOT wrap table/dir/group/assert/count/time/etc. - those
// interpret their arguments specially, so a leading timestamp would corrupt them
// (most dangerously console.assert, where a truthy first arg disables the check).
const LOG_METHODS = ['log', 'info', 'debug', 'warn', 'error', 'trace'];
const PREFIX = { warn: '⚠️ ', error: '❌', debug: '💧' };

// Returns the current local time as "YYYY-MM-DD_HH:mm:ss.SSS ::".
// (Function declaration, so it's hoisted and usable by the wrappers above.)
function getLogCurrentDateString() {
    const date = new Date();
    return new Date(date.getTime() - (date.getTimezoneOffset() * 60000)).toISOString().slice(0, -1).replace('T', '_') + " ::";
}

[process.stdout, process.stderr].forEach(s => s._handle?.setBlocking?.(true)); // For crash cases

// Route stderr through stdout so warn/error/trace land in the same stream (and the
// same log file), in order, via a single writer. Runs below the console wrappers,
// so timestamps/emoji are still applied. NOTE: Node writes *uncaught-exception*
// fatal traces straight to fd 2 and bypasses this, so keep WinSW's .err.log enabled.
process.stderr.write = process.stdout.write.bind(process.stdout);

for (const name of LOG_METHODS) {
    const original = console[name].bind(console);   // capture original, with correct `this`
    console[name] = (...args) => {
        const mark = PREFIX[name] ? [PREFIX[name]] : [];
        original(getLogCurrentDateString(), ...mark, ...args);
    };
}
// ===== END: console timestamping =====


// Single source of truth for the addon's metadata: read it straight from package.json
// (resolved relative to this file, so it works under Docker /app and native).
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

const THIS_ADDON_HTTP_PORT = Number(process.env.PORT) || 7000;
const THIS_ADDON_HTTPS_PORT = Number(process.env.HTTPS_PORT) || 7001;
export const thisAddon = Object.freeze({
    name: pkg.name,
    id: pkg.addonId,
    desc: pkg.description,
    version: pkg.version,
    httpPort: THIS_ADDON_HTTP_PORT,
    httpsPort: THIS_ADDON_HTTPS_PORT,
});
