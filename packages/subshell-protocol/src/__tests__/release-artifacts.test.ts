import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DESKTOP_TARGETS, nodeArtifactFileName, SERVER_TARGETS, serverArtifactFileName } from "../paths.js";
import {
  assertBunFloor,
  type BuiltArtifact,
  digestFile,
  type NotaryToolDeps,
  notarizeAndStapleDmg,
  parseScope,
  publishArtifacts,
  runSignHook,
  selectBundleOutput,
} from "../release-artifacts.js";
import { semverLt } from "../versions.js";

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
      const path = join(srcDir, nodeArtifactFileName(triple));
      await writeFile(path, `payload-${i}-${triple}`);
      const digest = await digestFile(path);
      artifacts.set(triple, { path, digest });
    }
  });

  test("writes binary + sidecar per target; sidecar is 64-hex + newline, lowercase", async () => {
    const destDir = join(workDir, "dest-clean");
    await publishArtifacts(artifacts, destDir);
    for (const [triple, { path, digest }] of artifacts) {
      const destBin = join(destDir, nodeArtifactFileName(triple));
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
    await writeFile(join(destDir, `${nodeArtifactFileName("linux-x64")}.sha256`), "deadbeef\n");
    await publishArtifacts(artifacts, destDir);
    const sidecar = await Bun.file(join(destDir, `${nodeArtifactFileName("linux-x64")}.sha256`)).text();
    expect(sidecar).toBe(`${(artifacts.get("linux-x64") as { digest: string }).digest}\n`);
    expect(sidecar).not.toContain("deadbeef");
  });

  test("publish into a nonexistent dest dir succeeds (mkdir -p semantics)", async () => {
    const destDir = join(workDir, "nested", "artifacts");
    expect(existsSync(destDir)).toBe(false);
    await publishArtifacts(artifacts, destDir);
    expect(existsSync(join(destDir, nodeArtifactFileName("darwin-arm64")))).toBe(true);
  });

  test("publishes under the artifact file's OWN basename — server-named artifacts coexist (Task E)", async () => {
    const srcDirLocal = join(workDir, "build-server");
    await mkdir(srcDirLocal, { recursive: true });
    const destDir = join(workDir, "dest-mixed");
    const mixed = new Map<string, BuiltArtifact>();
    for (const triple of SERVER_TARGETS) {
      const path = join(srcDirLocal, serverArtifactFileName(triple));
      await writeFile(path, `server-${triple}`);
      mixed.set(triple, { path, digest: await digestFile(path) });
    }
    await publishArtifacts(mixed, destDir);
    const names = (await readdir(destDir)).sort();
    expect(names).toEqual(
      SERVER_TARGETS.flatMap((t) => [serverArtifactFileName(t), `${serverArtifactFileName(t)}.sha256`]).sort(),
    );
  });
});

describe("parseScope (generalized from the client pipeline, Task E)", () => {
  test("undefined/blank → null (the full set)", () => {
    expect(parseScope(undefined, SERVER_TARGETS, "TEST_TRIPLES")).toBeNull();
    expect(parseScope("   ", SERVER_TARGETS, "TEST_TRIPLES")).toBeNull();
  });

  test("whitespace-separated subset passes through unmodified", () => {
    expect(parseScope(" linux-arm64\tdarwin-arm64 ", SERVER_TARGETS, "TEST_TRIPLES")).toEqual([
      "linux-arm64",
      "darwin-arm64",
    ]);
  });

  test("unknown triple throws, naming the env var AND the known set", () => {
    expect(() => parseScope("win32-x64", SERVER_TARGETS, "SUBSHELL_SERVER_RELEASE_TRIPLES")).toThrow(
      /unknown target "win32-x64" in SUBSHELL_SERVER_RELEASE_TRIPLES/,
    );
    expect(() => parseScope("win32-x64", SERVER_TARGETS, "TEST_TRIPLES")).toThrow(/linux-x64/);
  });

  test("darwin-x64 is known to every pipeline that ships it — CLI and desktop alike", () => {
    expect(parseScope("darwin-x64", SERVER_TARGETS, "TEST_TRIPLES")).toEqual(["darwin-x64"]);
    expect(parseScope("darwin-x64", DESKTOP_TARGETS, "TEST_TRIPLES")).toEqual(["darwin-x64"]);
    // and linux-arm64 is STILL unknown to desktop — the no-native-runner rule stands:
    expect(() => parseScope("linux-arm64", DESKTOP_TARGETS, "TEST_TRIPLES")).toThrow(/unknown target/);
  });
});

