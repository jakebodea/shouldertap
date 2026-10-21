/**
 * Explicit hosted signed-fixture check. This never creates a Creem payment.
 * The billing subject is a sender's patron identity (`patron_id` metadata):
 * its lifecycle decides whether that sender's taps carry a theme, to every
 * inbox they're paired with. A historical receiver subscription (`inbox_id`)
 * is still routed to its inbox and grants no theme.
 */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";

import * as Schema from "effect/Schema";

import {
  CredentialGrant,
  Appearance,
  PatronLinkCode,
  Invite,
  PatronKeyGrant,
  PatronStatus,
  Snapshot,
  Tap,
} from "../packages/domain/src/contracts";
import type { Patron } from "../packages/domain/src/contracts";
import { parseToken } from "../packages/domain/src/token";

const target =
  "https://shouldertap-server-patron-sandbox-plz4iniwxkqzrwox.jakebodea.workers.dev";
const product = "prod_4fniZfXS6ZbXHuZTQRb4M0";
const project = "fcaaebbd-83e7-4945-911f-cedba3ff25a3";
if (!process.argv.includes("--signed-fixtures")) {
  throw new Error(
    "Pass --signed-fixtures: this sends synthetic signed events to the isolated sandbox."
  );
}
const secretOutput =
  await Bun.$`/opt/homebrew/bin/infisical secrets get CREEM_WEBHOOK_SECRET --plain --silent --projectId ${project} --env dev`
    .quiet()
    .text();
const secret = secretOutput.trim();
assert.ok(secret);
const call = async <S extends Schema.ConstraintDecoder<unknown>>(
  path: string,
  schema: S,
  token?: string,
  body?: unknown,
  method?: string
) => {
  const response = await fetch(`${target}/v1${path}`, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    status: response.status,
    data: Schema.decodeUnknownSync(schema)(await response.json()),
  };
};
/** A fresh inbox with one sender pairing. */
const pairedInbox = async (recipientName: string) => {
  const { data: device, status } = await call(
    "/inboxes",
    CredentialGrant,
    undefined,
    { recipientName, deviceName: "Synthetic lifecycle verifier" }
  );
  assert.equal(status, 201);
  const invite = await call("/invites", Invite, device.token, {
    kind: "sender",
  });
  const sender = await call("/invites/redeem", CredentialGrant, undefined, {
    code: invite.data.code,
    name: "Fixture sender",
    color: "moss",
  });
  assert.equal(sender.status, 201);
  return { device, sender: sender.data };
};
// The same person paired with two recipients: one membership covers both.
const firstInbox = await pairedInbox("Signed fixture QA");
const secondInbox = await pairedInbox("Second recipient");
const { device } = firstInbox;
const { data: initial } = await call("/me", Snapshot, device.token);
assert.ok(initial.kind === "device");
assert.equal(initial.plan.status, "paid");
assert.ok(initial.patron);
assert.equal(initial.patron.status, "none");
assert.equal(initial.patron.canSubscribe, false);
const parsed = parseToken(device.token);
assert.ok(parsed);
const { inboxId } = parsed;
const grant = await call(
  "/patrons",
  PatronKeyGrant,
  undefined,
  undefined,
  "POST"
);
assert.equal(grant.status, 201);
const { key, patronId } = grant.data;
// Redirect parameters never authenticate or grant membership.
const returned = await fetch(
  `${target}/v1/patrons/return?status=paid&patron_id=${patronId}&checkout_id=fake`
);
assert.equal(returned.status, 200);
assert.equal(returned.headers.get("cache-control"), "no-store");
const returnPage = await returned.text();
assert.ok(returnPage.includes("Return to Shouldertap"));
assert.ok(!returnPage.includes(patronId));
const afterReturn = await call("/patrons/me", PatronStatus, key);
assert.equal(afterReturn.data.patron.active, false);
const run = crypto.randomUUID();
const subscription = {
  id: `sub_fixture_${run}`,
  product,
  customer: `cust_fixture_${run}`,
  current_period_end_date: "2027-10-21T00:00:00.000Z",
  last_transaction_id: `tran_fixture_first_${run}`,
  metadata: { patron_id: patronId },
};
const first = subscription.last_transaction_id;
const payload = (type: string, sequence: number, object: unknown) => ({
  id: `evt_fixture_${run}_${sequence}`,
  eventType: type,
  created_at: Date.UTC(2026, 9, 21) + sequence * 1000,
  object,
});
const deliver = async (event: unknown, valid = true) => {
  const body = JSON.stringify(event);
  const response = await fetch(`${target}/v1/webhooks/creem`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "creem-signature": valid
        ? createHmac("sha256", secret).update(body).digest("hex")
        : "invalid",
    },
    body,
  });
  assert.equal(response.status, valid ? 200 : 400);
};
const patron = async () => {
  const status = await call("/patrons/me", PatronStatus, key);
  assert.equal(status.status, 200);
  return status.data.patron;
};
let sent = 0;
/** A themed send from the patron sender: delivered either way, styled only
 * while their membership is active. */
