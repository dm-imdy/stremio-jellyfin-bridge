import path from 'path';
import { resolveViewer } from '../viewer.js';
import { jellyfinRequest } from '../jellyfin-auth.js';

// ==========================================
// THE AUTHENTICATED MEDIA PROXY
// ==========================================
// Jellyfin serves /Videos/{id}/stream, its HLS segments and its subtitle streams
// to ANYONE — those endpoints are declared anonymous in Jellyfin's own OpenAPI
// document, so the item id is effectively the credential. Handing those URLs to a
// player means the bytes are reachable by anyone who ever sees the URL, with no
// account, and they keep working after that account is disabled.
//
// So playback goes through here instead. The viewer is resolved from the same
// configuration every other request carries, Jellyfin authenticates them, and only
// then are the bytes fetched — as that viewer, with their own token, over the LAN.
// Revocation becomes real: disable the account and the next range request stops.
//
// Bandwidth is unchanged. The media already leaves the host it lives on; this only
// changes which process reads it.
//
// The path deliberately MIRRORS Jellyfin's own (/jf/Videos/...), because an HLS
// playlist references its segments relatively. Mirroring means the player resolves
// those references back through this proxy with no playlist rewriting.

// Only media. This is not a general pass-through to the Jellyfin API: a viewer's
// token is theirs, but a proxy that forwards anything is a liability the moment
// some other endpoint turns out to be more powerful than it looks.
const ALLOWED = [/^Videos\//i, /^Audio\//i, /^videos\//i];

// Response headers a player needs for seeking. Everything else is dropped.
const PASS_THROUGH = [
    'content-type', 'content-length', 'content-range', 'accept-ranges',
    'content-disposition', 'etag', 'last-modified',
];

export async function mediaProxyHandler(req, res) {
    // Express hands us the path already percent-decoded, so `..%2f..%2fUsers`
    // arrives as `Videos/../../Users` -- which passes a naive "starts with
    // Videos/" test and then collapses to /Users at the upstream. Resolve the
    // path FIRST and match on what will actually be requested.
    const upstreamPath = path.posix.normalize('/' + (req.params[0] || '')).replace(/^\/+/, '');

    if (upstreamPath.includes('..') || !ALLOWED.some((rx) => rx.test(upstreamPath))) {
        console.warn(`[Media] Refused a non-media path: ${req.params[0]} (resolves to ${upstreamPath})`);
        return res.status(403).send('Refused');
    }

    const viewer = await resolveViewer(req.params.config);
    if (!viewer) return res.status(401).send('Not authorised');

    // The client's own api_key is ignored on purpose: authorisation comes from the
    // configuration it presented, never from a token it chose to send.
    const params = { ...req.query };
    delete params.api_key;
    delete params.ApiKey;

    const headers = {};
    if (req.headers.range) headers.Range = req.headers.range;
    if (req.headers['if-range']) headers['If-Range'] = req.headers['if-range'];

    try {
        const upstream = await jellyfinRequest(viewer, {
            method: req.method === 'HEAD' ? 'head' : 'get',
            path: `/${upstreamPath}`,
            params,
            headers,
            responseType: 'stream',
            timeout: 0,              // a long play is not a stalled request
            maxRedirects: 0,
        });

        for (const h of PASS_THROUGH) {
            if (upstream.headers[h] !== undefined) res.setHeader(h, upstream.headers[h]);
        }
        res.status(upstream.status);

        if (req.method === 'HEAD') {
            upstream.data?.destroy?.();
            return res.end();
        }

        // A viewer who seeks or closes the player leaves us holding an open socket
        // to Jellyfin; without this the connection lives until it times out.
        req.on('close', () => upstream.data?.destroy?.());
        upstream.data.pipe(res);

    } catch (error) {
        const status = error?.response?.status;
        error?.response?.data?.destroy?.();
        console.error(`[Media] ${upstreamPath}: ${error.message}`);
        if (!res.headersSent) res.status(status && status < 500 ? status : 502).send('Upstream error');
        else res.destroy();
    }
}
