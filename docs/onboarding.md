# Account-first onboarding

Every client (iPhone, Mac, Windows, browser) runs the same flow and calls the same endpoints. The account is the person; signing in on a device links it. See [email accounts](accounts.md) for the security model underneath.

## The flow

1. **Welcome** — one promise, a live tap preview, "Get started". A quiet "I have an account" goes to the same sign-in, which also offers a QR code (see [Sign in with a QR code](#sign-in-with-a-qr-code)).
2. **Email** — "What's your email?" → "Send code".
3. **Code** — six digits, typed or autofilled (iOS: `.oneTimeCode`, which offers codes from Mail). Six digits submit on their own. "Resend" and "Change email".
4. **You** — only when `me.profile` is null: name and color, asked once. Prefilled from `me.suggestedName` (an inbox name an existing user already had).
5. **Notifications** — only on platforms that receive (iPhone). Mac asks for Accessibility as it does today; Windows asks nothing.
6. **Home** — "Add your people": "Invite someone" (share link + QR) and "Got a link? Paste or scan".

An invite link opened before sign-in shows "{name} invited you to Shouldertap" with a tap preview in their color and "Accept", runs steps 2–5, then accepts and lands on "You and {name} are connected".

Gone everywhere: typed device-authorization codes, "Create my inbox", "Link a device" / pairing-code QR, "Restore with email", "Save this device to my account", picking an inbox. Invite QR codes stay, and sign-in QR codes replace device linking.

## Sign in with a QR code

Once one device is signed in, the next one needn't wait for an email. Either way the new device gets its own session; signing out of one leaves the other signed in. After either flow the new device continues at step 4 (skipped when the profile exists), then syncs.

- **Computer → phone.** A signed-in Mac, PC or browser shows "Sign in on your phone": a QR code of `https://shouldertap.app/qr#<token>`, made on demand, single use, expiring after 2 minutes. The iPhone's sign-in step has "Scan from your computer"; scanning redeems the token. The computer polls status every 2 seconds and, once used, says "Signed in on your iPhone". The iPhone app also opens `shouldertap://qr#<token>`; a phone camera that opens the web link signs that browser in or hands off to the app.
- **Phone → computer.** A signed-out Mac, PC or browser shows "Sign in with your phone": it starts device authorization and shows `verification_uri_complete` (`https://shouldertap.app/account/device?user_code=…`) as a QR code with the code under it, then polls. A signed-in iPhone scans it (Account → "Sign in on a computer", or any in-app scanner) and asks "Sign in on your {Mac|PC|browser}?" with the code shown, then approves. A phone camera opens the website's `/account/device`, which asks the same and approves with the browser session.

Never sign in from a code someone sent you: the confirmation names the kind of device and shows the code so a person can check it matches the screen in front of them.

A browser never receives taps; it signs in, accepts invites and taps your people.

## Protocol

Account endpoints live on the API origin. Native clients send `Authorization: Bearer <session token>`; the browser sends cookies (`credentials: "include"`). Errors are `{ "error": string }` with 400/401/403/409/429.

### Sign in

```
POST /api/auth/email-otp/send-verification-otp   { "email": string, "type": "sign-in" }  → 200 { "success": true }
POST /api/auth/sign-in/email-otp                 { "email": string, "otp": "123456" }     → 200 { "token": string, "user": { "email": string, ... } }
```

- The code is 6 digits, valid 10 minutes, 3 wrong tries, hashed at rest. A new request rotates it.
- Native: store `token` in the platform vault as the account session and send it as the bearer. The browser gets an HttpOnly session cookie from the same response.
- `POST /api/auth/sign-out` signs out; local credentials stay.
- A wrong or expired code answers 400; show "That code didn't work. Check it or send a new one."

### QR sign-in: computer → phone

```
POST /api/auth/qr-sign-in/create   {}                                  (session) → { "token": string, "url": string, "expiresAt": number }
POST /api/auth/qr-sign-in/status   { "token": string }                 (session) → { "status": "pending" | "used" | "expired", "platform": Platform | null }
POST /api/auth/qr-sign-in/redeem   { "token": string, "platform": Platform }      → { "token": string, "user": { "email": string } }
```

- Show `url` as the QR code; scanners take the fragment after `/qr#` (or `shouldertap://qr#`). Redeem answers like the email-code sign-in, and sets the browser's cookie.
- An expired or used token answers 400 "That code expired. Show a new one and scan again." Status shows `used` only to the account that made the code.

### QR sign-in: phone → computer

Better Auth device authorization, `client_id` one of `shouldertap-mac`, `shouldertap-windows`, `shouldertap-web` (and `shouldertap-ios`):

```
POST /api/auth/device/code      { "client_id": string }                                        → { device_code, user_code, verification_uri_complete, interval, expires_in }
POST /api/auth/device/token     { client_id, device_code, "grant_type": "urn:ietf:params:oauth:grant-type:device_code" } → { access_token } | { error }
GET  /api/auth/device?user_code=<code>   (phone session) → { user_code, client_id, status }
POST /api/auth/device/approve   { "userCode": string }  (phone session)
POST /api/auth/device/deny      { "userCode": string }  (phone session)
```

- The computer polls `device/token` every `interval` seconds: `authorization_pending` keeps waiting, `slow_down` adds 5 seconds, `expired_token` makes a new code, `access_denied` says so. `access_token` is the session token, kept in the vault like an emailed-code sign-in's. The browser, which keeps sessions only in its HttpOnly cookie, trades it once: `qr-sign-in/create` with the bearer, `qr-sign-in/redeem` with cookies, then `sign-out` with the bearer.
- Codes last 10 minutes. The phone reads `user_code` from the scanned URL, shows the confirmation for `client_id`, then approves.

### Who am I

```
GET /account/me → Me
Me = {
  "email": string,
  "profile": { "name": string, "color": PersonColor } | null,   // null → show the You step
  "suggestedName": string | null,
  "inboxId": string | null                                      // the person's inbox, once the profile exists
}
```

### Set name and color

```
POST /account/profile { "name": string (1–40), "color": PersonColor } → Me
```

Creates the person's inbox the first time (no device credential; sync issues those). Later calls update the name and color used for new connections.

### Sync this device

Call after sign-in, after the profile step, on launch, on foreground, and whenever the inbox socket sends `credentials`.

```
POST /account/sync {
  "platform": "iphone" | "mac" | "windows" | "web",
  "deviceName": string (1–80),
  "receive": boolean,          // false for the browser
  "tokens": string[]           // every inbox and sender token this device holds (≤ 50)
}
→ {
  "me": Me,
  "inbox": CredentialGrant | null,   // a new device credential for your inbox, only when receive is true and none of `tokens` is one
  "senders": [{                      // a new sender key for each of your people this device has no token for
    "id": string,                    // `${inboxId}:${credentialId}`
    "grant": CredentialGrant,        // kind "sender"; credentialId is the person-level id, token is this device's own key
    "name": string,                  // your name as they see it
    "color": PersonColor
  }],
  "removed": string[]                // tokens from `tokens` whose connection is gone; drop them
}
```

Tokens the device holds that aren't on the account yet are saved to it (existing users keep everything). A token that belongs to another account is left alone and not returned in `removed`. Requires a profile (409 otherwise).

### Invites

Creating an invite is unchanged: `POST /v1/invites { "kind": "sender" }` with the device's inbox token → `{ code, expiresAt }`, shared as `https://shouldertap.app/join#<code>` and as a QR code. The browser, which has no inbox token, uses:

```
POST /account/invite → Invite
```

Look up an invite before accepting (no auth):

```
GET /v1/invites/preview?code=<code> → { "name": string, "color": PersonColor | null, "expiresAt": number }
```

Accept (account session; requires a profile):

```
POST /account/accept { "code": string, "platform": ..., "deviceName": string }
→ {
  "person": { "name": string, "color": PersonColor | null },
  "sender": { id, grant, name, color } | null,  // you → them; null if you were already connected
  "mutual": boolean                             // they can tap you too (false only for inviters without an account)
}
```

The server adds both directions: a sender credential for you in their inbox, and one for them in yours, each with that person's profile name and color. Their devices get a `credentials` socket event and pick up their new key with `/account/sync`. Your own invite answers 400 "That's your own invite".

### Remove someone you tap

```
POST /account/remove { "id": string }   // the sender id from sync/accept: `${inboxId}:${credentialId}`
→ { "removed": true }
```

Ends that connection for every device on the account (sync stops issuing it); then drop the local token. It doesn't stop them tapping you; they remove you from their side. Don't use `/v1/pairings/{id}` revoke for this: it only unlinks one device's key, and the next sync would issue a new one.

### Older clients

`/v1/invites/redeem`, `/v1/inboxes` and device invites (`kind: "device"`) keep working for builds already installed. New clients don't call them.
