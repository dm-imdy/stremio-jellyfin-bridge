import { getStandaloneSubtitles } from '../subtitleSources/index.js';
import { isJellyfinConfigured, getDefaultSubsLang } from '../global-constants.js';
import { resolveViewer, playbackUrl } from '../viewer.js';
import { jellyfinRequest } from '../jellyfin-auth.js';

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
    return getDefaultSubsLang();
}

export const subtitlesHandler = async ({ type, id, config }) => {
    console.log(`[Subtitles] Request for ${type} | id: ${id}`);

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
    //    Skipped entirely in subtitles-only mode.
    // ==========================================
    // Who is asking. A caller Jellyfin won't authenticate still gets whatever the
    // standalone sources found above — those are ours, not Jellyfin's.
    const viewer = isJellyfinConfigured() ? await resolveViewer(config) : null;

    if (viewer) try {
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
            const searchRes = await jellyfinRequest(viewer, {
                method: 'get',
                path: `/Users/${viewer.userId}/Items`,
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
                    const targetSeason = parseInt(season, 10);
                    const targetEpisode = parseInt(episode, 10);

                    // Purpose-built endpoint: honours `season` server-side and
                    // resolves through the series->episode relation. The old
                    // /Items + ParentId query silently ignored ParentIndexNumber
                    // and IndexNumber as filters (it returned the whole season
                    // and relied on the client-side match below), and matched
                    // nothing at all where episodes aren't Episode-type children
                    // of the series -- e.g. loose files in a mixed library.
                    const epRes = await jellyfinRequest(viewer, {
                        method: 'get',
                        path: `/Shows/${matchedItem.Id}/Episodes`,
                        params: {
                            userId: viewer.userId,
                            season: targetSeason,
                            Fields: 'ParentIndexNumber,IndexNumber'
                        }
                    });

                    // STRICT VALIDATION (Step 2: Episode Level Index Match)
                    const matchedEpisode = epRes.data.Items?.find(ep =>
                        ep.SeriesId === matchedItem.Id &&
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
            const itemRes = await jellyfinRequest(viewer, {
                method: 'get',
                path: `/Users/${viewer.userId}/Items/${jellyfinItemId}`,
                params: { Fields: 'MediaSources' }
            });

            const item = itemRes.data;

            if (item.MediaSources && item.MediaSources.length > 0) {
                const mediaSource = item.MediaSources[0];
                const validCodecs = ['srt', 'subrip', 'vtt', 'ass', 'ssa'];

                mediaSource.MediaStreams.forEach(stream => {
                    if (stream.Type === 'Subtitle' && validCodecs.includes(stream.Codec?.toLowerCase())) {
                        // Fetched by the player: public host, viewer's own token.
                        const ext = stream.Codec === 'vtt' ? 'vtt' : 'srt';
                        const subUrl = playbackUrl(
                            viewer,
                            `/Videos/${jellyfinItemId}/${mediaSource.Id}/Subtitles/${stream.Index}/0/Stream.${ext}`
                        );

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
