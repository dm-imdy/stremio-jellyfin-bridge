// ============================================================================
// LOCAL SUBTITLE FILE SERVER  (Phase 1)
// ============================================================================
// Mounted on the same Express app as /proxy-image, so it's reachable over the
// addon's HTTPS endpoint. Streams a single subtitle file from LOCAL_SUBS_DIR.
//
// SECURITY: `f` is a client-supplied path. We resolve it against LOCAL_SUBS_DIR
// and refuse anything that escapes the folder (e.g. ?f=../../etc/passwd).
// ============================================================================

import path from 'path';
import { createReadStream } from 'fs';
import { stat } from 'fs/promises';

const SUBS_DIR = process.env.LOCAL_SUBS_DIR;

const MIME_TYPES = {
    '.srt': 'application/x-subrip',
    '.vtt': 'text/vtt',
    '.ass': 'text/x-ssa',
    '.ssa': 'text/x-ssa',
};

export async function localSubtitleRoute(req, res) {
    if (!SUBS_DIR) {
        return res.status(404).send('Local subtitles are not enabled');
    }

    const requested = req.query.f || '';
    const root = path.resolve(SUBS_DIR);
    const abs = path.resolve(root, requested);

    // Path-traversal guard: resolved path must stay inside SUBS_DIR.
    if (abs !== root && !abs.startsWith(root + path.sep)) {
        console.log(`[LocalSubs] ⛔ Blocked traversal attempt: ${requested}`);
        return res.status(403).send('Forbidden');
    }

    try {
        const info = await stat(abs);
        if (!info.isFile()) return res.status(404).send('Not a file');
    } catch {
        return res.status(404).send('Subtitle not found');
    }

    const ext = path.extname(abs).toLowerCase();
    res.set('Content-Type', `${MIME_TYPES[ext] || 'text/plain'}; charset=utf-8`);
    res.set('Access-Control-Allow-Origin', '*'); // player fetches the file cross-origin
    res.set('Cache-Control', 'public, max-age=3600');

    createReadStream(abs)
        .on('error', (err) => {
            console.error('[LocalSubs] Read error:', err.message);
            if (!res.headersSent) res.status(500).end();
        })
        .pipe(res);
}

// ============================================================================
// LOCAL SUBTITLE WRITE  (Step 4a)  —  POST /local-subtitle
// ============================================================================
// Counterpart to the GET above: accepts a subtitle file and stores it in
// LOCAL_SUBS_DIR via subtitleSources/local.place(), so it is then served by the
// same find()/GET path. Identity comes from the query string; the raw request
// body is the subtitle text (UTF-8).
//
//   POST /local-subtitle?type=series&id=tt..:1:2&lang=fre&label=DMTranslate&freetext=Name%20(Year)
//   body: <srt text>
//
// Optional shared-secret guard: set LOCAL_SUBS_WRITE_SECRET and send it back in
// the X-Write-Secret header. Keep this endpoint LAN-only regardless.
import { place } from '../subtitleSources/local.js';

const MAX_WRITE_BYTES = 5 * 1024 * 1024;

export async function localSubtitleWriteRoute(req, res) {
    if (!SUBS_DIR) return res.status(404).send('Local subtitles are not enabled');

    const secret = process.env.LOCAL_SUBS_WRITE_SECRET;
    if (secret && req.headers['x-write-secret'] !== secret) {
        console.log('[LocalSubs] ⛔ write rejected: bad/missing secret');
        return res.status(403).send('Forbidden');
    }

    const { type, id, lang, label, freetext } = req.query;

    let size = 0;
    const chunks = [];
    let tooBig = false;
    req.on('data', (c) => {
        size += c.length;
        if (size > MAX_WRITE_BYTES) { tooBig = true; req.destroy(); return; }
        chunks.push(c);
    });
    req.on('error', () => { if (!res.headersSent) res.status(500).end(); });
    req.on('end', async () => {
        if (tooBig) return res.status(413).send('Subtitle too large');
        const content = Buffer.concat(chunks).toString('utf8');
        if (!content.trim()) return res.status(400).send('Empty body');
        try {
            const dest = await place({ type, id, lang, label, freetext, content });
            console.log(`[LocalSubs] ✅ placed ${type} ${id} (${lang}) -> ${dest}`);
            res.status(201).json({ ok: true, path: dest });
        } catch (e) {
            console.error(`[LocalSubs] place failed for ${type} ${id}: ${e.message}`);
            res.status(400).json({ ok: false, error: e.message });
        }
    });
}
