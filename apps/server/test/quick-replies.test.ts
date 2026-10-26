import { eq } from "drizzle-orm";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";

import { DEFAULT_THEME } from "../src/presentation";
import { taps } from "../src/schema";
import { readTaps, storeTap } from "../src/tap-storage";
import { migrate, open, withFile } from "./do-sqlite";

const NOW = Date.UTC(2026, 9, 26);

const run = <A, E>(effect: Effect.Effect<A, E, never>) =>
  Effect.runPromise(Effect.scoped(effect));

describe("a sender's own quick replies", () => {
  it("are kept with the tap they were sent on; a tap without them offers the presets", () =>
    withFile(async (path) => {
      const handle = open(path);
      migrate(handle.sqlite);
      handle.sqlite
        .prepare(
          "INSERT INTO inbox (id, inbox_id, recipient_name) VALUES (1, 'jake', 'Jake')"
        )
        .run();
      handle.sqlite
        .prepare(
          "INSERT INTO credentials (id, kind, name, color, secret_hash, created_at) VALUES ('maya', 'sender', 'Maya', 'tomato', 'x', 0)"
        )
        .run();
      try {
        const [custom, plain] = await run(
          Effect.gen(function* sendBoth() {
            const db = yield* handle.db;
            for (const [requestId, replies] of [
              ["req-custom", ["Coming!", "Can't now"]],
              ["req-plain", undefined],
            ] as const) {
              yield* storeTap(db, {
                senderId: "maya",
                message: {
                  requestId,
                  body: "Dinner's ready",
                  ...(replies ? { replies: [...replies] } : {}),
                },
                theme: DEFAULT_THEME,
                id: requestId,
                at: NOW,
              });
            }
            const read = (requestId: string) =>
              readTaps(db, eq(taps.requestId, requestId), 1).pipe(
                Effect.map(([tap]) => tap)
              );
            return [yield* read("req-custom"), yield* read("req-plain")];
          })
        );
        expect(custom?.replies).toStrictEqual(["Coming!", "Can't now"]);
        expect(plain?.body).toBe("Dinner's ready");
        expect(Object.keys(plain ?? {})).not.toContain("replies");
      } finally {
        handle.sqlite.close();
      }
    }));
});
