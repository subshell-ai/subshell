import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BuiltArtifact, digestFile, publishArtifacts } from "../release-artifacts.js";

describe("publishArtifacts", () => {
  let workDir = "";
  let srcDir = "";
  let artifacts: Map<string, BuiltArtifact>;

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), "subshell-publish-test-"));
    srcDir = join(workDir, "build");
    await mkdir(srcDir, { recursive: true });
    artifacts = new Map();
    for (const [i, triple] of (["linux-x64", "darwin-arm64"] as const).entries()) {
      const path = join(srcDir, `subshell-${triple}`);
      await writeFile(path, `payload-${i}-${triple}`);
      const digest = await digestFile(path);
      artifacts.set(triple, { path, digest });
    }
  });

  test("writes binary + sidecar per target; sidecar is 64-hex + newline, lowercase", async () => {
    const destDir = join(workDir, "dest-clean");
    await publishArtifacts(artifacts, destDir);
    for (const [triple, { path, digest }] of artifacts) {
      const destBin = join(destDir, `subshell-${triple}`);
      expect(await Bun.file(destBin).text()).toBe(await Bun.file(path).text());
      const sidecar = await Bun.file(`${destBin}.sha256`).text();
      expect(sidecar).toBe(`${digest}\n`);
      expect(sidecar.trim()).toMatch(/^[0-9a-f]{64}$/);
    }
    // Atomic publish leaves no temp debris behind.
    const names = await readdir(destDir);
    expect(names.filter((n) => n.includes(".tmp-"))).toEqual([]);
  });

  test("a stale garbage sidecar at dest is regenerated, never reused", async () => {
    const destDir = join(workDir, "dest-stale");
    await mkdir(destDir, { recursive: true });
    await writeFile(join(destDir, "subshell-linux-x64.sha256"), "deadbeef\n");
    await publishArtifacts(artifacts, destDir);
    const sidecar = await Bun.file(join(destDir, "subshell-linux-x64.sha256")).text();
    expect(sidecar).toBe(`${(artifacts.get("linux-x64") as { digest: string }).digest}\n`);
    expect(sidecar).not.toContain("deadbeef");
  });

  test("publish into a nonexistent dest dir succeeds (mkdir -p semantics)", async () => {
    const destDir = join(workDir, "nested", "artifacts");
    expect(existsSync(destDir)).toBe(false);
    await publishArtifacts(artifacts, destDir);
    expect(existsSync(join(destDir, "subshell-darwin-arm64"))).toBe(true);
  });
});
