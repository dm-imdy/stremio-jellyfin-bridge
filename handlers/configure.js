import { isMultiUser, getJellyfinApiBase } from '../global-constants.js';
import { authenticateByName } from '../jellyfin-auth.js';
import { sealLogin, installPath } from '../viewer.js';
import { recordLoginFailure, clearLoginFailures } from '../login-guard.js';
import { thisAddon } from '../common-utils.js';
import { TIERS, VIDEO_CODECS, AUDIO_CODECS, DEFAULT_PREFS } from '../transcode.js';

// The form is generated from the same tables the stream handler reads, so a tier
// or codec cannot exist in one and be missing from the other.
const TIER_ROWS = Object.values(TIERS)
    .sort((a, b) => b.height - a.height)
    .map((t) => `
                <div class="tier">
                    <label><input type="checkbox" name="tier" value="${t.key}"${
                        DEFAULT_PREFS.tiers.includes(t.key) ? ' checked' : ''
                    }> ${t.label}</label>
                    <input class="br" name="br-${t.key}" inputmode="decimal" placeholder="auto">
                    <span class="u">Mbps</span>
                </div>`)
    .join('');

const options = (table, selected) => Object.values(table)
    .map((c) => `<option value="${c.key}"${c.key === selected ? ' selected' : ''}>${c.label}</option>`)
    .join('');

const VIDEO_OPTIONS = options(VIDEO_CODECS, DEFAULT_PREFS.videoCodec);
const AUDIO_OPTIONS = options(AUDIO_CODECS, DEFAULT_PREFS.audioCodec);

// ==========================================
// THE CONFIGURE PAGE (multi-user mode)
// ==========================================
// Where a viewer turns their Jellyfin login into an install URL.
//
// The login is checked against Jellyfin HERE, before any URL is minted, so a typo
// says "Jellyfin rejected that login" on the spot instead of installing an addon
// that silently shows an empty library. The same check is what every later request
// repeats — this page is convenience, not the gate.
//
// The credentials are never stored server-side: they are sealed into the install
// URL, and that URL is the only thing the viewer keeps.

const page = (body) => `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${thisAddon.name} — configure</title>
<style>
  :root { color-scheme: dark light; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
         font:16px/1.5 system-ui,-apple-system,Segoe UI,sans-serif; background:#14151a; color:#e8e8ea; }
  main { width:min(30rem,92vw); background:#1d1f26; border:1px solid #2b2e38; border-radius:14px; padding:1.6rem 1.7rem; }
  h1 { font-size:1.15rem; margin:0 0 .3rem; }
  p.sub { margin:0 0 1.3rem; color:#9a9daa; font-size:.9rem; }
  label { display:block; font-size:.82rem; color:#9a9daa; margin:.9rem 0 .3rem; }
  input { width:100%; box-sizing:border-box; padding:.6rem .7rem; border-radius:8px; border:1px solid #343846;
          background:#14151a; color:inherit; font:inherit; }
  input:focus { outline:2px solid #5b7cfa; outline-offset:1px; border-color:transparent; }
  button { width:100%; margin-top:1.3rem; padding:.7rem; border:0; border-radius:8px; background:#5b7cfa;
           color:#fff; font:600 1rem/1 inherit; cursor:pointer; }
  button:disabled { opacity:.55; cursor:progress; }
  .msg { margin-top:1rem; padding:.7rem .8rem; border-radius:8px; font-size:.88rem; display:none; }
  .msg.err { display:block; background:#3a1d22; border:1px solid #6d2b35; color:#ffb3bd; }
  .msg.ok  { display:block; background:#16281f; border:1px solid #27503a; color:#9ff0c4; }
  .url { display:block; margin-top:.6rem; padding:.6rem .7rem; background:#14151a; border:1px solid #343846;
         border-radius:8px; font:.78rem/1.45 ui-monospace,SFMono-Regular,Menlo,monospace; word-break:break-all; color:#c8ccd8; }
  a.install { display:block; text-align:center; margin-top:.8rem; padding:.7rem; border-radius:8px;
              background:#27503a; color:#9ff0c4; text-decoration:none; font-weight:600; }
  fieldset { margin:1.4rem 0 0; padding:.9rem 1rem 1.1rem; border:1px solid #2b2e38; border-radius:10px; }
  legend { padding:0 .4rem; font-size:.82rem; color:#c8ccd8; }
  p.hint { margin:.1rem 0 .9rem; font-size:.76rem; line-height:1.45; color:#82859a; }
  .tier { display:flex; align-items:center; gap:.55rem; margin:.35rem 0; }
  .tier label { flex:1; margin:0; display:flex; align-items:center; gap:.5rem; color:#e8e8ea; font-size:.9rem; }
  .tier input[type=checkbox] { width:auto; margin:0; accent-color:#5b7cfa; }
  .tier input.br { width:5.4rem; flex:none; padding:.35rem .45rem; font-size:.82rem; text-align:right; }
  .tier span.u { font-size:.74rem; color:#82859a; width:2.6rem; }
  select { width:100%; box-sizing:border-box; padding:.6rem .7rem; border-radius:8px; border:1px solid #343846;
           background:#14151a; color:inherit; font:inherit; }
  .row { display:flex; gap:.7rem; }
  .row > div { flex:1; }
  .check { display:flex; align-items:center; gap:.5rem; margin-top:1rem; font-size:.86rem; color:#e8e8ea; }
  .check input { width:auto; margin:0; accent-color:#5b7cfa; }
  .warn { margin-top:.7rem; font-size:.76rem; line-height:1.45; color:#e8b57a; }
</style></head><body><main>${body}</main></body></html>`;

