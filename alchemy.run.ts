import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import { Path } from "effect/Path";

import Server from "./apps/server/src/Server.ts";
import { domains, isProduction, macDownloadUrl, zoneId } from "./domains.ts";

/**
 * Composition root: the API Worker (with its Inbox Durable Object), the
 * Safari sender site, and, in production, the bucket the Mac app downloads
 * from, deployed together as one Stack.
 */
export default Alchemy.Stack(
  "shouldertap",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const server = yield* Server;
    const path = yield* Path;
    const production = isProduction(yield* Alchemy.Stage);

    const web = yield* Cloudflare.Website.Vite("web", {
      rootDir: path.resolve(import.meta.dirname, "apps/web"),
      assets: {
        htmlHandling: "auto-trailing-slash",
        notFoundHandling: "single-page-application",
      },
      env: {
        VITE_SERVER_URL: server.url.as<string>(),
        VITE_MAC_DOWNLOAD_URL: macDownloadUrl,
      },
      domain: production
        ? { name: domains.web, redirects: [`www.${domains.web}`] }
        : undefined,
      dev: { port: 3001 },
    });

    // Mac app builds, uploaded by scripts/release-mac.sh. Only production
    // serves downloads; other stages link to it.
    const releases = production
      ? yield* Cloudflare.R2.Bucket("releases", {
          name: "shouldertap-releases",
          domains: [{ name: domains.downloads, minTLS: "1.2" }],
        })
      : undefined;

    if (production) {
      yield* Cloudflare.Zone.Setting("AlwaysUseHttps", {
        zoneId,
        settingId: "always_use_https",
        value: "on",
      });
      // Respect origin Cache-Control, so a new Shouldertap.dmg reaches
      // browsers within its 5 minute max-age instead of the 4 hour default.
      yield* Cloudflare.Zone.Setting("BrowserCacheTtl", {
        zoneId,
        settingId: "browser_cache_ttl",
        value: 0,
      });
    }

    return {
      server: server.url.as<string>(),
      web: web.url.as<string>(),
      releases: releases?.bucketName,
    };
  })
);
