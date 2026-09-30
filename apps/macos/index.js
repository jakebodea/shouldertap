import "./src/polyfills";

import { AppRegistry } from "react-native";

import { MenuBar } from "./src/menu-bar";
import { Overlay } from "./src/overlay";
import { store } from "./src/store";

// Two root components share one JS runtime and one store: the menu-bar
// popover, and the overlay the native side mounts on every display.
AppRegistry.registerComponent("MenuBar", () => MenuBar);
AppRegistry.registerComponent("Overlay", () => Overlay);

store.start();

if (__DEV__) {
  // Handle for poking at state from a debugger.
  globalThis.__shouldertap = { store, native: require("./src/native").native };
}
