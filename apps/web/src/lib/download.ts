export const MAC_DOWNLOAD_URL: string = import.meta.env.VITE_MAC_DOWNLOAD_URL;
export const WINDOWS_DOWNLOAD_URL: string = import.meta.env
  .VITE_WINDOWS_DOWNLOAD_URL;
export const IPHONE_APP_URL = "https://apps.apple.com/app/id6818330440";

/** What the visitor's own device can install. Android has no app: it taps from the web. */
export type VisitorPlatform = "mac" | "windows" | "iphone" | "android";

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
    return "android";
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
