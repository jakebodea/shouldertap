import { defineConfig } from "drizzle-kit";

// The Patron Durable Object's SQLite (one per sender patron identity), apart
// from the Inbox's: `drizzle-patron/migrations.js` goes to its
// `Drizzle.DurableObject`.
export default defineConfig({
  dialect: "sqlite",
  driver: "durable-sqlite",
  schema: "./src/patron-schema.ts",
  out: "./drizzle-patron",
});
