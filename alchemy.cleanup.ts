/**
 * Teardown uses the deployed stack's state without importing application code,
 * running builds, or loading app secrets. Only PR previews and runner-owned verification stages are accepted.
 */
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as GitHub from "alchemy/GitHub";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { previewNumber } from "./scripts/cloudflare/previews.ts";
import { assertVerificationStage } from "./scripts/verification/environment.ts";

const previewState = Layer.unwrap(
  Alchemy.Stage.pipe(
    Effect.flatMap((stage) =>
      Effect.sync(() => {
        if (previewNumber(stage) === undefined) {
          assertVerificationStage(stage);
        }
        return Cloudflare.state();
      })
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
