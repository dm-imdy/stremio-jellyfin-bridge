import gc from "./global-constants.js";

export const manifest = {
    id: "com.imdy-apps.jellyfinbridge",
    version: gc.thisAddonVersion,
    name: gc.thisAddonName,
    description: "Integrates your local Jellyfin library with Stremio for seamless catalog browsing and streaming.",
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
