import assert from "node:assert/strict";

import { ApiClient } from "../../packages/client/src/api.ts";
import { assertDeployment } from "./environment.ts";

const server = process.env.STACK_URL;
const revision = process.env.EXPECTED_REVISION;
if (!server || !revision) {
  throw new Error("STACK_URL and EXPECTED_REVISION are required");
}
const host = new URL(server).hostname;
if (
  !(host.endsWith(".workers.dev") || ["localhost", "127.0.0.1"].includes(host))
) {
  throw new Error("Preview smoke refuses production endpoints");
}
const response = await fetch(`${server}/version`);
assert.equal(response.status, 200);
const version = await response.json();
assertDeployment(version, revision);
const anonymous = new ApiClient({ baseUrl: server });
const grant = await anonymous.createInbox({
  recipientName: "Preview recipient",
  deviceName: "Preview smoke",
});
const receiver = new ApiClient({ baseUrl: server, token: grant.token });
const invite = await receiver.createInvite("sender");
const pairing = await anonymous.redeemInvite({
  code: invite.code,
  name: "Preview sender",
  color: "moss",
});
const sender = new ApiClient({ baseUrl: server, token: pairing.token });
const tap = await sender.sendTap({
  requestId: crypto.randomUUID(),
  body: "Preview protocol smoke",
});
assert.equal(tap.body, "Preview protocol smoke");
assert.equal(tap.state, "pending");
const displayed = await receiver.markDisplayed(tap.id);
assert.ok(displayed.displayedAt);
const reply = await receiver.acknowledge(tap.id, {
  response: { kind: "text", text: "Preview reply" },
});
assert.deepEqual(reply.response, { kind: "text", text: "Preview reply" });
const snapshot = await sender.me();
const observed = snapshot.taps.find((item) => item.id === tap.id);
assert.deepEqual(observed?.response, { kind: "text", text: "Preview reply" });
process.stdout.write(
  "PASS preview revision and protocol send/display/reply smoke (one inbox)\n"
);
