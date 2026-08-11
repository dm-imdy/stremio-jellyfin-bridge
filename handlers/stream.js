import axios from 'axios';
import { isJellyfinConfigured } from '../global-constants.js';

export const streamHandler = async ({ type, id }) => {
    console.log(`[Stream] Request for ${type} | id: ${id}`);

    // Subtitles-only mode: no Jellyfin streams to serve.
    if (!isJellyfinConfigured()) return { streams: [] };

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

            // Search Jellyfin for the root item
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
                    console.log(`[Stream] Found exact local Movie match: ${matchedItem.Name}`);
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
                    const epRes = await axios.get(`${JELLYFIN_URL}/Shows/${matchedItem.Id}/Episodes`, {
                        headers: { 'X-Emby-Token': JELLYFIN_API_KEY },
                        params: {
                            userId: JELLYFIN_USER_ID,
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
                        console.log(`[Stream] Found local Episode match: S${targetSeason}E${targetEpisode}`);
                    } else {
                        console.log(`[Stream] ⚠️ Strict check failed: No exact match for S${targetSeason}E${targetEpisode}`);
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
        let source = null;
        
        if (item.MediaSources && item.MediaSources.length > 0) {
            mediaSourceId = item.MediaSources[0].Id;
            source = item.MediaSources[0];
        } else {
            console.error(`No MediaSources found for Jellyfin Item: ${jellyfinItemId}`);
            return { streams: [] };
        }

        // ==========================================
        // RETURN THE STREAM URLS TO STREMIO
        // ==========================================
        const directPlayUrl = `${JELLYFIN_URL}/Videos/${jellyfinItemId}/stream?static=true&mediaSourceId=${mediaSourceId}&api_key=${JELLYFIN_API_KEY}`;
        const transcodeUrl = `${JELLYFIN_URL}/Videos/${jellyfinItemId}/master.m3u8?mediaSourceId=${mediaSourceId}&api_key=${JELLYFIN_API_KEY}&VideoCodec=h264&AudioCodec=aac`;

        // Surface the real file details in Stremio.
        //
        // Both entries were previously labelled only "Jellyfin / Direct Play" and
        // "Jellyfin / Transcode (Web Safe)", so the last screen before playback said
        // nothing about WHICH file was about to play. That matters as soon as a library
        // holds more than one cut of a title, differing in resolution, audio language
        // or size.
        //
        // MediaSources already carries all of it, so Stremio's name/description are
        // built from it. bingeGroup keeps next-episode autoplay on the same source.
        // Movies and episodes share this path.
        const vid   = (source && source.MediaStreams ? source.MediaStreams : []).find(x => x.Type === 'Video') || {};
        const auds  = (source && source.MediaStreams ? source.MediaStreams : []).filter(x => x.Type === 'Audio');
        const bytes = source && source.Size ? source.Size : 0;
        const gb    = bytes / 1073741824;
        const sizeS = bytes ? (gb >= 1 ? gb.toFixed(2) + ' GB' : (bytes / 1048576).toFixed(0) + ' MB') : '';
        const h     = vid.Height || 0;
        const resS  = h >= 2000 ? '4K' : h >= 1400 ? '1440p' : h >= 1000 ? '1080p' : h >= 700 ? '720p' : (h ? h + 'p' : '');
        const dims  = (vid.Width && vid.Height) ? (vid.Width + 'x' + vid.Height) : '';
        const codec = (vid.Codec || '').toUpperCase();
        const langs = [...new Set(auds.map(a => a.Language).filter(Boolean))].join('/');
        const chans = auds.length ? (Math.max(...auds.map(a => a.Channels || 0)) + 'ch') : '';
        // Split on both separators: a Windows Jellyfin host reports Path as
        // E:\Media\Shows\Show\Show.S05E05.mkv, so splitting on '/' alone would
        // hand the whole drive path back instead of the filename.
        const fname = (source && source.Name) ? source.Name : ((source && source.Path ? source.Path : '').split(/[\\/]/).pop() || '');
        const bitr  = source && source.Bitrate ? (source.Bitrate / 1000000).toFixed(1) + ' Mbps' : '';
        const cont  = (source && source.Container ? source.Container : '').toUpperCase();

        const SEP  = ' \u2022 ';
        const line2 = [dims, codec, chans, langs].filter(Boolean).join(SEP);
        const line3 = [sizeS, bitr, cont].filter(Boolean).join(SEP);
        const detail = [fname, line2, line3].filter(Boolean).join('\n');
        const label  = 'Jellyfin' + (resS ? '\n' + resS : '');

        // bingeGroup identifies the NATURE of the stream, not the item: Stremio
        // auto-selects the next episode only when it offers a stream carrying the
        // same group. Keying it on the per-episode item id can therefore never
        // match across episodes, and "Play Now" on the next-episode prompt falls
        // back to the current one. The resolution is deliberately part of the key
        // so that a show with mixed-quality episodes keeps binging on one tier
        // instead of silently switching; Direct Play and Transcode stay distinct
        // so Stremio knows which of the two to carry forward.
        const groupBase = 'jellyfin' + (resS ? '-' + resS : '');

        return {
            streams: [
                {
                    name: label,
                    description: 'Direct Play\n' + detail,
                    url: directPlayUrl,
                    behaviorHints: { notWebReady: true, bingeGroup: groupBase + '-direct', videoSize: bytes || undefined, filename: fname }
                },
                {
                    name: label,
                    description: 'Transcode (web safe)\n' + detail,
                    url: transcodeUrl,
                    behaviorHints: { notWebReady: false, bingeGroup: groupBase + '-transcode', filename: fname }
                }
            ]
        };

    } catch (error) {
        console.error("Error resolving stream:", error.message);
        return { streams: [] };
    }
};
