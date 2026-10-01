import type { ReactNode } from "react";

import { Frame } from "@/components/frame";
import { Mark } from "@/components/mark";

export const SUPPORT_EMAIL = "support@shouldertap.app";

const PAGES = [
  { href: "/support", label: "Support" },
  { href: "/privacy", label: "Privacy" },
  { href: "/terms", label: "Terms" },
] as const;

/** Small links to the support and policy pages, for page footers. */
export function DocLinks({ className }: { className?: string }) {
  return (
    <nav
      aria-label="Support and policies"
      className={`flex flex-wrap items-center gap-x-4 gap-y-1 ${className ?? ""}`}
    >
      {PAGES.map((page) => (
        <a
          className="underline-offset-[3px] hover:text-ink hover:underline"
          href={page.href}
          key={page.href}
        >
          {page.label}
        </a>
      ))}
    </nav>
  );
}

export function EmailLink() {
  return (
    <a
      className="font-semibold text-ink underline underline-offset-[3px]"
      href={`mailto:${SUPPORT_EMAIL}`}
    >
      {SUPPORT_EMAIL}
    </a>
  );
}

/**
 * A long-form reading page (support, privacy, terms): Shouldertap's own
 * neutral frame around a paper page.
 */
export function DocPage({
  title,
  effective,
  intro,
  children,
}: {
  title: string;
  effective?: string;
  intro?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Frame color="graphite">
      <header className="flex items-center justify-between">
        <a
          aria-label="Shouldertap home"
          className="inline-flex items-center gap-2 font-extrabold text-xl tracking-[-0.035em]"
          href="/"
        >
          <Mark className="size-6" />
          Shouldertap
        </a>
      </header>

      <div className="flex flex-col gap-3 pt-6">
        <h1 className="text-balance font-extrabold text-[2.75rem] leading-[0.95] tracking-[-0.04em]">
          {title}
        </h1>
        {effective ? (
          <p className="text-[0.9375rem] text-tone tabular-nums">
            Effective {effective}
          </p>
        ) : null}
        {intro ? (
          <p className="pt-2 text-[1.0625rem] text-tone leading-relaxed">
            {intro}
          </p>
        ) : null}
      </div>

      <div className="flex flex-col divide-y divide-line">{children}</div>

      <footer className="mt-auto flex flex-col items-center gap-2 pt-2 text-[0.8125rem] text-tone">
        <DocLinks className="justify-center" />
        <span>
          Questions? <EmailLink />
        </span>
      </footer>
    </Frame>
  );
}

/** One titled section of a reading page. */
export function DocSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3 py-6 text-[1rem] leading-relaxed [&_li]:pl-1 [&_ul]:flex [&_ul]:list-disc [&_ul]:flex-col [&_ul]:gap-2 [&_ul]:pl-5">
      <h2 className="font-bold text-[1.25rem] leading-tight tracking-[-0.02em]">
        {title}
      </h2>
      {children}
    </section>
  );
}
