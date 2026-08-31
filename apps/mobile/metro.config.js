// Metro needs no monorepo wiring here. SDK 57 walks up to the workspace root
// itself (`@expo/metro-config/build/ExpoMetroConfig.js` moves the server root
// down to the monorepo root), which is what lets this app import the
// `@internal/*` packages by name.
//
// The `withMonorepoConfiguration(require("expo/metro-config/monorepo"))` recipe
// that SDK 52-54 documentation still shows does not exist in 57 — the subpath
// is not exported and `expo export` fails at config load with "Cannot find
// module". Left here so the next person does not re-add it from a blog post.
const { getDefaultConfig } = require("expo/metro-config");

module.exports = getDefaultConfig(__dirname);