const expectTheme = async (
  active: boolean,
  to: { sender: { token: string } } = firstInbox
) => {
  sent += 1;
  const tap = await call("/taps", Tap, to.sender.token, {
    requestId: `fixture-${run}-${sent}`,
    body: `Themed ${sent}`,
    theme: "note",
    patronKey: key,
  });
  assert.equal(tap.status, 201);
  assert.equal(tap.data.state, "pending");
  assert.equal(tap.data.theme, active ? "note" : "default");
  return tap.data;
};
const expectPatron = async (field: keyof Patron, value: unknown) => {
  const current = await patron();
  assert.equal(current[field], value);
};
await deliver(payload("subscription.paid", 1, subscription), false);
await expectPatron("status", "none");
await deliver(
  payload("checkout.completed", 2, {
    id: `ch_fixture_${run}`,
    product: { id: product },
    subscription,
    metadata: subscription.metadata,
  })
);
await expectPatron("status", "none");
const paid = payload("subscription.paid", 3, subscription);
await deliver(paid);
assert.deepEqual(await patron(), {
  active: true,
  status: "active",
  paidUntil: 1_824_076_800_000,
  canManage: true,
  canSubscribe: false,
  legacySupporter: false,
});
const styled = await expectTheme(true);
// The same membership styles taps to a different recipient's inbox.
await expectTheme(true, secondInbox);

