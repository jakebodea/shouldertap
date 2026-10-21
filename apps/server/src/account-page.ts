const accountScript = String.raw`
(() => {
  const el = id => document.getElementById(id);
  const status = message => { el('status').textContent = message; };
  let token = location.hash.slice(1);
  if (token === 'patron') token = '';
  history.replaceState(null, '', location.pathname + location.search);
  try { token = decodeURIComponent(token); } catch { token = ''; }
  const pendingKey = 'shouldertap.account.pending-device';
  let userCode = new URLSearchParams(location.search).get('user_code') || '';
  try {
    if (userCode) localStorage.setItem(pendingKey, userCode);
    else userCode = localStorage.getItem(pendingKey) || '';
  } catch {}
  const request = async (path, body) => {
    const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.message || data.error_description || data.error || 'That did not work. Please try again.');
    return data;
  };
  const action = (id, callback) => { el(id).addEventListener('click', async () => { el(id).disabled = true; status(''); try { await callback(); } catch (error) { status(error.message); } finally { el(id).disabled = false; } }); };
  const finishDevice = async decision => {
    await request('/api/auth/device/' + decision, { userCode });
    try { localStorage.removeItem(pendingKey); } catch {}
    el('device').hidden = true;
    status(decision === 'approve' ? 'Device connected. You can return to the Shouldertap app.' : 'Device request denied.');
  };
  const loadDevice = async () => {
    if (!userCode) return;
    const data = await request('/api/auth/device?user_code=' + encodeURIComponent(userCode));
    const clients = { 'shouldertap-ios': 'Shouldertap for iPhone', 'shouldertap-mac': 'Shouldertap for Mac', 'shouldertap-windows': 'Shouldertap for Windows', 'shouldertap-web': 'Shouldertap in your browser' };
    if (data.status !== 'pending' || !clients[data.client_id]) throw new Error('This device request is no longer available. Start sign in again in your app.');
    el('code').textContent = data.user_code;
    el('client').textContent = clients[data.client_id];
    el('matches').checked = false; el('approve').disabled = true;
    el('device').hidden = false;
  };
  const loadConnections = async () => {
    const data = await request('/account/data');
    el('connections').replaceChildren();
    el('empty').textContent = 'Your saved connections will appear here.';
    // Resource names are always inserted as text, never account-controlled HTML.
    for (const item of [...(data.inboxes || []), ...(data.senders || [])]) {
      const row = document.createElement('div'); row.className = 'row';
      const name = document.createElement('strong'); name.textContent = item.name || item.recipientName || 'Shouldertap connection'; row.append(name);
      if (data.inboxes.includes(item)) {
        const button = document.createElement('button'); button.textContent = data.defaultInboxId === item.inboxId ? 'Default inbox' : 'Make default'; button.disabled = data.defaultInboxId === item.inboxId;
        button.onclick = async () => { button.disabled = true; try { await request('/account/default', {inboxId: item.inboxId}); await loadConnections(); status('Default inbox updated.'); } catch (error) { status(error.message); button.disabled = false; } }; row.append(button);
      }
      el('connections').append(row);
    }
    if (el('connections').children.length) el('empty').hidden = true;
  };
  const loadPatron = async () => {
    if (location.pathname === '/account/device' || userCode) { el('patron').hidden = true; return; }
    const data = await request('/account/patron/status');
    el('patron-actions').replaceChildren();
    const memberships = data.memberships || [];
    el('patron-status').textContent = memberships.length ? 'Your patron memberships' : 'You do not have active patron support.';
    const add = (label, path, patronId) => { const button = document.createElement('button'); button.textContent = label; button.onclick = async () => { button.disabled = true; try { const result = await request(path, patronId ? {patronId} : {}); const url = new URL(result.url); if (url.protocol !== 'https:') throw new Error('Billing link is unavailable.'); location.assign(url.href); } catch (error) { status(error.message); button.disabled = false; } }; el('patron-actions').append(button); };
    for (const membership of memberships) {
      const patron = membership.status.patron;
      const row = document.createElement('p'); row.textContent = (membership.name || 'Patron membership') + ': ' + (patron.active ? 'Active' : patron.status.replaceAll('_', ' ')); el('patron-actions').append(row);
      if (patron.canManage) add('Manage billing', '/account/patron/manage', membership.id);
      if (data.checkoutEnabled && patron.canSubscribe) add('Become a patron', '/account/patron/checkout', membership.id);
    }
    if (data.checkoutEnabled && !memberships.length) add('Become a patron', '/account/patron/checkout');
    else if (!data.checkoutEnabled) { const note = document.createElement('p'); note.textContent = 'New subscriptions are not available yet.'; el('patron-actions').append(note); }
  };
  const load = async () => {
    const session = await request('/api/auth/get-session');
    const signedIn = Boolean(session && session.user);
    el('signin').hidden = signedIn || Boolean(token); el('signedin').hidden = !signedIn; el('confirm').hidden = !token;
    if (!signedIn) return;
    el('intro').textContent = 'Your Shouldertap connections and account settings.';
    el('who').textContent = 'Signed in as ' + session.user.email;
    await Promise.all([loadDevice().catch(error => status(error.message)), loadConnections().catch(() => { el('empty').textContent = 'Connections could not load. Refresh to try again.'; }), loadPatron().catch(() => { el('patron-status').textContent = 'Patron status could not load. Refresh to try again.'; })]);
  };
  el('signin').addEventListener('submit', async event => {
    event.preventDefault(); const button = el('signin').querySelector('button'); button.disabled = true;
    try { await request('/api/auth/sign-in/magic-link', { email: el('email').value, callbackURL: '/account' }); status('Check your email for a sign-in link. You can close this tab.'); } catch (error) { status(error.message); } finally { button.disabled = false; }
  });
  action('verify', async () => { await request('/account/verify', { token }); token = ''; status('Signed in.'); await load(); });
  action('signout', async () => { await request('/api/auth/sign-out', {}); location.replace('/account'); });
  el('matches').addEventListener('change', () => { el('approve').disabled = !el('matches').checked; });
  action('approve', async () => { if (!el('matches').checked) return; await finishDevice('approve'); });
  action('deny', () => finishDevice('deny'));
  el('device-entry').addEventListener('submit', async event => { event.preventDefault(); userCode = el('entered-code').value.trim(); try { await loadDevice(); } catch (error) { status(error.message); } });
  el('delete-confirm').addEventListener('change', () => { el('delete-account').disabled = !el('delete-confirm').checked; });
  action('delete-account', async () => { if (!el('delete-confirm').checked) return; await request('/api/auth/delete-user', {}); location.replace('/account'); });
  load().catch(() => { status('Your account could not load. Refresh to try again.'); });
})();`;

