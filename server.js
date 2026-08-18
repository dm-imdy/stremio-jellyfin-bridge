import { thisAddon } from "./common-utils.js";
import { getJellyfinConfigStatus, getJellyfinApiBase, getJellyfinPublicBase } from "./global-constants.js";

import { serveHTTPS, getHttpsBaseUrl } from "./https.js";
import stremio from 'stremio-addon-sdk';
const { addonBuilder, serveHTTP, getRouter } = stremio;
import express from 'express';
import { isMediaProxied } from './viewer.js';
import { manifest } from './manifest.js';
import { proxyImageHandler } from './handlers/proxy.js';
import { mediaProxyHandler } from './handlers/media.js';
import { configurePage, configureSubmit } from './handlers/configure.js';
import { guardLogin } from './login-guard.js';
import { localSubtitleRoute, localSubtitleWriteRoute } from './handlers/localSubsRoute.js';
import { anySourceEnabled } from './subtitleSources/index.js';
import axios from 'axios';

// Import our modular handlers
import { catalogHandler } from './handlers/catalog.js';
import { metaHandler } from './handlers/meta.js';
import { streamHandler } from './handlers/stream.js';
import { subtitlesHandler } from './handlers/subtitles.js';

// Environment checks
const JELLYFIN_URL = process.env.JELLYFIN_URL;
const JELLYFIN_API_KEY = process.env.JELLYFIN_API_KEY;
const JELLYFIN_USER_NAME = process.env.JELLYFIN_USER_NAME;
const PORT = thisAddon.httpPort;
const HTTPS_PORT = thisAddon.httpsPort;
// Inject the full https URL into the global environment.
//
// By default this is derived from the host's LAN address, giving something like
// https://192-168-1-50.local-ip.medicmobile.org:7001, and that host is stamped
// into every poster and backdrop URL the addon emits. It does not resolve on
// networks whose resolver enables DNS rebind protection, because it is a public
// name that answers with a private IP -- so no artwork loads at all.
//
// PUBLIC_BASE_URL overrides it, which is also what you want whenever the addon
// sits behind your own reverse proxy or hostname. Trailing slashes are trimmed
// so the emitted URLs never end up with a doubled separator.
//
// NOTE: HTTPS_BASE_URL is derived here, not user config — anything set for it
// in .env is overwritten on every start. PUBLIC_BASE_URL is the only override.
const publicBase = process.env.PUBLIC_BASE_URL?.trim().replace(/\/+$/, '');
process.env.HTTPS_BASE_URL = publicBase || `${getHttpsBaseUrl(HTTPS_PORT)}`;

console.log(`**********`);
console.log(`**********`);
console.log(`**********`);
console.log(`Starting ${thisAddon.name} [v${thisAddon.version}].`);

// ==========================================
// RUN MODE (Jellyfin optional)
//   jellyfin        -> all Jellyfin vars set: catalog + meta + stream + subtitles
//   subtitles-only  -> no Jellyfin vars set: standalone subtitles only
//   partial         -> some set, some missing: misconfiguration -> refuse to start
// ==========================================
const jf = getJellyfinConfigStatus();

if (jf.mode === 'partial') {
    console.error(
        `Incomplete Jellyfin configuration. Set ALL of [${jf.required.join(', ')}] to run as a ` +
        `Jellyfin bridge, or leave ALL of them empty for subtitles-only mode. ` +
        `Missing: [${jf.missing.join(', ')}].`
    );
    process.exit(1);
}

const jellyfinEnabled = jf.mode === 'multi-user' || jf.mode === 'single-user';
const multiUser = jf.mode === 'multi-user';

if (multiUser) {
    console.log(`✅ Jellyfin configured — full bridge, per-viewer authentication (multi-user).`);
    console.log(`   Each viewer installs from /configure with their own Jellyfin account.`);
    if (String(process.env.JELLYFIN_API_KEY ?? '').trim() !== '') {
        console.warn(`JELLYFIN_API_KEY is set but IGNORED in multi-user mode — remove it. ` +
            `A Jellyfin API key is always server-wide admin and must never reach a client.`);
    }
    if (!isMediaProxied() && !process.env.JELLYFIN_PUBLIC_URL && !/^https:/i.test(getJellyfinApiBase())) {
        console.warn(`JELLYFIN_PUBLIC_URL is not set, so playback URLs will point at ${getJellyfinApiBase()}. ` +
            `Remote viewers can only play if that address is reachable from the internet.`);
    }
} else if (jellyfinEnabled) {
    console.log(`✅ Jellyfin configured — full bridge (catalog, meta, stream, subtitles).`);
    console.log(`   Single-user mode: every viewer is served as "${process.env.JELLYFIN_USER_NAME}" using the ` +
        `server-wide API key, which is stamped into the URLs clients receive. Keep this install on a ` +
        `trusted network, or set BRIDGE_SECRET to switch to per-viewer Jellyfin logins.`);
} else {
    console.log(`ℹ️ No Jellyfin configuration — running in subtitles-only mode.`);
    if (!anySourceEnabled()) {
        console.warn(`Nothing to serve yet: no Jellyfin config and no standalone source (LOCAL_SUBS_DIR).`);
    }
}

