// ==========================================
// TRANSCODE TIERS
// ==========================================
// What quality the bridge offers a viewer, and how the numbers behind each
// offer are worked out.
//
// The bridge used to hand Stremio exactly one transcode URL, hardcoded to
// `VideoCodec=h264&AudioCodec=aac` with no size and no bitrate. Jellyfin's own
// default is then the SOURCE bitrate, so a 23 Mbps remux was re-encoded to
// roughly 23 Mbps and "transcode" capped nothing at all. That is fine on a LAN
// and useless on a remote link, which is the case this addon exists for.
//
// So a viewer now configures TIERS. Each tier becomes its own row in Stremio's
// stream list, next to Direct Play, and is picked per play — no re-install to
// change quality.
//
// THE BITRATE RULE
// ----------------
// A tier's default bitrate is derived from the source and scaled 1:1 with PIXEL
// COUNT: half the pixels, half the bits. Aspect ratio is preserved, so the
// height ratio squared IS the pixel ratio:
//
//     scale  = tierHeight / sourceHeight        (never above 1 — no upscaling)
//     bitrate = sourceVideoBitrate * scale^2
//
// e.g. a 1920x1080 source at 23.8 Mbps, offered at 720p:
//     scale = 720/1080 = 0.667 ; 0.667^2 = 0.444 ; 23.8 * 0.444 = 10.6 Mbps
//
// This keeps bits-per-pixel constant, so the picture holds up rather than being
// squeezed by a fixed ladder that knows nothing about the source. A viewer who
// wants a hard ceiling instead sets an explicit bitrate on the tier, which wins.

/** The tier catalogue. Keyed by the string that travels in a viewer's config. */
export const TIERS = Object.freeze({
    '2160': { key: '2160', label: '4K', height: 2160 },
    '1440': { key: '1440', label: '1440p', height: 1440 },
    '1080': { key: '1080', label: '1080p', height: 1080 },
    '720': { key: '720', label: '720p', height: 720 },
    '480': { key: '480', label: '480p', height: 480 },
    '360': { key: '360', label: '360p', height: 360 },
});

/**
 * Video codecs a viewer may pick.
 *
 * h264 is the default and is what every Stremio client can play. hevc roughly
 * halves the bitrate at equal quality but has to be carried in fMP4 segments and
 * is not universally supported, so it is opt-in and marked not-web-ready.
 *
 * av1 is deliberately ABSENT. AV1 *encoding* is supported by only the newest
 * GPUs, so whether it works depends on the exact hardware Jellyfin happens to be
 * running on -- and a tier that silently stops working when a server is moved or
 * its GPU changed is worse than one that was never offered. Adding it would mean
 * probing the encoder's real capabilities first, not just naming the codec.
 */
export const VIDEO_CODECS = Object.freeze({
    h264: { key: 'h264', label: 'H.264', container: 'ts', webReady: true },
    hevc: { key: 'hevc', label: 'HEVC (H.265)', container: 'mp4', webReady: false },
});

/** Audio codecs. aac is universal; the others exist for 5.1 passthrough. */
export const AUDIO_CODECS = Object.freeze({
    aac: { key: 'aac', label: 'AAC' },
    ac3: { key: 'ac3', label: 'Dolby Digital (AC3)' },
    eac3: { key: 'eac3', label: 'Dolby Digital Plus (E-AC3)' },
    opus: { key: 'opus', label: 'Opus' },
});

export const DEFAULT_PREFS = Object.freeze({
    tiers: ['1080', '720'],
    bitrates: {},          // tier key -> bits per second, overriding the derived default
    videoCodec: 'h264',
    audioCodec: 'aac',
    audioChannels: 2,
    streamCopy: true,
});

// Audio bitrate follows the channel count rather than being another knob: 128k is
// the accepted figure for stereo AAC and 384k for 5.1, and getting it wrong is
// audible long before it is worth configuring.
const AUDIO_BITRATE = { 2: 128000, 6: 384000 };

// Out of range is REJECTED, not clamped. Clamping a mistyped "1" up to 100 kbps
// would hand back an unwatchable stream that the viewer never asked for and
// could not explain; dropping it falls back to the derived bitrate, which is a
// sane number by construction.
const inRange = (v, lo, hi) => {
    const n = Math.trunc(Number(v));
    return Number.isFinite(n) && n >= lo && n <= hi ? n : null;
};

