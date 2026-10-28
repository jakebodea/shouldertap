import type { VerificationMailbox } from "./verification-mail";

const json = (body: unknown, status = 200) =>
  Response.json(body, {
    status,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });

const configureResult = async (
  request: Request,
  mailbox: VerificationMailbox
): Promise<Response> => {
  const result = (await request.json().catch(() => null)) as {
    status?: number;
    reason?: string;
  } | null;
  if (
    !result ||
    ![200, 400, 403, 410, 429, 500, 503].includes(result.status ?? 0) ||
    (result.reason !== undefined &&
      (typeof result.reason !== "string" || result.reason.length > 100))
  ) {
    return json({ error: "Invalid APNs result" }, 400);
  }
  await mailbox.database
    .prepare(
      "INSERT INTO verification_push_result(id, status, reason) VALUES(1, ?, ?) ON CONFLICT(id) DO UPDATE SET status = excluded.status, reason = excluded.reason"
    )
    .bind(result.status, result.reason ?? null)
    .run();
  return json({
    status: result.status,
    ...(result.reason ? { reason: result.reason } : {}),
  });
};

/** Private simulated APNs transport; never registered without verification bindings. */
export const verificationPushResponse = async (
  request: Request,
  mailbox: VerificationMailbox
): Promise<Response> => {
  if (
    mailbox.token.length < 32 ||
    request.headers.get("authorization") !== `Bearer ${mailbox.token}`
  ) {
    return json({ error: "Not found" }, 404);
  }
  if (request.method === "GET") {
    const rows = await mailbox.database
      .prepare(
        "SELECT id, request FROM verification_push ORDER BY id DESC LIMIT 100"
      )
      .all<{ id: number; request: string }>();
    return json({
      pushes: rows.results.map((row) => ({
        id: row.id,
        ...JSON.parse(row.request),
      })),
    });
  }
  if (request.method === "DELETE") {
    await mailbox.database.batch([
      mailbox.database.prepare("DELETE FROM verification_push"),
      mailbox.database.prepare("DELETE FROM verification_push_result"),
    ]);
    return json({ cleared: true });
  }
  if (request.method === "PUT") {
    return configureResult(request, mailbox);
  }
  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }
  const body = await request.text();
  if (body.length > 65_536) {
    return json({ error: "Payload too large" }, 413);
  }
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return json({ error: "Invalid payload" }, 400);
  }
  const result = (await mailbox.database
    .prepare("SELECT status, reason FROM verification_push_result WHERE id = 1")
    .first<{ status: number; reason: string | null }>()) ?? {
    status: 200,
    reason: null,
  };
  const headers: Record<string, string> = {};
  for (const name of [
    "apns-topic",
    "apns-push-type",
    "apns-priority",
    "apns-collapse-id",
  ]) {
    const value = request.headers.get(name);
    if (value) {
      headers[name] = value;
    }
  }
  await mailbox.database
    .prepare("INSERT INTO verification_push(request, received_at) VALUES(?, ?)")
    .bind(
      JSON.stringify({
        token: request.headers.get("x-shouldertap-apns-token"),
        environment: request.headers.get("x-shouldertap-apns-environment"),
        headers,
        payload,
        status: result.status,
        ...(result.reason ? { reason: result.reason } : {}),
      }),
      Date.now()
    )
    .run();
  return json(result.reason ? { reason: result.reason } : {}, result.status);
};
