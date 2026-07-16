// ============================================================================
// LOCAL FILESYSTEM SUBTITLE SOURCE  (Phase 1)
// ============================================================================
// Reads standalone subtitle files from a folder on the addon's own machine
// (LOCAL_SUBS_DIR). It does NOT serve the bytes itself — it returns descriptors
// whose `url` points back at the addon's /local-subtitle route, which streams
// the file over HTTPS (see handlers/localSubsRoute.js).
//
// LAYOUT — one folder per title, named by its IMDb id (optionally followed by
// ".<free text>" for your own reference, which is ignored when matching):
//
//   movie/<imdbId>[.<free text>]/<label> <notes>.<lang>.<ext>
//   series/<imdbId>[.<free text>]/S<season>E<episode>.<label> <notes>.<lang>.<ext>
//
// The FOLDER is the match key. Inside it:
//   - movie  files carry no key (the whole folder is that one movie):
//                 <label> <notes>.<lang>.<ext>
//   - series files carry the episode key SxxExx (the folder holds many):
//                 S<season>E<episode>.<label> <notes>.<lang>.<ext>
//
// FILENAME FIELDS — the LANGUAGE is always the final field before the
// extension (e.g. ...eng.srt), matching what external players/tools expect:
//
//     <lang>     The LAST field before the extension. A 2/3-letter code
//                (en, eng, fr, fre, ...). Stremio shows the language name
//                from it. If missing/unrecognised, a default is used.
//                Deterministic rule: the last field is ALWAYS read as the
//                language, so a lone "drift.srt" means language "drift"
//                (-> default), NOT a label. Keep the language on the end.
//     <label>    optional dot-field(s) before the language (and, for series,
//                after the SxxExx key). Becomes part of the subtitle `id`,
//                shown on hover in the Stremio PC app — use it to tell apart
//                files of the same title+language ("synced" vs "drift").
//                Multi-word? join with - or . (a space starts the notes).
//     <notes>    optional; anything after the first SPACE is IGNORED — your
//                spot for a human-readable name (title, release, reminder).
//
// Examples:
//   movie/tt0133093.The Matrix/eng.srt          -> lang eng, no label
//   movie/tt0133093.The Matrix/synced.eng.srt   -> lang eng, label "synced"
//   movie/tt0133093.The Matrix/drift v1.eng.srt -> lang eng, label "drift"
//   series/tt0903747.Breaking Bad/S01E05.eng.srt        -> lang eng, no label
//   series/tt0903747.Breaking Bad/S01E05.synced.eng.srt -> lang eng, "synced"
// ============================================================================

import { readdir, mkdir, writeFile, rename } from 'fs/promises';
import path from 'path';
import { getDefaultSubsLang } from '../global-constants.js';

const SUBS_DIR = process.env.LOCAL_SUBS_DIR;
const SUB_EXTS = ['.srt', '.vtt', '.ass', '.ssa'];

// Map 2-letter hints to the 3-letter ISO 639-2 codes the rest of the addon uses.
const LANG_MAP = { en: 'eng', he: 'heb', es: 'spa', fr: 'fre', ru: 'rus', ar: 'ara' };

export function isEnabled() {
    return Boolean(SUBS_DIR);
}

// Turn the language field into an ISO 639-2 code (or the configured default).
function toLangCode(seg) {
    if (seg) {
        const code = seg.toLowerCase();
        if (code.length === 3) return code;     // already ISO 639-2 (e.g. fre, eng)
        if (LANG_MAP[code]) return LANG_MAP[code];
    }
    return getDefaultSubsLang();
}

// Resolve a title folder: named either exactly "<imdbId>" or "<imdbId>.<free
// text>" — the text after the imdbId is for humans and is ignored for
// matching. Used for BOTH movies and series. The trailing-dot guard prevents
// matching a different id (e.g. tt123 must not match a tt1234 folder).
async function resolveTitleFolder(root, imdbId) {
    let entries;
    try {
        entries = await readdir(root, { withFileTypes: true });
    } catch {
        return null; // movie/ or series/ doesn't exist yet
    }
    const want = imdbId.toLowerCase();
    const match = entries.find((e) =>
        e.isDirectory() &&
        (e.name.toLowerCase() === want || e.name.toLowerCase().startsWith(want + '.'))
    );
    return match ? match.name : null;
}

// Extract { lang, label } from a subtitle filename.
//   matcherToken = the leading key to strip first (SxxExx for series), or
//                  null for movies (whose files carry no key).
// The language is always the LAST dot-field; the label is what remains before
// the first space.
function parseSubFile(filename, matcherToken) {
    const ext = path.extname(filename);
    let base = path.basename(filename, ext);

    if (matcherToken) {
        base = base.slice(matcherToken.length);          // drop e.g. "S01E05"
        if (base.startsWith('.')) base = base.slice(1);  // drop the following dot
    }

    const parts = base.length ? base.split('.') : [];
    let lang, rest;
    if (parts.length >= 2) {
        lang = toLangCode(parts[parts.length - 1]);      // language = last field
        rest = parts.slice(0, -1).join('.');
    } else if (parts.length === 1) {
        lang = toLangCode(parts[0]);                     // lone field IS the language
        rest = '';
    } else {
        lang = toLangCode(undefined);                    // nothing left -> default
        rest = '';
    }

    const label = rest.split(' ')[0].trim();             // before first space; notes ignored
    return { lang, label };
}

