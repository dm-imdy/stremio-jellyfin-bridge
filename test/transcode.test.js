// Tests for the transcode tiers.
//
// The behaviour under test is arithmetic and a set of refusals, so every case
// here executes the thing and checks the number or the decision that came out.
// Nothing asserts on source text: a comment describing a rule and a rule that
// runs are not the same object, and only one of them can be wrong silently.

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.BRIDGE_SECRET = 'test-secret-for-the-suite';
process.env.JELLYFIN_URL = 'http://jellyfin.invalid:8096';

const {
    TIERS, VIDEO_CODECS, DEFAULT_PREFS,
    normalisePrefs, packPrefs, derivedBitrate, readSource,
    applicableTiers, tierParams, isWebReady,
} = await import('../transcode.js');
const { sealLogin, openLogin } = await import('../viewer.js');

const prefs = (over = {}) => normalisePrefs({
    t: DEFAULT_PREFS.tiers, vc: 'h264', ac: 'aac', ch: 2, sc: 1, ...over,
});

// Taken from a real 1080p remux: 1920x1080, 23,778,331 bps of video with a
// 192 kbps 5.1 track beside it, so the container bitrate and the video bitrate
// genuinely differ.
const REMUX = {
    Bitrate: 23970331,
    MediaStreams: [
        { Type: 'Video', Codec: 'h264', Width: 1920, Height: 1080, BitRate: 23778331 },
        { Type: 'Audio', Codec: 'eac3', Channels: 6, BitRate: 192000 },
    ],
};

// ---------------------------------------------------------------------------
// The bitrate rule: bits scale 1:1 with PIXEL COUNT, so the height ratio squared.
// ---------------------------------------------------------------------------
test('bitrate scales with pixel count, not with height', () => {
    const src = readSource(REMUX);

    // 720/1080 = 0.6667 of the height => 0.4444 of the pixels.
    // 23,778,331 * 0.4444 = 10,568,147 -> 10.6 Mbps.
    assert.equal(derivedBitrate('720', src, prefs()), 10600000);

    // 480/1080 squared = 0.1975 => 4,696,706 -> 4.7 Mbps.
    assert.equal(derivedBitrate('480', src, prefs()), 4700000);
});

test('the default tiers are 1080p and 720p', () => {
    // What every viewer gets without configuring anything, including every
    // install link minted before this feature existed.
    assert.deepEqual(DEFAULT_PREFS.tiers, ['1080', '720']);
    assert.deepEqual(normalisePrefs(null).tiers, ['1080', '720']);
});

test('halving the pixels halves the bitrate exactly', () => {
    // 1440p -> 1018p would be awkward to read, so this uses a source whose
    // half-pixel point lands on a real tier: 2160 -> 1527 is not one, but
    // 1080 is exactly a quarter of 2160's pixels.
    const src = readSource({
        MediaStreams: [{ Type: 'Video', Codec: 'hevc', Width: 3840, Height: 2160, BitRate: 40000000 }],
    });
    assert.equal(derivedBitrate('1080', src, prefs()), 10000000);   // quarter the pixels, quarter the bits
});

test('an explicit per-tier bitrate wins over the derived one', () => {
    const src = readSource(REMUX);
    const p = prefs({ b: { 720: 3000000 } });
    assert.equal(derivedBitrate('720', src, p), 3000000);
    // ...and only for the tier it was set on.
    assert.equal(derivedBitrate('480', src, p), 4700000);
});

test('an unknown source bitrate yields no bitrate rather than an invented one', () => {
    const src = readSource({ MediaStreams: [{ Type: 'Video', Codec: 'h264', Width: 1920, Height: 1080 }] });
    assert.equal(derivedBitrate('720', src, prefs()), null);
    assert.equal(tierParams(TIERS['720'], src, prefs(), 'ms1').videoBitRate, undefined);
});

// ---------------------------------------------------------------------------
// Reading the source. The VIDEO stream's bitrate is the one that matters.
// ---------------------------------------------------------------------------
test('source bitrate comes from the video stream, not the container', () => {
    const src = readSource(REMUX);
    assert.equal(src.videoBitrate, 23778331);       // not 23,970,331
    assert.equal(src.height, 1080);
    assert.equal(src.codec, 'h264');
});

