import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";

import {
  connectedPairings,
  requireSenderRestoreRoom,
} from "../src/pairing-auth";
import { migrate, open, withFile } from "./do-sqlite";

describe("connected sender identities", () => {
  it("hides only keyless senders, shows a restored alias as its original person, and honors recipient removal", () =>
    withFile(async (path) => {
      const { sqlite, db } = open(path);
      try {
        migrate(sqlite);
        sqlite.exec(
          "INSERT INTO credentials(id,kind,name,secret_hash,created_at) VALUES('parent','sender','Taylor','unused',1),('other','sender','Sam','unused',2),('receiver','device','Mac','unused',3); UPDATE credentials SET key_revoked_at=5 WHERE id='parent'"
        );
        const ids = () =>
          Effect.runPromise(
            Effect.gen(function* readConnectedIds() {
              return (yield* connectedPairings(yield* db)).map((row) => row.id);
            })
          );
        await expect(ids()).resolves.toStrictEqual(["other", "receiver"]);
        sqlite.exec(
          "INSERT INTO credentials(id,kind,name,secret_hash,created_at,parent_id) VALUES('alias','sender','Phone','unused',4,'parent')"
        );
        await expect(ids()).resolves.toStrictEqual([
          "parent",
          "other",
          "receiver",
        ]);
        sqlite.exec("UPDATE credentials SET key_revoked_at=6 WHERE id='alias'");
        await expect(ids()).resolves.toStrictEqual(["other", "receiver"]);
        sqlite.exec(
          "INSERT INTO credentials(id,kind,name,secret_hash,created_at,parent_id) VALUES('restored','sender','New phone','unused',7,'parent')"
        );
        await expect(ids()).resolves.toStrictEqual([
          "parent",
          "other",
          "receiver",
        ]);
        sqlite.exec("UPDATE credentials SET revoked_at=8 WHERE id='parent'");
        await expect(ids()).resolves.toStrictEqual(["other", "receiver"]);
      } finally {
        sqlite.close();
      }
    }));

  it("counts connected people rather than keys and rechecks capacity before waking a dormant sender", () =>
    withFile(async (path) => {
      const { sqlite, db } = open(path);
      try {
        migrate(sqlite);
        const insert = sqlite.prepare(
          "INSERT INTO credentials(id,kind,name,secret_hash,created_at) VALUES(?,'sender',?,'unused',1)"
        );
        for (let n = 1; n <= 20; n += 1) {
          insert.run(`sender${n}`, `Person ${n}`);
        }
        sqlite.exec(
          "INSERT INTO credentials(id,kind,name,secret_hash,created_at,key_revoked_at) VALUES('dormant','sender','Dormant','unused',2,3); INSERT INTO credentials(id,kind,name,secret_hash,created_at,parent_id) VALUES('extra-key','sender','Phone','unused',3,'sender1')"
        );
        const room = (id: string) =>
          Effect.gen(function* checkRoom() {
            return yield* requireSenderRestoreRoom(yield* db, id, 20);
          });
        const denied = await Effect.runPromise(
          room("dormant").pipe(Effect.flip)
        );
        expect(denied._tag).toBe("Conflict");
        await expect(Effect.runPromise(room("sender1"))).resolves.toBe(
          "sender1"
        );
        const count = await Effect.runPromise(
          Effect.gen(function* countPeople() {
            return (yield* connectedPairings(yield* db)).length;
          })
        );
        expect(count).toBe(20);
        sqlite.exec(
          "UPDATE credentials SET key_revoked_at=4 WHERE id='sender2'"
        );
        await expect(Effect.runPromise(room("dormant"))).resolves.toBe(
          "dormant"
        );
      } finally {
        sqlite.close();
      }
    }));
});
