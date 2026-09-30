// biome-ignore-all lint/correctness/noGlobalDirnameFilename: Metro loads this file as CommonJS
const path = require("node:path");
const { getDefaultConfig, mergeConfig } = require("@react-native/metro-config");

const repoRoot = path.resolve(__dirname, "../..");
const shared = (name) => path.join(repoRoot, "packages", name);

const defaults = getDefaultConfig(__dirname);
// Includes the CLI's react-native → react-native-macos redirect; keep it.
const baseResolve = defaults.resolver.resolveRequest;

/**
 * The Mac app lives outside the Bun workspace (CocoaPods and Metro want a
 * hoisted node_modules) and compiles shared TypeScript packages from source.
 * `effect`, even when imported from those packages, resolves to this app's
 * node_modules so the bundle has exactly one copy.
 *
 * @type {import('@react-native/metro-config').MetroConfig}
 */
const config = {
  watchFolders: [shared("domain"), shared("client")],
  resolver: {
    nodeModulesPaths: [path.join(__dirname, "node_modules")],
    extraNodeModules: {
      "@shouldertap/domain": shared("domain"),
      "@shouldertap/client": shared("client"),
    },
    resolveRequest: (context, moduleName, platform) => {
      const resolve = baseResolve ?? context.resolveRequest;
      if (moduleName === "effect" || moduleName.startsWith("effect/")) {
        return resolve(
          {
            ...context,
            originModulePath: path.join(__dirname, "index.js"),
          },
          moduleName,
          platform
        );
      }
      return resolve(context, moduleName, platform);
    },
  },
};

module.exports = mergeConfig(defaults, config);
