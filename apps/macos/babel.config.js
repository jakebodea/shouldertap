module.exports = {
  presets: ["module:@react-native/babel-preset"],
  // Effect ships `export * as X from` re-exports.
  plugins: ["@babel/plugin-transform-export-namespace-from"],
};