// A second patron sends a different style into the SAME free recipient inbox.
const otherGrant = await call(
  "/patrons",
  PatronKeyGrant,
  undefined,
  undefined,
  "POST"
);
const other = otherGrant.data;
const otherSubscription = {
  ...subscription,
  id: `sub_fixture_other_${run}`,
  last_transaction_id: `tran_fixture_other_${run}`,
  metadata: { patron_id: other.patronId },
};
await deliver(payload("subscription.paid", 30, otherSubscription));
const otherInvite = await call("/invites", Invite, device.token, {
  kind: "sender",
});
const otherSenderResult = await call(
  "/invites/redeem",
  CredentialGrant,
  undefined,
  {
    code: otherInvite.data.code,
    name: "Second styled sender",
    color: "plum",
  }
);
const otherSender = otherSenderResult.data;
const secondStyle = await call("/taps", Tap, otherSender.token, {
  requestId: crypto.randomUUID(),
  body: "Independent Broadsheet sender",
  theme: "broadsheet",
  patronKey: other.key,
});
assert.equal(secondStyle.data.theme, "broadsheet");
const receivedResult = await call("/me", Snapshot, device.token);
const received = receivedResult.data;
assert.equal(received.taps.find((t) => t.id === styled.id)?.theme, "note");
assert.equal(
  received.taps.find((t) => t.id === secondStyle.data.id)?.theme,
  "broadsheet"
);
assert.ok(received.kind === "device");
assert.equal(received.patron?.active, false);
const settings = await call(
  "/appearance",
  Appearance,
  device.token,
  { senderThemes: "plain", motion: "reduced" },
  "PUT"
);
assert.deepEqual(settings.data, { senderThemes: "plain", motion: "reduced" });
const plainResult = await call("/me", Snapshot, device.token);
const plain = plainResult.data;
assert.ok(plain.kind === "device");
assert.deepEqual(plain.appearance, {
  senderThemes: "plain",
  motion: "reduced",
});
assert.equal(
  plain.taps.find((t) => t.id === secondStyle.data.id)?.theme,
  "broadsheet"
);
await call(
  "/appearance",
  Appearance,
  device.token,
  { senderThemes: "show", motion: "system" },
  "PUT"
);
// Invalid and revoked keys cannot style a tap, but never block delivery.
const linkedResult = await call(
  "/patrons/me/link-codes",
  PatronLinkCode,
  other.key,
  undefined,
  "POST"
);
const linked = linkedResult.data;
const addedResult = await call("/patrons/link", PatronKeyGrant, undefined, {
  code: linked.code,
});
const added = addedResult.data;
const revoke = await fetch(`${target}/v1/patrons/me/key`, {
  method: "DELETE",
  headers: { authorization: `Bearer ${added.key}` },
});
assert.equal(revoke.status, 200);
await Promise.all(
  ["forged", added.key].map(async (badKey) => {
    const fallback = await call("/taps", Tap, otherSender.token, {
      requestId: crypto.randomUUID(),
      body: "Free fallback",
      theme: "terminal",
      patronKey: badKey,
    });
    assert.equal(fallback.status, 201);
    assert.equal(fallback.data.theme, "default");
  })
);
// A real Worker clock after a synthetic paid boundary: no entitlement.
const lapsedResult = await call(
  "/patrons",
  PatronKeyGrant,
  undefined,
  undefined,
  "POST"
);
const lapsed = lapsedResult.data;
await deliver(
  payload("subscription.paid", 31, {
    ...subscription,
    id: `sub_lapsed_${run}`,
    current_period_end_date: "2026-10-20T00:00:00.000Z",
    metadata: { patron_id: lapsed.patronId },
  })
);
const lapsedTap = await call("/taps", Tap, otherSender.token, {
  requestId: crypto.randomUUID(),
  body: "Lapsed fallback",
  theme: "billboard",
  patronKey: lapsed.key,
});
assert.equal(lapsedTap.status, 201);
assert.equal(lapsedTap.data.theme, "default");
// Credentials stay in an owner-only continuation file, never in evidence/logs.
const stateDir = "/tmp/shouldertap-sender-sandbox-20261021";
await mkdir(stateDir, { recursive: true, mode: 0o700 });
await writeFile(
  `${stateDir}/state.json`,
  JSON.stringify({
    target,
    firstInbox,
    secondInbox,
    other,
    otherSender,
    styled: styled.id,
    secondStyle: secondStyle.data.id,
  }),
  { mode: 0o600 }
);
console.log(
  "SIGNED FIXTURES: two independent styles on a free receiver, immutable taps with free plain/reduced settings, malformed/revoked/lapsed fallback passed"
);

