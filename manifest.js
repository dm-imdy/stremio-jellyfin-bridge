import { thisAddon } from "./common-utils.js";

export const manifest = {
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
