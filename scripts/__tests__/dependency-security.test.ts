import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
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
