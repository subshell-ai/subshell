import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyReleaseManifest } from "../../packages/subshell-protocol/src/release-signature.js";
import { RELEASE_MANIFEST_NAME, RELEASE_MANIFEST_SIG_NAME } from "../../packages/subshell-protocol/src/releases.js";
import { digestRefusals, stagedBinaryNames } from "../docker-release-verify.ts";

/**
 * The Docker bake gate (`scripts/docker-release-verify.ts`): it must refuse by
 * NAME, and only the signature gate standing between the CLI and the digest
 * layer decides what is reachable end-to-end. The publisher private key lives
 * only in the release shards' CI secrets, so no test here can sign a manifest
 * the REAL pubkey accepts. What is pinned accordingly:
 *
 * - spawn level: (a) a dir with no manifest, (b) tampered manifest bytes with
 *   the fixture signature copied in - both exit 1 naming the refusal;
 * - fixture-key level for the layers below the signature gate: (c) the
 *   version/component claims `verifyReleaseManifest` binds after the sig
 *   (using the protocol fixture's own pubkey, where the fixture signature IS
 *   valid), and (d) the exported `digestRefusals` loop against a supplied
 *   signed-assets map, plus `stagedBinaryNames`' derivation.
 */

const SCRIPT = join(import.meta.dir, "..", "docker-release-verify.ts");
const FIXTURES = join(
  import.meta.dir,
  "..",
  "..",
  "packages/subshell-protocol/src/__tests__/fixtures/release-signature",
);
const fixtureManifest = readFileSync(join(FIXTURES, "release-manifest.json"));
const fixtureSig = readFileSync(join(FIXTURES, "release-manifest.sig"), "utf8");
const fixturePubkey = readFileSync(join(FIXTURES, "publisher-pubkey.txt"), "utf8");

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "docker-verify-"));
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Run the CLI as CI does; returns exit code + combined stderr. */
async function run(dir: string, version: string): Promise<{ code: number; stderr: string }> {
  const proc = Bun.spawn([process.execPath, "run", SCRIPT, dir, version], {
    cwd: join(import.meta.dir, "..", ".."),
    stdout: "pipe",
    stderr: "pipe",
  });
  // `proc.exited`, not `proc.exitCode`: on bun 1.4.0 the latter resolves null
  // for a piped spawn (measured here), and the refusal's exit code is the
  // whole assertion.
  const code = await proc.exited;
  const stderr = await new Response(proc.stderr).text();
  return { code, stderr };
}

describe("docker-release-verify CLI refusals (spawned, as the workflow runs it)", () => {
  test("missing manifest: refused by name", async () => {
    const dir = join(root, "empty");
    mkdirSync(dir, { recursive: true });
    const res = await run(dir, "9.9.9");
    expect(res.code).toBe(1);
    expect(res.stderr).toContain(RELEASE_MANIFEST_NAME);
  });

  test("tampered manifest bytes with the signature copied in: refused, naming the signature", async () => {
    const dir = join(root, "tampered");
    mkdirSync(dir, { recursive: true });
    const tampered = JSON.parse(fixtureManifest.toString("utf8"));
    tampered.version = "9.9.10";
    writeFileSync(join(dir, RELEASE_MANIFEST_NAME), JSON.stringify(tampered, null, 2));
    writeFileSync(join(dir, RELEASE_MANIFEST_SIG_NAME), fixtureSig);
    const res = await run(dir, "9.9.10");
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("signature");
  });

  test("no version argument: usage refusal", async () => {
    const res = await run(root, "");
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("usage");
  });
});

describe("the layers under the signature gate", () => {
  test("the fixture is self-consistent under ITS pubkey, and wrong claims are refused", async () => {
    // Control: the pair verifies, so the refusals below are the claims failing,
    // not broken fixture bytes.
    const good = await verifyReleaseManifest(fixtureManifest, fixtureSig, fixturePubkey, {
      component: "cli-node",
      version: "9.9.9",
    });
    expect(good.ok).toBe(true);

    const wrongVersion = await verifyReleaseManifest(fixtureManifest, fixtureSig, fixturePubkey, {
      component: "cli-node",
      version: "1.2.3",
    });
    expect(wrongVersion.ok).toBe(false);

    // The script's own call pins component cli-server; a node release's
    // signature can never carry it (the replay defense).
    const wrongComponent = await verifyReleaseManifest(fixtureManifest, fixtureSig, fixturePubkey, {
      component: "cli-server",
      version: "9.9.9",
    });
    expect(wrongComponent.ok).toBe(false);
  });

  test("staged names derive from SERVER_TARGETS, not a hardcoded spelling", () => {
    const dir = join(root, "staged");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "subshell-server-cli-linux-x64"), "binary");
    expect(stagedBinaryNames(dir)).toEqual(["subshell-server-cli-linux-x64"]);
  });

  test("digest layer: mismatch refused, name absent from the signed map refused, true digest accepted", () => {
    const dir = join(root, "digests");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "subshell-server-cli-linux-x64"), "one");
    writeFileSync(join(dir, "subshell-server-cli-linux-arm64"), "two");
    const hex = (s: string) => createHash("sha256").update(s).digest("hex");

    const wrong = digestRefusals(dir, {
      "subshell-server-cli-linux-x64": hex("one"),
      "subshell-server-cli-linux-arm64": hex("tampered"),
    });
    expect(wrong.length).toBe(1);
    expect(wrong[0]).toContain("subshell-server-cli-linux-arm64");
    expect(wrong[0]).toContain("is not the signed");

    const absent = digestRefusals(dir, { "subshell-server-cli-linux-x64": hex("one") });
    expect(absent.length).toBe(1);
    expect(absent[0]).toContain("subshell-server-cli-linux-arm64");
    expect(absent[0]).toContain("(absent from the manifest)");

    expect(
      digestRefusals(dir, {
        "subshell-server-cli-linux-x64": hex("one"),
        "subshell-server-cli-linux-arm64": hex("two"),
      }),
    ).toEqual([]);
  });
});