describe("semverLt / assertBunFloor (bytecode floor, spec 2026-09-03 §5)", () => {
  test("semverLt orders dotted numerics, not strings", () => {
    expect(semverLt("1.3.10", "1.4.0")).toBe(true);
    expect(semverLt("1.4.0", "1.12.3")).toBe(true);
    expect(semverLt("1.4.0", "1.4.0")).toBe(false);
    expect(semverLt("1.4.0", "1.3.99")).toBe(false);
    expect(semverLt("2.0", "2.0.1")).toBe(true);
  });

  test("assertBunFloor accepts the floor and newer, refuses older", () => {
    expect(() => assertBunFloor("1.4.0", "1.4.0")).not.toThrow();
    expect(() => assertBunFloor("1.4.0", "1.12.3")).not.toThrow();
    expect(() => assertBunFloor("1.4.0", "1.4.0-canary1")).not.toThrow(); // suffix ≠ older
    expect(() => assertBunFloor("1.4.0", "1.3.10")).toThrow(/bun 1\.4\.0/);
  });
});

describe("runSignHook (SUBSHELL_RELEASE_SIGN_CMD, darwin release signing)", () => {
  let workDir = "";

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), "subshell-signhook-test-"));
  });

  test("unset/blank env is a silent no-op — linux shards and local builds never shell out", async () => {
    expect(await runSignHook("/any/path", {})).toBe(true);
    expect(await runSignHook("/any/path", { SUBSHELL_RELEASE_SIGN_CMD: "   " })).toBe(true);
  });

  test("the artifact path is appended as the command's argument; its exit code decides", async () => {
    const bin = join(workDir, nodeArtifactFileName("darwin-arm64"));
    await writeFile(bin, "bytes");
    // `test -f <appended path>` — passes iff the artifact path arrived verbatim.
    expect(await runSignHook(bin, { SUBSHELL_RELEASE_SIGN_CMD: "test -f" })).toBe(true);
    expect(await runSignHook(join(workDir, "ghost"), { SUBSHELL_RELEASE_SIGN_CMD: "test -f" })).toBe(false);
    expect(await runSignHook(bin, { SUBSHELL_RELEASE_SIGN_CMD: "exit 7" })).toBe(false);
  });
});

/**
 * The glob that replaced a prediction. Both desktop `productName`s were single
 * tokens only because the `.deb` name Tauri derives from them goes through
 * Debian's sanitizer — unknowable without running the Linux bundler. Reading
 * the directory answers it; the only rule that matters is that an ambiguous
 * answer is a refusal, because publishing an arbitrary bundle under a canonical
 * name looks exactly like a success.
 */
describe("selectBundleOutput", () => {
  test("finds the one artifact, spaces and all", () => {
    expect(selectBundleOutput(["Subshell Client.app"], ".app", "bundle/macos")).toBe("Subshell Client.app");
    expect(
      // Both names are spaced, measured against a real aarch64 bundle: Tauri
      // leaves a staging DIRECTORY beside the artifact named from the same base
      // (`Subshell Client_0.1.0_amd64`, no extension). It is only the `.deb`
      // suffix that tells them apart — which is exactly what this filters on.
      selectBundleOutput(["Subshell Client_0.1.0_amd64", "Subshell Client_0.1.0_amd64.deb"], ".deb", "bundle/deb"),
    ).toBe("Subshell Client_0.1.0_amd64.deb");
  });

  // The DMG is bundled FROM the .app, and a collect must not confuse the two
  // spellings no matter which directory listing they share.
  test("the .app an image was made from is not a second .dmg", () => {
    expect(selectBundleOutput(["Subshell Server.app", "Subshell Server_0.1.0_aarch64.dmg"], ".dmg", "d")).toBe(
      "Subshell Server_0.1.0_aarch64.dmg",
    );
  });

  test("nothing matching is a refusal that says what WAS there", () => {
    expect(() => selectBundleOutput(["rpm", "appimage"], ".deb", "bundle/deb")).toThrow(
      /no \.deb in bundle\/deb; the bundler wrote: rpm, appimage/,
    );
    expect(() => selectBundleOutput([], ".app", "bundle/macos")).toThrow(/\(empty\)/);
  });

  // Never the first of several: an arbitrary artifact published under a
  // canonical name is indistinguishable from a correct cut.
  test("more than one match is a refusal, never a pick", () => {
    expect(() => selectBundleOutput(["a_1_amd64.deb", "b_1_amd64.deb"], ".deb", "bundle/deb")).toThrow(
      /2 \.deb bundles in bundle\/deb, expected exactly one/,
    );
  });
});

