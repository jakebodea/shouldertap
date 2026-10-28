import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";

import {
  authenticatePairing,
  authorizePairingRevocation,
  eraseSender,
} from "../src/pairing-auth";
import { hashSecret } from "../src/secrets";
import { open, migrate, withFile } from "./do-sqlite";

describe("restored sender device keys", () => {
  // oxlint-disable vitest/max-expects -- One lifecycle checks original, individual-key and logical-parent revocation independently.
  it("keeps existing keys valid and honors individual and parent revocation", () =>
    withFile(async (path) => {
      const { sqlite, db } = open(path);
      try {
        migrate(sqlite);
        const originalHash = await Effect.runPromise(
          hashSecret("original-secret")
        );
        const restoredHash = await Effect.runPromise(
          hashSecret("restored-secret")
        );
        sqlite
          .prepare(
            "INSERT INTO credentials(id,kind,name,secret_hash,created_at) VALUES('parent','sender','Taylor',?,1)"
          )
          .run(originalHash);
        sqlite
          .prepare(
            "INSERT INTO credentials(id,kind,name,secret_hash,created_at,parent_id) VALUES('child','sender','Phone',?,2,'parent')"
          )
          .run(restoredHash);
        const run = (id: string, secret: string) =>
          Effect.runPromise(
            Effect.gen(function* authenticateTestKey() {
              return yield* authenticatePairing(
                yield* db,
                { id, secret, inboxId: "inbox" },
                1000
              );
            })
          );
        const original = await run("parent", "original-secret");
        expect(original.name).toBe("Taylor");
        const restored = await run("child", "restored-secret");
        expect(restored.id).toBe("parent");
        sqlite.exec("UPDATE credentials SET revoked_at=5 WHERE id='child'");
        await expect(run("child", "restored-secret")).rejects.toThrow(
          "This pairing is no longer valid"
        );
        const surviving = await run("parent", "original-secret");
        expect(surviving.id).toBe("parent");
        sqlite.exec(
          "UPDATE credentials SET revoked_at=NULL WHERE id='child'; UPDATE credentials SET key_revoked_at=6 WHERE id='parent'"
        );
        await expect(run("parent", "original-secret")).rejects.toThrow(
          "This pairing is no longer valid"
        );
        const aliasAfterOriginalUnlink = await run("child", "restored-secret");
        expect(aliasAfterOriginalUnlink.id).toBe("parent");
        sqlite.exec("UPDATE credentials SET revoked_at=7 WHERE id='parent'");
        await expect(run("child", "restored-secret")).rejects.toThrow(
          "This pairing is no longer valid"
        );
      } finally {
        sqlite.close();
      }
    }));

  // oxlint-enable vitest/max-expects
  it("a restored sender can unpair only its own key while the recipient can remove the full pairing", async () => {
    await expect(
      Effect.runPromise(
        authorizePairingRevocation("sender", "child-key", "child-key")
      )
    ).resolves.toBe("child-key");
    const parentDenied = await Effect.runPromise(
      authorizePairingRevocation(
        "sender",
        "child-key",
        "canonical-sender"
      ).pipe(Effect.flip)
    );
    expect(parentDenied._tag).toBe("Unauthorized");
    await expect(
      Effect.runPromise(
        authorizePairingRevocation(
          "sender",
          "canonical-sender",
          "canonical-sender"
        )
      )
    ).resolves.toBe("canonical-sender");
    await expect(
      Effect.runPromise(
        authorizePairingRevocation(
          "device",
          "recipient-device",
          "canonical-sender"
        )
      )
    ).resolves.toBe("canonical-sender");
  });
});

describe("deleting a sender with their messages", () => {
  it("removes the person, every device key and what they left, and nobody else's", () =>
    withFile(async (path) => {
      const { sqlite, db } = open(path);
      try {
        migrate(sqlite);
        sqlite.exec(`
          INSERT INTO credentials(id,kind,name,secret_hash,created_at,parent_id) VALUES
            ('sam','sender','Sam','x',1,NULL),
            ('sam-mac','sender','Mac','x',2,'sam'),
            ('jo','sender','Jo','x',3,NULL),
            ('ari-mac','device','Mac','x',4,NULL);
          INSERT INTO taps(id,request_id,sender_id,body,created_at,state,sequence) VALUES
            ('t1','r1','sam','Lunch?',1,'pending',1),
            ('t2','r2','sam','Now?',2,'acknowledged',2),
            ('t3','r1','jo','Hi',3,'pending',3);
          INSERT INTO tickets(id,secret_hash,credential_id,expires_at) VALUES
            ('k1','x','sam-mac',9),('k2','x','jo',9);
          INSERT INTO push_registrations(credential_id,environment,topic,live_activities,updated_at) VALUES
            ('sam-mac','production','app',0,1),('ari-mac','production','app',1,1);
        `);
        const erase = (id: string) =>
          Effect.runPromise(
            Effect.gen(function* eraseForTest() {
              yield* eraseSender(yield* db, id);
            })
          );
        const left = () => ({
          credentials: sqlite
            .prepare("SELECT id FROM credentials ORDER BY id")
            .all()
            .map((row) => row.id),
          taps: sqlite
            .prepare("SELECT body FROM taps ORDER BY id")
            .all()
            .map((row) => row.body),
          tickets: sqlite
            .prepare("SELECT id FROM tickets ORDER BY id")
            .all()
            .map((row) => row.id),
          push: sqlite
            .prepare("SELECT credential_id FROM push_registrations ORDER BY 1")
            .all()
            .map((row) => row.credential_id),
        });
        const everyone = left();

        await erase("ari-mac");
        await erase("sam-mac");
        const unchanged = left();
        await erase("sam");
        const afterSam = left();
        await erase("sam");

        expect(unchanged).toStrictEqual(everyone);
        expect(afterSam).toStrictEqual({
          credentials: ["ari-mac", "jo"],
          taps: ["Hi"],
          tickets: ["k2"],
          push: ["ari-mac"],
        });
        expect(left()).toStrictEqual(afterSam);
      } finally {
        sqlite.close();
      }
    }));
});
