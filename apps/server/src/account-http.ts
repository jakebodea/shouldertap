import type { createAccountAuth } from "./account-auth";

type AccountAuth = ReturnType<typeof createAccountAuth>;

export interface AccountHttpOptions {
  auth: AccountAuth;
  origin: string;
  webOrigin: string;
  accountRequest?: (userId: string, request: Request) => Promise<Response>;
  deleteAccount?: (userId: string, request: Request) => Promise<Response>;
}

const json = (value: unknown, status = 200) => Response.json(value, { status });

const executeAccountRequest = async (
  request: Request,
  options: AccountHttpOptions,
  allowedOrigin: boolean
): Promise<Response> => {
  const url = new URL(request.url);
  if (url.pathname === "/api/auth/delete-user" && options.deleteAccount) {
    const session = await options.auth.api.getSession({
      headers: request.headers,
    });
    if (!session?.user.emailVerified) {
      return json({ error: "Sign in to continue" }, 401);
    }
    return await options.deleteAccount(session.user.id, request);
  }
  if (url.pathname.startsWith("/api/auth/")) {
    return await options.auth.handler(request);
  }
  if (
    request.method === "POST" &&
    !allowedOrigin &&
    !request.headers.has("authorization")
  ) {
    return json({ error: "Origin required" }, 403);
  }
  const session = await options.auth.api.getSession({
    headers: request.headers,
  });
  if (!session?.user.emailVerified) {
    return json({ error: "Sign in to continue" }, 401);
  }
  if (options.accountRequest) {
    return await options.accountRequest(session.user.id, request);
  }
  return json({ error: "Not found" }, 404);
};

/** Cookie-based account requests have a separate, exact-origin CORS policy. */
export const handleAccountHttp = async (
  request: Request,
  options: AccountHttpOptions
): Promise<Response> => {
  const requestOrigin = request.headers.get("origin");
  const allowedOrigin =
    requestOrigin === options.origin || requestOrigin === options.webOrigin;
  const finish = (response: Response) => {
    const headers = new Headers(response.headers);
    headers.set("cache-control", "no-store");
    headers.set("referrer-policy", "no-referrer");
    headers.set("x-content-type-options", "nosniff");
    headers.set("vary", "Origin");
    if (allowedOrigin && requestOrigin) {
      headers.set("access-control-allow-origin", requestOrigin);
      headers.set("access-control-allow-credentials", "true");
      headers.set("access-control-allow-methods", "GET, POST, OPTIONS");
      headers.set(
        "access-control-allow-headers",
        "Content-Type, Authorization"
      );
    }
    return new Response(response.body, { status: response.status, headers });
  };
  if (requestOrigin && !allowedOrigin) {
    return finish(json({ error: "Origin not allowed" }, 403));
  }
  if (request.method === "OPTIONS") {
    return finish(new Response(null, { status: allowedOrigin ? 204 : 403 }));
  }
  if (!["GET", "POST"].includes(request.method)) {
    return finish(json({ error: "Method not allowed" }, 405));
  }
  try {
    return finish(await executeAccountRequest(request, options, allowedOrigin));
  } catch {
    // Never surface provider exceptions or token-bearing request data.
    return finish(
      json({ error: "Couldn't complete that request. Please try again." }, 503)
    );
  }
};
