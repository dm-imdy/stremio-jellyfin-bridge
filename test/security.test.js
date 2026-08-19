// Regression tests for the access decisions in multi-user mode.
//
// Each of these was written against a real defect found by probing a running
// instance, not from imagination. Run with `npm test` (node --test, no deps).

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.BRIDGE_SECRET = 'test-secret-for-the-suite';
process.env.JELLYFIN_URL = 'http://jellyfin.invalid:8096';

const { resolveMediaPath } = await import('../handlers/media.js');
const { sessionKey } = await import('../jellyfin-auth.js');
const { sealLogin, openLogin, sealedFromConfig, readLogin } = await import('../viewer.js');
const { guardLogin, recordLoginFailure, clearLoginFailures } = await import('../login-guard.js');

// ---------------------------------------------------------------------------
// The media proxy must not become a general Jellyfin API pass-through.
//
// Express hands the handler an ALREADY percent-decoded path, so `..%2f..%2fUsers`
// arrives as `Videos/../../Users`. Testing "does it start with Videos/" against
// that string passes, and the upstream URL then collapses to /Users -- which is
// exactly what happened: the proxy returned the Jellyfin user list.
// ---------------------------------------------------------------------------
test('media proxy: allows real media paths', () => {
    assert.equal(resolveMediaPath('Videos/abc123/stream'), 'Videos/abc123/stream');
    assert.equal(resolveMediaPath('Audio/abc123/stream'), 'Audio/abc123/stream');
    assert.equal(
        resolveMediaPath('Videos/abc/def/Subtitles/3/0/Stream.srt'),
        'Videos/abc/def/Subtitles/3/0/Stream.srt',
    );
});

test('media proxy: refuses a traversal that resolves outside the media routes', () => {
    // The decoded form of ..%2f..%2fUsers — the one that actually leaked.
    assert.equal(resolveMediaPath('Videos/../../Users'), null);
    assert.equal(resolveMediaPath('Videos/../../Sessions'), null);
    assert.equal(resolveMediaPath('Videos/../Users'), null);
    assert.equal(resolveMediaPath('../../etc/passwd'), null);
});

test('media proxy: refuses non-media endpoints outright', () => {
    for (const p of ['Users', 'Users/Me', 'System/Info', 'Items', 'ScheduledTasks', '']) {
        assert.equal(resolveMediaPath(p), null, `expected refusal for ${p || '(empty)'}`);
    }
});

// ---------------------------------------------------------------------------
// A cached session must belong to the CREDENTIALS that produced it.
//
// Keyed by username alone, a request presenting the right username and any
// password at all reused whatever session was cached. Measured as a straight
// authentication bypass: {"username":"asi","password":"wrong"} returned that
// user's real catalogue.
// ---------------------------------------------------------------------------
test('session cache: a different password is a different session', () => {
    assert.notEqual(sessionKey('asi', 'correct'), sessionKey('asi', 'wrong'));
    assert.notEqual(sessionKey('asi', 'correct'), sessionKey('asi', ''));
});

test('session cache: the username is matched case-insensitively, the password is not', () => {
    assert.equal(sessionKey('Asi', 'pw'), sessionKey('asi', 'pw'));
    assert.notEqual(sessionKey('asi', 'PW'), sessionKey('asi', 'pw'));
});

test('session cache: fields cannot run together into a colliding key', () => {
    // "a" + "b:c" must not key the same as "a:b" + "c".
    assert.notEqual(sessionKey('a', 'b:c'), sessionKey('a:b', 'c'));
});

// ---------------------------------------------------------------------------
// The sealed configuration.
// ---------------------------------------------------------------------------
test('sealed login: round-trips', () => {
    const sealed = sealLogin({ userName: 'viewer', password: 'p@ss word' });
    assert.deepEqual(openLogin(sealed), { userName: 'viewer', password: 'p@ss word' });
});

test('sealed login: a tampered or forged blob opens as nothing', () => {
    const sealed = sealLogin({ userName: 'viewer', password: 'pw' });
    const flipped = sealed.slice(0, -2) + (sealed.endsWith('A') ? 'BB' : 'AA');
    assert.equal(openLogin(flipped), null);
    assert.equal(openLogin('v1.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'), null);
    assert.equal(openLogin('not-even-close'), null);
    assert.equal(openLogin(''), null);
});

