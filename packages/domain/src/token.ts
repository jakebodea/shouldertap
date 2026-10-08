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
