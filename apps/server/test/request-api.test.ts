import * as NodeServices from "@effect/platform-node/NodeServices";
import { RuntimeContext } from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";

import { RequestBackground, withRequestBackground } from "../src/request-api";

describe("request API context", () => {
  it("uses each request's execution context for HTTP API background work", async () => {
    const Exec = Cloudflare.Workers.WorkerExecutionContext;
    // Fake the Cloudflare host boundary, while running the real Effect HTTP router.
    const context = (
      schedule: (work: Effect.Effect<unknown>) => Effect.Effect<void>
    ) => ({ waitUntil: schedule }) as unknown as typeof Exec.Service;
    const initial = context(() => Effect.die("init context used by a request"));
    const deliveries: string[] = [];
    const api = HttpApi.make("request-context-test").add(
      HttpApiGroup.make("test").add(
        HttpApiEndpoint.get("run", "/run", {
          success: Schema.Struct({ accepted: Schema.Boolean }),
        })
      )
    );
    const group = HttpApiBuilder.group(api, "test", (handlers) =>
      Effect.gen(function* constructGroup() {
        // Real construction layers also need Alchemy's init context.
        yield* Exec;
        return handlers.handle("run", () =>
          Effect.gen(function* handleRequest() {
            const exec = yield* RequestBackground;
            yield* exec.waitUntil(
              Effect.sync(() => {
                deliveries.push("product event");
              })
            );
            return { accepted: true };
          })
        );
      })
    );
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* buildAndCall() {
          const handler = yield* HttpRouter.toHttpEffect(
            HttpApiBuilder.layer(api).pipe(
              Layer.provide(group),
              Layer.provide([HttpPlatform.layer, Etag.layer])
            )
          );
          const request = HttpServerRequest.fromWeb(
            new Request("https://example.com/run")
          );
          const live = context((work) => work.pipe(Effect.asVoid));
          const response = yield* handler.pipe(
            withRequestBackground,
            Effect.provideService(HttpServerRequest.HttpServerRequest, request),
            Effect.provideService(Exec, live)
          );
          return response.status;
        })
      ).pipe(
        Effect.provide(NodeServices.layer),
        Effect.provideService(RuntimeContext, {
          Type: "test",
          id: "request-api",
          env: {},
          get: () => Effect.die("Unexpected runtime lookup"),
          set: (id) => Effect.succeed(id),
        }),
        Effect.provideService(Exec, initial)
      )
    );
    expect({ status: result, deliveries }).toStrictEqual({
      status: 200,
      deliveries: ["product event"],
    });
  });
});
