# Download flow

From `apps/web`:

```sh
bunx playwright install webkit
bun run test:e2e
```

The suite builds the production site and checks it in iPhone-sized WebKit. The landing page offers what the visitor's device can install: on a Mac the header and footer download links start `Shouldertap.dmg` before the instructions page, and the instructions page can start that download again; on Windows they start `Shouldertap-Setup.exe`; on a phone they open the web composer (iPhones get the App Store once `IPHONE_APP_LIVE` is on). Opening `/download` directly does not start a download but links the Mac and Windows installers. A mistyped address shows a page that leads back into the site.
