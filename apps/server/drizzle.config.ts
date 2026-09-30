import { defineConfig } from "drizzle-kit";

// Durable Object SQLite: drizzle-kit emits `drizzle/migrations.js`, which the
// Inbox passes to `Drizzle.DurableObject` and applies on activation.
export default defineConfig({
  dialect: "sqlite",
  driver: "durable-sqlite",
  schema: "./src/schema.ts",
  out: "./drizzle",
});
