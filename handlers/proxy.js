import axios from 'axios';
import { getJellyfinApiBase, getJellyfinPublicBase } from '../global-constants.js';
import { resolveViewer } from '../viewer.js';
import { jellyfinRequest } from '../jellyfin-auth.js';

// ==========================================
// THE JELLYFIN IMAGE PROXY
// ==========================================
// Stremio fetches artwork itself, so the addon proxies it: Jellyfin may sit on a
// LAN address the client cannot reach.
//
// Addressed by ITEM ID (`?item=<id>&img=Primary&c=<viewer config>`). The older
// `?url=<full jellyfin url>` form is still accepted for artwork URLs already
// cached in a client, but only for the configured Jellyfin server — as written it
// would fetch ANY host on request, which turns the addon into an open proxy
// reachable from wherever the addon is reachable.

const ALLOWED_IMAGE_TYPES = new Set(['Primary', 'Backdrop', 'Logo', 'Thumb', 'Banner', 'Art', 'Disc']);

function isOurJellyfin(url) {
    const bases = [getJellyfinApiBase(), getJellyfinPublicBase()].filter(Boolean);
    try {
        const target = new URL(url);
        return bases.some((base) => {
            const allowed = new URL(base);
            return allowed.protocol === target.protocol && allowed.host === target.host;
        });
    } catch {
        return false;
    }
}

export async function proxyImageHandler(req, res) {
    const { item, img, c, url: legacyUrl } = req.query;

    try {
        // ----- current form: item id + image type, fetched as the viewer -----
        if (item) {
            const imageType = ALLOWED_IMAGE_TYPES.has(img) ? img : 'Primary';

            const viewer = await resolveViewer(c);
            if (!viewer) return res.status(401).send('Not authorised');

            const imageResponse = await jellyfinRequest(viewer, {
                method: 'get',
                path: `/Items/${encodeURIComponent(item)}/Images/${imageType}`,
                responseType: 'stream',
            });

            res.set('Content-Type', imageResponse.headers['content-type']);
            return imageResponse.data.pipe(res);
        }

        // ----- legacy form: a full URL, restricted to our own Jellyfin -----
        if (!legacyUrl) return res.status(400).send('Missing image parameters');
        if (!isOurJellyfin(legacyUrl)) {
            console.warn(`[Proxy] Refused a fetch outside the configured Jellyfin server: ${legacyUrl}`);
            return res.status(403).send('Refused');
        }

        const imageResponse = await axios.get(legacyUrl, { responseType: 'stream', timeout: 20000 });
        res.set('Content-Type', imageResponse.headers['content-type']);
        imageResponse.data.pipe(res);

    } catch (error) {
        const status = error?.response?.status;
        // An image Jellyfin itself refuses (404/401) is not a bridge failure.
        console.error('Proxy error:', error.message, item ? `item=${item}` : legacyUrl);
        res.status(status && status < 500 ? status : 500).send('Error fetching image from Jellyfin');
    }
}