// Initialize Builder.
// The manifest is STATIC (always advertises catalog/meta/stream/subtitles). Instead of
// changing it per mode — which would force installed clients to reinstall — the handlers
// return empty results when Jellyfin is absent. Same idea as SHOW_CATALOG=false.
const builder = new addonBuilder(manifest);

// Attach Handlers
builder.defineCatalogHandler(catalogHandler);
builder.defineMetaHandler(metaHandler);
builder.defineStreamHandler(streamHandler);
builder.defineSubtitlesHandler(subtitlesHandler);

// ==========================================
// MULTI-USER HTTP SERVER
// ==========================================
// The SDK's serveHTTP owns /configure as soon as the manifest declares config, and
// serves its generic form there — which would mint an install URL holding a
// Jellyfin password in plain text, with no chance to check it first. So multi-user
// mode mounts the SDK's router itself and keeps /configure. Single-user installs
// still go through serveHTTP unchanged.
async function serveAddon(addonInterface, port) {
    const app = express();
    app.use(express.json({ limit: '16kb' }));

    // Behind a reverse proxy the socket address is the proxy's, so every viewer
    // would share one rate-limit bucket. Trust X-Forwarded-For ONLY from the
    // proxies named here — trusting it from anyone would let a client claim any
    // address it likes and walk straight past the per-IP limit.
    const trusted = String(process.env.TRUSTED_PROXY_IPS || '').trim();
    if (trusted) app.set('trust proxy', trusted.split(',').map((s) => s.trim()).filter(Boolean));

    app.get('/', (_, res) => res.redirect('/configure'));
    // Both shapes: a fresh install, and the "Configure" button of an installed
    // addon, which lands on /{existing config}/configure.
    app.get('/configure', configurePage);
    app.get('/:config/configure', configurePage);
    app.post('/configure', guardLogin, configureSubmit);
    app.post('/:config/configure', guardLogin, configureSubmit);

    app.use(getRouter(addonInterface));

    const server = app.listen(port);
    await new Promise((resolve, reject) => {
        server.once('listening', resolve);
        server.once('error', reject);
    });

    const url = `http://127.0.0.1:${server.address().port}/manifest.json`;
    console.log('HTTP addon is accessible at:', url);
    return { url, server, app };
}

