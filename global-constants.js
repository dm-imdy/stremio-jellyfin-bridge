import { thisAddon } from "./common-utils.js";

const gc = Object.freeze({
});


export default gc;


// ===== Jellyfin run-mode detection =====
// The addon runs in one of two modes, decided purely by which Jellyfin vars are set:
//   "jellyfin"        -> ALL required vars present: full bridge (catalog/meta/stream/subtitles)
//   "subtitles-only"  -> NONE present: standalone subtitles only, no Jellyfin calls
// A PARTIAL set (some present, some missing) is a misconfiguration, reported as "partial"
// so the caller can refuse to start rather than silently half-work.
const JELLYFIN_REQUIRED_VARS = ['JELLYFIN_URL', 'JELLYFIN_API_KEY', 'JELLYFIN_USER_NAME'];

export function getJellyfinConfigStatus() {
    const present = JELLYFIN_REQUIRED_VARS.filter((v) => String(process.env[v] ?? '').trim() !== '');
    const missing = JELLYFIN_REQUIRED_VARS.filter((v) => !present.includes(v));

    let mode = 'partial';
    if (present.length === JELLYFIN_REQUIRED_VARS.length) mode = 'jellyfin';
    else if (present.length === 0) mode = 'subtitles-only';

    return { mode, present, missing, required: JELLYFIN_REQUIRED_VARS };
}

/** True only when the FULL Jellyfin config is present (catalog/meta/stream active). */
export function isJellyfinConfigured() {
    return getJellyfinConfigStatus().mode === 'jellyfin';
}


/**
 * Default subtitle language code for files whose name doesn't specify one.
 * Prefers DEFAULT_SUBS_LANG; falls back to the legacy JELLYFIN_DEFAULT_EXT_SUBS_LANG
 * (kept for backward compatibility), then 'und'.
 */
export function getDefaultSubsLang() {
    return process.env.DEFAULT_SUBS_LANG || process.env.JELLYFIN_DEFAULT_EXT_SUBS_LANG || 'und';
}
