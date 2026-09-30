import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import { Path } from "effect/Path";

import Server from "./apps/server/src/Server.ts";

/**
 * Composition root: the API Worker (with its Inbox Durable Object) and the
 * Safari sender site, deployed together as one Stack.
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

    const web = yield* Cloudflare.Website.Vite("web", {
      rootDir: path.resolve(import.meta.dirname, "apps/web"),
      assets: {
        htmlHandling: "auto-trailing-slash",
        notFoundHandling: "single-page-application",
      },
      env: {
        VITE_SERVER_URL: server.url.as<string>(),
      },
      dev: { port: 3001 },
    });

    return {
      server: server.url.as<string>(),
      web: web.url.as<string>(),
    };
  })
);
