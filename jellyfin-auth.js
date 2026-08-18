import axios from 'axios';
import crypto from 'crypto';
import { thisAddon } from './common-utils.js';

// ==========================================
// JELLYFIN USER AUTHENTICATION
// ==========================================
// Jellyfin has two kinds of credential, and only one of them is safe to hand out:
//
//   * an API key (dashboard -> API keys) is ALWAYS server-wide and ALWAYS admin.
//     Anything holding it can read every library and every user, so it must never
//     leave the server -- yet the bridge used to embed it in every stream, poster
//     and subtitle URL it emitted.
//   * an access token from POST /Users/AuthenticateByName belongs to ONE user and
//     carries exactly that user's permissions and library visibility.
//
// So a viewer is authenticated with their own Jellyfin login and everything the
// bridge does for them is done with their token. Jellyfin itself is the gate: if
// it refuses the login (wrong password, disabled account, no library access), the
// bridge has nothing to serve. There is no second password to keep in step.
//
// Tokens, unlike API keys, can be invalidated server-side (logout, some restarts),
// so they are treated as a cache over the credentials, never as the credentials:
// a 401 drops the cached session and re-authenticates once from the stored login.

const SESSIONS = new Map();          // credential key -> { token, userId, userName, isAdmin, checkedAt }
const INFLIGHT = new Map();          // credential key -> Promise, so N parallel requests log in once

// Keyed by the CREDENTIALS, never by the username alone. Keying on the name means
// a request presenting that name and any password at all reuses whatever session
// is cached -- measured as a straight authentication bypass: a configuration of
// {"username":"asi","password":"wrong"} returned asi's real catalogue.
function sessionKey(userName, password) {
    // JSON so the two fields cannot run together: a separator that either field
    // may itself contain would let one pair collide with another.
    return crypto.createHash('sha256')
        .update(JSON.stringify([String(userName).toLowerCase(), String(password)]))
        .digest('hex');
}

// Jellyfin keys a session by DeviceId: authenticating a DIFFERENT user with the
// SAME DeviceId replaces the existing session and invalidates its token. One
// stable id per user therefore keeps viewers from logging each other out, while
// still giving each viewer a single long-lived session instead of one per request.
function deviceIdFor(userName) {
    return 'sjb-' + crypto.createHash('sha256').update(userName.toLowerCase()).digest('hex').slice(0, 24);
}

function authHeader(userName, token) {
    const parts = [
        `MediaBrowser Client="${thisAddon.name}"`,
        `Device="Stremio"`,
        `DeviceId="${deviceIdFor(userName)}"`,
        `Version="${thisAddon.version}"`,
    ];
    if (token) parts.push(`Token="${token}"`);
    return parts.join(', ');
}

/**
 * Log a user in against Jellyfin and return their session.
 * Throws on bad credentials (Jellyfin answers 401) or an unreachable server.
 */
export async function authenticateByName(baseUrl, userName, password) {
    const res = await axios.post(
        `${baseUrl}/Users/AuthenticateByName`,
        { Username: userName, Pw: password },
        { headers: { Authorization: authHeader(userName), 'Content-Type': 'application/json' }, timeout: 15000 }
    );

    const user = res.data?.User || {};
    if (!res.data?.AccessToken || !user.Id) {
        throw new Error('Jellyfin accepted the login but returned no access token');
    }

    return {
        token: res.data.AccessToken,
        userId: user.Id,
        userName: user.Name,
        // Reported so the caller can warn: handing an admin account to a guest
        // gives back exactly the blast radius this whole change removes.
        isAdmin: !!user.Policy?.IsAdministrator,
    };
}

/** How long a cached session is trusted before Jellyfin is asked about it again. */
function recheckAfterMs() {
    const seconds = Number(process.env.AUTH_RECHECK_SECONDS);
    return (Number.isFinite(seconds) && seconds >= 0 ? seconds : 60) * 1000;
}

/**
 * Cached login. Concurrent callers for the same user share one authentication.
 *
 * The cache is REVALIDATED, not just held. Nothing else forces it to expire:
 * Jellyfin's media endpoints are anonymous, so a proxied stream never comes back
 * 401 no matter what happened to the account — measured, by disabling a user
 * mid-test and watching the bytes keep flowing. So every AUTH_RECHECK_SECONDS the
 * token is put to an endpoint that DOES enforce authorisation (/Users/Me). A
 * disabled account, a deleted account or an invalidated token fails there, the
 * session is dropped, and re-authentication from the stored credentials fails too
 * — which is what makes revoking access in Jellyfin actually stop playback.
 */
export async function getSession(baseUrl, userName, password) {
    const key = sessionKey(userName, password);

    const cached = SESSIONS.get(key);
    if (cached) {
        if (Date.now() - cached.checkedAt < recheckAfterMs()) return cached;
        try {
            await axios.get(`${baseUrl}/Users/Me`, {
                headers: { Authorization: authHeader(cached.userName, cached.token) },
                timeout: 10000,
            });
            cached.checkedAt = Date.now();
            return cached;
        } catch (error) {
            // Refused, or Jellyfin unreachable. Either way stop trusting the
            // cached token: fall through and prove the credentials again.
            console.warn(`[Auth] Re-check failed for "${cached.userName}" ` +
                `(${error.response?.status || error.message}) — re-authenticating.`);
            SESSIONS.delete(key);
        }
    }

    if (INFLIGHT.has(key)) return INFLIGHT.get(key);

    const pending = authenticateByName(baseUrl, userName, password)
        .then((session) => {
            session.checkedAt = Date.now();
            SESSIONS.set(key, session);
            return session;
        })
        .finally(() => INFLIGHT.delete(key));

    INFLIGHT.set(key, pending);
    return pending;
}

export function dropSession(userName, password) {
    SESSIONS.delete(sessionKey(userName, password));
}

/**
 * The session currently held for a user, without logging in.
 * Used when stamping a token into a URL: a call earlier in the same request may
 * have re-authenticated, which makes any session object captured before it stale.
 */
export function peekSession(userName, password) {
    return SESSIONS.get(sessionKey(userName, password)) || null;
}

/** Is this the Jellyfin "you are not authorised" answer? */
export function isAuthFailure(error) {
    const status = error?.response?.status;
    return status === 401 || status === 403;
}

/**
 * Authenticated Jellyfin call for a viewer, with one re-login retry.
 *
 * The retry is what makes a cached token safe: when Jellyfin invalidates it the
 * viewer sees nothing at all, because the credentials -- not the token -- are what
 * the bridge actually stores. A second failure is a real refusal and propagates,
 * so a disabled account stops working rather than silently falling back.
 */
export async function jellyfinRequest(viewer, config) {
    const send = (session) =>
        axios({
            ...config,
            url: `${viewer.apiBase}${config.path}`,
            headers: { ...(config.headers || {}), Authorization: authHeader(session.userName, session.token) },
            timeout: config.timeout ?? 20000,
        });

    let session = await viewer.session();

    try {
        return await send(session);
    } catch (error) {
        if (!isAuthFailure(error) || !viewer.canReauthenticate) throw error;

        console.warn(`[Auth] Jellyfin rejected the cached token for "${session.userName}" — re-authenticating.`);
        viewer.dropSession?.();
        session = await viewer.session();
        return send(session);
    }
}
