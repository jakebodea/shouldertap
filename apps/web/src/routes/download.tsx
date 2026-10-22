import { Download04Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { createFileRoute } from "@tanstack/react-router";

import { DocLinks } from "@/components/document";
import { SitePage } from "@/components/site-page";
import { MAC_DOWNLOAD_URL, WINDOWS_DOWNLOAD_URL } from "@/lib/download";

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
    <main className="grid items-start gap-12 pb-12 lg:grid-cols-[1.1fr_1fr] lg:gap-24 lg:pb-16">
      <section className="flex flex-col items-start gap-6">
        <h1 className="text-[2.75rem] leading-[0.98] font-extrabold tracking-[-0.04em] sm:text-[4rem]">
          Shouldertap
          <span className="block">for Mac</span>
        </h1>
        <p className="text-tone max-w-[35rem] text-lg leading-relaxed">
          A menu bar app. When someone you invited taps you, their message
          covers your screens until you answer.
        </p>
        <p className="text-tone max-w-[30rem] text-[0.9375rem] leading-relaxed">
          Your download should start automatically. If it didn’t, use the link
          below, then follow the steps to get set up.
        </p>
        <a
          className="pill pill-ink w-full sm:w-auto"
          download
          href={MAC_DOWNLOAD_URL}
        >
          <HugeiconsIcon className="size-5" icon={Download04Icon} />
          Download for Mac
        </a>
        <p className="text-tone text-[0.8125rem] leading-relaxed">
          <span className="text-ink block text-sm font-semibold">
            Free to use
          </span>
          macOS 14 Sonoma or later · Apple silicon and Intel
        </p>
        <p className="text-tone max-w-[30rem] text-[0.8125rem] leading-relaxed">
          <span className="text-ink block text-sm font-semibold">
            On Windows?{" "}
            <a className="underline" download href={WINDOWS_DOWNLOAD_URL}>
              Download for Windows
            </a>
          </span>
          Windows 10 and 11. It isn&apos;t signed yet, so if Windows warns,
          choose More info, then Run anyway. It lives in the system tray.
        </p>
      </section>

      <ol
        aria-label="Set up Shouldertap"
        className="divide-line flex flex-col divide-y lg:pt-2"
      >
        {STEPS.map((step, i) => (
          <li className="flex gap-5 py-7 first:pt-0 last:pb-0" key={step.title}>
            <span className="bg-faint text-ink grid size-9 shrink-0 place-items-center rounded-full text-sm font-bold">
              {i + 1}
            </span>
            <div className="flex flex-col gap-2 pt-1">
              <h2 className="text-lg leading-tight font-bold">{step.title}</h2>
              <p className="text-tone max-w-[30rem] text-base leading-relaxed">
                {step.body}
              </p>
            </div>
          </li>
        ))}
      </ol>
    </main>
    <footer className="text-tone border-line flex flex-wrap items-center justify-between gap-x-8 gap-y-3 border-t pt-4 text-sm">
      <p className="max-w-[36rem] leading-relaxed">
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
