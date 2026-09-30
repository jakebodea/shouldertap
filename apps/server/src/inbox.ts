import {
  AcknowledgeRequest,
  ApiFailure,
  type ConnectTicket,
  CreateInboxRequest,
  CreateInviteRequest,
  type Credential,
  type CredentialGrant,
  type CredentialKind,
  type ErrorCode,
  formatToken,
  type Invite,
  type ParsedToken,
  parseToken,
  RedeemInviteRequest,
  type ServerEvent,
  SendTapRequest,
  type Snapshot,
  type Tap,
  type TapResponse,
} from "@shouldertap/domain";
import { DurableObject } from "cloudflare:workers";
import { Effect, Schema } from "effect";

/** Plain data so failures survive the Worker ↔ Durable Object RPC boundary. */
export type Result<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly error: { readonly code: ErrorCode; readonly message: string } };

const SENDER_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEVICE_INVITE_TTL_MS = 15 * 60 * 1000;
const TICKET_TTL_MS = 60 * 1000;
const HISTORY_LIMIT = 25;
const LAST_SEEN_WRITE_INTERVAL_MS = 60 * 1000;

interface Actor {
  readonly id: string;
  readonly kind: CredentialKind;
  readonly name: string;
}

interface SocketAttachment {
  readonly credentialId: string;
  readonly kind: CredentialKind;
}

type Row = Record<string, SqlStorageValue>;

const fail = (code: ErrorCode, message: string) => Effect.fail(new ApiFailure({ code, message }));

const decode = <S extends Schema.Top & { readonly DecodingServices: never }>(
  schema: S,
  input: unknown,
) =>
  Schema.decodeUnknownEffect(schema)(input).pipe(
    Effect.mapError((error) => new ApiFailure({ code: "invalid_request", message: error.message })),
  );

const run = <A>(program: Effect.Effect<A, ApiFailure>): Promise<Result<A>> =>
  Effect.runPromise(
    program.pipe(
      Effect.map((value): Result<A> => ({ ok: true, value })),
      Effect.catchTag("ApiFailure", (error) =>
        Effect.succeed<Result<A>>({
          ok: false,
          error: { code: error.code, message: error.message },
        }),
      ),
    ),
  );

const randomId = (bytes = 12): string => {
  const buffer = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...buffer))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
};

const hashSecret = (secret: string) =>
  Effect.promise(async () => {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  });

