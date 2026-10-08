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
export const DocLinks = ({ className }: { className?: string }) => (
  <nav
    aria-label="Support and policies"
    className={`flex flex-wrap items-center gap-x-4 gap-y-1 ${className ?? ""}`}
  >
    {PAGES.map((page) => (
      <a
        className="hover:text-ink underline-offset-[3px] hover:underline"
        href={page.href}
        key={page.href}
      >
        {page.label}
      </a>
    ))}
  </nav>
);

export const EmailLink = () => (
  <a
    className="text-ink font-semibold underline underline-offset-[3px]"
    href={`mailto:${SUPPORT_EMAIL}`}
  >
    {SUPPORT_EMAIL}
  </a>
);

/**
 * A long-form reading page (support, privacy, terms): Shouldertap's own
 * neutral frame around a paper page.
 */
export const DocPage = ({
  title,
  effective,
  intro,
  children,
}: {
  title: string;
  effective?: string;
  intro?: ReactNode;
  children: ReactNode;
}) => (
  <Frame color="graphite">
    <header className="flex items-center justify-between">
      <a
        aria-label="Shouldertap home"
        className="inline-flex items-center gap-2 text-xl font-extrabold tracking-[-0.035em]"
        href="/"
      >
        <Mark className="size-6" />
        Shouldertap
      </a>
    </header>

    <div className="flex flex-col gap-3 pt-6">
      <h1 className="text-[2.75rem] leading-[0.95] font-extrabold tracking-[-0.04em] text-balance">
        {title}
      </h1>
      {effective ? (
        <p className="text-tone text-[0.9375rem] tabular-nums">
          Effective {effective}
        </p>
      ) : null}
      {intro ? (
        <p className="text-tone pt-2 text-[1.0625rem] leading-relaxed">
          {intro}
        </p>
      ) : null}
    </div>

    <div className="divide-line flex flex-col divide-y">{children}</div>

    <footer className="text-tone mt-auto flex flex-col items-center gap-2 pt-2 text-[0.8125rem]">
      <DocLinks className="justify-center" />
      <span>
        Questions? <EmailLink />
      </span>
    </footer>
  </Frame>
);

/** One titled section of a reading page. */
export const DocSection = ({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) => (
  <section className="flex flex-col gap-3 py-6 text-[1rem] leading-relaxed [&_li]:pl-1 [&_ul]:flex [&_ul]:list-disc [&_ul]:flex-col [&_ul]:gap-2 [&_ul]:pl-5">
    <h2 className="text-[1.25rem] leading-tight font-bold tracking-[-0.02em]">
      {title}
    </h2>
    {children}
  </section>
);
