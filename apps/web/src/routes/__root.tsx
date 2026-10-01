import { Toaster } from "@shouldertap/ui/components/sonner";
import {
  createRootRouteWithContext,
  HeadContent,
  Outlet,
} from "@tanstack/react-router";

import { ThemeProvider } from "@/components/theme-provider";

import "../index.css";

export type RouterAppContext = Record<string, never>;

export const Route = createRootRouteWithContext<RouterAppContext>()({
  component: RootComponent,
  head: () => ({
    // The description and link-preview tags are static in index.html.
    meta: [{ title: "Shouldertap" }],
  }),
});

function RootComponent() {
  return (
    <>
      <HeadContent />
      <ThemeProvider
        attribute="class"
        defaultTheme="system"
        disableTransitionOnChange
      >
        <div className="min-h-svh bg-background text-foreground">
          <Outlet />
        </div>
        <Toaster position="top-center" richColors />
      </ThemeProvider>
    </>
  );
}
