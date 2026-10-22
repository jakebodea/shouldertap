/** Running as a Home Screen web app rather than in a browser tab. */
export const isStandalone = () =>
  window.matchMedia("(display-mode: standalone)").matches ||
  ("standalone" in navigator && navigator.standalone === true);
