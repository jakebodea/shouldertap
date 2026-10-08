/** Running as a Home Screen web app rather than in a browser tab. */
export const isStandalone = () =>
  window.matchMedia("(display-mode: standalone)").matches ||
  ("standalone" in navigator && navigator.standalone === true);

const IOS_DEVICE = /iPhone|iPad|iPod/u;

/**
 * An iPhone or iPad browser tab. iPadOS reports itself as a Mac, so a Mac
 * with a touch screen counts too.
 */
export const isIosBrowser = () =>
  !isStandalone() &&
  (IOS_DEVICE.test(navigator.userAgent) ||
    (navigator.userAgent.includes("Macintosh") &&
      navigator.maxTouchPoints > 1));
