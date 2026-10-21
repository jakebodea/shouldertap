import { Download04Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { createFileRoute } from "@tanstack/react-router";

import { DocLinks } from "@/components/document";
import { SitePage } from "@/components/site-page";
import { MAC_DOWNLOAD_URL } from "@/lib/download";

const STEPS = [
  {
    title: "Install",
    body: "Open Shouldertap.dmg and drag Shouldertap into Applications.",
  },
  {
    title: "Open it",
    body: "Open Shouldertap from Applications and choose Open when macOS asks. It's signed and notarized by Apple, so that's the only prompt.",
  },
  {
    title: "Invite someone",
    body: "Click the Shouldertap mark in your menu bar and create an invite link. They scan it with their iPhone camera, and that's it.",
  },
];

const DownloadComponent = () => (
  <SitePage>
    <main className="grid gap-12 pb-12 md:grid-cols-2 md:gap-16 md:pb-20">
      <section className="flex flex-col items-start gap-5">
        <h1 className="text-[2.75rem] leading-[0.95] font-extrabold tracking-[-0.04em] text-balance sm:text-6xl">
          Shouldertap for Mac
        </h1>
        <p className="text-tone text-[1.0625rem] leading-relaxed">
          A menu bar app. When someone you invited taps you, their message
          covers your screens until you answer.
        </p>
        <p className="text-tone text-[0.9375rem] leading-snug">
          Your download should start automatically. If it didn’t, use the link
          below, then follow the steps to get set up.
        </p>
        <a className="pill pill-ink" download href={MAC_DOWNLOAD_URL}>
          <HugeiconsIcon className="size-5" icon={Download04Icon} />
          Download for Mac
        </a>
        <p className="text-tone text-[0.8125rem] leading-relaxed">
          Free for 7 days, then $5 once · macOS 14 Sonoma or later · Apple
          silicon and Intel
        </p>
      </section>

      <ol
        aria-label="Set up Shouldertap"
        className="divide-line flex flex-col divide-y"
      >
        {STEPS.map((step, i) => (
          <li className="flex gap-4 py-5 first:pt-0" key={step.title}>
            <span className="bg-faint text-ink grid size-8 shrink-0 place-items-center rounded-full text-sm font-bold">
              {i + 1}
            </span>
            <div className="flex flex-col gap-1">
              <h2 className="text-[1.0625rem] font-bold">{step.title}</h2>
              <p className="text-tone text-[0.9375rem] leading-snug">
                {step.body}
              </p>
            </div>
          </li>
        ))}
      </ol>
    </main>
    <footer className="text-tone border-line flex flex-wrap items-center justify-between gap-4 border-t pt-6 text-[0.8125rem]">
      <p>
        The people who tap you don&apos;t install anything. They use Safari on
        their iPhone.
      </p>
      <DocLinks />
    </footer>
  </SitePage>
);

export const Route = createFileRoute("/download")({
  component: DownloadComponent,
  head: () => ({ meta: [{ title: "Download Shouldertap for Mac" }] }),
});
