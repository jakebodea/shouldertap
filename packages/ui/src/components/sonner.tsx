"use client";

import {
  Alert02Icon,
  CancelCircleIcon,
  CheckmarkCircle02Icon,
  InformationCircleIcon,
  Loading03Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useTheme } from "next-themes";
import { Toaster as Sonner, type ToasterProps } from "sonner";

const Toaster = ({ ...props }: ToasterProps) => {
  const { theme = "system" } = useTheme();

  return (
    <Sonner
      className="toaster group"
      icons={{
        success: <HugeiconsIcon className="size-4" icon={CheckmarkCircle02Icon} />,
        info: <HugeiconsIcon className="size-4" icon={InformationCircleIcon} />,
        warning: <HugeiconsIcon className="size-4" icon={Alert02Icon} />,
        error: <HugeiconsIcon className="size-4" icon={CancelCircleIcon} />,
        loading: (
          <HugeiconsIcon className="size-4 animate-spin" icon={Loading03Icon} />
        ),
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius)",
        } as React.CSSProperties
      }
      theme={theme as ToasterProps["theme"]}
      toastOptions={{
        classNames: {
          toast: "cn-toast",
        },
      }}
      {...props}
    />
  );
};

export { Toaster };
