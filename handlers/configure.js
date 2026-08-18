import { isMultiUser, getJellyfinApiBase } from '../global-constants.js';
import { authenticateByName } from '../jellyfin-auth.js';
import { sealLogin, installPath } from '../viewer.js';
import { thisAddon } from '../common-utils.js';

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
            <button type="submit">Sign in &amp; get my link</button>
        </form>
        <div id="m" class="msg"></div>
        <script>
        const f = document.getElementById('f'), m = document.getElementById('m'), b = f.querySelector('button');
        f.addEventListener('submit', async (e) => {
            e.preventDefault();
            b.disabled = true; m.className = 'msg'; m.textContent = '';
            try {
                const r = await fetch('configure', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username: f.username.value, password: f.password.value })
                });
                const d = await r.json();
                if (!r.ok) { m.className = 'msg err'; m.textContent = d.error || 'Sign-in failed.'; return; }
                m.className = 'msg ok';
                m.innerHTML = 'Signed in as <b>' + d.userName + '</b>' +
                    (d.warning ? '<br><b>' + d.warning + '</b>' : '') +
                    '<span class="url">' + d.installUrl + '</span>' +
                    '<a class="install" href="' + d.stremioUrl + '">Install in Stremio</a>';
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
            return res.status(401).json({ error: 'Jellyfin rejected that username or password' });
        }
        console.error(`[Configure] Jellyfin authentication failed for "${userName}": ${error.message}`);
        return res.status(502).json({ error: 'Could not reach Jellyfin — try again shortly' });
    }

    const base = process.env.HTTPS_BASE_URL || '';
    const path = installPath(sealLogin({ userName, password }));
    const installUrl = `${base}${path}`;

    console.log(`[Configure] Minted an install link for Jellyfin user "${session.userName}".`);

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
