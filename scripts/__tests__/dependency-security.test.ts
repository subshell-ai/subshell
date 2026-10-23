import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

test("security overrides preserve Node consumers and reject malformed inputs promptly", () => {
  // Metro runs under Node, whose CommonJS/ESM interoperability differs from Bun's.
  const result = spawnSync("node", [fileURLToPath(new URL("./fixtures/dependency-consumers.cjs", import.meta.url))], {
    cwd: fileURLToPath(new URL("../../", import.meta.url)),
    encoding: "utf8",
    timeout: 10_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("Dependency consumer compatibility passed");
}, 15_000);

/** True when `version` sorts below `fixed` (both plain major.minor.patch). */
function olderThan(version: string, fixed: string): boolean {
  const a = version.split(".").map(Number);
  const b = fixed.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) < (b[i] ?? 0);
  }
  return false;
}

test("zod resolves to the patched version everywhere except the @expo/cli 3.x copy", () => {
  // GHSA-mrhx-c7xc-m3w5 is fixed at 4.6.6. The root "zod@4" override pins
  // every 4.x consumer to it, and the ignore file allows the one copy that
  // cannot be patched: zod@3 under @expo/cli (mobile build tooling). That
  // entry matches by package name, so it would also mask a new unpatched
  // 4.x copy. This check is the version-aware half: no resolution may sit
  // below 4.6.6 except that single @expo/cli copy.
  const lock = readFileSync(new URL("../../bun.lock", import.meta.url), "utf8");
  const copies = [...lock.matchAll(/"((?:[^"]*\/)?zod)":\s*\["zod@(\d+\.\d+\.\d+)"/g)].map((m) => ({
    key: m[1] ?? "",
    version: m[2] ?? "",
  }));
  expect(copies.length).toBeGreaterThan(0);
  const belowFix = copies.filter((c) => olderThan(c.version, "4.6.6"));
  expect(belowFix).toEqual([{ key: "@expo/cli/zod", version: "3.25.76" }]);
});
