# Download flow

From `apps/web`:

```sh
bunx playwright install webkit
bun run test:e2e
```

The suite builds the production site and checks it in iPhone-sized WebKit. The landing page offers what the visitor's device can install: on a Mac the header and footer download links start `Shouldertap.dmg` before the instructions page, and the instructions page can start that download again; on Windows they start `Shouldertap-Setup.exe`; on an iPhone they link the App Store, and on other phones the web composer. Opening `/download` directly does not start a download but links the Mac and Windows installers and the iPhone app. A mistyped address shows a page that leads back into the site.

## Verification against a real stack

`bun run test:verify` uses `playwright.verify.config.ts` and requires `SHOULDERTAP_WEB_URL`, `SHOULDERTAP_SERVER_URL` and the private `SHOULDERTAP_VERIFY_TOKEN` supplied by the verification runner. It never starts or reuses a development server. Production hosts are rejected.

The default **browser-protocol** suite signs two fresh accounts in through the UI using real emailed OTPs captured at the delivery boundary. It creates and accepts an invite, sends from the composer and checks the live displayed and reply states. Its receiver is explicitly a protocol client; this does not prove native rendering. It also checks rejection of a wrong code and unrelated origin.

For the **native foreground** suite, set `SHOULDERTAP_VERIFY_NATIVE=1` and `SHOULDERTAP_VERIFY_EXCHANGE` to a private JSON file containing `{ "invite": "<link from running native app>" }`. The suite signs in a fresh sender, accepts that invite, and sends `Verification native foreground tap`. It atomically writes `<exchange>.sent.json` with the tap ID, then waits for a real native display receipt. Once observed it writes `<exchange>.displayed.json`; the native runner can now press **On it**. The browser must receive the actual reply. This suite never manufactures native display receipts or replies.

Traces, video and automatic failure screenshots are disabled because they can contain OTPs, bearer credentials and invite fragments. Explicit evidence captures the composer only, after authentication and invite acceptance. Do not publish private mailbox contents, browser profiles or exchange files with the report.

The runner sets `SHOULDERTAP_VERIFY_OUTPUT` to a private Playwright output directory and `SHOULDERTAP_VERIFY_REPORT` to a private JSON report. Error-context files may contain sensitive page state even with traces disabled. Only explicit, sanitized composer PNGs are written to `SHOULDERTAP_VERIFY_ARTIFACTS` for sharing.
