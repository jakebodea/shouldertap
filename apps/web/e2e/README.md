# Download flow

From `apps/web`:

```sh
bunx playwright install webkit
bun run test:e2e
```

The suite builds the production site and checks it in iPhone-sized WebKit. The landing page offers what the visitor's device can install: on a Mac the header and footer download links start `Shouldertap.dmg` before the instructions page, and the instructions page can start that download again; on Windows they start `Shouldertap-Setup.exe`; on an iPhone they link the App Store, and on other phones the web composer. Opening `/download` directly does not start a download but links the Mac and Windows installers and the iPhone app. A mistyped address shows a page that leads back into the site.
