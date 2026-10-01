import { Download04Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { createFileRoute } from "@tanstack/react-router";

import { DocLinks } from "@/components/document";
import { Frame } from "@/components/frame";
import { Mark } from "@/components/mark";

export const Route = createFileRoute("/download")({
  component: DownloadComponent,
  head: () => ({ meta: [{ title: "Download Shouldertap for Mac" }] }),
});

const DOWNLOAD_URL: string = import.meta.env.VITE_MAC_DOWNLOAD_URL;

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

function DownloadComponent() {
  return (
    <Frame color="moss">
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

      <section className="flex flex-col gap-5 pt-6">
        <h1 className="text-balance font-extrabold text-[2.75rem] leading-[0.95] tracking-[-0.04em]">
          Shouldertap for Mac
        </h1>
        <p className="text-[1.0625rem] text-tone leading-relaxed">
          A menu bar app. When someone you invited taps you, their message
          covers your screens until you answer.
        </p>
        <a className="pill pill-frame w-full" download href={DOWNLOAD_URL}>
          <HugeiconsIcon className="size-5" icon={Download04Icon} />
          Download for Mac
        </a>
        <p className="text-center text-[0.8125rem] text-tone">
          Free for 7 days, then $5 once · macOS 14 Sonoma or later · Apple
          silicon and Intel
        </p>
      </section>

      <ol className="flex flex-col divide-y divide-line">
        {STEPS.map((step, i) => (
          <li className="flex gap-4 py-5" key={step.title}>
            <span className="grid size-8 shrink-0 place-items-center rounded-full bg-frame font-bold text-frame-ink text-sm">
              {i + 1}
            </span>
            <div className="flex flex-col gap-1">
              <h2 className="font-bold text-[1.0625rem]">{step.title}</h2>
              <p className="text-[0.9375rem] text-tone leading-snug">
                {step.body}
              </p>
            </div>
          </li>
        ))}
      </ol>

      <footer className="mt-auto flex flex-col items-center gap-3 pt-2 text-center text-[0.8125rem] text-tone">
        <p>
          The people who tap you don't install anything. They use Safari on
          their iPhone.
        </p>
        <DocLinks className="justify-center" />
      </footer>
    </Frame>
  );
}
