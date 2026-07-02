import axios from 'axios';
import { getStandaloneSubtitles } from '../subtitleSources/index.js';

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
    const httpsBase = process.env.HTTPS_BASE_URL;

    // We accumulate from every source into one list, then return it once.
    const subtitles = [];

    // ==========================================
    // 1) STANDALONE SUBTITLES (independent of Jellyfin)
    //    Inert unless a source is configured (Phase 1: LOCAL_SUBS_DIR).
    //    Runs for `tt` ids and must NOT depend on the item existing in Jellyfin.
    // ==========================================
    if (id.startsWith('tt')) {
        try {
            const standalone = await getStandaloneSubtitles({ type, id, httpsBase });
            if (standalone.length > 0) {
                console.log(`[Subtitles] Found ${standalone.length} standalone subtitle(s) | id: ${id}`);
                subtitles.push(...standalone);
            }
        } catch (error) {
            console.error(`[Subtitles] Standalone source error: ${error.message} | id: ${id}`);
        }
    }

    // ==========================================
    // 2) JELLYFIN SUBTITLES (embedded / sidecar tracks on the media item)
    // ==========================================
    try {
        let jellyfinItemId = null;

        // ----- RESOLVE THE ID -----
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

            // STRICT VALIDATION (Step 1: Root Level Match)
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
                            Recursive: true,
                            Fields: 'ParentIndexNumber,IndexNumber'
                        }
                    });

                    // STRICT VALIDATION (Step 2: Episode Level Index Match)
                    const targetSeason = parseInt(season, 10);
                    const targetEpisode = parseInt(episode, 10);

                    const matchedEpisode = epRes.data.Items?.find(ep =>
                        ep.ParentIndexNumber === targetSeason && ep.IndexNumber === targetEpisode
                    );

                    if (matchedEpisode) {
                        jellyfinItemId = matchedEpisode.Id;
                    } else {
                        console.log(`[Subtitles] ⚠️ Strict check failed: No exact match for S${targetSeason}E${targetEpisode} | id: ${id}`);
                    }
                }
            }
        }

        // ----- FETCH SUBTITLE TRACKS -----
        // NOTE: we deliberately do NOT early-return when jellyfinItemId is null.
        // Any standalone subtitles collected above must still be returned for
        // titles that aren't in Jellyfin at all.
        if (jellyfinItemId) {
            const itemRes = await axios.get(`${JELLYFIN_URL}/Users/${JELLYFIN_USER_ID}/Items/${jellyfinItemId}`, {
                headers: { 'X-Emby-Token': JELLYFIN_API_KEY },
                params: { Fields: 'MediaSources' }
            });

            const item = itemRes.data;

            if (item.MediaSources && item.MediaSources.length > 0) {
                const mediaSource = item.MediaSources[0];
                const validCodecs = ['srt', 'subrip', 'vtt', 'ass', 'ssa'];

                mediaSource.MediaStreams.forEach(stream => {
                    if (stream.Type === 'Subtitle' && validCodecs.includes(stream.Codec?.toLowerCase())) {
                        const subUrl = `${JELLYFIN_URL}/Videos/${jellyfinItemId}/${mediaSource.Id}/Subtitles/${stream.Index}/0/Stream.${stream.Codec === 'vtt' ? 'vtt' : 'srt'}?api_key=${JELLYFIN_API_KEY}`;

                        const langCode = parseLanguage(stream);

                        subtitles.push({
                            id: `[JellyfinBridge]${stream.Index}_${stream.DisplayTitle}`,
                            url: subUrl,
                            lang: langCode
                        });
                    }
                });
            }
        }
    } catch (error) {
        console.error('Error resolving Jellyfin subtitles:', error.message);
        // fall through — still return whatever standalone subs we already have
    }

    console.log(`[Subtitles] Returning ${subtitles.length} subtitle track(s) total. | id: ${id}`);
    return { subtitles };
};
