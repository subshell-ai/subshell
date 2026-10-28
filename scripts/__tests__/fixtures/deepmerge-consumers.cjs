const assert = require("node:assert/strict");
const { createRequire } = require("node:module");
const { resolve } = require("node:path");

const mobile = createRequire(resolve("apps/client/mobile/package.json"));
const expo = createRequire(mobile.resolve("expo/package.json"));
const config = createRequire(expo.resolve("@expo/config/package.json"));
const cjs = config("deepmerge");
const umd = config(resolve(config.resolve("deepmerge/package.json"), "../dist/umd.js"));

for (const merge of [cjs, umd]) {
  const poison = JSON.parse('{"__proto__":{"injected":true}}');
  for (const merged of [
    merge(Object.create(null), poison),
    merge(poison, { safe: true }),
    merge({ nested: null }, { nested: poison }).nested,
    merge({ nested: poison }, {}).nested,
    merge.all([poison, { safe: true }]),
  ]) {
    assert.equal(Object.getPrototypeOf(merged), Object.prototype);
    assert.equal(merged.injected, undefined);
    assert.equal(Object.hasOwn(merged, "__proto__"), false);
  }
  const symbol = Symbol("config");
  const first = { nested: { one: 1 }, values: [1], [symbol]: "kept" };
  const second = { nested: { two: 2 }, values: [2] };
  assert.deepEqual(merge(first, second), { nested: { one: 1, two: 2 }, values: [1, 2], [symbol]: "kept" });
  assert.deepEqual(first.nested, { one: 1 });
  assert.deepEqual(second.nested, { two: 2 });
}
console.log("Deepmerge rejects prototype poisoning and preserves Expo configuration merges");
