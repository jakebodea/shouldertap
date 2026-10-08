import { Toaster } from "@shouldertap/ui/components/sonner";
import {
  createRootRouteWithContext,
  HeadContent,
  Outlet,
} from "@tanstack/react-router";

import { ThemeProvider } from "@/components/theme-provider";

import "../index.css";

export type RouterAppContext = Record<string, never>;

const RootComponent = () => (
  <>
    <HeadContent />
    <ThemeProvider
      attribute="class"
      defaultTheme="system"
      disableTransitionOnChange
    >
      <div className="bg-background text-foreground min-h-svh">
        <Outlet />
      </div>
      <Toaster position="top-center" richColors />
    </ThemeProvider>
  </>
);

export const Route = createRootRouteWithContext<RouterAppContext>()({
  component: RootComponent,
  head: () => ({
    // The description and link-preview tags are static in index.html.
    meta: [{ title: "Shouldertap" }],
  }),
});
