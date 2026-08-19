import crypto from 'crypto';
import { getSession, dropSession, peekSession } from './jellyfin-auth.js';
import { getRunMode, getJellyfinApiBase, getJellyfinPublicBase } from './global-constants.js';

// ==========================================
// WHO IS ASKING
// ==========================================
// Every request the addon serves is resolved to a VIEWER first. A viewer carries
// the identity all Jellyfin calls are made as, and the token that gets stamped
// into the URLs handed to the Stremio client.
//
// Two ways to get one:
//
//   multi-user  -- the install URL carries a sealed blob holding the viewer's own
//                  Jellyfin login. Each viewer sees their own libraries, and a
//                  leaked URL exposes that one account, not the server.
//   single-user -- the legacy environment configuration (JELLYFIN_API_KEY +
//                  JELLYFIN_USER_NAME). Unchanged, still admin-keyed, and still
//                  the right answer for a private LAN-only install.
//
// The blob is sealed rather than plain because the install URL travels: it sits in
// the addon list of every Stremio client, in reverse-proxy access logs, and in
// whatever chat app it was sent through. Sealing keeps a Jellyfin password out of
// all of those. It is NOT the access control -- Jellyfin is. Anyone holding the
// URL can use it, exactly like every other Stremio addon install URL.

const SEAL_VERSION = 'v1';
const KDF_SALT = 'stremio-jellyfin-bridge/viewer-seal';

let cachedKey = null;

function sealingKey() {
    const secret = process.env.BRIDGE_SECRET;
    if (!secret || !secret.trim()) return null;
    if (!cachedKey) cachedKey = crypto.scryptSync(secret.trim(), KDF_SALT, 32);
    return cachedKey;
}

/** Seal a Jellyfin login into the opaque string that lives in the install URL. */
export function sealLogin({ userName, password }) {
    const key = sealingKey();
    if (!key) throw new Error('BRIDGE_SECRET is not set — cannot seal a viewer login');

    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const body = Buffer.concat([
        cipher.update(JSON.stringify({ u: userName, p: password }), 'utf8'),
        cipher.final(),
    ]);

    return `${SEAL_VERSION}.${Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url')}`;
}

/** Open a sealed login. Returns null for anything we did not seal ourselves. */
export function openLogin(sealed) {
    const key = sealingKey();
    if (!key || typeof sealed !== 'string') return null;

    const [version, payload] = sealed.split('.', 2);
    if (version !== SEAL_VERSION || !payload) return null;

    try {
        const raw = Buffer.from(payload, 'base64url');
        if (raw.length < 29) return null;

        const decipher = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
        decipher.setAuthTag(raw.subarray(12, 28));
        const json = JSON.parse(
            Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8')
        );

        if (!json.u || !json.p) return null;
        return { userName: json.u, password: json.p };
    } catch {
        // A wrong BRIDGE_SECRET, a truncated URL and a forged blob all land here.
        return null;
    }
}

/** The path a sealed login installs at, e.g. /%7B%22jf%22...%7D/manifest.json */
export function installPath(sealed, resource = 'manifest.json') {
    return `/${encodeURIComponent(JSON.stringify({ jf: sealed }))}/${resource}`;
}

/**
 * Normalise the configuration, whichever route it arrived on.
 *
 * The SDK router JSON-parses the path segment before calling a handler, but the
 * addon's own routes (playback, artwork) see it raw — as the JSON TEXT, or as the
 * bare sealed blob when it came from a query parameter. All three mean the same
 * thing and must resolve to the same viewer.
 */
function asConfigObject(config) {
    if (!config) return null;
    if (typeof config === 'object') return config;
    if (typeof config !== 'string') return null;

    const text = config.trim();
    if (!text.startsWith('{')) return { jf: text };
    try {
        const parsed = JSON.parse(text);
        return typeof parsed === 'object' && parsed ? parsed : null;
    } catch {
        return null;
    }
}

/** Pull the sealed blob out of whatever we were handed as `config`. */
export function sealedFromConfig(config) {
    const obj = asConfigObject(config);
    return obj && typeof obj.jf === 'string' ? obj.jf : null;
}

/**
 * The login a request carries, in either accepted form.
 *
 * The manifest declares `username` + `password` as ordinary config fields, so a
 * config built by Stremio's own generic form works — Jellyfin still authenticates
 * it, so it is no weaker as access control. It is simply more exposed: that
 * password sits in clear text in the install URL, and therefore in proxy logs and
 * in every client's addon list. The configure page mints the sealed `jf` form
 * instead, and that is what to hand out.
 */