export function configurePage(req, res) {
    if (!isMultiUser()) {
        return res.status(404).type('html').send(page(`
            <h1>Nothing to configure</h1>
            <p class="sub">This addon is running in single-user mode: it serves one identity taken from its
            environment, so there is no per-viewer login to set. Set <code>BRIDGE_SECRET</code> to enable
            per-viewer Jellyfin accounts.</p>`));
    }

    res.type('html').send(page(`
        <h1>${thisAddon.name}</h1>
        <p class="sub">Sign in with your own Jellyfin account to get your personal install link.
        You will only see the libraries that account can see.</p>
        <form id="f" autocomplete="on">
            <label for="u">Jellyfin username</label>
            <input id="u" name="username" required autocapitalize="none" autocomplete="username">
            <label for="p">Jellyfin password</label>
            <input id="p" name="password" type="password" autocomplete="current-password">

            <fieldset>
                <legend>Quality offered in Stremio</legend>
                <p class="hint">Every ticked size becomes its own row next to Direct Play, so you choose
                quality when you press play rather than here. Leave a bitrate blank and it is worked out
                from the file itself, scaled by pixel count — half the pixels, half the bits. Sizes larger
                than the file are skipped instead of being upscaled.</p>
                ${TIER_ROWS}
            </fieldset>

            <fieldset>
                <legend>Codecs</legend>
                <div class="row">
                    <div>
                        <label for="vc">Video</label>
                        <select id="vc" name="videoCodec">${VIDEO_OPTIONS}</select>
                    </div>
                    <div>
                        <label for="ac">Audio</label>
                        <select id="ac" name="audioCodec">${AUDIO_OPTIONS}</select>
                    </div>
                </div>
                <label for="ch">Audio channels</label>
                <select id="ch" name="audioChannels">
                    <option value="2" selected>Stereo — safest away from home</option>
                    <option value="6">5.1 — only if your player handles it</option>
                </select>
                <p class="warn" id="vcwarn" hidden>HEVC roughly halves the bitrate at the same quality, but
                not every Stremio player can decode it. Pick H.264 if anything refuses to play.</p>
                <div class="check">
                    <input type="checkbox" id="sc" name="streamCopy" checked>
                    <label for="sc" style="margin:0;color:inherit">Skip re-encoding when the file already fits</label>
                </div>
            </fieldset>

            <button type="submit">Sign in &amp; get my link</button>
        </form>
        <div id="m" class="msg"></div>
        <script>
        const f = document.getElementById('f'), m = document.getElementById('m'), b = f.querySelector('button');

        // Only warn about HEVC while it is actually selected -- a warning that is
        // always on stops being read.
        const vc = document.getElementById('vc'), vcwarn = document.getElementById('vcwarn');
        const syncWarn = () => { vcwarn.hidden = vc.value === 'h264'; };
        vc.addEventListener('change', syncWarn); syncWarn();

        // Bitrates are typed in Mbps because that is how anyone thinks about a
        // connection, and sent in bits per second because that is what Jellyfin
        // takes. A blank field means "work it out from the file".
        function readPrefs() {
            const tiers = [...f.querySelectorAll('input[name=tier]:checked')].map(c => c.value);
            const bitrates = {};
            for (const key of tiers) {
                const raw = (f.elements['br-' + key]?.value || '').trim();
                if (!raw) continue;
                const mbps = Number(raw.replace(',', '.'));
                if (Number.isFinite(mbps) && mbps > 0) bitrates[key] = Math.round(mbps * 1000000);
            }
            return {
                tiers, bitrates,
                videoCodec: vc.value,
                audioCodec: document.getElementById('ac').value,
                audioChannels: Number(document.getElementById('ch').value),
                streamCopy: document.getElementById('sc').checked
            };
        }

        f.addEventListener('submit', async (e) => {
            e.preventDefault();
            const prefs = readPrefs();
            if (!prefs.tiers.length) {
                m.className = 'msg err';
                m.textContent = 'Tick at least one size, or Direct Play will be your only option.';
                return;
            }
            b.disabled = true; m.className = 'msg'; m.textContent = '';
            try {
                const r = await fetch('configure', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username: f.username.value, password: f.password.value, prefs })
                });
                const d = await r.json();
                if (!r.ok) { m.className = 'msg err'; m.textContent = d.error || 'Sign-in failed.'; return; }
                m.className = 'msg ok';
                // Built as DOM nodes, not concatenated HTML: the username comes
                // from Jellyfin, and a display name is not something this page
                // should be able to be talked into executing.
                m.textContent = 'Signed in as ' + d.userName;
                if (d.warning) { const w = document.createElement('div'); w.textContent = d.warning; m.appendChild(w); }
                const u = document.createElement('span'); u.className = 'url'; u.textContent = d.installUrl;
                const a = document.createElement('a'); a.className = 'install'; a.textContent = 'Install in Stremio';
                a.href = d.stremioUrl;
                m.appendChild(u); m.appendChild(a);
            } catch (err) {
                m.className = 'msg err'; m.textContent = 'Could not reach the addon: ' + err.message;
            } finally { b.disabled = false; }
        });
        </script>`));
}