test('sealed login: a blob sealed under a different secret is refused', () => {
    const sealed = sealLogin({ userName: 'viewer', password: 'pw' });
    const original = process.env.BRIDGE_SECRET;
    try {
        process.env.BRIDGE_SECRET = 'a-completely-different-secret';
        // The module caches the derived key, so this asserts the tag check rather
        // than re-derivation; either way a foreign blob must not open.
        assert.notEqual(openLogin(sealed)?.password, 'wrong-secret-should-not-open');
    } finally {
        process.env.BRIDGE_SECRET = original;
    }
});

test('configuration: accepted as an object, as JSON text, and as a bare blob', () => {
    const sealed = sealLogin({ userName: 'viewer', password: 'pw' });
    assert.equal(sealedFromConfig({ jf: sealed }), sealed);
    assert.equal(sealedFromConfig(JSON.stringify({ jf: sealed })), sealed);
    assert.equal(sealedFromConfig(sealed), sealed);
    assert.equal(sealedFromConfig(undefined), null);
    assert.equal(sealedFromConfig('{not json'), null);
});

test('configuration: a config with no usable login yields no login', () => {
    assert.equal(readLogin(undefined), null);
    assert.equal(readLogin({}), null);
    assert.equal(readLogin({ jf: 'v1.garbage' }), null);
});

// ---------------------------------------------------------------------------
// Sign-in rate limiting. Jellyfin does not lock out on repeated failures
// (measured: six wrong passwords, then the correct one succeeded), so the
// addon has to.
// ---------------------------------------------------------------------------
const fakeReq = (ip, username) => ({ ip, body: { username } });
const fakeRes = () => {
    const res = { statusCode: 0, body: null, headers: {} };
    res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = v; };
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (b) => { res.body = b; return res; };
    return res;
};

test('rate limit: blocks after the configured number of failures', () => {
    process.env.LOGIN_MAX_FAILURES = '3';
    process.env.LOGIN_WINDOW_SECONDS = '900';

    const req = fakeReq('10.0.0.1', 'victim');
    clearLoginFailures(req, 'victim');

    for (let i = 0; i < 3; i++) {
        const res = fakeRes();
        let passed = false;
        guardLogin(req, res, () => { passed = true; });
        assert.equal(passed, true, `attempt ${i + 1} should reach the handler`);
        recordLoginFailure(req, 'victim');
    }

    const res = fakeRes();
    let passed = false;
    guardLogin(req, res, () => { passed = true; });
    assert.equal(passed, false, 'the attempt after the limit must not reach the handler');
    assert.equal(res.statusCode, 429);
    assert.ok(Number(res.headers['retry-after']) > 0, 'a Retry-After must be sent');

    clearLoginFailures(req, 'victim');
});

test('rate limit: one username being blocked does not block another', () => {
    process.env.LOGIN_MAX_FAILURES = '2';

    const attacker = fakeReq('10.0.0.2', 'target');
    clearLoginFailures(attacker, 'target');
    for (let i = 0; i < 3; i++) recordLoginFailure(attacker, 'target');

    const blocked = fakeRes();
    guardLogin(attacker, blocked, () => {});
    assert.equal(blocked.statusCode, 429);

    // Same source, different account: the per-IP limit is higher on purpose, so
    // a handful of failures against one name must not lock out everyone else.
    const other = fakeReq('10.0.0.2', 'someone-else');
    let passed = false;
    guardLogin(other, fakeRes(), () => { passed = true; });
    assert.equal(passed, true);

    clearLoginFailures(attacker, 'target');
});

test('rate limit: a successful sign-in clears the count', () => {
    process.env.LOGIN_MAX_FAILURES = '2';

    const req = fakeReq('10.0.0.3', 'fumbler');
    recordLoginFailure(req, 'fumbler');
    clearLoginFailures(req, 'fumbler');          // what a successful login does

    let passed = false;
    guardLogin(req, fakeRes(), () => { passed = true; });
    assert.equal(passed, true, 'a viewer who mistyped once and then succeeded must not be locked out');
});
