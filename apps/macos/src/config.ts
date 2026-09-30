/**
 * Where this Mac connects. Debug builds use the local `alchemy dev` stack;
 * release builds use the deployed stage.
 */
const local = {
  serverUrl: "http://localhost:3000",
  webUrl: "http://localhost:3001",
};

const deployed = {
  serverUrl: "http://localhost:3000",
  webUrl: "http://localhost:3001",
};

export const endpoints = __DEV__ ? local : deployed;
