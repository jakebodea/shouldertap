import type { Tick02Icon } from "@hugeicons/core-free-icons";
import type { CSSProperties, ReactNode } from "react";

/*
 * Text and icons that sit on a person's color on the landing page. They are
 * painted from the same viewport-fixed layer as the frame, in that color's
 * ink, so the sweep recolors them at the exact moment it passes, not all at
 * once. Icons can't be clipped as text, so they become masks onto the layer.
 */

type Icon = typeof Tick02Icon;

const kebab = (key: string) =>
  key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

const maskFromSvg = (inner: string, viewBox: string) =>
  `url("data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" fill="none" stroke="black" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`
  )}")`;

const iconMasks = new WeakMap<Icon, string>();

const maskFor = (icon: Icon) => {
  let mask = iconMasks.get(icon);
  if (!mask) {
    const inner = icon
      .map(([tag, attrs]) => {
        const attributes = Object.entries(attrs)
          .filter(([key]) => key !== "key")
          .map(([key, value]) => {
            const v = value === "currentColor" ? "black" : value;
            return `${kebab(key)}="${v}"`;
          })
          .join(" ");
        return `<${tag} ${attributes}/>`;
      })
      .join("");
    mask = maskFromSvg(inner, "0 0 24 24");
    iconMasks.set(icon, mask);
  }
  return mask;
};

const MARK_MASK = maskFromSvg(
  '<path d="M4 0C23.59 0 30 6.41 30 27.5V28C30 31.07 29.07 32 26 32H4C0.93 32 0 31.07 0 28V4C0 0.93 0.93 0 4 0Z" stroke-width="5"/><path d="M26.8 -3.08L29.19 -9.65" stroke-width="3.75"/><path d="M30.63 -0.63L35.58 -5.58" stroke-width="3.75"/><path d="M33.08 3.2L39.65 0.81" stroke-width="3.75"/>',
  "-2.5 -8.65 44.65 44.65"
);

const masked = (mask: string): CSSProperties => ({
  maskImage: mask,
  WebkitMaskImage: mask,
});

export function InkIcon({
  icon,
  className,
}: {
  icon: Icon;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={`ink-fill mask-glyph inline-block shrink-0 ${className ?? ""}`}
      style={masked(maskFor(icon))}
    />
  );
}

export function InkMark({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={`ink-fill mask-glyph inline-block shrink-0 ${className ?? ""}`}
      style={masked(MARK_MASK)}
    />
  );
}

export function InkText({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <span className={`ink-text ${className ?? ""}`}>{children}</span>;
}
