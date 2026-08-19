import { thisAddon } from "./common-utils.js";
import { isMultiUser } from "./global-constants.js";

// In multi-user mode the install URL carries a per-viewer configuration segment.
// Declaring it here is what makes the SDK router accept `/{config}/manifest.json`
// and `/{config}/stream/...` at all -- without it every request would arrive
// anonymous and there would be nobody to authenticate.
//
// The value is minted by this addon's own /configure page (which logs the viewer
// into Jellyfin first), so it is marked hidden: there is nothing useful for a
// viewer to type into Stremio's generic config form.
const viewerConfig = isMultiUser()
    ? {
        config: [
            { key: 'username', type: 'text', title: 'Jellyfin username' },
            { key: 'password', type: 'password', title: 'Jellyfin password' },
            // What the configure page actually mints: the same two fields, sealed,
            // so the install URL does not carry a password in clear text. Either
            // form is accepted on every request.
            { key: 'jf', type: 'text', title: 'Sealed login (filled in by the configure page)' },
        ],
        behaviorHints: { configurable: true, configurationRequired: true },
    }
    : {};

export const manifest = {
    ...viewerConfig,
    id: thisAddon.id,
    version: thisAddon.version,
    name: thisAddon.name,
    description: thisAddon.desc,
    types: ["movie", "series"],
    
    // We prefix our custom IDs so they don't clash with IMDb/Cinemeta IDs
    idPrefixes: ["jf:", "tt"], 
    
    // The features this addon provides to Stremio
    resources: [
        "catalog",   // We provide a list of movies/series
        "meta",
        "stream",    // We provide direct video URLs
        "subtitles"  // We provide external subtitle tracks
    ],
    
    // The specific catalogs Stremio will display on the Discover page
    catalogs: [
        {
            type: "movie",
            id: "jellyfin_movies",
            name: "Jellyfin Movies",
            extra: [
                { name: "search", isRequired: false }
            ]
        },
        {
            type: "series",
            id: "jellyfin_series",
            name: "Jellyfin Series",
            extra: [
                { name: "search", isRequired: false }
            ]
        }
    ]
};
