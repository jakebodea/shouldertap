// Tap bodies shown in the captures, from the landing page's scenes (apps/web/src/components/landing.tsx).
// Each slide shows one, so the set rotates instead of repeating a single message.
export const messages = {
  dinner: "Dinner's ready",
  come: "Can you come here?",
  call: "Call me",
  trash: "Take out the trash",
  // Nina's answer to "Call me" on Priya's phone.
  reply: "In a meeting. Calling at 3.",
};

// Fictional people: each message has its own sender, in a color that stands off its slide's background.
export const recipient = "Nina";
export const senders = {
  dinner: { name: "Maya", color: "moss" },
  come: { name: "Marcus", color: "tomato" },
  call: { name: "Priya", color: "cobalt" },
  trash: { name: "Rosa", color: "plum" },
};
// The sender's own two quick replies; taps without them offer On it and In 10 min.
export const replies = {
  dinner: ["Coming!", "Save me a plate"],
  call: ["Calling now", "After 5"],
};
export const repliesFor = (body) =>
  replies[Object.keys(messages).find((key) => messages[key] === body)];
// The sender for a tap body; the fixture and captures look people up by message.
export const senderFor = (body) =>
  senders[Object.keys(senders).find((key) => messages[key] === body)] ??
  senders.dinner;
