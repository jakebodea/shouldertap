import * as Effect from "effect/Effect";

import { accountResources, withAccountOperation } from "./account-identity";
import type { PatronRpc } from "./SenderPatron";

/** Keep billing recoverable and serialize deletion against checkout/adoption. */
export const deleteAccount = (
  db: D1Database,
  patrons: { getByName: (id: string) => PatronRpc },
  userId: string,
  remove: () => Promise<Response>
) =>
  withAccountOperation(
    db,
    userId,
    "delete",
    Effect.gen(function* removeAccountData() {
      const refs = yield* accountResources(db, userId);
      for (const ref of refs.filter((resource) => resource.kind === "patron")) {
        const state = yield* patrons.getByName(ref.id).accountDeletionStatus();
        if (!state.canDelete) {
          return Response.json(
            {
              error:
                "Manage your patron subscription before deleting this account. If a checkout is still pending, contact support@shouldertap.app so we can resolve it without losing your billing access.",
            },
            { status: 409 }
          );
        }
      }
      return yield* Effect.promise(remove);
    })
  );
