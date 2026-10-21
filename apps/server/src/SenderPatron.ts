import {
  Conflict,
  Expired,
  formatPatronKey,
  NotFound,
  Unauthorized,
} from "@shouldertap/domain";
import type {
  ParsedPatronKey,
  PatronKeyGrant,
  PatronLinkCode,
  PatronStatus,
} from "@shouldertap/domain";
import type { RuntimeContext } from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Drizzle from "alchemy/Drizzle/Cloudflare";
import { count, eq, isNull } from "drizzle-orm";
import * as Effect from "effect/Effect";

import migrations from "../drizzle-patron/migrations.js";
import type { PatronEvent } from "./patron";
import {
  authenticateKey,
  accountDeletionState,
  initializeAccountIdentity,
  createIdentity,
  createLinkCode,
  isActiveKey,
  redeemLinkCode,
  revokeKey,
  statusOf,
} from "./patron-identity";
import {
  patron,
  patronKeys,
  patronCheckout,
  patronEvents,
} from "./patron-schema";
import { reserveCheckout, storePatronEvent } from "./patron-storage";
import { hashSecret, randomId } from "./secrets";

type Rpc<A, E = never> = Effect.Effect<A, E, RuntimeContext>;

/** The SenderPatron's typed RPC surface, called by the Server Worker. */
export interface PatronRpc {
  readonly initializeAccount: (patronId: string) => Rpc<void, Conflict>;
  readonly accountDeletionStatus: () => Rpc<{
    canDelete: boolean;
    checkout: { requestId: string; providerId: string | null } | null;
  }>;
  readonly accountStatus: () => Rpc<PatronStatus>;
  readonly accountCustomer: () => Rpc<string, Conflict>;
  readonly accountReserveCheckout: () => Rpc<
    { requestId: string; url: string | null; providerId: string | null },
    Conflict
  >;
  readonly accountRestore: (
    patronId: string
  ) => Rpc<PatronKeyGrant, Unauthorized | Conflict>;
  /** Creates this identity with its first key. Conflict if it exists. */
  readonly initialize: (patronId: string) => Rpc<PatronKeyGrant, Conflict>;
  readonly status: (key: ParsedPatronKey) => Rpc<PatronStatus, Unauthorized>;
  /** Whether this key belongs to an active patron right now: the only check
   * behind storing a tap in a theme other than Default. */
  readonly isActive: (key: ParsedPatronKey) => Rpc<boolean, Unauthorized>;
  readonly reserveCheckout: (
    key: ParsedPatronKey
  ) => Rpc<
    { requestId: string; url: string | null; providerId: string | null },
    Unauthorized | Conflict
  >;
  readonly finishCheckout: (
    requestId: string,
    providerId: string,
    url: string
  ) => Rpc<void>;
  readonly releaseExpiredCheckout: (requestId: string) => Rpc<void>;
  /** The provider customer to open the billing portal for. */
  readonly customer: (
    key: ParsedPatronKey
  ) => Rpc<string, Unauthorized | Conflict>;
  readonly recordEvent: (event: PatronEvent) => Rpc<{ applied: boolean }>;
  readonly createLinkCode: (
    key: ParsedPatronKey
  ) => Rpc<PatronLinkCode, Unauthorized | Conflict>;
  readonly redeemLinkCode: (
    code: ParsedPatronKey
  ) => Rpc<PatronKeyGrant, NotFound | Expired | Conflict>;
  readonly forgetKey: (
    key: ParsedPatronKey
  ) => Rpc<{ forgotten: true }, Unauthorized>;
}

/**
 * One instance per sender patron identity, addressed by its random patron id.
 * The billing subject for sender themes: Creem checkouts carry its id as
 * `patron_id` metadata, and its signed facts decide whether the sender's taps
 * may carry a theme, to everyone they tap. It knows nothing about inboxes,
 * pairings or recipients.
 */
export class SenderPatron extends Cloudflare.DurableObject<
  SenderPatron,
  PatronRpc
>()("SenderPatrons", { errors: [Unauthorized, NotFound, Conflict, Expired] }) {}

const now = Effect.sync(() => Date.now());

/** Storage failures are defects: the Worker answers 500 and clients retry. */
const orDie = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.catchIf(
      (
        error
      ): error is Extract<
        E,
        { _tag: "EffectDrizzleQueryError" | "SqlError" }
      > =>
        typeof error === "object" &&
        error !== null &&
        "_tag" in error &&
        (error._tag === "EffectDrizzleQueryError" || error._tag === "SqlError"),
      (defect) => Effect.die(defect)
    )
  ) as Effect.Effect<
    A,
    Exclude<E, { _tag: "EffectDrizzleQueryError" | "SqlError" }>,
    R
  >;

