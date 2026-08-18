import { isJellyfinConfigured } from '../global-constants.js';
import { resolveViewer, proxyImageUrl } from '../viewer.js';
import { jellyfinRequest } from '../jellyfin-auth.js';

export const catalogHandler = async ({ type, id, extra, config }) => {
    console.log(`[Catalog] Request for ${type} | id: ${id} | search: ${extra.search || 'none'}`);

    // Subtitles-only mode: no Jellyfin, so there's no catalog to serve.
    if (!isJellyfinConfigured()) return { metas: [] };

    const isSearch = extra && extra.search;
    const hideDiscover = process.env.SHOW_CATALOG === 'false';

    if (!isSearch && hideDiscover) {
        //console.log(`[Catalog] 🛑 Blocked Home/Discover request. (SHOW_CATALOG=false)`);
        return { metas: [] }; // Returning empty tells Stremio to hide the UI row completely
    }

    // Route guard
    if (id !== 'jellyfin_movies' && id !== 'jellyfin_series') {
        return { metas: [] };
    }

    // Who is asking. Jellyfin decides — an unauthenticated caller gets no catalog.
    const viewer = await resolveViewer(config);
    if (!viewer) return { metas: [] };

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

        const response = await jellyfinRequest(viewer, {
            method: 'get',
            path: `/Users/${viewer.userId}/Items`,
            params: params
        });

        // Map the Jellyfin data array into Stremio 'Meta' objects
        const metas = response.data.Items.map(item => {
            //console.log(`***[DEBUG] item: ${JSON.stringify(item, null, 2)}`);
            const posterUrl = proxyImageUrl(viewer, item.Id, 'Primary');
            const logoUrl = proxyImageUrl(viewer, item.Id, 'Logo');

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