/**
 * Normalise whatever arrived in a configuration into usable preferences.
 *
 * Everything here is attacker-reachable in the sense that it comes off a URL, so
 * nothing is trusted: unknown tiers, codecs and channel counts are dropped, not
 * passed through to Jellyfin. An empty or absent value yields DEFAULT_PREFS,
 * which is what every install URL minted before this feature existed carries.
 */
export function normalisePrefs(raw) {
    if (!raw || typeof raw !== 'object') return { ...DEFAULT_PREFS, bitrates: {} };

    const tiers = Array.isArray(raw.t) ? raw.t.map(String).filter((k) => TIERS[k]) : null;
    // Highest first, so Stremio lists the best option at the top.
    const ordered = tiers && tiers.length
        ? [...new Set(tiers)].sort((a, b) => TIERS[b].height - TIERS[a].height)
        : [...DEFAULT_PREFS.tiers];

    const bitrates = {};
    if (raw.b && typeof raw.b === 'object') {
        for (const [k, v] of Object.entries(raw.b)) {
            if (!TIERS[k]) continue;
            // 100 kbps to 100 Mbps. Outside that it is a typo or a probe.
            const bps = inRange(v, 100000, 100000000);
            if (bps) bitrates[k] = bps;
        }
    }

    return {
        tiers: ordered,
        bitrates,
        videoCodec: VIDEO_CODECS[raw.vc] ? raw.vc : DEFAULT_PREFS.videoCodec,
        audioCodec: AUDIO_CODECS[raw.ac] ? raw.ac : DEFAULT_PREFS.audioCodec,
        audioChannels: raw.ch === 6 || raw.ch === '6' ? 6 : 2,
        streamCopy: raw.sc === undefined ? DEFAULT_PREFS.streamCopy : !(raw.sc === false || raw.sc === 0 || raw.sc === '0'),
    };
}

/** The compact form that travels inside the sealed blob. Short keys keep the URL short. */
export function packPrefs(prefs) {
    const p = normalisePrefs(prefs && prefs.t ? prefs : {
        t: prefs?.tiers, b: prefs?.bitrates, vc: prefs?.videoCodec,
        ac: prefs?.audioCodec, ch: prefs?.audioChannels, sc: prefs?.streamCopy,
    });
    return {
        t: p.tiers,
        ...(Object.keys(p.bitrates).length ? { b: p.bitrates } : {}),
        vc: p.videoCodec,
        ac: p.audioCodec,
        ch: p.audioChannels,
        sc: p.streamCopy ? 1 : 0,
    };
}

/**
 * The bitrate a tier gets for one specific source, in bits per second.
 *
 * An explicit per-tier override wins outright. Otherwise the pixel-count rule
 * above applies. Returns null when the source bitrate is unknown — Jellyfin is
 * then left to decide rather than being handed a number invented here.
 */
export function derivedBitrate(tierKey, source, prefs) {
    const override = prefs?.bitrates?.[tierKey];
    if (override) return override;

    const tier = TIERS[tierKey];
    const srcH = source?.height || 0;
    const srcBps = source?.videoBitrate || 0;
    if (!tier || !srcH || !srcBps) return null;

    const scale = Math.min(1, tier.height / srcH);
    // Rounded to the nearest 100 kbps: the third significant figure of a derived
    // bitrate is noise, and a round number is far easier to recognise in a log.
    return Math.max(100000, Math.round((srcBps * scale * scale) / 100000) * 100000);
}

/**
 * Pull the numbers a tier decision needs out of a Jellyfin MediaSource.
 *
 * The VIDEO stream's own bitrate is used, not the container's: the container
 * figure includes every audio track, which on a dubbed file carrying a second
 * language is a few hundred kbps of bits that are not picture.
 */
