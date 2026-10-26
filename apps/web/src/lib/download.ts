export const MAC_DOWNLOAD_URL: string = import.meta.env.VITE_MAC_DOWNLOAD_URL;
export const WINDOWS_DOWNLOAD_URL: string = import.meta.env
  .VITE_WINDOWS_DOWNLOAD_URL;

/** Shouldertap for iPhone on the App Store (docs/app-store/readiness.md). */
export const IPHONE_APP_URL = "https://apps.apple.com/app/id6818330440";
/**
 * The App Store listing isn't public yet, so its link is a dead page. Until
 * it is, an iPhone taps from the web like any other phone. Turn this on once
 * https://itunes.apple.com/lookup?id=6818330440 returns a result.
 */
export const IPHONE_APP_LIVE = false;
