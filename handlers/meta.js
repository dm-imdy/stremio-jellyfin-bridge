import axios from 'axios';

export const metaHandler = async ({ type, id }) => {
    console.log(`[Meta] Request for ${type} | id: ${id}`);

    if (!id.startsWith('jf:')) {
        return { meta: {} };
    }

    const JELLYFIN_URL = process.env.JELLYFIN_URL;
    const JELLYFIN_API_KEY = process.env.JELLYFIN_API_KEY;
    const JELLYFIN_USER_ID = process.env.JELLYFIN_USER_ID;
    const proxyBase = `${process.env.HTTPS_BASE_URL}/proxy-image?url=`;
    
    const jellyfinItemId = id.replace('jf:', '');

    try {
        // ==========================================
        // FETCH THE MAIN ITEM (Movie or Series)
        // ==========================================
        const itemRes = await axios.get(`${JELLYFIN_URL}/Users/${JELLYFIN_USER_ID}/Items/${jellyfinItemId}`, {
            headers: { 'X-Emby-Token': JELLYFIN_API_KEY },
            params: { Fields: 'ProviderIds' } // <-- Ensure we get the IDs!
        });

        const item = itemRes.data;
        //console.log(`***[DEBUG] item: ${JSON.stringify(item, null, 2)}`);

        const rawPosterUrl = `${JELLYFIN_URL}/Items/${item.Id}/Images/Primary?api_key=${JELLYFIN_API_KEY}`;
        const posterUrl = `${proxyBase}${encodeURIComponent(rawPosterUrl)}`;

        const rawBackgroundUrl = `${JELLYFIN_URL}/Items/${item.Id}/Images/Backdrop?api_key=${JELLYFIN_API_KEY}`;
        const backgroundUrl = `${proxyBase}${encodeURIComponent(rawBackgroundUrl)}`;

        const rawLogoUrl = `${JELLYFIN_URL}/Items/${item.Id}/Images/Logo?api_key=${JELLYFIN_API_KEY}`;
        const logoUrl = `${proxyBase}${encodeURIComponent(rawLogoUrl)}`;

        const meta = {
            id: id,
            type: type,
            name: item.Name,
            description: item.Overview || '',
            poster: posterUrl,
            background: backgroundUrl,
            logo: logoUrl
        };

        // ==========================================
        // IF IT'S A SERIES: FETCH THE EPISODES
        // ==========================================
        if (type === 'series') {
            // Fetch local episodes from Jellyfin
            const episodesRes = await axios.get(`${JELLYFIN_URL}/Users/${JELLYFIN_USER_ID}/Items`, {
                headers: { 'X-Emby-Token': JELLYFIN_API_KEY },
                params: {
                    ParentId: item.Id, 
                    IncludeItemTypes: 'Episode',
                    Recursive: true,
                    Fields: 'Overview,ImageTags,PremiereDate'
                }
            });

            // Loop the episodes and create meta for each one
            if (episodesRes.data.Items && episodesRes.data.Items.length > 0) {
                //console.log(`***[DEBUG] episodes: ${JSON.stringify(episodesRes.data.Items, null, 2)}`);
                meta.videos = episodesRes.data.Items.map(ep => {
                    const seasonNum = ep.ParentIndexNumber || 1;
                    const episodeNum = ep.IndexNumber || 1;

                    const rawEpisodeThumbnail = `${JELLYFIN_URL}/Items/${ep.Id}/Images/Primary?api_key=${JELLYFIN_API_KEY}`;
                    const episodeThumbnail = `${proxyBase}${encodeURIComponent(rawEpisodeThumbnail)}`;

                    return {
                        id: `jf:${ep.Id}`, 
                        title: ep.Name,
                        season: seasonNum,
                        episode: episodeNum,
                        overview: ep.Overview || '',
                        released: item.PremiereDate || undefined,
                        thumbnail: episodeThumbnail 
                    };
                });
                
                console.log(`[Meta] Attached ${meta.videos.length} episodes to Series: ${item.Name}`);
            }
        }

        return { meta };

    } catch (error) {
        console.error("Error resolving metadata:", error.message);
        return { meta: {} };
    }
};