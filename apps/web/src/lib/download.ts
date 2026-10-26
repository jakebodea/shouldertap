export const MAC_DOWNLOAD_URL: string = import.meta.env.VITE_MAC_DOWNLOAD_URL;
export const WINDOWS_DOWNLOAD_URL: string = import.meta.env
  .VITE_WINDOWS_DOWNLOAD_URL;

/** Shouldertap for iPhone on the App Store (docs/app-store/readiness.md). */
export const IPHONE_APP_URL = "https://apps.apple.com/app/id6822383031";
/**
 * Whether the App Store listing is public. Off, iPhones tap from the web like
 * any other phone and invites skip the App Store step.
 */
export const IPHONE_APP_LIVE = true;

/** What the visitor's own device can install. Other phones tap from the web. */
export type VisitorPlatform = "mac" | "windows" | "iphone" | "phone";

export const visitorPlatform = (
  userAgent = navigator.userAgent,
  maxTouchPoints = navigator.maxTouchPoints
): VisitorPlatform => {
  if (/iPhone|iPad|iPod/u.test(userAgent)) {
    return "iphone";
  }
  // iPadOS Safari asks for desktop sites as a Mac; only the touch screen tells.
  if (/Macintosh/u.test(userAgent) && maxTouchPoints > 1) {
    return "iphone";
  }
  if (/Android/u.test(userAgent)) {
    return "phone";
  }
  if (/Windows/u.test(userAgent)) {
    return "windows";
  }
  return "mac";
};

/** Set by a download link just before it opens the instructions page. */
let started = false;
export const markDownloadStarted = () => {
  started = true;
};
/** Whether this visit to the instructions page followed a download click. */
export const takeDownloadStarted = () => {
  const was = started;
  started = false;
  return was;
};
