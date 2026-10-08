import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";

import {
  CreateInboxRequest,
  SendTapRequest,
  ServerEvent,
  Snapshot,
} from "./contracts";
import { formatToken, parseBearer, parseToken } from "./token";

describe("token", () => {
  it("round-trips", () => {
    const token = {
      inboxId: "inbox1234",
      id: "cred12345",
      secret: "s3cr3t-value_xyz",
    };
    expect(parseToken(formatToken(token))).toStrictEqual(token);
    expect(parseBearer(`Bearer ${formatToken(token)}`)).toStrictEqual(token);
  });

  it("rejects malformed values", () => {
    expect(parseToken("a.b")).toBeNull();
    expect(parseToken("inbox1234.cred12345.bad secret")).toBeNull();
    expect(parseBearer("Basic abc")).toBeNull();
    expect(parseBearer(null)).toBeNull();
  });
});

describe("contracts", () => {
  it("send request trims are enforced", () => {
    const decode = Schema.decodeUnknownExit(SendTapRequest);
    expect(decode({ requestId: "req-12345", body: "Laundry!" })._tag).toBe(
      "Success"
    );
    expect(decode({ requestId: "req-12345", body: "" })._tag).toBe("Failure");
    expect(decode({ requestId: "req-12345", body: " padded " })._tag).toBe(
      "Failure"
    );
  });

  it("create inbox accepts only a 64-char lowercase hex machine", () => {
    const decode = Schema.decodeUnknownExit(CreateInboxRequest);
    const names = { recipientName: "Jake", deviceName: "Studio Mac" };
    expect(decode(names)._tag).toBe("Success");
    expect(decode({ ...names, machine: "a1".repeat(32) })._tag).toBe("Success");
    for (const machine of ["A1".repeat(32), "a1".repeat(31), "zz".repeat(32)]) {
      expect(decode({ ...names, machine })._tag).toBe("Failure");
    }
  });

  it("decodes snapshot union and events", () => {
    const sender = {
      kind: "sender",
      credentialId: "c",
      senderName: "Sam",
      senderColor: "moss",
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
