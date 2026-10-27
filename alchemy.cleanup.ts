import * as Cloudflare from "@alchemy.run/cloudflare";
import * as GitHub from "@alchemy.run/github";
/**
 * Teardown uses the deployed stack's state without importing application code,
 * running builds, or loading app secrets. Only pr-<number> stages are accepted.
 */
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { previewNumber } from "./scripts/cloudflare/previews.ts";

const previewState = Layer.unwrap(
  Alchemy.Stage.pipe(
    Effect.flatMap((stage) =>
      previewNumber(stage) === undefined
        ? Effect.die(new Error(`Cleanup only accepts pr-<number>: ${stage}`))
        : Effect.succeed(Cloudflare.state())
    )
  )
);

export default Alchemy.Stack(
  "shouldertap",
  {
    providers: Layer.mergeAll(Cloudflare.providers(), GitHub.providers()),
    state: previewState,
  },
  Effect.succeed({})
);
