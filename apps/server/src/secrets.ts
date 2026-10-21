import * as Effect from "effect/Effect";

/** URL-safe random id: credential and key ids, secrets, request ids. */
export const randomId = (bytes = 12) =>
  Effect.sync(() =>
    btoa(String.fromCodePoint(...crypto.getRandomValues(new Uint8Array(bytes))))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replaceAll("=", "")
  );

/** Hex SHA-256: only a secret's hash is ever stored. */
export const hashSecret = (secret: string) =>
  Effect.promise(async () => {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(secret)
    );
    return [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  });
