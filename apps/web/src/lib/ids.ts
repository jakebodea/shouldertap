/** Works outside secure contexts too (e.g. testing over plain HTTP on a LAN). */
export const newRequestId = (): string =>
  [...crypto.getRandomValues(new Uint8Array(16))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