test('a source with no per-stream bitrate falls back to container minus audio', () => {
    const src = readSource({
        Bitrate: 10000000,
        MediaStreams: [
            { Type: 'Video', Codec: 'h264', Width: 1280, Height: 720 },
            { Type: 'Audio', BitRate: 256000 },
        ],
    });
    assert.equal(src.videoBitrate, 9744000);
});

// ---------------------------------------------------------------------------
// Which tiers get offered.
// ---------------------------------------------------------------------------
test('a tier at the SAME resolution as the source is not offered', () => {
    // A 1080p file must not be offered a "1080p transcode" -- that is a re-encode
    // to the size it already is, sitting next to Direct Play saying the same word.
    const src = readSource(REMUX);                            // 1920x1080 h264
    const keys = applicableTiers(src, prefs()).map((t) => t.key);
    assert.deepEqual(keys, ['720']);
});

test('tiers above the source resolution are not offered', () => {
    const src = readSource({
        MediaStreams: [{ Type: 'Video', Codec: 'h264', Width: 1280, Height: 720, BitRate: 4000000 }],
    });
    // 1080 would upscale, 720 is the source size: on the defaults, neither is
    // worth offering and Direct Play already plays this file.
    assert.deepEqual(applicableTiers(src, prefs()).map((t) => t.key), []);
    // A smaller tier still is.
    assert.deepEqual(applicableTiers(src, prefs({ t: ['1080', '720', '480'] })).map((t) => t.key), ['480']);
});

test('tiers are offered best first', () => {
    const src = readSource({
        MediaStreams: [{ Type: 'Video', Codec: 'h264', Width: 3840, Height: 2160, BitRate: 60000000 }],
    });
    const keys = applicableTiers(src, prefs({ t: ['480', '1080', '720'] })).map((t) => t.key);
    assert.deepEqual(keys, ['1080', '720', '480']);
});

test('a playable source with nothing smaller gets no transcode row at all', () => {
    const src = readSource({
        MediaStreams: [{ Type: 'Video', Codec: 'h264', Width: 640, Height: 360, BitRate: 900000 }],
    });
    // Direct Play handles h264. Offering a same-size re-encode would be noise.
    assert.deepEqual(applicableTiers(src, prefs({ t: ['1080', '720'] })), []);
});

test('an UNPLAYABLE source with nothing smaller still gets one remux row', () => {
    const src = readSource({
        MediaStreams: [{ Type: 'Video', Codec: 'mpeg4', Width: 640, Height: 360, BitRate: 900000 }],
    });
    const tiers = applicableTiers(src, prefs({ t: ['1080', '720'] }));
    assert.equal(tiers.length, 1);
    assert.equal(tiers[0].atSource, true);
    // No maxHeight: nothing to cap. This offer exists only to reach a container
    // the player will accept, not to change the size.
    assert.equal(tierParams(tiers[0], src, prefs(), 'ms1').maxHeight, undefined);
});

// ---------------------------------------------------------------------------
// The query handed to Jellyfin.
// ---------------------------------------------------------------------------
test('a tier caps height and bitrate, and allows stream copy by default', () => {
    const src = readSource(REMUX);
    const p = tierParams(TIERS['720'], src, prefs(), 'ms-42');

    assert.equal(p.maxHeight, '720');
    assert.equal(p.videoBitRate, '10600000');
    assert.equal(p.mediaSourceId, 'ms-42');
    assert.equal(p.EnableAutoStreamCopy, 'true');
    assert.equal(p.TranscodingMaxAudioChannels, '2');
    assert.equal(p.audioBitRate, '128000');
    assert.equal(p.SegmentContainer, 'ts');
});

test('turning stream copy off reaches Jellyfin', () => {
    const src = readSource(REMUX);
    assert.equal(tierParams(TIERS['720'], src, prefs({ sc: 0 }), 'm').EnableAutoStreamCopy, 'false');
});

test('5.1 raises the audio bitrate with the channel count', () => {
    const src = readSource(REMUX);
    const p = tierParams(TIERS['720'], src, prefs({ ch: 6 }), 'm');
    assert.equal(p.TranscodingMaxAudioChannels, '6');
    assert.equal(p.audioBitRate, '384000');
});

