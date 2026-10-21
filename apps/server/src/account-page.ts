const accountScript = String.raw`
(() => {
  const el = id => document.getElementById(id);
  const say = (id, message) => { el(id).textContent = message; };
  const query = new URLSearchParams(location.search);
  let token = location.hash.slice(1);
  if (token === 'patron') token = '';
  history.replaceState(null, '', location.pathname + location.search);
  try { token = decodeURIComponent(token); } catch { token = ''; }
  const pendingKey = 'shouldertap.account.pending-device';
  let userCode = query.get('user_code') || '';
  try {
    if (userCode) localStorage.setItem(pendingKey, userCode);
    else userCode = localStorage.getItem(pendingKey) || '';
  } catch {}
  const clients = { 'shouldertap-ios': 'iPhone', 'shouldertap-mac': 'Mac', 'shouldertap-windows': 'PC', 'shouldertap-web': 'browser' };
  // Server and OAuth wording never reaches the page as-is.
  const friendly = message => ({
    'Sign in to continue': 'Your sign-in expired. Sign in again.',
    'Origin required': 'That did not work. Refresh and try again.',
    invalid_request: 'This code is not valid. Check it and try again.',
    expired_token: 'This code expired. Start sign in again in your app.',
    access_denied: 'This request was denied.',
  })[message] || message;
  const generic = 'That did not work. Please try again.';
  const request = async (path, body) => {
    const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(friendly(data.message || data.error_description || data.error || generic));
    return data;
  };
  // Every action reports next to itself, so a phone never scrolls to find an error.
  // Device-only pages leave out the account controls, so wire only what exists.
  const on = (id, type, callback) => { if (el(id)) el(id).addEventListener(type, callback); };
  const action = (id, note, callback) => on(id, 'click', async () => { el(id).disabled = true; say(note, ''); try { await callback(); } catch (error) { say(note, error.message); } finally { el(id).disabled = false; } });
  const pill = (label, onClick) => { const button = document.createElement('button'); button.type = 'button'; button.className = 'small'; button.textContent = label; button.onclick = onClick; return button; };
  const tag = text => { const span = document.createElement('span'); span.className = 'tag'; span.textContent = text; return span; };
  const row = (label, trailing) => { const item = document.createElement('div'); item.className = 'row'; const name = document.createElement('span'); name.textContent = label; item.append(name); if (trailing) item.append(trailing); return item; };
  let deviceKind = 'device';
  const finishDevice = async decision => {
    await request('/api/auth/device/' + decision, { userCode });
    try { localStorage.removeItem(pendingKey); } catch {}
    el('device-card').hidden = true;
    el('device-done').hidden = false;
    say('device-result', decision === 'approve' ? 'Done. Go back to Shouldertap on your ' + deviceKind + '.' : 'Request denied. Nothing was connected.');
  };
  const loadDevice = async () => {
    if (!userCode) return;
    el('device').hidden = false;
    const data = await request('/api/auth/device?user_code=' + encodeURIComponent(userCode));
    if (data.status !== 'pending' || !clients[data.client_id]) {
      try { localStorage.removeItem(pendingKey); } catch {}
      throw new Error('This code is no longer valid. Start sign in again in your app.');
    }
    deviceKind = clients[data.client_id];
    say('device-title', 'Is this the code on your ' + deviceKind + '?');
    say('code', data.user_code);
    el('matches').checked = false; el('approve').disabled = true;
    el('device-card').hidden = false;
  };
  const loadConnections = async () => {
    const data = await request('/account/data');
    el('inboxes').replaceChildren(); el('senders').replaceChildren();
    // Resource names are always inserted as text, never account-controlled HTML.
    for (const item of data.inboxes || []) {
      const isDefault = data.defaultInboxId === item.inboxId;
      const button = isDefault ? tag('Default') : pill('Make default', async () => {
        button.disabled = true; say('connections-note', '');
        try { await request('/account/default', { inboxId: item.inboxId }); await loadConnections(); say('connections-note', 'Default inbox updated.'); }
        catch (error) { say('connections-note', error.message); button.disabled = false; }
      });
      el('inboxes').append(row('Taps for ' + (item.name || 'you'), (data.inboxes || []).length > 1 ? button : null));
    }
    for (const item of data.senders || []) el('senders').append(row('Tap ' + (item.name || 'someone')));
    el('inboxes-group').hidden = !el('inboxes').children.length;
    el('senders-group').hidden = !el('senders').children.length;
    el('empty').hidden = Boolean(el('inboxes').children.length || el('senders').children.length);
  };
  const loadPatron = async () => {
    const data = await request('/account/patron/status');
    el('patron-actions').replaceChildren(); el('patron-rows').replaceChildren();
    const memberships = data.memberships || [];
    const add = (label, path, patronId, primary) => { const button = pill(label, async () => { button.disabled = true; say('patron-note', ''); try { const result = await request(path, patronId ? { patronId } : {}); const url = new URL(result.url); if (url.protocol !== 'https:') throw new Error('Billing link is unavailable.'); location.assign(url.href); } catch (error) { say('patron-note', error.message); button.disabled = false; } }); if (primary) button.className = 'primary'; el('patron-actions').append(button); };
    for (const membership of memberships) {
      const patron = membership.status.patron;
      el('patron-rows').append(row(membership.name || 'Patron membership', tag(patron.active ? (patron.status === 'ending' ? 'Ending' : 'Active') : patron.status.replaceAll('_', ' '))));
      if (patron.canManage) add('Manage billing', '/account/patron/manage', membership.id);
      if (data.checkoutEnabled && patron.canSubscribe) add('Become a patron', '/account/patron/checkout', membership.id, true);
    }
    if (data.checkoutEnabled && !memberships.length) add('Become a patron', '/account/patron/checkout', undefined, true);
    say('patron-status', memberships.length ? '' : data.checkoutEnabled ? 'Patrons can send their taps in a theme, to everyone they tap.' : 'Patron memberships open soon.');
    el('patron-status').hidden = !el('patron-status').textContent;
  };
  const showAccount = async () => {
    el('account').hidden = false;
    say('title', 'Your account.'); el('intro').hidden = true;
    await Promise.all([
      loadConnections().catch(() => { say('connections-note', 'Connections could not load. Refresh to try again.'); }),
      loadPatron().catch(() => { say('patron-note', 'Patron status could not load. Refresh to try again.'); }),
    ]);
    if (query.get('section') === 'patron') { el('patron').scrollIntoView({ block: 'start' }); el('patron-title').focus({ preventScroll: true }); }
  };
  const load = async () => {
    const session = await request('/api/auth/get-session');
    const signedIn = Boolean(session && session.user);
    el('signin').hidden = signedIn || Boolean(token); el('confirm').hidden = signedIn || !token;
    el('signedin').hidden = !signedIn;
    if (userCode) {
      if (el('account')) el('account').hidden = true;
      say('title', 'Connect your device.');
      say('intro', signedIn ? '' : 'Sign in, then check the code your app shows.');
    }
    el('intro').hidden = !el('intro').textContent;
    if (!signedIn) return;
    say('who', session.user.email);
    if (userCode) {
      try { await loadDevice(); return; } catch (error) { el('device-card').hidden = true; say('device-note', error.message); }
      // A stale code from an earlier request: fall back to the account.
      userCode = '';
      if (!el('account')) return;
    }
    await showAccount();
  };
  on('signin', 'submit', async event => {
    event.preventDefault(); const button = el('signin').querySelector('button'); button.disabled = true; say('signin-note', '');
    try {
      await request('/api/auth/sign-in/magic-link', { email: el('email').value, callbackURL: '/account' });
      say('sent-to', el('email').value); el('signin').hidden = true; el('sent').hidden = false;
    } catch (error) { say('signin-note', error.message === generic ? 'We couldn’t send your sign-in email. Try again in a moment.' : error.message); } finally { button.disabled = false; }
  });
  on('resend', 'click', () => { el('sent').hidden = true; el('signin').hidden = false; el('email').focus(); });
  action('verify', 'confirm-note', async () => { await request('/account/verify', { token }); token = ''; await load(); });
  action('signout', 'signout-note', async () => { await request('/api/auth/sign-out', {}); location.replace('/account'); });
  on('matches', 'change', () => { el('approve').disabled = !el('matches').checked; });
  action('approve', 'device-note', async () => { if (!el('matches').checked) return; await finishDevice('approve'); });
  action('deny', 'device-note', () => finishDevice('deny'));
  on('device-entry', 'submit', async event => {
    event.preventDefault(); say('entry-note', '');
    userCode = el('entered-code').value.trim();
    try { await loadDevice(); el('account').hidden = true; say('title', 'Connect your device.'); }
    catch (error) { el('device').hidden = true; userCode = ''; say('entry-note', error.message); }
  });
  on('delete-confirm', 'change', () => { el('delete-account').disabled = !el('delete-confirm').checked; });
  action('delete-account', 'delete-note', async () => { if (!el('delete-confirm').checked) return; await request('/api/auth/delete-user', {}); location.replace('/account'); });
  load().catch(() => { say('signin-note', 'Your account could not load. Refresh to try again.'); });
})();`;

