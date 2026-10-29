const assert = require("node:assert/strict");
const { createRequire } = require("node:module");
const { mkdtempSync, writeFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const mobile = createRequire(resolve("apps/client/mobile/package.json"));
const router = createRequire(mobile.resolve("expo-router/package.json"));
const query = router("query-string");
assert.deepEqual(
  { ...query.parse("a=hello+world&b=%2B&c=%FF&d=%E2%82%AC") },
  { a: "hello world", b: "+", c: "%FF", d: "€" },
);
assert.equal(query.parse(`a=${"%FF".repeat(100000)}`).a.length, 300000);
// Distinct encoded runs exercise the quadratic fallback in GHSA-qr28-fpjm-wq7f;
// the repeated byte above only exercises one replacement. The parent bounds
// this real consumer's runtime so a vulnerable decoder can't hang the suite.
let distinctRuns = "";
for (let index = 0; index < 64000; index++) {
  const high = Math.floor(index / 256)
    .toString(16)
    .padStart(2, "0");
  const low = (index % 256).toString(16).padStart(2, "0");
  distinctRuns += `%${high}%${low}x`;
}
assert.ok(query.parse(`a=${distinctRuns}%zz`).a.endsWith("%zz"));
assert.equal(
  query.parseUrl("https://example.com/#hello+world", { parseFragmentIdentifier: true }).fragmentIdentifier,
  "hello world",
);
const worklets = createRequire(mobile.resolve("react-native-worklets/package.json"));
const config = createRequire(worklets.resolve("@react-native/metro-config/package.json"));
const metroConfig = createRequire(config.resolve("metro-config/package.json"));
const metro = createRequire(metroConfig.resolve("metro/package.json"));
const assets = metro("./src/Assets.js");
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6z8AAAAASUVORK5CYII=",
  "base64",
);
assert.deepEqual(assets.getAssetSize("png", png), { width: 1, height: 1 });
// A zero-length ICNS entry used to leave the parser's loop at the same offset.
const icns = Buffer.alloc(16);
icns.write("icns");
icns.writeUInt32BE(16, 4);
icns.write("xxxx", 8);
assert.throws(() => metro("image-size").imageSize(icns));
const dir = mkdtempSync(join(tmpdir(), "subshell-deps-"));
(async () => {
  try {
    const file = join(dir, "icon.png");
    writeFileSync(file, png);
    const data = await assets.getAssetData(file, "icon.png", [], null, "/assets");
    assert.equal(data.width, 1);
    assert.equal(data.height, 1);
    const text = join(dir, "sample.txt");
    writeFileSync(text, "ordinary asset");
    assert.equal((await assets.getAssetData(text, "sample.txt", [], null, "/assets")).width, undefined);
    const expoPackage = createRequire(mobile.resolve("expo/package.json"));
    const expo = createRequire(expoPackage.resolve("@expo/config-plugins/package.json"));
    const xcode = expo("xcode");
    const project = xcode.project(join(dir, "test.pbxproj"));
    project.hash = { project: { objects: {} } };
    assert.match(project.generateUuid(), /^[A-F0-9]{24}$/);
    const server = createRequire(resolve("packages/backend-client/package.json"));
    const hashRunner = createRequire(server.resolve("hash-runner"));
    assert.deepEqual(await hashRunner("glob").glob("*.png", { cwd: dir }), ["icon.png"]);
    console.log("Dependency consumer compatibility passed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