test('HEVC switches the segment container to fMP4 and is flagged not-web-ready', () => {
    const src = readSource(REMUX);
    const p = prefs({ vc: 'hevc' });
    assert.equal(tierParams(TIERS['720'], src, p, 'm').SegmentContainer, 'mp4');
    assert.equal(tierParams(TIERS['720'], src, p, 'm').VideoCodec, 'hevc');
    assert.equal(isWebReady(p), false);
    assert.equal(isWebReady(prefs()), true);
});

// ---------------------------------------------------------------------------
// Nothing off a URL is trusted.
// ---------------------------------------------------------------------------
test('unknown tiers and codecs are dropped, not forwarded to Jellyfin', () => {
    const p = normalisePrefs({ t: ['1080', '9999', 'DROP TABLE'], vc: 'vp9', ac: 'mp3' });
    assert.deepEqual(p.tiers, ['1080']);
    assert.equal(p.videoCodec, 'h264');
    assert.equal(p.audioCodec, 'aac');
});

test('AV1 cannot be selected — support is too hardware-dependent to promise', () => {
    // AV1 encoding exists only on the newest GPUs. Offering it by name, without
    // probing what the encoder can actually do, produces a tier that works on one
    // server and fails on another with nothing to tell the viewer why.
    assert.equal(VIDEO_CODECS.av1, undefined);
    assert.equal(normalisePrefs({ vc: 'av1' }).videoCodec, 'h264');
});

test('absurd bitrates are clamped away', () => {
    assert.deepEqual(normalisePrefs({ b: { 720: 1 } }).bitrates, {});                 // below 100 kbps
    assert.deepEqual(normalisePrefs({ b: { 720: 999000000000 } }).bitrates, {});      // above 100 Mbps
    assert.deepEqual(normalisePrefs({ b: { 720: 'x' } }).bitrates, {});
    assert.deepEqual(normalisePrefs({ b: { 999: 4000000 } }).bitrates, {});           // not a real tier
});

test('an empty tier list falls back to the defaults rather than offering nothing', () => {
    assert.deepEqual(normalisePrefs({ t: [] }).tiers, DEFAULT_PREFS.tiers);
    assert.deepEqual(normalisePrefs(null).tiers, DEFAULT_PREFS.tiers);
});

// ---------------------------------------------------------------------------
// The seal. This is the regression that matters most: every install link handed
// out before tiers existed was sealed WITHOUT them and must keep working.
// ---------------------------------------------------------------------------
test('preferences survive a seal/open round trip', () => {
    const sealed = sealLogin({
        userName: 'viewer', password: 'pw',
        prefs: { tiers: ['1080', '480'], bitrates: { 480: 1500000 }, videoCodec: 'hevc', audioCodec: 'eac3', audioChannels: 6, streamCopy: false },
    });
    const opened = openLogin(sealed);

    assert.equal(opened.userName, 'viewer');
    assert.equal(opened.password, 'pw');
    assert.deepEqual(opened.prefs.tiers, ['1080', '480']);
    assert.deepEqual(opened.prefs.bitrates, { 480: 1500000 });
    assert.equal(opened.prefs.videoCodec, 'hevc');
    assert.equal(opened.prefs.audioCodec, 'eac3');
    assert.equal(opened.prefs.audioChannels, 6);
    assert.equal(opened.prefs.streamCopy, false);
});

test('an install link sealed before tiers existed still opens, on the defaults', () => {
    // Exactly what sealLogin produced before this feature: no `q` in the payload.
    const legacy = sealLogin({ userName: 'old-viewer', password: 'pw' });
    const opened = openLogin(legacy);

    assert.equal(opened.userName, 'old-viewer');
    assert.equal(opened.password, 'pw');
    assert.deepEqual(opened.prefs.tiers, DEFAULT_PREFS.tiers);
    assert.equal(opened.prefs.videoCodec, 'h264');
    assert.equal(opened.prefs.streamCopy, true);
});

test('the configure page form shape packs into the sealed short form', () => {
    // What the browser actually posts, long-keyed.
    const packed = packPrefs({
        tiers: ['720'], bitrates: { 720: 3000000 },
        videoCodec: 'h264', audioCodec: 'aac', audioChannels: 2, streamCopy: true,
    });
    assert.deepEqual(packed.t, ['720']);
    assert.deepEqual(packed.b, { 720: 3000000 });
    assert.equal(packed.sc, 1);
});
