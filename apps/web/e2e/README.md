# Download flow

From `apps/web`:

```sh
bunx playwright install webkit
bun run test:e2e
```

The suite builds the production site and checks it in iPhone-sized WebKit. The header and footer download links start `Shouldertap.dmg` before the instructions page, the instructions page can start that download again, and opening `/download` directly does not start one.
