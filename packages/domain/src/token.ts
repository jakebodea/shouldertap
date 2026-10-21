/**
 * Credentials, invite codes and connect tickets share one shape:
 * `<inboxId>.<id>.<secret>`. The inbox id lets the Worker route to the
 * recipient's Durable Object; the object verifies the secret's hash.
 */
export interface ParsedToken {
  readonly id: string;
  readonly inboxId: string;
  readonly secret: string;
}

const SEGMENT = /^[A-Za-z0-9_-]{8,64}$/u;
const BEARER = /^Bearer\s+(?<token>.+)$/iu;

export const formatToken = (token: ParsedToken): string =>
  `${token.inboxId}.${token.id}.${token.secret}`;

export const parseToken = (value: string): ParsedToken | null => {
  const parts = value.trim().split(".");
  if (parts.length !== 3) {
    return null;
  }
  const [inboxId, id, secret] = parts as [string, string, string];
  if (!(SEGMENT.test(inboxId) && SEGMENT.test(id) && SEGMENT.test(secret))) {
    return null;
  }
  return { inboxId, id, secret };
};

export const parseBearer = (
  header: string | null | undefined
): ParsedToken | null => {
  const token = header?.match(BEARER)?.groups?.token;
  return token ? parseToken(token) : null;
};

/**
 * A sender's patron key: `stp1.<patronId>.<keyId>.<secret>`. Four segments,
 * so it never parses as a pairing credential (and a pairing credential never
 * parses as a patron key). The patron id routes to the sender's Patron
 * Durable Object, which verifies the secret's hash.
 */
export interface ParsedPatronKey {
  readonly patronId: string;
  readonly keyId: string;
  readonly secret: string;
}

const PATRON_PREFIX = "stp1";

export const formatPatronKey = (key: ParsedPatronKey): string =>
  `${PATRON_PREFIX}.${key.patronId}.${key.keyId}.${key.secret}`;

export const parsePatronKey = (value: string): ParsedPatronKey | null => {
  const parts = value.trim().split(".");
  if (parts.length !== 4 || parts[0] !== PATRON_PREFIX) {
    return null;
  }
  const [, patronId, keyId, secret] = parts as [string, string, string, string];
  if (
    !(SEGMENT.test(patronId) && SEGMENT.test(keyId) && SEGMENT.test(secret))
  ) {
    return null;
  }
  return { patronId, keyId, secret };
};

export const parsePatronBearer = (
  header: string | null | undefined
): ParsedPatronKey | null => {
  const token = header?.match(BEARER)?.groups?.token;
  return token ? parsePatronKey(token) : null;
};