const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS credentials (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    secret_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER,
    revoked_at INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS invites (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    secret_hash TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    redeemed_at INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS tickets (
    id TEXT PRIMARY KEY,
    secret_hash TEXT NOT NULL,
    credential_id TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS taps (
    id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL,
    sender_id TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    state TEXT NOT NULL,
    displayed_at INTEGER,
    acknowledged_at INTEGER,
    acknowledged_by TEXT,
    response TEXT,
    sequence INTEGER NOT NULL,
    UNIQUE (sender_id, request_id)
  )`,
  `CREATE INDEX IF NOT EXISTS taps_by_sequence ON taps (sequence)`,
];

/**
 * One instance per recipient. Authoritative owner of the recipient's
 * paired devices, trusted senders and taps. Commands arrive over RPC from
 * the Worker; events leave over hibernatable WebSockets.
 */
export class Inbox extends DurableObject<Env> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    for (const statement of MIGRATIONS) {
      this.sql.exec(statement);
    }
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  // Commands

  initialize(inboxId: string, input: unknown): Promise<Result<CredentialGrant>> {
    return run(
      Effect.gen({ self: this }, function* () {
        const request = yield* decode(CreateInboxRequest, input);
        if (this.meta("inbox_id") !== null) {
          return yield* fail("conflict", "Inbox already exists");
        }
        const secret = randomId(32);
        const secretHash = yield* hashSecret(secret);
        const credentialId = randomId();
        this.ctx.storage.transactionSync(() => {
          this.setMeta("inbox_id", inboxId);
          this.setMeta("recipient_name", request.recipientName);
          this.setMeta("sequence", "0");
          this.insertCredential(credentialId, "device", request.deviceName, secretHash);
        });
        return {
          kind: "device" as const,
          credentialId,
          token: formatToken({ inboxId, id: credentialId, secret }),
          recipientName: request.recipientName,
        };
      }),
    );
  }

  snapshot(token: ParsedToken): Promise<Result<Snapshot>> {
    return run(
      Effect.gen({ self: this }, function* () {
        const actor = yield* this.authenticate(token);
        const sequence = this.sequence();
        const recipientName = this.meta("recipient_name") ?? "";
        if (actor.kind === "sender") {
          return {
            kind: "sender" as const,
            credentialId: actor.id,
            senderName: actor.name,
            recipientName,
            sequence,
            taps: this.selectTaps("WHERE t.sender_id = ?", actor.id),
          };
        }
        return {
          kind: "device" as const,
          credentialId: actor.id,
          recipientName,
          sequence,
          taps: this.selectTaps("WHERE t.state = 'pending' OR t.id IN (SELECT id FROM taps ORDER BY created_at DESC LIMIT ?)", HISTORY_LIMIT),
          credentials: this.listCredentials(),
        };
      }),
    );
  }

  createInvite(token: ParsedToken, input: unknown): Promise<Result<Invite>> {
    return run(
      Effect.gen({ self: this }, function* () {
        const actor = yield* this.authenticate(token);
        if (actor.kind !== "device") {
          return yield* fail("unauthorized", "Only a paired Mac can create invites");
        }
        const request = yield* decode(CreateInviteRequest, input);
        const id = randomId();
        const secret = randomId(24);
        const secretHash = yield* hashSecret(secret);
        const now = Date.now();
        const expiresAt =
          now + (request.kind === "sender" ? SENDER_INVITE_TTL_MS : DEVICE_INVITE_TTL_MS);
        this.sql.exec(
          "INSERT INTO invites (id, kind, secret_hash, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
          id,
          request.kind,
          secretHash,
          actor.id,
          now,
          expiresAt,
        );
        return {
          kind: request.kind,
          code: formatToken({ inboxId: token.inboxId, id, secret }),
          expiresAt,
        };
      }),
    );
  }

  redeemInvite(code: ParsedToken, input: unknown): Promise<Result<CredentialGrant>> {
    return run(
      Effect.gen({ self: this }, function* () {
        const request = yield* decode(RedeemInviteRequest, input);
        const secretHash = yield* hashSecret(code.secret);
        const secret = randomId(32);
        const credentialHash = yield* hashSecret(secret);
        const credentialId = randomId();
        const now = Date.now();

        const invite = this.one("SELECT * FROM invites WHERE id = ?", code.id);
        if (!invite || invite.secret_hash !== secretHash) {
          return yield* fail("not_found", "This invite link isn't valid");
        }
        if (invite.redeemed_at !== null) {
          return yield* fail("expired", "This invite link was already used");
        }
        if ((invite.expires_at as number) < now) {
          return yield* fail("expired", "This invite link has expired");
        }
        const kind = invite.kind as CredentialKind;
        this.ctx.storage.transactionSync(() => {
          this.sql.exec("UPDATE invites SET redeemed_at = ? WHERE id = ?", now, code.id);
          this.insertCredential(credentialId, kind, request.name, credentialHash);
        });
        this.broadcastToDevices({ v: 1, type: "credentials", sequence: this.sequence() });
        return {
          kind,
          credentialId,
          token: formatToken({ inboxId: code.inboxId, id: credentialId, secret }),
          recipientName: this.meta("recipient_name") ?? "",
        };
      }),
    );
  }

  sendTap(token: ParsedToken, input: unknown): Promise<Result<Tap>> {
    return run(
      Effect.gen({ self: this }, function* () {
        const actor = yield* this.authenticate(token);
        if (actor.kind !== "sender") {
          return yield* fail("unauthorized", "Only a paired sender can send taps");
        }
        const request = yield* decode(SendTapRequest, input);
        const existing = this.one(
          "SELECT id, body FROM taps WHERE sender_id = ? AND request_id = ?",
          actor.id,
          request.requestId,
        );
        if (existing) {
          if (existing.body !== request.body) {
            return yield* fail("conflict", "Request id was reused with a different message");
          }
          return this.getTap(existing.id as string);
        }
        const id = randomId();
        this.ctx.storage.transactionSync(() => {
          const sequence = this.nextSequence();
          this.sql.exec(
            "INSERT INTO taps (id, request_id, sender_id, body, created_at, state, sequence) VALUES (?, ?, ?, ?, ?, 'pending', ?)",
            id,
            request.requestId,
            actor.id,
            request.body,
            Date.now(),
            sequence,
          );
        });
        const tap = this.getTap(id);
        this.broadcastTap(tap);
        return tap;
      }),
    );
  }

  markDisplayed(token: ParsedToken, tapId: string): Promise<Result<Tap>> {
    return run(
      Effect.gen({ self: this }, function* () {
        const actor = yield* this.authenticate(token);
        if (actor.kind !== "device") {
          return yield* fail("unauthorized", "Only a paired Mac can report display");
        }
        const tap = yield* this.findTap(tapId);
        if (tap.displayedAt !== null) {
          return tap;
        }
        this.ctx.storage.transactionSync(() => {
          this.sql.exec(
            "UPDATE taps SET displayed_at = ?, sequence = ? WHERE id = ?",
            Date.now(),
            this.nextSequence(),
            tapId,
          );
        });
        const updated = this.getTap(tapId);
        this.broadcastTap(updated);
        return updated;
      }),
    );
  }

  acknowledge(token: ParsedToken, tapId: string, input: unknown): Promise<Result<Tap>> {
    return run(
      Effect.gen({ self: this }, function* () {
        const actor = yield* this.authenticate(token);
        if (actor.kind !== "device") {
          return yield* fail("unauthorized", "Only a paired Mac can respond");
        }
        const request = yield* decode(AcknowledgeRequest, input);
        if (request.response.kind === "text" && !request.response.text?.trim()) {
          return yield* fail("invalid_request", "A text reply needs some text");
        }
        const tap = yield* this.findTap(tapId);
        // The first committed acknowledgement wins; retries and other Macs get it back.
        if (tap.state === "acknowledged") {
          return tap;
        }
        const now = Date.now();
        this.ctx.storage.transactionSync(() => {
          this.sql.exec(
            `UPDATE taps SET state = 'acknowledged', acknowledged_at = ?, acknowledged_by = ?,
              displayed_at = COALESCE(displayed_at, ?), response = ?, sequence = ? WHERE id = ?`,
            now,
            actor.name,
            now,
            JSON.stringify(request.response),
            this.nextSequence(),
            tapId,
          );
        });
        const updated = this.getTap(tapId);
        this.broadcastTap(updated);
        return updated;
      }),
    );
  }

  revoke(token: ParsedToken, credentialId: string): Promise<Result<{ revoked: true }>> {
    return run(
      Effect.gen({ self: this }, function* () {
        const actor = yield* this.authenticate(token);
        if (actor.kind !== "device") {
          return yield* fail("unauthorized", "Only a paired Mac can remove pairings");
        }
        const target = this.one(
          "SELECT id, kind FROM credentials WHERE id = ? AND revoked_at IS NULL",
          credentialId,
        );
        if (!target) {
          return yield* fail("not_found", "No such pairing");
        }
        this.sql.exec("UPDATE credentials SET revoked_at = ? WHERE id = ?", Date.now(), credentialId);
        const tag = `${target.kind as string}:${credentialId}`;
        for (const socket of this.ctx.getWebSockets(tag)) {
          this.send(socket, { v: 1, type: "revoked" });
          socket.close(4001, "revoked");
        }
        this.broadcastToDevices({ v: 1, type: "credentials", sequence: this.sequence() });
        return { revoked: true as const };
      }),
    );
  }

  createTicket(token: ParsedToken): Promise<Result<ConnectTicket>> {
    return run(
      Effect.gen({ self: this }, function* () {
        const actor = yield* this.authenticate(token);
        const id = randomId();
        const secret = randomId(24);
        const secretHash = yield* hashSecret(secret);
        const now = Date.now();
        const expiresAt = now + TICKET_TTL_MS;
        this.sql.exec("DELETE FROM tickets WHERE expires_at < ?", now);
        this.sql.exec(
          "INSERT INTO tickets (id, secret_hash, credential_id, expires_at) VALUES (?, ?, ?, ?)",
          id,
          secretHash,
          actor.id,
          expiresAt,
        );
        return { ticket: formatToken({ inboxId: token.inboxId, id, secret }), expiresAt };
      }),
    );
  }

  // WebSocket upgrade: `GET /v1/connect?ticket=…`, forwarded by the Worker.

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }
    const ticket = parseToken(new URL(request.url).searchParams.get("ticket") ?? "");
    if (!ticket) {
      return new Response("Invalid ticket", { status: 401 });
    }
    const secretHash = await Effect.runPromise(hashSecret(ticket.secret));
    const row = this.one("SELECT * FROM tickets WHERE id = ?", ticket.id);
    // One-time: consume before checking so a guessed id can't be retried.
    this.sql.exec("DELETE FROM tickets WHERE id = ?", ticket.id);
    if (!row || row.secret_hash !== secretHash || (row.expires_at as number) < Date.now()) {
      return new Response("Invalid ticket", { status: 401 });
    }
    const credential = this.one(
      "SELECT id, kind FROM credentials WHERE id = ? AND revoked_at IS NULL",
      row.credential_id as string,
    );
    if (!credential) {
      return new Response("Revoked", { status: 401 });
    }
    const kind = credential.kind as CredentialKind;
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server, [kind, `${kind}:${credential.id as string}`]);
    server.serializeAttachment({
      credentialId: credential.id as string,
      kind,
    } satisfies SocketAttachment);
    return new Response(null, { status: 101, webSocket: client });
  }

  override webSocketMessage(): void {
    // Clients send commands over HTTPS; "ping" is answered by the auto-response.
  }

  override webSocketClose(socket: WebSocket, code: number): void {
    try {
      socket.close(code === 1005 ? 1000 : code, "closing");
    } catch {
      // Already closed.
    }
  }

  // Internals

  private authenticate(token: ParsedToken) {
    return Effect.gen({ self: this }, function* () {
      const secretHash = yield* hashSecret(token.secret);
      const row = this.one(
        "SELECT id, kind, name, secret_hash, last_seen_at FROM credentials WHERE id = ? AND revoked_at IS NULL",
        token.id,
      );
      if (!row || row.secret_hash !== secretHash) {
        return yield* fail("unauthorized", "This pairing is no longer valid");
      }
      const now = Date.now();
      if (((row.last_seen_at as number | null) ?? 0) < now - LAST_SEEN_WRITE_INTERVAL_MS) {
        this.sql.exec("UPDATE credentials SET last_seen_at = ? WHERE id = ?", now, token.id);
      }
      return {
        id: row.id as string,
        kind: row.kind as CredentialKind,
        name: row.name as string,
      } satisfies Actor;
    });
  }

  private insertCredential(id: string, kind: CredentialKind, name: string, secretHash: string) {
    this.sql.exec(
      "INSERT INTO credentials (id, kind, name, secret_hash, created_at) VALUES (?, ?, ?, ?, ?)",
      id,
      kind,
      name,
      secretHash,
      Date.now(),
    );
  }

  private listCredentials(): Credential[] {
    return this.sql
      .exec(
        "SELECT id, kind, name, created_at, last_seen_at FROM credentials WHERE revoked_at IS NULL ORDER BY created_at",
      )
      .toArray()
      .map((row) => ({
        id: row.id as string,
        kind: row.kind as CredentialKind,
        name: row.name as string,
        createdAt: row.created_at as number,
        lastSeenAt: row.last_seen_at as number | null,
      }));
  }

  private findTap(tapId: string) {
    const rows = this.selectTaps("WHERE t.id = ?", tapId);
    return rows[0] ? Effect.succeed(rows[0]) : fail("not_found", "No such tap");
  }

  private getTap(tapId: string): Tap {
    const tap = this.selectTaps("WHERE t.id = ?", tapId)[0];
    if (!tap) {
      throw new Error(`Tap ${tapId} vanished`);
    }
    return tap;
  }

  private selectTaps(where: string, ...bindings: SqlStorageValue[]): Tap[] {
    return this.sql
      .exec(
        `SELECT t.*, c.name AS sender_name FROM taps t JOIN credentials c ON c.id = t.sender_id
         ${where} ORDER BY t.created_at DESC LIMIT ${HISTORY_LIMIT * 2}`,
        ...bindings,
      )
      .toArray()
      .map((row) => ({
        id: row.id as string,
        senderId: row.sender_id as string,
        senderName: row.sender_name as string,
        body: row.body as string,
        createdAt: row.created_at as number,
        state: row.state as Tap["state"],
        displayedAt: row.displayed_at as number | null,
        acknowledgedAt: row.acknowledged_at as number | null,
        acknowledgedBy: row.acknowledged_by as string | null,
        response: row.response ? (JSON.parse(row.response as string) as TapResponse) : null,
        sequence: row.sequence as number,
      }));
  }

  private one(query: string, ...bindings: SqlStorageValue[]): Row | null {
    return (this.sql.exec(query, ...bindings).toArray()[0] as Row | undefined) ?? null;
  }

  private meta(key: string): string | null {
    return (this.one("SELECT value FROM meta WHERE key = ?", key)?.value as string) ?? null;
  }

  private setMeta(key: string, value: string) {
    this.sql.exec(
      "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      key,
      value,
    );
  }

  private sequence(): number {
    return Number(this.meta("sequence") ?? 0);
  }

  private nextSequence(): number {
    const next = this.sequence() + 1;
    this.setMeta("sequence", String(next));
    return next;
  }

  private broadcastTap(tap: Tap) {
    const event: ServerEvent = { v: 1, type: "tap", sequence: tap.sequence, tap };
    this.broadcastToDevices(event);
    for (const socket of this.ctx.getWebSockets(`sender:${tap.senderId}`)) {
      this.send(socket, event);
    }
  }

  private broadcastToDevices(event: ServerEvent) {
    for (const socket of this.ctx.getWebSockets("device")) {
      this.send(socket, event);
    }
  }

  private send(socket: WebSocket, event: ServerEvent) {
    try {
      socket.send(JSON.stringify(event));
    } catch {
      // A dead socket is cleaned up by the runtime; clients resync on reconnect.
    }
  }
}