export function readLogin(config) {
    const sealed = sealedFromConfig(config);
    if (sealed) {
        const opened = openLogin(sealed);
        if (opened) return opened;
        // A sealed blob we cannot open is a wrong BRIDGE_SECRET or a forgery.
        // Falling through to the plaintext fields would be fine, but saying so
        // costs nothing and this is the confusing failure.
        console.warn('[Viewer] Request carried a sealed login this addon cannot open (BRIDGE_SECRET changed?).');
        return null;
    }

    const obj = asConfigObject(config);
    if (obj && obj.username) {
        console.warn(`[Viewer] "${obj.username}" is installed with an UNSEALED login — ` +
            `their Jellyfin password is in clear text in their install URL. Re-issue it from /configure.`);
        return { userName: String(obj.username), password: String(obj.password ?? '') };
    }

    return null;
}

/**
 * Resolve the viewer for one request.
 *
 * Returns null when nobody could be authenticated — a missing config in
 * multi-user mode, a blob we cannot open, or credentials Jellyfin refuses. The
 * caller then serves nothing: there is no "anonymous" fallback, because that is
 * precisely the hole this replaces.
 */
export async function resolveViewer(config) {
    const mode = getRunMode();
    if (mode === 'subtitles-only' || mode === 'partial') return null;

    const apiBase = getJellyfinApiBase();
    const publicBase = getJellyfinPublicBase();

    if (mode === 'single-user') {
        const token = process.env.JELLYFIN_API_KEY;
        const userName = process.env.JELLYFIN_USER_NAME;
        const userId = process.env.JELLYFIN_USER_ID;   // resolved once at startup
        if (!userId) return null;

        return {
            apiBase,
            publicBase,
            userId,
            userName,
            sealed: null,
            canReauthenticate: false,
            currentToken: () => token,
            session: async () => ({ token, userId, userName }),
        };
    }

    // ----- multi-user -----
    const login = readLogin(config);
    if (!login) {
        console.warn('[Viewer] Request carried no usable configuration — refusing.');
        return null;
    }

    let session;
    try {
        session = await getSession(apiBase, login.userName, login.password);
    } catch (error) {
        // Wrong password, disabled account, or Jellyfin down. Either way: nothing.
        console.warn(`[Viewer] Jellyfin refused "${login.userName}": ${error.response?.status || error.message}`);
        return null;
    }

    return {
        apiBase,
        publicBase,
        userId: session.userId,
        userName: session.userName,
        // Always the sealed form, even when the request arrived with plaintext
        // fields: artwork URLs are handed to the client, and re-emitting a
        // password into them would spread it further with every poster.
        sealed: sealedFromConfig(config) || sealLogin(login),
        canReauthenticate: true,
        // The token stamped into client URLs must be the CURRENT one: if a call
        // earlier in this same request had to re-authenticate, the session
        // captured above is already stale and would 401 in the player.
        currentToken: () => peekSession(login.userName, login.password)?.token || session.token,
        session: async () => getSession(apiBase, login.userName, login.password),
        dropSession: () => dropSession(login.userName, login.password),
    };
}

/**
 * Artwork URL for the Stremio client, pointing at this addon's image proxy.
 *
 * The proxy is addressed by ITEM ID, never by a full Jellyfin URL: the old
 * `?url=<anything>` form both leaked the Jellyfin credential into every poster
 * URL and let any caller use the addon as an open proxy to fetch arbitrary hosts.
 * The viewer's own configuration rides along so the proxy fetches as them.
 */
export function proxyImageUrl(viewer, itemId, imageType) {
    const params = new URLSearchParams({ item: itemId, img: imageType });
    if (viewer.sealed) params.set('c', viewer.sealed);
    return `${process.env.HTTPS_BASE_URL}/proxy-image?${params.toString()}`;
}

/**
 * Is playback proxied through this addon rather than fetched straight from
 * Jellyfin? On by default in multi-user mode, because Jellyfin's media endpoints
 * are anonymous: without the proxy, "authenticated" would stop at the catalog and
 * the bytes would be open to anyone holding a URL. Off by default in single-user
 * mode, which keeps a private LAN install behaving exactly as it always has.
 */
export function isMediaProxied() {
    const explicit = String(process.env.PROXY_MEDIA ?? '').trim().toLowerCase();
    if (explicit === 'true' || explicit === '1') return true;
    if (explicit === 'false' || explicit === '0') return false;
    return getRunMode() === 'multi-user';
}

/**
 * A media URL for the PLAYER.
 *
 * Proxied: it points back at this addon, carries the viewer's configuration, and
 * NO Jellyfin token — nothing in the URL is a Jellyfin credential, and it is
 * useless to anyone Jellyfin will not authenticate.
 * Direct: the legacy shape, straight at Jellyfin's public host with a token.
 */
export function playbackUrl(viewer, path, params = {}) {
    if (isMediaProxied()) {
        const prefix = viewer.sealed ? `/${encodeURIComponent(JSON.stringify({ jf: viewer.sealed }))}` : '';
        const qs = new URLSearchParams(params).toString();
        return `${process.env.HTTPS_BASE_URL}${prefix}/jf${path}${qs ? `?${qs}` : ''}`;
    }

    const qs = new URLSearchParams({ ...params, api_key: viewer.currentToken() });
    return `${viewer.publicBase}${path}?${qs.toString()}`;
}

export { dropSession };
