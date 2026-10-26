import { useNavigate } from "@tanstack/react-router";
import { useMemo } from "react";
import type { MouseEvent, ReactNode } from "react";

import {
  IPHONE_APP_URL,
  MAC_DOWNLOAD_URL,
  markDownloadStarted,
  visitorPlatform,
  WINDOWS_DOWNLOAD_URL,
} from "@/lib/download";
import type { VisitorPlatform } from "@/lib/download";

/** The verb stays when space is short; the rest names what they get. */
const LABELS: Record<VisitorPlatform, readonly [string, string]> = {
  android: ["Start", "on the web"],
  iphone: ["Get", "the iPhone app"],
  mac: ["Download", "for Mac"],
  windows: ["Download", "for Windows"],
};

const INSTALLERS: Partial<Record<VisitorPlatform, string>> = {
  mac: MAC_DOWNLOAD_URL,
  windows: WINDOWS_DOWNLOAD_URL,
};

/**
 * The landing page's call to action, for the device it's opened on: the Mac
 * or Windows installer (then the setup steps), the App Store on an iPhone or
 * iPad, and the web composer on Android.
 */
export const DownloadLink = ({
  children,
  className,
  short = false,
}: {
  children?: (label: ReactNode) => ReactNode;
  className: string;
  /** Show only the verb below the small breakpoint. */
  short?: boolean;
}) => {
  const navigate = useNavigate();
  const platform = useMemo(() => visitorPlatform(), []);
  const [verb, rest] = LABELS[platform];
  const label = (
    <>
      {verb}
      <span className={short ? "hidden sm:inline" : undefined}>
        &nbsp;{rest}
      </span>
    </>
  );
  const installer = INSTALLERS[platform];

  if (!installer) {
    return (
      <a
        className={className}
        href={platform === "iphone" ? IPHONE_APP_URL : "/tap"}
      >
        {children ? children(label) : label}
      </a>
    );
  }

  const download = (event: MouseEvent<HTMLAnchorElement>) => {
    if (
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return;
    }

    // Keep the cross-origin download outside the router's tree so navigating
    // to the instructions cannot cancel it. The host serves it as attachment.
    let frame = document.querySelector<HTMLIFrameElement>(
      "iframe[data-download]"
    );
    if (!frame) {
      frame = document.createElement("iframe");
      frame.hidden = true;
      frame.name = "download";
      frame.title = "Shouldertap download";
      frame.dataset.download = "";
      document.body.append(frame);
    }
    event.currentTarget.target = frame.name;
    markDownloadStarted();
    // Let the native link action start the download with the user's gesture
    // before changing routes.
    setTimeout(() => navigate({ to: "/download" }), 0);
  };

  return (
    <a className={className} download href={installer} onClick={download}>
      {children ? children(label) : label}
    </a>
  );
};
