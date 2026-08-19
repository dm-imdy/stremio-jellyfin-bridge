import { isJellyfinConfigured } from '../global-constants.js';
import { resolveViewer, proxyImageUrl } from '../viewer.js';
import { jellyfinRequest } from '../jellyfin-auth.js';

export const metaHandler = async ({ type, id, config }) => {
    console.log(`[Meta] Request for ${type} | id: ${id}`);

    // Subtitles-only mode: no Jellyfin metadata to resolve.
    if (!isJellyfinConfigured()) return { meta: {} };

    if (!id.startsWith('jf:')) {
        return { meta: {} };
    }

    const jellyfinItemId = id.replace('jf:', '');

    // Who is asking. Jellyfin decides — an unauthenticated caller gets no metadata.
    const viewer = await resolveViewer(config);
    if (!viewer) return { meta: {} };

    try {
        // ==========================================
        // FETCH THE MAIN ITEM (Movie or Series)
        // ==========================================
        const itemRes = await jellyfinRequest(viewer, {
            method: 'get',
            path: `/Users/${viewer.userId}/Items/${jellyfinItemId}`,
            params: { Fields: 'ProviderIds' } // <-- Ensure we get the IDs!
        });

        const item = itemRes.data;
        //console.log(`***[DEBUG] item: ${JSON.stringify(item, null, 2)}`);

        const posterUrl = proxyImageUrl(viewer, item.Id, 'Primary');
        const backgroundUrl = proxyImageUrl(viewer, item.Id, 'Backdrop');
        const logoUrl = proxyImageUrl(viewer, item.Id, 'Logo');

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
            const episodesRes = await jellyfinRequest(viewer, {
                method: 'get',
                path: `/Users/${viewer.userId}/Items`,
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

                    const episodeThumbnail = proxyImageUrl(viewer, ep.Id, 'Primary');

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