export async function configureSubmit(req, res) {
    if (!isMultiUser()) return res.status(404).json({ error: 'This addon is not in multi-user mode' });

    const userName = String(req.body?.username || '').trim();
    const password = String(req.body?.password ?? '');

    if (!userName) return res.status(400).json({ error: 'Enter your Jellyfin username' });

    let session;
    try {
        session = await authenticateByName(getJellyfinApiBase(), userName, password);
    } catch (error) {
        const status = error?.response?.status;
        if (status === 401 || status === 403) {
            // Counted, not just refused: this is the endpoint a guesser hammers.
            recordLoginFailure(req, userName);
            return res.status(401).json({ error: 'Jellyfin rejected that username or password' });
        }
        console.error(`[Configure] Jellyfin authentication failed for "${userName}": ${error.message}`);
        return res.status(502).json({ error: 'Could not reach Jellyfin — try again shortly' });
    }

    // Cleared on success so an honest typo does not leave a viewer locked out.
    clearLoginFailures(req, userName);

    // Whatever arrives here is normalised inside the seal: this endpoint is public,
    // so the preferences are treated as untrusted input rather than as a form this
    // page necessarily produced.
    const prefs = req.body?.prefs && typeof req.body.prefs === 'object' ? req.body.prefs : null;

    const base = process.env.HTTPS_BASE_URL || '';
    const path = installPath(sealLogin({ userName, password, prefs }));
    const installUrl = `${base}${path}`;

    console.log(`[Configure] Minted an install link for Jellyfin user "${session.userName}"` +
        (prefs ? ` (tiers: ${(prefs.tiers || []).join(', ') || 'defaults'}, ${prefs.videoCodec || 'h264'}).` : '.'));

    res.json({
        userName: session.userName,
        installUrl,
        stremioUrl: installUrl.replace(/^https?:\/\//, 'stremio://'),
        // Handing an ADMIN account to a viewer restores the exposure this mode
        // removes: their token can read every user and every library.
        warning: session.isAdmin
            ? 'This is an administrator account — its token can see everything on the server. Use a normal user account for anyone but yourself.'
            : undefined,
    });
}
