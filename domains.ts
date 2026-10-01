/**
 * Public hostnames. Only the `prod` stage attaches them; every other stage
 * stays on its `workers.dev` URLs.
 */
/** Registered with Cloudflare Registrar, which created this zone. */
export const zoneId = "67ca54dc8d4b36bf46486ad14875914d";

export const domains = {
  web: "shouldertap.app",
  api: "api.shouldertap.app",
  downloads: "download.shouldertap.app",
} as const;

/** Inbound only: Email Routing hands it to the Support Worker. */
export const supportEmail = `support@${domains.web}`;

export const isProduction = (stage: string) => stage === "prod";

/** Always the newest Mac build; scripts/release-mac.sh overwrites it. */
export const macDownloadUrl = `https://${domains.downloads}/Shouldertap.dmg`;
