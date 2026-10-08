import { useNavigate } from "@tanstack/react-router";
import type { MouseEvent, ReactNode } from "react";

import { MAC_DOWNLOAD_URL } from "@/lib/download";

export const MacDownloadLink = ({
  children,
  className,
}: {
  children: ReactNode;
  className: string;
}) => {
  const navigate = useNavigate();

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
      "iframe[data-mac-download]"
    );
    if (!frame) {
      frame = document.createElement("iframe");
      frame.hidden = true;
      frame.name = "mac-download";
      frame.title = "Mac app download";
      frame.dataset.macDownload = "";
      document.body.append(frame);
    }
    event.currentTarget.target = frame.name;
    // Let the native link action start the download with the user's gesture
    // before changing routes.
    setTimeout(() => navigate({ to: "/download" }), 0);
  };

  return (
    <a
      className={className}
      download
      href={MAC_DOWNLOAD_URL}
      onClick={download}
    >
      {children}
    </a>
  );
};
