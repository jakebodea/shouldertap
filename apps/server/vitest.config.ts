import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    {
      // drizzle-kit's `drizzle/migrations.js` imports each `migration.sql` as a string, the way
      // Wrangler and Bun load `.sql` files. Vite would parse them as JavaScript.
      name: "sql-as-text",
      transform(code, id) {
        return id.endsWith(".sql")
          ? { code: `export default ${JSON.stringify(code)};`, map: null }
          : null;
      },
    },
  ],
});
