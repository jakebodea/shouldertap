import type { RuntimeContext } from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";

import { claimTrial } from "./plan";

const TRIAL_ENDS_AT = "trialEndsAt";

/** The TrialLedger's typed RPC surface, called by the Server Worker. */
export interface TrialLedgerRpc {
  /**
   * This Mac's trial end: recorded now if it has none yet, otherwise the one
   * recorded at its first setup. Idempotent after the first call.
   */
  readonly claim: () => Effect.Effect<
    { readonly trialEndsAt: number },
    never,
    RuntimeContext
  >;
}

/**
 * One instance per Mac, addressed by its machine fingerprint (a salted hash
 * of the hardware UUID, never the UUID itself). Remembers only when that
 * Mac's free trial ends, so setting up again doesn't start a new one.
 */
export class TrialLedger extends Cloudflare.DurableObject<
  TrialLedger,
  TrialLedgerRpc
>()("TrialLedgers") {}

export const TrialLedgerLive = TrialLedger.make(
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;

    return Effect.succeed({
      // Durable Objects run one call at a time across storage reads and
      // writes, so two concurrent setups from one Mac can't both start trials.
      claim: () =>
        Effect.gen(function* () {
          const recorded = yield* state.storage.get<number>(TRIAL_ENDS_AT);
          const claim = claimTrial(recorded, Date.now());
          if (claim.isNew) {
            yield* state.storage.put(TRIAL_ENDS_AT, claim.trialEndsAt);
          }
          return { trialEndsAt: claim.trialEndsAt };
        }),
    } satisfies TrialLedgerRpc);
  })
);