const mark = `<svg aria-hidden="true" xmlns="http://www.w3.org/2000/svg" viewBox="-2.5 -8.65 44.65 44.65" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M4 0C23.59 0 30 6.41 30 27.5V28C30 31.07 29.07 32 26 32H4C0.93 32 0 31.07 0 28V4C0 0.93 0.93 0 4 0Z" stroke-width="5"/><path d="M26.8 -3.08L29.19 -9.65" stroke-width="3.75"/><path d="M30.63 -0.63L35.58 -5.58" stroke-width="3.75"/><path d="M33.08 3.2L39.65 0.81" stroke-width="3.75"/></svg>`;

const escape = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;");

const styles = `
:root{color-scheme:light;--paper:#f6f5f1;--ink:#161616;--tone:#6f6e69;--line:#dedcd5;--faint:#ebe9e3;--frame:#161616;--on-frame:#f6f5f1}*{box-sizing:border-box}body{margin:0;background:var(--frame);color:var(--ink);font:500 17px/1.5 system-ui,sans-serif;padding:0 9px 9px;min-height:100svh}
header{color:var(--on-frame);max-width:760px;margin:0 auto;height:64px;display:flex;align-items:center;gap:8px;padding:0 12px;font-size:21px;font-weight:800;letter-spacing:-.035em}header svg{width:1.3em;height:1.3em}
main{background:var(--paper);border-radius:28px;max-width:760px;margin:0 auto;padding:clamp(24px,6vw,56px);min-height:calc(100svh - 73px)}
h1{font-size:clamp(34px,7vw,52px);line-height:1.03;letter-spacing:-.035em;margin:0 0 12px;font-weight:800}h2{font-size:22px;letter-spacing:-.02em;line-height:1.2;margin:0 0 4px;font-weight:800}h3{font-size:14px;color:var(--tone);margin:20px 0 0;font-weight:700}
p{max-width:60ch;margin:8px 0;color:var(--tone)}section{padding:28px 0 4px;border-top:1px solid var(--line);margin-top:28px}
label{display:block;margin:20px 0 8px;font-weight:600}input{width:100%;font:inherit;color:inherit;background:var(--faint);border:0;border-radius:18px;padding:15px 18px;min-height:52px}
.check{display:flex;align-items:center;gap:12px;margin:20px 0;cursor:pointer;min-height:44px}.check input{width:22px;height:22px;min-height:0;margin:0;flex:none;accent-color:var(--ink)}
button,.button{font:700 16px/1.3 system-ui,sans-serif;border:1.5px solid var(--line);background:transparent;color:inherit;border-radius:999px;padding:13px 22px;min-height:48px;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;justify-content:center}button.small{min-height:36px;padding:6px 14px;font-size:15px}
button.primary,.button.primary{background:var(--ink);color:var(--paper);border-color:var(--ink)}button:hover,.button:hover{border-color:var(--ink)}button:disabled{opacity:.45;cursor:not-allowed}
.link{border:0;padding:0;min-height:44px;font-weight:600;text-decoration:underline;text-underline-offset:3px;color:var(--tone)}
button:focus-visible,input:focus-visible,a:focus-visible,h2:focus-visible{outline:3px solid var(--ink);outline-offset:4px}
.actions{display:flex;gap:12px;flex-wrap:wrap;margin-top:20px}.note{color:var(--ink);font-weight:600;margin:12px 0 0}.note:empty{display:none}
.code{font-size:clamp(32px,9vw,44px);font-weight:800;letter-spacing:.12em;font-variant-numeric:tabular-nums;overflow-wrap:anywhere;color:var(--ink);background:var(--faint);border-radius:16px;padding:16px 20px;margin:16px 0 0;max-width:none;text-align:center}
.row{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:12px 0;border-bottom:1px solid var(--line);min-height:56px}.row span:first-child{font-weight:600;overflow-wrap:anywhere}
.tag{font-size:14px;color:var(--tone);font-weight:600;white-space:nowrap;text-transform:capitalize}
summary{list-style:none;cursor:pointer;display:inline-flex}summary::-webkit-details-marker{display:none}.who{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}.who p{margin:0;color:var(--ink);font-weight:600;overflow-wrap:anywhere}
a{color:inherit;text-underline-offset:3px}footer{margin-top:40px;font-size:14px;color:var(--tone)}[hidden]{display:none!important}::selection{background:var(--ink);color:var(--paper)}
@media(prefers-color-scheme:dark){:root{color-scheme:dark;--paper:#18181a;--ink:#f1f0ec;--tone:#9a9994;--line:#34343a;--faint:#232326;--frame:#34343a;--on-frame:#f1f0ec}}`;

