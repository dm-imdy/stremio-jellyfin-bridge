import { thisAddon } from "./common-utils.js";
import { getJellyfinConfigStatus } from "./global-constants.js";

import { serveHTTPS, getHttpsBaseUrl } from "./https.js";
import stremio from 'stremio-addon-sdk';
const { addonBuilder, serveHTTP } = stremio;
import { manifest } from './manifest.js';
import { proxyImageHandler } from './handlers/proxy.js';
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
// Inject the full https URL into the global environment
process.env.HTTPS_BASE_URL = `${getHttpsBaseUrl(HTTPS_PORT)}`;

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

const jellyfinEnabled = jf.mode === 'jellyfin';

if (jellyfinEnabled) {
    console.log(`✅ Jellyfin configured — full bridge (catalog, meta, stream, subtitles).`);
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

async function main() {
    try {
        // Resolve the Jellyfin user id up front — only needed in full bridge mode.
        if (jellyfinEnabled) {
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

        // Start the Stremio server (both modes). In full mode this runs after the
        // user-id lookup above; in subtitles-only mode it starts immediately.
        const { url, server, app } = await serveHTTP(builder.getInterface(), { port: PORT });

        // ==========================================
        // THE JELLYFIN IMAGE PROXY
        // ==========================================
        app.get('/proxy-image', proxyImageHandler);

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
            'JELLYFIN_URL', 'JELLYFIN_API_KEY', 'JELLYFIN_USER_NAME',
            'SHOW_CATALOG',
            'DEFAULT_SUBS_LANG', 'JELLYFIN_DEFAULT_EXT_SUBS_LANG',
            'LOCAL_SUBS_DIR', 'LOCAL_SUBS_WRITE_SECRET',
            'PORT', 'HTTPS_PORT',
        ];
        const SECRET_KEYS = new Set(['JELLYFIN_API_KEY', 'LOCAL_SUBS_WRITE_SECRET']);

        const envLines = ['Active .env configuration (non-empty):'];
        for (const key of ENV_KEYS) {
            const val = process.env[key];
            if (val === undefined || String(val).trim() === '') continue;
            envLines.push(`  ${key}=${SECRET_KEYS.has(key) ? '********' : val}`);
        }
        console.debug(envLines.join('\n'));

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
