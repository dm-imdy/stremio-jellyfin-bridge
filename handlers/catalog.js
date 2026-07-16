import axios from 'axios';
import { isJellyfinConfigured } from '../global-constants.js';

export const catalogHandler = async ({ type, id, extra }) => {
    console.log(`[Catalog] Request for ${type} | id: ${id} | search: ${extra.search || 'none'}`);

    // Subtitles-only mode: no Jellyfin, so there's no catalog to serve.
    if (!isJellyfinConfigured()) return { metas: [] };

    const isSearch = extra && extra.search;
    const hideDiscover = process.env.SHOW_CATALOG === 'false';

    if (!isSearch && hideDiscover) {
        //console.log(`[Catalog] 🛑 Blocked Home/Discover request. (SHOW_CATALOG=false)`);
        return { metas: [] }; // Returning empty tells Stremio to hide the UI row completely
    }

    const JELLYFIN_URL = process.env.JELLYFIN_URL;
    const JELLYFIN_API_KEY = process.env.JELLYFIN_API_KEY;
    const JELLYFIN_USER_ID = process.env.JELLYFIN_USER_ID;
    const proxyBase = `${process.env.HTTPS_BASE_URL}/proxy-image?url=`;

    // Route guard
    if (id !== 'jellyfin_movies' && id !== 'jellyfin_series') {
        return { metas: [] };
    }

    const jfType = type === 'movie' ? 'Movie' : 'Series';

    try {
        const params = {
            IncludeItemTypes: jfType,
            Recursive: true,
            Fields: 'Overview,ProductionYear,ProviderIds,Genres',
            SortBy: 'DateCreated',
            SortOrder: 'Descending',
            Limit: 100
        };

        if (isSearch) {
            console.log(`[Catalog] 🔎 Searching Jellyfin for: "${extra.search}"`);
            params.searchTerm = extra.search;
        }

        const response = await axios.get(`${JELLYFIN_URL}/Users/${JELLYFIN_USER_ID}/Items`, {
            headers: { 'X-Emby-Token': JELLYFIN_API_KEY },
            params: params
        });

        // Map the Jellyfin data array into Stremio 'Meta' objects
        const metas = response.data.Items.map(item => {
            //console.log(`***[DEBUG] item: ${JSON.stringify(item, null, 2)}`);
            const rawPosterUrl = `${JELLYFIN_URL}/Items/${item.Id}/Images/Primary?api_key=${JELLYFIN_API_KEY}`;
            const posterUrl = `${proxyBase}${encodeURIComponent(rawPosterUrl)}`;

            const rawLogoUrl = `${JELLYFIN_URL}/Items/${item.Id}/Images/Logo?api_key=${JELLYFIN_API_KEY}`;
            const logoUrl = `${proxyBase}${encodeURIComponent(rawLogoUrl)}`;
            
            return {
                id: `jf:${item.Id}`, 
                type: type,
                name: item.Name,
                description: item.Overview || '',
                releaseInfo: item.ProductionYear ? item.ProductionYear.toString() : '',
                poster: posterUrl,
                posterShape: 'regular',
                logo: logoUrl,
            };
        });

        console.log(`[Catalog] Returned ${metas.length} items.`);
        return { metas };

    } catch (error) {
        console.error("Error fetching catalog:", error.message);
        return { metas: [] };
    }
};
