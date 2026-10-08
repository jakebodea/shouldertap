import { defineConfig } from "oxfmt";
import ultracite from "ultracite/oxfmt";

export default defineConfig({
  ...ultracite,
  ignorePatterns: [
    ...(ultracite.ignorePatterns ?? []),
    // Generated: shadcn primitives, router tree, drizzle-kit output.
    "packages/ui/src/components/**",
    "apps/server/drizzle/**",
    "**/routeTree.gen.ts",
    // Not TypeScript: the Swift and Rust apps.
    "apps/macos/**",
    "apps/ios/**",
    "apps/windows/**",
  ],
});
