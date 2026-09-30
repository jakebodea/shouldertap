/**
 * Where this Mac connects. Debug builds use the local `alchemy dev` stack;
 * release builds use production (`alchemy deploy --stage prod`, see
 * domains.ts at the repo root).
 */
const local = {
  serverUrl: "http://localhost:3000",
  webUrl: "http://localhost:3001",
};

const production = {
  serverUrl: "https://api.shouldertap.app",
  webUrl: "https://shouldertap.app",
};

export const endpoints = __DEV__ ? local : production;
