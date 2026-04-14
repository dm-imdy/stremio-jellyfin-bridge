import axios from 'axios';

export const streamHandler = async ({ type, id }) => {
    console.log(`[Stream] Request for ${type} | id: ${id}`);

    const JELLYFIN_URL = process.env.JELLYFIN_URL;
    const JELLYFIN_API_KEY = process.env.JELLYFIN_API_KEY;
    const JELLYFIN_USER_ID = process.env.JELLYFIN_USER_ID;

    let jellyfinItemId = null;

    try {
        // ==========================================
        // RESOLVE THE ID
        // ==========================================
        if (id.startsWith('jf:')) {
            jellyfinItemId = id.replace('jf:', '');
        } 
        else if (id.startsWith('tt')) { 
            const parts = id.split(':');
            const imdbId = parts[0];
            const season = parts[1];
            const episode = parts[2];

            // Search Jellyfin using searchTerm (safer fallback than AnyProviderIdEquals)
            const searchRes = await axios.get(`${JELLYFIN_URL}/Users/${JELLYFIN_USER_ID}/Items`, {
                headers: { 'X-Emby-Token': JELLYFIN_API_KEY },
                params: { 
                    Recursive: true, 
                    AnyProviderIdEquals: imdbId,
                    IncludeItemTypes: type === 'movie' ? 'Movie' : 'Series',
                    Fields: 'ProviderIds' 
                }
            });

            // STRICT VALIDATION: Do not trust Jellyfin blindly. 
            // Force verify that the IMDb ID actually matches.
            const matchedItem = searchRes.data.Items?.find(item => 
                item.ProviderIds && item.ProviderIds.Imdb === imdbId
            );

            if (matchedItem) {
                if (type === 'movie') {
                    jellyfinItemId = matchedItem.Id;
                    console.log(`[Stream] Found exact local Movie match: ${matchedItem.Name}`);
                } 
                else if (type === 'series' && season && episode) {
                    const epRes = await axios.get(`${JELLYFIN_URL}/Users/${JELLYFIN_USER_ID}/Items`, {
                        headers: { 'X-Emby-Token': JELLYFIN_API_KEY },
                        params: {
                            ParentId: matchedItem.Id,
                            ParentIndexNumber: season,
                            IndexNumber: episode,
                            IncludeItemTypes: 'Episode',
                            Recursive: true
                        }
                    });

                    if (epRes.data.Items && epRes.data.Items.length > 0) {
                        jellyfinItemId = epRes.data.Items[0].Id;
                        console.log(`[Stream] Found local Episode match: S${season}E${episode}`);
                    }
                }
            } else {
                console.log(`[Stream] No exact IMDb match found in Jellyfin for: ${imdbId}`);
            }
        }

        if (!jellyfinItemId) {
            return { streams: [] };
        }

        // ==========================================
        // FETCH MEDIA SOURCES FOR EXACT ID
        // ==========================================
        const itemRes = await axios.get(`${JELLYFIN_URL}/Users/${JELLYFIN_USER_ID}/Items/${jellyfinItemId}`, {
            headers: { 'X-Emby-Token': JELLYFIN_API_KEY },
            params: { Fields: 'MediaSources' }
        });

        const item = itemRes.data;
        let mediaSourceId = '';
        
        if (item.MediaSources && item.MediaSources.length > 0) {
            mediaSourceId = item.MediaSources[0].Id;
        } else {
            console.log(`❌ No MediaSources found for Jellyfin Item: ${jellyfinItemId}`);
            return { streams: [] };
        }

        // ==========================================
        // RETURN THE STREAM URLS TO STREMIO
        // ==========================================
        const directPlayUrl = `${JELLYFIN_URL}/Videos/${jellyfinItemId}/stream?static=true&mediaSourceId=${mediaSourceId}&api_key=${JELLYFIN_API_KEY}`;
        const transcodeUrl = `${JELLYFIN_URL}/Videos/${jellyfinItemId}/master.m3u8?mediaSourceId=${mediaSourceId}&api_key=${JELLYFIN_API_KEY}&VideoCodec=h264&AudioCodec=aac`;

        return {
            streams: [
                {
                    title: "Jellyfin\nDirect Play",
                    url: directPlayUrl,
                    behaviorHints: { notWebReady: true }
                },
                {
                    title: "Jellyfin\nTranscode (Web Safe)",
                    url: transcodeUrl,
                    behaviorHints: { notWebReady: false }
                }
            ]
        };

    } catch (error) {
        console.log("❌ Error resolving stream:", error.message);
        return { streams: [] };
    }
};