export async function find({ type, id, httpsBase }) {
    if (!isEnabled()) return [];
    if (!id || !id.startsWith('tt')) return [];

    const [imdbId, season, episode] = id.split(':');

    // Resolve the per-title folder (same "<imdbId>[.<free text>]" convention
    // for movies and series).
    const titleFolder = await resolveTitleFolder(path.join(SUBS_DIR, type), imdbId);
    if (!titleFolder) return [];                        // no folder for this title

    const dir = path.join(SUBS_DIR, type, titleFolder);
    const relBase = path.posix.join(type, titleFolder);

    // Movies: the folder IS the movie, so every subtitle file in it matches
    //         and the id is built around the imdbId.
    // Series: files are keyed by the episode SxxExx, which also seeds the id.
    let matcherToken = null;
    let idMatcher = imdbId;
    if (type === 'series' && season && episode) {
        const s = String(season).padStart(2, '0');
        const e = String(episode).padStart(2, '0');
        matcherToken = `S${s}E${e}`;
        idMatcher = matcherToken;
    }

    let files;
    try {
        files = await readdir(dir);
    } catch {
        return []; // folder vanished between calls -> nothing to serve
    }

    // Trailing dot guards prefix collisions (S01E05 vs S01E055).
    const prefix = matcherToken ? (matcherToken + '.').toLowerCase() : null;

    const subs = files
        .filter((f) => {
            const lf = f.toLowerCase();
            if (!SUB_EXTS.includes(path.extname(lf))) return false;
            return prefix ? lf.startsWith(prefix) : true; // movies: any subtitle file
        })
        .sort((a, b) => a.localeCompare(b))                // stable, predictable order
        .map((f) => {
            const { lang, label } = parseSubFile(f, matcherToken);
            const core = label ? `${idMatcher}.${label}` : idMatcher;
            return {
                id: `local-${core}.${lang}`,
                url: `${httpsBase}/local-subtitle?f=${encodeURIComponent(path.posix.join(relBase, f))}`,
                lang,
            };
        });

    // Defensive: subtitle ids must be unique within a response. Well-formed
    // files always are, but a malformed name (e.g. a missing language that
    // defaults to one already present) could otherwise collide and get one
    // entry dropped by the player. Suffix any duplicates so nothing vanishes.
    const seen = new Map();
    for (const s of subs) {
        const n = (seen.get(s.id) || 0) + 1;
        seen.set(s.id, n);
        if (n > 1) s.id = `${s.id}.${n}`;
    }
    return subs;
}

// ============================================================================
// WRITE SIDE — place a subtitle file into the store (Step 4a)
// ============================================================================
// Mirror of find(): given a title id and the subtitle bytes, write the file
// using the SAME folder/naming rules find() reads, so it is immediately served.
// Reuses an existing "<imdbId>[.<freetext>]" folder if present (freetext is
// ignored for matching); otherwise creates "<imdbId>[.<freetext>]".

// Sanitize a human freetext suffix for a folder name: strip illegal/path chars,
// collapse spaces, no leading dots. '' if nothing usable.
function sanitizeFreetext(s) {
    if (!s) return '';
    return String(s)
        .replace(/[\/\\:*?"<>|]/g, ' ')
        .replace(/\s+/g, ' ')
        .replace(/^\.+/, '')
        .trim()
        .slice(0, 80);
}

// Sanitize a label into a single dot-field (no spaces -> a space would start
// "notes"; no dots -> dots delimit fields). '' if nothing usable.
function sanitizeLabel(s) {
    if (!s) return '';
    return String(s).replace(/[^\w-]/g, '').slice(0, 40);
}

// Write a subtitle for `id` and return the absolute path written.
//   { type:'movie'|'series', id:'tt..[:s:e]', lang, label='', freetext='', content }
// `lang` defaults to DEFAULT_SUBS_LANG (the read-side default) when omitted.
export async function place({ type, id, lang, label = '', freetext = '', content }) {
    if (!isEnabled()) throw new Error('LOCAL_SUBS_DIR not configured');
    if (type !== 'movie' && type !== 'series') throw new Error(`bad type: ${type}`);
    if (!id || !id.startsWith('tt')) throw new Error(`bad id: ${id}`);
    if (content == null || content === '') throw new Error('empty content');

    const [imdbId, season, episode] = id.split(':');
    if (type === 'series' && !(season && episode)) throw new Error('series id needs season:episode');

    // Resolve or create the per-title folder.
    const typeRoot = path.join(SUBS_DIR, type);
    await mkdir(typeRoot, { recursive: true });
    let titleFolder = await resolveTitleFolder(typeRoot, imdbId);
    if (!titleFolder) {
        const ft = sanitizeFreetext(freetext);
        titleFolder = ft ? `${imdbId}.${ft}` : imdbId;
    }
    const dir = path.join(typeRoot, titleFolder);
    await mkdir(dir, { recursive: true });

    // Build "[SxxExx.][label.]<lang>.srt". Default language comes from
    // DEFAULT_SUBS_LANG, matching what the read side falls back to.
    const langCode = String(lang || getDefaultSubsLang()).toLowerCase();
    const lbl = sanitizeLabel(label);
    let name = '';
    if (type === 'series') {
        name += `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}.`;
    }
    if (lbl) name += `${lbl}.`;
    name += `${langCode}.srt`;

    const dest = path.join(dir, name);
    const tmp = path.join(dir, `.tmp-${Date.now()}.${name}`);
    await writeFile(tmp, content, 'utf8');
    await rename(tmp, dest);   // atomic publish so find() never sees a partial
    return dest;
}