await deliver(paid);
await expectPatron("paidUntil", 1_824_076_800_000);
await deliver(payload("subscription.canceled", 4, subscription));
await expectPatron("status", "ending");
await expectPatron("active", true);
await expectTheme(true);
await deliver(
  payload("refund.created", 5, {
    status: "succeeded",
    subscription,
    transaction: first,
  })
);
await expectPatron("active", false);
await expectTheme(false);
await deliver(paid);
await expectPatron("active", false);
await deliver(payload("subscription.paid", 5.5, subscription));
await expectPatron("canSubscribe", true);
console.log(
  "SIGNED FIXTURES: invalid signature, checkout alone, paid, duplicate, cancellation paid-through, refund, late paid replay passed"
);
// A newer payment survives a refund of the earlier transaction.
const renewal = {
  ...subscription,
  current_period_end_date: "2028-10-21T00:00:00.000Z",
  last_transaction_id: `tran_fixture_renewal_${run}`,
};
await deliver(payload("subscription.paid", 6, renewal));
await expectPatron("status", "active");
await expectPatron("paidUntil", 1_855_699_200_000);
await expectTheme(true);
await deliver(
  payload("refund.created", 7, {
    status: "succeeded",
    subscription: renewal,
    transaction: first,
  })
);
await expectPatron("active", true);
const checkFailure = async (sequence: number, type: string) => {
  await deliver(
    payload(type, sequence, {
      ...renewal,
      current_period_end_date: "2029-10-21T00:00:00.000Z",
    })
  );
  await expectPatron("paidUntil", 1_855_699_200_000);
};
await checkFailure(8, "subscription.past_due");
await checkFailure(9, "subscription.unpaid");
await checkFailure(10, "subscription.expired");
await deliver(payload("subscription.paused", 11, renewal));
await expectPatron("active", false);
await expectTheme(false);
await deliver(payload("subscription.paid", 12, renewal));
await expectPatron("active", true);
await expectTheme(true);
await deliver(payload("subscription.scheduled_cancel", 13, renewal));
await expectPatron("status", "ending");
await deliver(
  payload("refund.created", 14, {
    status: "succeeded",
    subscription: renewal,
    transaction: renewal.last_transaction_id,
  })
);
await expectPatron("active", false);
await expectTheme(false);
// A refund delivered before the first (previously unseen) paid event is sticky.
const delayed = {
  ...subscription,
  id: `sub_fixture_delayed_${run}`,
  last_transaction_id: `tran_fixture_delayed_${run}`,
};
await deliver(
  payload("refund.created", 16, {
    status: "succeeded",
    subscription: delayed,
    transaction: delayed.last_transaction_id,
  })
);
await deliver(payload("subscription.paid", 15, delayed));
await expectPatron("active", false);
// Idempotent retry cannot restyle a tap even after entitlement is gone.
const retried = await call("/taps", Tap, firstInbox.sender.token, {
  requestId: `fixture-${run}-1`,
  body: "Themed 1",
  theme: "terminal",
  patronKey: key,
});
assert.equal(retried.data.id, styled.id);
assert.equal(retried.data.theme, "note");
assert.equal(retried.data.body, "Themed 1");
// A tap sent while active keeps its theme after refunds.
const history = await call("/me", Snapshot, device.token);
assert.equal(history.data.taps.find((t) => t.id === styled.id)?.theme, "note");
// A historical receiver subscription goes to its inbox, manageable there, and
// styles nobody's taps.
const legacy = {
  ...subscription,
  id: `sub_fixture_legacy_${run}`,
  last_transaction_id: `tran_fixture_legacy_${run}`,
  metadata: { inbox_id: inboxId },
};
await deliver(payload("subscription.paid", 17, legacy));
const receiver = await call("/me", Snapshot, device.token);
assert.ok(receiver.data.kind === "device");
assert.equal(receiver.data.patron?.active, true);
assert.equal(receiver.data.patron?.canSubscribe, false);
await expectPatron("active", false);
await expectTheme(false);
const tap = await call("/taps", Tap, firstInbox.sender.token, {
  requestId: crypto.randomUUID(),
  body: "Free after refund",
});
assert.equal(tap.status, 201);
assert.equal(tap.data.state, "pending");
const reply = await call(
  `/taps/${tap.data.id}/acknowledge`,
  Tap,
  device.token,
  {
    response: { kind: "text", text: "Still free" },
  }
);
assert.equal(reply.status, 200);
assert.equal(reply.data.state, "acknowledged");
assert.ok(reply.data.response?.kind === "text");
assert.equal(reply.data.response.text, "Still free");
console.log(
  "SIGNED FIXTURES: renewal, old-refund ordering, failures do not extend, pause, recovery, scheduled cancel, sender themes across two inboxes with lapse fallback for new taps, legacy receiver routing without themes, free send/reply after refund passed"
);
console.log("Synthetic inbox:", inboxId, "patron:", patronId);
