// ==========================================
// SIGN-IN RATE LIMITING
// ==========================================
// /configure is a login endpoint, and once the addon is reachable from the
// internet it is an internet-facing one. Jellyfin does not save us here: measured
// against this server, six consecutive wrong passwords all returned 401 and the
// seventh, correct one succeeded — `LoginAttemptsBeforeLockout: -1`, the account
// still enabled. So password guessing was bounded only by how fast requests could
// be made.
//
// Two counters, either of which can block:
//   per USERNAME  — the one that matters. An attacker rotating IPs still cannot
//                   hammer a single account.
//   per CLIENT IP — catches someone spraying many usernames from one place.
//
// Failures only. A successful sign-in clears the username, so a viewer who
// fumbles their password twice and then gets it right is not left locked out.
//
// In memory on purpose: the window is minutes, the bridge is a single process,
// and a restart clearing the counters is not a weakness worth a database.

const FAILURES = new Map();   // key -> { count, firstAt, blockedUntil }
const MAX_KEYS = 10_000;      // spoofed usernames must not grow this without bound

const num = (name, fallback) => {
    const v = Number(process.env[name]);
    return Number.isFinite(v) && v >= 0 ? v : fallback;
};

const windowMs = () => num('LOGIN_WINDOW_SECONDS', 900) * 1000;
const maxPerUser = () => num('LOGIN_MAX_FAILURES', 5);
const maxPerIp = () => num('LOGIN_MAX_FAILURES_PER_IP', 20);

function sweep(now) {
    for (const [key, rec] of FAILURES) {
        if (now - rec.firstAt > windowMs() && (!rec.blockedUntil || rec.blockedUntil < now)) FAILURES.delete(key);
    }
    // Still full after a sweep: the oldest entries go. Insertion order is age
    // order closely enough for a counter whose whole life is one window.
    while (FAILURES.size > MAX_KEYS) FAILURES.delete(FAILURES.keys().next().value);
}

/** The client, as far as we can tell. Behind a proxy this needs `trust proxy`. */
export function clientIp(req) {
    return req.ip || req.socket?.remoteAddress || 'unknown';
}

function check(key, limit, now) {
    const rec = FAILURES.get(key);
    if (!rec) return null;
    if (rec.blockedUntil && rec.blockedUntil > now) return Math.ceil((rec.blockedUntil - now) / 1000);
    if (now - rec.firstAt > windowMs()) { FAILURES.delete(key); return null; }
    return rec.count >= limit ? Math.ceil((rec.firstAt + windowMs() - now) / 1000) : null;
}

function bump(key, limit, now) {
    const rec = FAILURES.get(key);
    if (!rec || now - rec.firstAt > windowMs()) {
        FAILURES.set(key, { count: 1, firstAt: now, blockedUntil: 0 });
        return;
    }
    rec.count += 1;
    if (rec.count >= limit) rec.blockedUntil = now + windowMs();
}

/** Express middleware: refuse a sign-in that is already over its limit. */
export function guardLogin(req, res, next) {
    const now = Date.now();
    sweep(now);

    const userName = String(req.body?.username || '').trim().toLowerCase();
    const ip = clientIp(req);

    const retryAfter = Math.max(
        check(`u:${userName}`, maxPerUser(), now) || 0,
        check(`i:${ip}`, maxPerIp(), now) || 0,
    );

    if (retryAfter > 0) {
        console.warn(`[Login] Blocked: too many failed sign-ins (user "${userName}", ip ${ip}) — ${retryAfter}s left.`);
        res.setHeader('Retry-After', String(retryAfter));
        return res.status(429).json({
            error: `Too many failed sign-in attempts. Try again in ${retryAfter} seconds.`,
        });
    }

    next();
}

export function recordLoginFailure(req, userName) {
    const now = Date.now();
    bump(`u:${String(userName || '').trim().toLowerCase()}`, maxPerUser(), now);
    bump(`i:${clientIp(req)}`, maxPerIp(), now);
}

export function clearLoginFailures(req, userName) {
    FAILURES.delete(`u:${String(userName || '').trim().toLowerCase()}`);
    FAILURES.delete(`i:${clientIp(req)}`);
}