async function main() {
    try {
        // Resolve the Jellyfin user id up front — single-user mode only. In
        // multi-user mode the identity arrives with the request, and /Users is
        // admin-only anyway, so a per-viewer token could not read it.
        if (jellyfinEnabled && !multiUser) {
            console.log(`🔍 Looking up Jellyfin User ID for username: "${JELLYFIN_USER_NAME}"...`);

            // Fetch all users from the Jellyfin server
            const response = await axios.get(`${JELLYFIN_URL}/Users`, {
                headers: { 'X-Emby-Token': JELLYFIN_API_KEY }
            });

            // Find the user that matches (case-insensitive just to be safe)
            const user = response.data.find(u => u.Name.toLowerCase() === JELLYFIN_USER_NAME.toLowerCase());

            if (!user) {
                console.error(`Could not find a Jellyfin user named "${JELLYFIN_USER_NAME}"`);
                process.exit(1);
            }

            // Dynamically inject the UUID into the environment for the handlers to use
            process.env.JELLYFIN_USER_ID = user.Id;
            console.log(`✅ Successfully resolved User ID: ${user.Id}`);
        }

        // Fail fast on an unreachable Jellyfin: in multi-user mode nothing else
        // talks to it until a viewer arrives, and "no results" is otherwise
        // indistinguishable from a wrong password.
        if (multiUser) {
            try {
                const info = await axios.get(`${getJellyfinApiBase()}/System/Info/Public`, { timeout: 10000 });
                console.log(`✅ Jellyfin reachable: "${info.data?.ServerName}" (${info.data?.Version}).`);
            } catch (error) {
                console.warn(`Could not reach Jellyfin at ${getJellyfinApiBase()}: ${error.message}. ` +
                    `Starting anyway — every viewer sign-in will fail until it is reachable.`);
            }
        }

        // Start the Stremio server. Multi-user mode serves its own configure page;
        // every other mode keeps the SDK's own HTTP server and landing page.
        const { url, server, app } = multiUser
            ? await serveAddon(builder.getInterface(), PORT)
            : await serveHTTP(builder.getInterface(), { port: PORT });

        // ==========================================
        // THE JELLYFIN IMAGE PROXY
        // ==========================================
        app.get('/proxy-image', proxyImageHandler);

        // ==========================================
        // AUTHENTICATED PLAYBACK
        // ==========================================
        // Jellyfin's media endpoints are anonymous, so the bytes are served here
        // instead — behind the same Jellyfin authentication as everything else.
        // The path mirrors Jellyfin's own so HLS playlists resolve their relative
        // segment references straight back through the proxy.
        app.get('/:config/jf/*', mediaProxyHandler);
        app.head('/:config/jf/*', mediaProxyHandler);
        app.get('/jf/*', mediaProxyHandler);
        app.head('/jf/*', mediaProxyHandler);

        // ==========================================
        // STANDALONE LOCAL SUBTITLES (Phase 1)
        // Serves files from LOCAL_SUBS_DIR over the same HTTPS endpoint.
        // ==========================================
        app.get('/local-subtitle', localSubtitleRoute);
        app.post('/local-subtitle', localSubtitleWriteRoute);   // Step 4a: accept + place a translated subtitle

        await serveHTTPS(app, HTTPS_PORT);

        // ==========================================
        // STARTUP SUMMARY
        // ==========================================
        // Dump the active .env-configurable variables (non-empty only).
        // Secret values are masked so shared logs don't leak them.
        const ENV_KEYS = [
            'TZ', 'PUID', 'PGID',
            'JELLYFIN_URL', 'JELLYFIN_PUBLIC_URL', 'BRIDGE_SECRET', 'PROXY_MEDIA',
            'JELLYFIN_API_KEY', 'JELLYFIN_USER_NAME',
            'SHOW_CATALOG',
            'DEFAULT_SUBS_LANG', 'JELLYFIN_DEFAULT_EXT_SUBS_LANG',
            'LOCAL_SUBS_DIR', 'LOCAL_SUBS_WRITE_SECRET',
            'PUBLIC_BASE_URL', 'PORT', 'HTTPS_PORT',
        ];
        const SECRET_KEYS = new Set(['JELLYFIN_API_KEY', 'LOCAL_SUBS_WRITE_SECRET', 'BRIDGE_SECRET']);

        const envLines = ['Active .env configuration (non-empty):'];
        for (const key of ENV_KEYS) {
            const val = process.env[key];
            if (val === undefined || String(val).trim() === '') continue;
            envLines.push(`  ${key}=${SECRET_KEYS.has(key) ? '********' : val}`);
        }
        console.debug(envLines.join('\n'));

        // The base URL actually stamped into the content URLs the addon emits
        // (posters, backdrops, local subtitles). When PUBLIC_BASE_URL is set this
        // differs from the "HTTPS addon is accessible at" line above — and it is
        // the first thing to check if artwork or subtitles fail to load.
        console.log(`Advertising base URL: ${process.env.HTTPS_BASE_URL}`);

        // The Jellyfin host the PLAYER is sent to. Differs from JELLYFIN_URL
        // whenever the addon reaches Jellyfin over the LAN but viewers do not —
        // and it is the first thing to check when playback fails off-network.
        if (jellyfinEnabled) {
            console.log(`Run mode: ${jf.mode} | Jellyfin API: ${getJellyfinApiBase()} | ` +
                (isMediaProxied()
                    // Jellyfin is never contacted by the client, so it needs no
                    // public exposure at all — the addon is the only door.
                    ? `playback: PROXIED through this addon (Jellyfin needs no public exposure)`
                    : `playback host: ${getJellyfinPublicBase()} (fetched directly by the player)`));
        }

        // If the Local Subtitles feature is enabled, announce its base folder.
        const localSubsDir = process.env.LOCAL_SUBS_DIR;
        if (localSubsDir && localSubsDir.trim() !== '') {
            console.log(`Serving local subtitles at base folder: ${localSubsDir}`);
        }

    } catch (error) {
        console.error("Failed to start the server:", error.message);
        process.exit(1);
    }
}

main();
