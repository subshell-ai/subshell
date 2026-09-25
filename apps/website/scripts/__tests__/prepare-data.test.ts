import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const appDir = join(import.meta.dir, "..", "..");

describe("prepare-data", () => {
  test("copies the root releases.json into data/ byte-for-byte", () => {
    const proc = Bun.spawnSync(["bun", "scripts/prepare-data.ts"], { cwd: appDir });
    expect(proc.exitCode).toBe(0);

    const source = readFileSync(join(appDir, "..", "..", "releases.json"));
    const baked = readFileSync(join(appDir, "data", "releases.json"));
    expect(baked.equals(source)).toBe(true);
  });
});
