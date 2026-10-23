import * as Cloudflare from "alchemy/Cloudflare";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

/** HttpApiBuilder captures construction services. Preserve the live request's
 * execution context instead of shadowing it with Alchemy's init placeholder. */
export const requestApiConstruction = <A, E, R>(
  build: Effect.Effect<A, E, R>
): Effect.Effect<A, E, R> =>
  Effect.updateContext(
    build,
    (context: Context.Context<R>) =>
      // The router captures this context; it does not consume the request-only
      // service while building. Keep its declared dependencies for handler typing.
      Context.omit(Cloudflare.Workers.WorkerExecutionContext)(
        context
      ) as Context.Context<R>
  );
