import { describe, expect, test } from "bun:test";
import { Schema } from "effect";

import { SendTapRequest, ServerEvent, Snapshot } from "./contracts";
import { formatToken, parseBearer, parseToken } from "./token";

describe("token", () => {
  test("round-trips", () => {
    const token = {
      inboxId: "inbox1234",
      id: "cred12345",
      secret: "s3cr3t-value_xyz",
    };
    expect(parseToken(formatToken(token))).toEqual(token);
    expect(parseBearer(`Bearer ${formatToken(token)}`)).toEqual(token);
  });

  test("rejects malformed values", () => {
    expect(parseToken("a.b")).toBeNull();
    expect(parseToken("inbox1234.cred12345.bad secret")).toBeNull();
    expect(parseBearer("Basic abc")).toBeNull();
    expect(parseBearer(null)).toBeNull();
  });
});

describe("contracts", () => {
  test("send request trims are enforced", () => {
    const decode = Schema.decodeUnknownExit(SendTapRequest);
    expect(decode({ requestId: "req-12345", body: "Laundry!" })._tag).toBe(
      "Success"
    );
    expect(decode({ requestId: "req-12345", body: "" })._tag).toBe("Failure");
    expect(decode({ requestId: "req-12345", body: " padded " })._tag).toBe(
      "Failure"
    );
  });

  test("decodes snapshot union and events", () => {
    const sender = {
      kind: "sender",
      credentialId: "c",
      senderName: "Sam",
      recipientName: "Jake",
      sequence: 3,
      taps: [],
    };
    expect(Schema.decodeUnknownSync(Snapshot)(sender).kind).toBe("sender");
    expect(
      Schema.decodeUnknownSync(ServerEvent)({ v: 1, type: "revoked" }).type
    ).toBe("revoked");
  });
});
