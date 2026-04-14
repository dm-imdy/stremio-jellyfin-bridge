import axios from 'axios';

// Helper to parse languages robustly
function parseLanguage(stream) {
    const hints = [stream.Language, stream.DisplayLanguage, stream.Title]
        .filter(Boolean) 
        .map(s => s.toLowerCase().trim());

    for (const hint of hints) {
        if (hint.length === 3) return hint;
        if (hint.startsWith('en')) return 'eng';
        if (hint.startsWith('he')) return 'heb';
        if (hint.startsWith('es') || hint.includes('span')) return 'spa';
        if (hint.startsWith('fr')) return 'fre';
        if (hint.startsWith('ru')) return 'rus';
        if (hint.startsWith('ar')) return 'ara';
    }
    return process.env.JELLYFIN_DEFAULT_EXT_SUBS_LANG || 'und';
}

export const subtitlesHandler = async ({ type, id }) => {
    console.log(`[Subtitles] Request for ${type} | id: ${id}`);

    const JELLYFIN_URL = process.env.JELLYFIN_URL;
    const JELLYFIN_API_KEY = process.env.JELLYFIN_API_KEY;
    const JELLYFIN_USER_ID = process.env.JELLYFIN_USER_ID;

    let jellyfinItemId = null;

    try {
        // ==========================================
        // RESOLVE THE ID (Using the new robust logic)
        // ==========================================
        if (id.startsWith('jf:')) {
            jellyfinItemId = id.replace('jf:', '');
        } 
        else if (id.startsWith('tt')) { 
            const parts = id.split(':');
            const imdbId = parts[0];
            const season = parts[1];
            const episode = parts[2];

            // Safely search Jellyfin's external IDs
            const searchRes = await axios.get(`${JELLYFIN_URL}/Users/${JELLYFIN_USER_ID}/Items`, {
                headers: { 'X-Emby-Token': JELLYFIN_API_KEY },
                params: { 
                    Recursive: true, 
                    AnyProviderIdEquals: imdbId, 
                    IncludeItemTypes: type === 'movie' ? 'Movie' : 'Series',
                    Fields: 'ProviderIds' 
                }
            });

            // STRICT VALIDATION
            const matchedItem = searchRes.data.Items?.find(item => 
                item.ProviderIds && item.ProviderIds.Imdb === imdbId
            );

            if (matchedItem) {
                if (type === 'movie') {
                    jellyfinItemId = matchedItem.Id;
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
                    }
                }
            }
        }

        if (!jellyfinItemId) {
            return { subtitles: [] };
        }

        // ==========================================
        // FETCH SUBTITLE TRACKS
        // ==========================================
        const itemRes = await axios.get(`${JELLYFIN_URL}/Users/${JELLYFIN_USER_ID}/Items/${jellyfinItemId}`, {
            headers: { 'X-Emby-Token': JELLYFIN_API_KEY },
            params: { Fields: 'MediaSources' }
        });

        const item = itemRes.data;
        const mappedSubtitles = [];

        if (item.MediaSources && item.MediaSources.length > 0) {
            const mediaSource = item.MediaSources[0];
            const validCodecs = ['srt', 'subrip', 'vtt', 'ass', 'ssa'];

            mediaSource.MediaStreams.forEach(stream => {
                if (stream.Type === 'Subtitle' && validCodecs.includes(stream.Codec?.toLowerCase())) {
                    const subUrl = `${JELLYFIN_URL}/Videos/${jellyfinItemId}/${mediaSource.Id}/Subtitles/${stream.Index}/0/Stream.${stream.Codec === 'vtt' ? 'vtt' : 'srt'}?api_key=${JELLYFIN_API_KEY}`;
                    
                    const langCode = parseLanguage(stream);

                    mappedSubtitles.push({
                        id: `[JellyfinBridge]${stream.Index}_${stream.DisplayTitle}`,
                        url: subUrl,
                        lang: langCode
                    });
                }
            });
        }

        console.log(`[Subtitles] Found ${mappedSubtitles.length} subtitle tracks.`);
        return { subtitles: mappedSubtitles };

    } catch (error) {
        console.log("❌ Error resolving subtitles:", error.message);
        return { subtitles: [] };
    }
};