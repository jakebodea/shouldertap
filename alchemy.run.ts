import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as GitHub from "alchemy/GitHub";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Path } from "effect/Path";

import Server from "./apps/server/src/Server.ts";
import Support, { parseForwardTo } from "./apps/server/src/Support.ts";
import { domains, isProduction, macDownloadUrl, zoneId } from "./domains.ts";

/** Set by .github/workflows/deploy.yml for preview deploys. */
const pullRequest = process.env.PULL_REQUEST;

/**
 * Composition root: the API Worker (with its Inbox Durable Object), the
 * Safari sender site, and, in production, the bucket the Mac app downloads
 * from, deployed together as one Stack. In CI, pull requests deploy to a
 * `pr-<number>` stage and get a comment linking the preview.
 */
export default Alchemy.Stack(
  "shouldertap",
  {
    // GitHub is only needed for the preview comment, so local deploys don't
    // need it in their profile.
    providers: pullRequest
      ? Layer.mergeAll(Cloudflare.providers(), GitHub.providers())
      : Cloudflare.providers(),
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
      // support@ forwards to each of these (Gmail, the Slack channel's email
      // address). Cloudflare emails each a verification link on creation;
      // mail isn't delivered to an address until its link is clicked.
      const forwardTo = parseForwardTo(process.env.SUPPORT_FORWARD_TO ?? "");
      if (forwardTo.length === 0) {
        return yield* Effect.die("SUPPORT_FORWARD_TO is required for prod");
      }
      // Indexed ids: public CI logs print logical ids, not props.
      for (const [index, email] of forwardTo.entries()) {
        yield* Cloudflare.Email.Address(`SupportForward${index}`, { email });
      }
      yield* Support;
    }

    // The fixed logical ID makes each push update the same comment.
    if (pullRequest) {
      yield* GitHub.Comment("preview-comment", {
        owner: "jakebodea",
        repository: "shouldertap",
        issueNumber: Number(pullRequest),
        body: Output.interpolate`
          ## Preview deployed

          **Web:** ${web.url}
          **API:** ${server.url}

          Built from ${process.env.COMMIT_SHA?.slice(0, 7)}. Destroyed when this PR closes.
        `,
      });
    }

    return {
      server: server.url.as<string>(),
      web: web.url.as<string>(),
      releases: releases?.bucketName,
    };
  })
);