/** API-origin portal: credentials stay in HttpOnly cookies, never in web URLs. */
export const accountPage = (webOrigin?: string) => {
  const returnURL = webOrigin ? new URL("/account", webOrigin).href : "";
  const returnLink = returnURL
    ? `<a class="button" href="${returnURL.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;")}">Return to Shouldertap</a><p>Return to save or restore this browser’s connections and continue to patron support.</p>`
    : "";
  const nonce = crypto.randomUUID().replaceAll("-", "");
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="referrer" content="no-referrer"><title>Your account · Shouldertap</title><style nonce="${nonce}">
:root{color-scheme:light;--paper:#f6f5f1;--ink:#161616;--tone:#6f6e69;--line:#dedcd5;--faint:#ebe9e3}*{box-sizing:border-box}body{margin:0;background:var(--ink);color:var(--ink);font:500 17px/1.5 system-ui,sans-serif;padding:12px;min-height:100svh}header{color:var(--paper);max-width:760px;margin:12px auto 24px;font-size:24px;font-weight:800;letter-spacing:-.035em}main{background:var(--paper);border-radius:28px;max-width:760px;margin:auto;padding:clamp(24px,6vw,64px);min-height:75svh}h1{font-size:clamp(36px,7vw,54px);line-height:1.03;letter-spacing:-.035em;margin:0 0 20px;font-weight:800}h2{font-size:24px;letter-spacing:-.02em;line-height:1.2;margin:0 0 12px}p{max-width:60ch;margin:12px 0;color:var(--tone)}section{padding:28px 0;border-top:1px solid var(--line)}label{display:block;margin:20px 0 8px}input{width:100%;font:inherit;color:inherit;background:var(--faint);border:0;border-radius:18px;padding:15px 18px;min-height:50px}input[type=checkbox]{width:auto;min-height:auto;margin-right:8px}button,.button{font:700 16px/1.3 system-ui,sans-serif;border:1.5px solid var(--line);background:transparent;color:inherit;border-radius:999px;padding:13px 22px;min-height:48px;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;justify-content:center}button.primary{background:var(--ink);color:var(--paper);border-color:var(--ink)}button:hover,.button:hover{border-color:var(--ink)}button:disabled{opacity:.5;cursor:wait}button:focus-visible,input:focus-visible,a:focus-visible{outline:3px solid var(--ink);outline-offset:4px}.actions{display:flex;gap:12px;flex-wrap:wrap;margin-top:22px}#status{min-height:1.5em;color:var(--ink)}.code{font-size:32px;font-weight:800;letter-spacing:.12em;font-variant-numeric:tabular-nums;overflow-wrap:anywhere;color:var(--ink)}.row{padding:18px 0;border-bottom:1px solid var(--line)}.row p{margin:4px 0}a{color:inherit;text-underline-offset:3px}footer{margin-top:32px;font-size:14px;color:var(--tone)}[hidden]{display:none!important}::selection{background:var(--ink);color:var(--paper)}@media(prefers-color-scheme:dark){:root{color-scheme:dark;--paper:#18181a;--ink:#f1f0ec;--tone:#9a9994;--line:#34343a;--faint:#232326}body{background:#34343a}header{color:var(--ink)}}
</style></head><body><header>Shouldertap</header><main><h1>Your account.</h1><p id="intro">Sign in to keep your Shouldertap connections and patron support with you.</p><p id="status" role="status" aria-live="polite"></p><div id="confirm" hidden><h2>Confirm your sign in</h2><p>Continue only if you asked for this email.</p><button id="verify" class="primary">Confirm sign in</button></div><form id="signin" hidden><label for="email">Email address</label><input id="email" type="email" autocomplete="email" required maxlength="254"><div class="actions"><button class="primary" type="submit">Email me a sign-in link</button></div><p>The link expires in 10 minutes.</p></form><div id="signedin" hidden><p id="who"></p>${returnLink}<form id="device-entry"><label for="entered-code">Have a device sign-in code?</label><input id="entered-code" autocomplete="off" maxlength="32" required placeholder="Enter the code from your app"><div class="actions"><button type="submit">Review device code</button></div></form><section id="device" hidden><h2>Connect your device</h2><p>Only connect a device in your possession. Check this code against your app; never approve a code sent by another person.</p><p class="code" id="code"></p><p id="client"></p><label><input id="matches" type="checkbox" >The code matches my device</label><div class="actions"><button id="approve" class="primary" disabled>Connect device</button><button id="deny">Deny</button></div></section><section><h2>Your connections</h2><p id="empty">Loading your saved connections…</p><div id="connections"></div></section><section id="patron"><h2>Patron support</h2><p>Core messaging is free. Optional patron support belongs to your account.</p><p id="patron-status">Loading patron status…</p><div class="actions" id="patron-actions"></div></section><section><h2>Delete account</h2><p>Deletes your account and its recovery links. Existing device connections remain on their devices. This does not cancel billing; manage active subscriptions first. You may need to sign in again before deleting.</p><label><input id="delete-confirm" type="checkbox" >I want to permanently delete my account</label><div class="actions"><button id="delete-account" disabled>Delete my account</button></div></section><div class="actions"><button id="signout">Sign out</button></div></div><footer>Your sign-in link is private. Never share it with anyone.<br><a href="mailto:support@shouldertap.app">Contact support</a></footer></main><script nonce="${nonce}">${accountScript}</script></body></html>`,
    {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
        "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
      },
    }
  );
};
