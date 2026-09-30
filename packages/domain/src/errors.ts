import * as Schema from "effect/Schema";

// Typed failures shared by the Durable Object (RPC), the Worker (HttpApi)
// and clients. `httpApiStatus` sets the response status for each.

export class InvalidRequest extends Schema.TaggedError<InvalidRequest>()(
  "InvalidRequest",
  { message: Schema.String },
  { httpApiStatus: 400 }
) {}

export class Unauthorized extends Schema.TaggedError<Unauthorized>()(
  "Unauthorized",
  { message: Schema.String },
  { httpApiStatus: 401 }
) {}

export class NotFound extends Schema.TaggedError<NotFound>()(
  "NotFound",
  { message: Schema.String },
  { httpApiStatus: 404 }
) {}

export class Conflict extends Schema.TaggedError<Conflict>()(
  "Conflict",
  { message: Schema.String },
  { httpApiStatus: 409 }
) {}

export class Expired extends Schema.TaggedError<Expired>()(
  "Expired",
  { message: Schema.String },
  { httpApiStatus: 410 }
) {}

export class TooManyRequests extends Schema.TaggedError<TooManyRequests>()(
  "TooManyRequests",
  { message: Schema.String },
  { httpApiStatus: 429 }
) {}