/**
 * Tauri signs the DMG and stops; this is the step that makes the image the
 * user downloads notarized AND stapled. The two invariants under test are the
 * ones the repo paid for elsewhere: the verdict is READ from notarytool's
 * output (an exit code has never implied acceptance here), and a staple that
 * did not happen must fail the cut rather than ship a silent gatekeeper wall.
 */
describe("notarizeAndStapleDmg", () => {
  const CREDS = { APPLE_API_KEY_PATH: "/tmp/notary.p8", APPLE_API_KEY: "KEYID", APPLE_API_ISSUER: "ISSUER" };
  const DMG = "/w/bundle/dmg/Subshell Server_0.1.0_aarch64.dmg";

  /** A recording fake: scripted per-command results, nothing executed. */
  function fake(over: { submit?: { code: number; output: string }; staple?: { code: number; output: string } } = {}) {
    const calls: string[][] = [];
    const deps: NotaryToolDeps = {
      runCapture: async (argv) => {
        calls.push(argv);
        if (argv[2] === "submit") return over.submit ?? { code: 0, output: "Current status: Accepted." };
        return over.staple ?? { code: 0, output: "The asset has been successfully stapled." };
      },
      log: () => {},
    };
    return { deps, calls };
  }

  test("no credentials is a skip, not a failure — and nothing runs", async () => {
    const f = fake();
    expect(await notarizeAndStapleDmg(DMG, f.deps, {})).toBe(true);
    expect(f.calls).toEqual([]);
  });

  // Partial credentials are as unusable as none, and reading only one of the
  // three would silently notarize with the wrong identity's key.
  test("any credential missing is a skip", async () => {
    for (const partial of [{}, { APPLE_API_KEY_PATH: "/k.p8" }, { APPLE_API_KEY_PATH: "/k.p8", APPLE_API_KEY: "ID" }]) {
      const f = fake();
      expect(await notarizeAndStapleDmg(DMG, f.deps, partial)).toBe(true);
      expect(f.calls).toEqual([]);
    }
  });

  test("submits the IMAGE with the three credentials and --wait", async () => {
    const f = fake();
    expect(await notarizeAndStapleDmg(DMG, f.deps, CREDS)).toBe(true);
    expect(f.calls[0]).toEqual([
      "xcrun",
      "notarytool",
      "submit",
      DMG,
      "--key",
      "/tmp/notary.p8",
      "--key-id",
      "KEYID",
      "--issuer",
      "ISSUER",
      "--wait",
    ]);
    expect(f.calls[1]).toEqual(["xcrun", "stapler", "staple", DMG]);
  });

  // The exact failure the exit-code rule exists for: notarytool has exited 0
  // while reporting an unaccepted submission.
  test("an exit-0 Invalid verdict refuses, and nothing is stapled", async () => {
    const f = fake({ submit: { code: 0, output: "Current status: Invalid. The binary is signed..." } });
    expect(await notarizeAndStapleDmg(DMG, f.deps, CREDS)).toBe(false);
    expect(f.calls).toHaveLength(1);
  });

  test("a submission that did not even finish refuses", async () => {
    const f = fake({ submit: { code: 1, output: "connection reset" } });
    expect(await notarizeAndStapleDmg(DMG, f.deps, CREDS)).toBe(false);
    expect(f.calls).toHaveLength(1);
  });

  // Accepted but never stapled = Gatekeeper answers online or not at all;
  // Tauri's own silent-staple failure is the precedent this refuses.
  test("a failed staple fails the cut AFTER acceptance", async () => {
    const f = fake({ staple: { code: 7, output: "Could not open package" } });
    expect(await notarizeAndStapleDmg(DMG, f.deps, CREDS)).toBe(false);
    expect(f.calls).toHaveLength(2);
  });
});
