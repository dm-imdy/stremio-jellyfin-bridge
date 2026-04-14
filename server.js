import gc from "./global-constants.js";

import { serveHTTPS, getHttpsBaseUrl } from "./https.js";
import stremio from 'stremio-addon-sdk';
const { addonBuilder, serveHTTP } = stremio;
import { manifest } from './manifest.js';
import { proxyImageHandler } from './handlers/proxy.js';
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
const PORT = process.env.PORT || 7000;
const HTTPS_PORT = process.env.HTTPS_PORT || 7001;
// Inject the full https URL into the global environment
process.env.HTTPS_BASE_URL = `${getHttpsBaseUrl(HTTPS_PORT)}`;

console.log(`**********`);
console.log(`**********`);
console.log(`**********`);
console.log(`Starting ${gc.thisAddonName} [v${gc.thisAddonVersion}].`);

if (!JELLYFIN_URL || !JELLYFIN_API_KEY) {
    console.log("❌ Missing Jellyfin environment variables! Check your .env file.");
    process.exit(1);
}

// Initialize Builder
const builder = new addonBuilder(manifest);

// Attach Handlers
builder.defineCatalogHandler(catalogHandler);
builder.defineMetaHandler(metaHandler);
builder.defineStreamHandler(streamHandler);
builder.defineSubtitlesHandler(subtitlesHandler);

async function main() {
    try {
        console.log(`🔍 Looking up Jellyfin User ID for username: "${JELLYFIN_USER_NAME}"...`);
        
        // Fetch all users from the Jellyfin server
        const response = await axios.get(`${JELLYFIN_URL}/Users`, {
            headers: { 'X-Emby-Token': JELLYFIN_API_KEY }
        });

        // Find the user that matches (case-insensitive just to be safe)
        const user = response.data.find(u => u.Name.toLowerCase() === JELLYFIN_USER_NAME.toLowerCase());

        if (!user) {
            console.log(`❌ Could not find a Jellyfin user named "${JELLYFIN_USER_NAME}"`);
            process.exit(1);
        }

        // Dynamically inject the UUID into the environment for the handlers to use
        process.env.JELLYFIN_USER_ID = user.Id;
        console.log(`✅ Successfully resolved User ID: ${user.Id}`);

        // Start the Stremio server only AFTER we have the user ID
        const { url, server, app } = await serveHTTP(builder.getInterface(), { port: PORT });

        // ==========================================
        // THE JELLYFIN IMAGE PROXY
        // ==========================================
        app.get('/proxy-image', proxyImageHandler);
        await serveHTTPS(app, HTTPS_PORT);

    } catch (error) {
        console.log("❌ Failed to start the server:", error.message);
        process.exit(1);
    }
}

main();