export function readSource(mediaSource) {
    const streams = mediaSource?.MediaStreams || [];
    const video = streams.find((s) => s.Type === 'Video') || {};
    const audioTotal = streams
        .filter((s) => s.Type === 'Audio')
        .reduce((sum, s) => sum + (s.BitRate || 0), 0);

    const container = mediaSource?.Bitrate || 0;
    const videoBitrate = video.BitRate || (container ? Math.max(0, container - audioTotal) : 0);

    return {
        width: video.Width || 0,
        height: video.Height || 0,
        codec: (video.Codec || '').toLowerCase(),
        videoBitrate,
    };
}

/**
 * Which tiers to actually offer for one source, best first.
 *
 * A tier is offered only if it is strictly SMALLER than the source. Upscaling is
 * pointless — it spends GPU time to make the picture no better and the stream
 * bigger — and a tier at exactly the source resolution is no better: it asks the
 * viewer to choose between "1080p" and "1080p", and re-encodes a file that was
 * already the size they asked for.
 *
 * The one exception is a source whose codec the player cannot decode. Then Direct
 * Play fails and, with every tier filtered out, the viewer would be left with no
 * working option at all — so a single same-resolution entry is emitted, which
 * stream-copy turns into a cheap remux into a playable container rather than a
 * real transcode.
 */
export function applicableTiers(source, prefs) {
    const srcH = source?.height || 0;
    const chosen = prefs.tiers.filter((k) => TIERS[k] && (!srcH || TIERS[k].height < srcH));

    if (chosen.length) return chosen.map((k) => ({ ...TIERS[k], sourceHeight: srcH }));

    // Nothing smaller to offer. Direct Play already covers a source the player
    // can decode, so only step in when it cannot.
    const target = VIDEO_CODECS[prefs.videoCodec] || VIDEO_CODECS.h264;
    if (source?.codec === 'h264' || source?.codec === target.key) return [];

    return [{
        key: 'source',
        label: srcH ? `${srcH}p` : 'source',
        height: srcH,
        sourceHeight: srcH,
        atSource: true,
    }];
}

/**
 * The query Jellyfin is asked for one tier.
 *
 * `EnableAutoStreamCopy` is what makes a tier cheap when it can be: Jellyfin
 * copies the video stream untouched if it already satisfies the constraints,
 * and only re-encodes when it does not. Turning it off forces a re-encode every
 * time, which is occasionally what someone wants and is never the default.
 */
export function tierParams(tier, source, prefs, mediaSourceId) {
    const video = VIDEO_CODECS[prefs.videoCodec] || VIDEO_CODECS.h264;
    const bitrate = tier.atSource ? (prefs.bitrates[tier.key] || null) : derivedBitrate(tier.key, source, prefs);

    const params = {
        mediaSourceId,
        VideoCodec: video.key,
        AudioCodec: prefs.audioCodec,
        TranscodingMaxAudioChannels: String(prefs.audioChannels),
        audioBitRate: String(AUDIO_BITRATE[prefs.audioChannels] || AUDIO_BITRATE[2]),
        SegmentContainer: video.container,
        EnableAutoStreamCopy: prefs.streamCopy ? 'true' : 'false',
    };

    // Height alone caps the size: Jellyfin preserves aspect ratio, so passing a
    // width too would fight it on anything that is not exactly 16:9.
    if (!tier.atSource && tier.height) params.maxHeight = String(tier.height);
    if (bitrate) params.videoBitRate = String(bitrate);

    return params;
}

/** What the viewer reads in Stremio's stream list for this tier. */
export function tierDescription(tier, source, prefs) {
    const video = VIDEO_CODECS[prefs.videoCodec] || VIDEO_CODECS.h264;
    const bitrate = tier.atSource ? (prefs.bitrates[tier.key] || null) : derivedBitrate(tier.key, source, prefs);
    const isCopy = prefs.streamCopy && tier.height === source.height && source.codec === video.key;

    const bits = [];
    bits.push(isCopy ? 'remux' : video.label);
    if (bitrate) bits.push('≤ ' + (bitrate / 1000000).toFixed(1) + ' Mbps');
    if (prefs.bitrates[tier.key]) bits.push('set by you');
    bits.push(prefs.audioChannels === 6 ? '5.1' : 'stereo');

    return bits.join(' • ');
}

export const isWebReady = (prefs) => (VIDEO_CODECS[prefs.videoCodec] || VIDEO_CODECS.h264).webReady;
