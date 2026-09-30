/**
 * Where this Mac connects. Debug builds use the local `alchemy dev` stack;
 * release builds use the deployed stage.
 */
const local = {
  serverUrl: "http://localhost:3000",
  webUrl: "http://localhost:3001",
};

// `dev` stage from `alchemy deploy --stage dev`.
const deployed = {
  serverUrl: "https://shouldertap-server-dev-rtv4iyushaacenl3.jakebodea.workers.dev",
  webUrl: "https://shouldertap-web-dev-np4ztb2ul2oajd6h.jakebodea.workers.dev",
};

export const endpoints = __DEV__ ? local : deployed;
