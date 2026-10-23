import * as Cloudflare from "alchemy/Cloudflare";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

// HttpApiBuilder captures construction services, including Alchemy's deferred
// execution context. This key exists only in the live fetch context, so the
// captured router context cannot shadow it. Outside a request, reporting is off.
export const RequestBackground = Context.Reference<
  Pick<typeof Cloudflare.Workers.WorkerExecutionContext.Service, "waitUntil">
>("Shouldertap.RequestBackground", {
  defaultValue: () => ({ waitUntil: () => Effect.void }),
});

export const withRequestBackground = <A, E, R>(
  effect: Effect.Effect<A, E, R>
) =>
  effect.pipe(
    Effect.provideServiceEffect(
      RequestBackground,
      Cloudflare.Workers.WorkerExecutionContext
    )
  );