export const SenderPatronLive = SenderPatron.make(
  Effect.succeed(
    Effect.gen(function* patronMethods() {
      const db = yield* Drizzle.DurableObject({ migrations });

      const authenticate = Effect.fn("SenderPatron.authenticate")(
        function* auth(key: ParsedPatronKey) {
          return yield* authenticateKey(
            db,
            key.keyId,
            yield* hashSecret(key.secret),
            yield* now
          );
        }
      );

      const newKey = Effect.gen(function* newKey() {
        const id = yield* randomId();
        const secret = yield* randomId(32);
        return { id, secret, secretHash: yield* hashSecret(secret) };
      });

      return {
        initializeAccount: Effect.fn("SenderPatron.initializeAccount")(
          function* initializeAccount(patronId) {
            yield* initializeAccountIdentity(db, patronId, yield* now);
          },
          orDie
        ),
        accountDeletionStatus: Effect.fn("SenderPatron.accountDeletionStatus")(
          function* accountDeletionStatus() {
            return yield* accountDeletionState(db, yield* now);
          },
          orDie
        ),
        accountStatus: Effect.fn("SenderPatron.accountStatus")(
          function* accountStatus() {
            return yield* statusOf(db, yield* now);
          },
          orDie
        ),
        accountReserveCheckout: Effect.fn(
          "SenderPatron.accountReserveCheckout"
        )(function* accountReserveCheckout() {
          return yield* reserveCheckout(db, yield* randomId(), yield* now);
        }, orDie),
        accountCustomer: Effect.fn("SenderPatron.accountCustomer")(
          function* accountCustomer() {
            const [latest] = (yield* db.select().from(patronEvents))
              .map((r) => r.event)
              .toSorted((a, b) => b.at - a.at);
            if (!latest?.customerId) {
              return yield* new Conflict({
                message: "No patron membership to manage yet.",
              });
            }
            return latest.customerId;
          },
          orDie
        ),
        accountRestore: Effect.fn("SenderPatron.accountRestore")(
          function* accountRestore(patronId) {
            const key = yield* newKey;
            yield* db.transaction((tx) =>
              Effect.gen(function* restoreInTransaction() {
                const [identity] = yield* tx.select().from(patron);
                if (!identity || identity.patronId !== patronId) {
                  return yield* new Unauthorized({
                    message: "Membership unavailable",
                  });
                }
                const [keys] = yield* tx
                  .select({ n: count() })
                  .from(patronKeys)
                  .where(isNull(patronKeys.revokedAt));
                if ((keys?.n ?? 0) >= 10) {
                  return yield* new Conflict({
                    message:
                      "Forget a membership device before restoring another",
                  });
                }
                yield* tx.insert(patronKeys).values({
                  id: key.id,
                  secretHash: key.secretHash,
                  createdAt: yield* now,
                });
              })
            );
            return {
              patronId,
              keyId: key.id,
              key: formatPatronKey({
                patronId,
                keyId: key.id,
                secret: key.secret,
              }),
            };
          },
          orDie
        ),
        initialize: Effect.fn("SenderPatron.initialize")(function* initialize(
          patronId
        ) {
          const key = yield* newKey;
          yield* createIdentity(db, patronId, key, yield* now);
          return {
            patronId,
            keyId: key.id,
            key: formatPatronKey({
              patronId,
              keyId: key.id,
              secret: key.secret,
            }),
          };
        }, orDie),

        status: Effect.fn("SenderPatron.status")(function* status(key) {
          yield* authenticate(key);
          return yield* statusOf(db, yield* now);
        }, orDie),

        isActive: Effect.fn("SenderPatron.isActive")(function* isActive(key) {
          return yield* isActiveKey(db, key, yield* now);
        }, orDie),

        reserveCheckout: Effect.fn("SenderPatron.reserveCheckout")(
          function* reserve(key) {
            yield* authenticate(key);
            return yield* reserveCheckout(db, yield* randomId(), yield* now);
          },
          orDie
        ),

        finishCheckout: Effect.fn("SenderPatron.finishCheckout")(
          function* finish(requestId, providerId, url) {
            yield* db
              .update(patronCheckout)
              .set({ url, providerId })
              .where(eq(patronCheckout.requestId, requestId));
          },
          orDie
        ),

        releaseExpiredCheckout: Effect.fn(
          "SenderPatron.releaseExpiredCheckout"
        )(function* release(requestId) {
          yield* db
            .delete(patronCheckout)
            .where(eq(patronCheckout.requestId, requestId));
        }, orDie),

        customer: Effect.fn("SenderPatron.customer")(function* customer(key) {
          yield* authenticate(key);
          const [latest] = (yield* db.select().from(patronEvents))
            .map((r) => r.event)
            .toSorted((a, b) => b.at - a.at);
          if (!latest?.customerId) {
            return yield* new Conflict({
              message: "No patron membership to manage yet.",
            });
          }
          return latest.customerId;
        }, orDie),

        recordEvent: Effect.fn("SenderPatron.recordEvent")(
          function* recordEvent(event) {
            return { applied: yield* storePatronEvent(db, event) };
          },
          orDie
        ),

        createLinkCode: Effect.fn("SenderPatron.createLinkCode")(function* link(
          key
        ) {
          const actor = yield* authenticate(key);
          const code = yield* newKey;
          const { expiresAt } = yield* createLinkCode(
            db,
            actor.id,
            code,
            yield* now
          );
          return {
            code: formatPatronKey({
              patronId: key.patronId,
              keyId: code.id,
              secret: code.secret,
            }),
            expiresAt,
          };
        }, orDie),

        redeemLinkCode: Effect.fn("SenderPatron.redeemLinkCode")(
          function* redeem(code) {
            const key = yield* newKey;
            const { patronId } = yield* redeemLinkCode(
              db,
              code.keyId,
              yield* hashSecret(code.secret),
              key,
              yield* now
            );
            return {
              patronId,
              keyId: key.id,
              key: formatPatronKey({
                patronId,
                keyId: key.id,
                secret: key.secret,
              }),
            };
          },
          orDie
        ),

        forgetKey: Effect.fn("SenderPatron.forgetKey")(function* forget(key) {
          const actor = yield* authenticate(key);
          yield* revokeKey(db, actor.id, yield* now);
          return { forgotten: true as const };
        }, orDie),
      } satisfies PatronRpc;
    })
  )
);
