import type { SenderGrant } from "@shouldertap/client";
import { describe, expect, it } from "vitest";

import { mergeSync } from "./pairing";
import type { Pairing } from "./pairing";

const ana: Pairing = {
  token: "inboxAna1.keyAna01.secretAna",
  credentialId: "senderAna",
  recipientName: "Ana",
  senderName: "Sam",
  color: "moss",
};

const ben: Pairing = {
  token: "inboxBen1.keyBen01.secretBen",
  credentialId: "senderBen",
  recipientName: "Ben",
  senderName: "Sam",
  color: "moss",
};

const keyForCleo: SenderGrant = {
  id: "inboxCleo:senderCleo",
  grant: {
    kind: "sender",
    credentialId: "senderCleo",
    token: "inboxCleo.keyCleo1.secretCleo",
    recipientName: "Cleo",
  },
  name: "Sammy",
  color: "tomato",
};

describe("pairings after a sync", () => {
  it("adds a person this browser couldn't tap yet", () => {
    expect(
      mergeSync([ana], { senders: [keyForCleo], removed: [] })
    ).toStrictEqual([
      ana,
      {
        token: "inboxCleo.keyCleo1.secretCleo",
        credentialId: "senderCleo",
        recipientName: "Cleo",
        senderName: "Sammy",
        color: "tomato",
      },
    ]);
  });

  it("drops connections that are gone", () => {
    expect(
      mergeSync([ana, ben], {
        senders: [],
        removed: ["inboxAna1.keyAna01.secretAna"],
      })
    ).toStrictEqual([ben]);
  });

  it("replaces an older key for the same person", () => {
    const newKeyForAna: SenderGrant = {
      id: "inboxAna1:senderAna2",
      grant: {
        kind: "sender",
        credentialId: "senderAna2",
        token: "inboxAna1.keyAna02.secretAna2",
        recipientName: "Ana",
      },
      name: "Sam",
      color: "cobalt",
    };
    expect(
      mergeSync([ana, ben], { senders: [newKeyForAna], removed: [] }).map(
        (p) => p.token
      )
    ).toStrictEqual([
      "inboxBen1.keyBen01.secretBen",
      "inboxAna1.keyAna02.secretAna2",
    ]);
  });

  it("takes the name, color and theme the account has for each person", () => {
    expect(
      mergeSync([ana, ben], {
        senders: [],
        removed: [],
        connections: [
          {
            id: "inboxAna1:senderAna",
            name: "Dr. Sam",
            color: "sky",
            theme: "terminal",
            chooseSeenAs: false,
          },
          {
            id: "inboxBen1:senderBen",
            name: "Sam",
            color: "moss",
            theme: null,
          },
        ],
      })
    ).toStrictEqual([
      {
        token: "inboxAna1.keyAna01.secretAna",
        credentialId: "senderAna",
        recipientName: "Ana",
        senderName: "Dr. Sam",
        color: "sky",
        theme: "terminal",
      },
      ben,
    ]);
  });

  it("goes back to this browser's style when the account clears a theme", () => {
    const themed: Pairing = { ...ana, theme: "note" };
    expect(
      mergeSync([themed], {
        senders: [],
        removed: [],
        connections: [
          {
            id: "inboxAna1:senderAna",
            name: "Sam",
            color: "moss",
            theme: null,
          },
        ],
      })
    ).toStrictEqual([ana]);
  });
});
