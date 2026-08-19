import { thisAddon } from "./common-utils.js";

const gc = Object.freeze({
});


export default gc;


// ===== Jellyfin run-mode detection =====
// The addon runs in one of three modes, decided purely by which variables are set:
//
//   "multi-user"      -> JELLYFIN_URL + BRIDGE_SECRET: every viewer installs with
//                        their OWN Jellyfin login, sealed into their install URL.
//                        Jellyfin authenticates each request; no server-wide key is
//                        ever handed to a client. Required for any install that is
//                        reachable off the LAN.
//   "single-user"     -> JELLYFIN_URL + JELLYFIN_API_KEY + JELLYFIN_USER_NAME: the
//                        original behaviour. One identity for everyone, and that
//                        identity is an admin API key (Jellyfin has no other kind),
//                        stamped into every stream/poster/subtitle URL emitted.
//                        Safe only where the addon itself is trusted-network-only.
//   "subtitles-only"  -> nothing set: standalone subtitles, no Jellyfin calls.
//
// Anything else is a misconfiguration, reported as "partial" so the caller can
// refuse to start rather than silently half-work.
const MULTI_USER_VARS = ['JELLYFIN_URL', 'BRIDGE_SECRET'];
const SINGLE_USER_VARS = ['JELLYFIN_URL', 'JELLYFIN_API_KEY', 'JELLYFIN_USER_NAME'];
const ALL_JELLYFIN_VARS = [...new Set([...MULTI_USER_VARS, ...SINGLE_USER_VARS])];

const isSet = (v) => String(process.env[v] ?? '').trim() !== '';

export function getJellyfinConfigStatus() {
    const present = ALL_JELLYFIN_VARS.filter(isSet);

    if (present.length === 0) {
        return { mode: 'subtitles-only', present, missing: [], required: [] };
    }

    // BRIDGE_SECRET is the deliberate switch into per-viewer auth, so it decides the
    // mode. If a legacy admin key is still lying around in the environment it is
    // NOT used -- falling back to it would quietly restore the very exposure that
    // multi-user mode exists to remove.
    if (isSet('BRIDGE_SECRET')) {
        const missing = MULTI_USER_VARS.filter((v) => !isSet(v));
        return {
            mode: missing.length ? 'partial' : 'multi-user',
            present,
            missing,
            required: MULTI_USER_VARS,
        };
    }

    const missing = SINGLE_USER_VARS.filter((v) => !isSet(v));
    return {
        mode: missing.length ? 'partial' : 'single-user',
        present,
        missing,
        required: SINGLE_USER_VARS,
    };
}

/** "multi-user" | "single-user" | "subtitles-only" | "partial" */
export function getRunMode() {
    return getJellyfinConfigStatus().mode;
}

/** True when the addon bridges a Jellyfin server at all (either identity mode). */
export function isJellyfinConfigured() {
    const mode = getRunMode();
    return mode === 'multi-user' || mode === 'single-user';
}

export function isMultiUser() {
    return getRunMode() === 'multi-user';
}

const trimSlashes = (v) => String(v ?? '').trim().replace(/\/+$/, '');

/** Where the ADDON talks to Jellyfin. May be a LAN address the internet cannot reach. */
export function getJellyfinApiBase() {
    return trimSlashes(process.env.JELLYFIN_URL);
}

/**
 * Where the PLAYER talks to Jellyfin.
 *
 * Streams and subtitle tracks are fetched by the Stremio client, not by the addon,
 * so a LAN-only JELLYFIN_URL produces URLs that work at home and silently fail
 * everywhere else. JELLYFIN_PUBLIC_URL is the externally reachable name for the
 * same server; it defaults to JELLYFIN_URL so a LAN-only install needs no change.
 */
export function getJellyfinPublicBase() {
    return trimSlashes(process.env.JELLYFIN_PUBLIC_URL) || getJellyfinApiBase();
}


/**
 * Default subtitle language code for files whose name doesn't specify one.
 * Prefers DEFAULT_SUBS_LANG; falls back to the legacy JELLYFIN_DEFAULT_EXT_SUBS_LANG
 * (kept for backward compatibility), then 'und'.
 */
export function getDefaultSubsLang() {
    return process.env.DEFAULT_SUBS_LANG || process.env.JELLYFIN_DEFAULT_EXT_SUBS_LANG || 'und';
}