/**
 * API-origin portal: credentials stay in HttpOnly cookies, never in web URLs.
 * A device request (`user_code`) gets only the code check, so an app user
 * never scrolls past account settings to approve their own phone.
 */
export const accountPage = (url: URL, webOrigin?: string) => {
  const deviceOnly = url.searchParams.has("user_code");
  const patronReturn = url.searchParams.get("section") === "patron";
  const returnURL = webOrigin
    ? new URL(patronReturn ? "/account?intent=patron" : "/account", webOrigin)
        .href
    : "";
  const returnLink = returnURL
    ? `<div class="actions"><a class="button primary" href="${escape(returnURL)}">Back to Shouldertap</a></div>`
    : "";
  const account = deviceOnly
    ? ""
    : `<div id="account">${returnLink}<section><h2>Connections</h2><p id="empty">Saved inboxes and people you tap appear here.</p><div id="inboxes-group" hidden><h3>Your inboxes</h3><div id="inboxes"></div></div><div id="senders-group" hidden><h3>People you can tap</h3><div id="senders"></div></div><p class="note" id="connections-note" role="alert"></p></section><section id="patron"><h2 id="patron-title" tabindex="-1">Patron</h2><p id="patron-status">Loading…</p><div id="patron-rows"></div><div class="actions" id="patron-actions"></div><p class="note" id="patron-note" role="alert"></p></section><section><details><summary class="button link">Have a code from your app?</summary><form id="device-entry"><label for="entered-code">Code</label><input id="entered-code" autocomplete="off" autocapitalize="characters" maxlength="32" required><div class="actions"><button type="submit">Continue</button></div><p class="note" id="entry-note" role="alert"></p></form></details></section><section><h2>Delete account</h2><p>Deletes your account and its recovery links. Inboxes and connections stay on their devices. Cancel an active membership first. You may need to sign in again.</p><label class="check"><input id="delete-confirm" type="checkbox">Permanently delete my account</label><div class="actions"><button id="delete-account" disabled>Delete account</button></div><p class="note" id="delete-note" role="alert"></p></section></div>`;
  const nonce = crypto.randomUUID().replaceAll("-", "");
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="referrer" content="no-referrer"><title>Your account · Shouldertap</title><style nonce="${nonce}">${styles}</style></head><body><header>${mark}Shouldertap</header><main><h1 id="title">${deviceOnly ? "Connect your device." : "Your account."}</h1><p id="intro">${deviceOnly ? "Sign in, then check the code your app shows." : "Sign in to keep your inboxes, connections and patron membership."}</p>` +
      `<div id="confirm" hidden><h2>Confirm sign in</h2><p>Continue only if you asked for this email.</p><div class="actions"><button id="verify" class="primary">Confirm sign in</button></div><p class="note" id="confirm-note" role="alert"></p></div>` +
      `<form id="signin" hidden><label for="email">Email</label><input id="email" type="email" autocomplete="email" required maxlength="254"><div class="actions"><button class="primary" type="submit">Email me a sign-in link</button></div><p class="note" id="signin-note" role="alert"></p></form>` +
      `<div id="sent" hidden><h2>Check your email</h2><p>We sent a link to <strong id="sent-to"></strong>. It expires in 10 minutes. Open it in this browser.</p><button class="link" id="resend" type="button">Use a different email</button></div>` +
      `<div id="signedin" hidden><div class="who"><p id="who"></p><button class="small" id="signout">Sign out</button></div><p class="note" id="signout-note" role="alert"></p>` +
      `<section id="device" hidden><div id="device-card" hidden><h2 id="device-title">Is this the code on your device?</h2><p>Only connect a device you have with you. Never approve a code someone sent you.</p><p class="code" id="code"></p><label class="check"><input id="matches" type="checkbox">The code matches my device</label><div class="actions"><button id="approve" class="primary" disabled>Connect</button><button id="deny">Deny</button></div></div><div id="device-done" hidden><h2 id="device-result"></h2></div><p class="note" id="device-note" role="alert"></p></section>` +
      `${account}</div><footer>Never share your sign-in link. <a href="mailto:support@shouldertap.app">Contact support</a></footer></main><script nonce="${nonce}">${accountScript}</script></body></html>`,
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
