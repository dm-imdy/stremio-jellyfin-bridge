// ============================================================================
// STANDALONE SUBTITLE SOURCES — AGGREGATOR
// ============================================================================
// This is the single seam the subtitles handler talks to. The handler never
// knows *where* a standalone subtitle comes from; it just asks for whatever
// matches an id and gets back a flat list of Stremio subtitle descriptors.
//
// A "source" is any module that exports:
//     isEnabled()                         -> boolean   (config-gated)
//     find({ type, id, httpsBase })       -> Promise<Array<{id,url,lang}>>
//
// Phase 1: local filesystem source only.
// Phase 2: add ./http.js (small file-server on the PC) — register it below.
// Phase 3: same ./http.js, just pointed at the Jellyfin plugin via env. No
//          change here at all — Phase 3 is a backend swap on the PC side.
// ============================================================================

import * as localSource from './local.js';
// import * as httpSource from './http.js';   // <-- Phase 2 lands here

const SOURCES = [
    localSource,
    // httpSource,                              // <-- and is registered here
];

/**
 * Ask every *enabled* source for subtitles matching this id, and merge the
 * results. Returns [] when no source is configured, which keeps the whole
 * feature inert by default — existing deployments behave exactly as before.
 */
export async function getStandaloneSubtitles(ctx) {
    const active = SOURCES.filter((s) => s.isEnabled());
    if (active.length === 0) return [];

    const batches = await Promise.all(
        active.map(async (s) => {
            try {
                return await s.find(ctx);
            } catch (err) {
                console.log('[StandaloneSubs] source error:', err.message);
                return []; // one bad source must not sink the others
            }
        })
    );

    return batches.flat();
}

/** True if at least one standalone source is configured. */
export function anySourceEnabled() {
    return SOURCES.some((s) => s.isEnabled());
}
