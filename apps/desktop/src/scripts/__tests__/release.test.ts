import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { DESKTOP_TARGETS, desktopSidecarFileName, serverArtifactFileName } from "@internal/subshell-protocol";
import {
  assertBundleSet,
  bundleKind,
  DESKTOP_RELEASE_DIR_ENV,
  type DesktopReleaseDeps,
  resolveReleaseDir,
  SIDECAR_DIR,
  stageSidecar,
  tauriBuildArgs,
} from "../release.js";

/**
 * The parts of this pipeline worth pinning are the ones whose failure is
 * INVISIBLE: a sidecar staged under the wrong name (cargo says "binary not
 * found" pointing at a path that looks right), a signing hook inherited from
 * the CI shard (wall-clock spent signing bytes Tauri re-seals, plus a digest
 * that matches nothing), a relative publish dir (resolved in the CHILD's cwd,
 * so it lands in apps/server/apps/desktop/…), and a surplus bundle (which the
 * publish glob would ship).
 *
 * `tauri build`'s own argv is deliberately NOT pinned — that is Tauri's
 * contract, not ours, and a test of it only breaks on upgrades.
 */

/** A recording stub: every effect captured, nothing executed. */
function stub(over: Partial<DesktopReleaseDeps> & { built?: boolean } = {}) {
  const runs: { argv: string[]; cwd: string; env?: Record<string, string> }[] = [];
  const removed: string[] = [];
  const moves: [string, string][] = [];
  const logs: string[] = [];
  const { built = true, ...rest } = over;
  const deps: DesktopReleaseDeps = {
    run: async (argv, cwd, env) => {
      runs.push({ argv, cwd, env });
      return 0;
    },
    exists: () => built,
    remove: async (p) => {
      removed.push(p);
    },
    move: async (a, b) => {
      moves.push([a, b]);
    },
    log: (l) => logs.push(l),
    ...rest,
  };
  return { deps, runs, removed, moves, logs };
}

describe("stageSidecar", () => {
  test("builds the SERVER with compile:release, never compile", async () => {
    const s = stub();
    expect(await stageSidecar(s.deps, "darwin-arm64")).toBe(true);
    // `compile` ships the tracked embedded-web stub, and the binary then
    // throws at boot on a machine with no apps/frontend/dist.
    expect(s.runs[0]?.argv).toEqual(["bun", "run", "--cwd", "apps/server", "compile:release"]);
  });

  // resolveArtifactsDir() on the server side resolves in the CHILD's cwd, so a
  // relative override would land in apps/server/apps/desktop/…
  test("passes an ABSOLUTE publish directory", async () => {
    const s = stub();
    await stageSidecar(s.deps, "darwin-arm64");
    const dir = s.runs[0]?.env?.SUBSHELL_SERVER_RELEASE_DIR;
    expect(dir).toBe(SIDECAR_DIR);
    expect(dir?.startsWith("/")).toBe(true);
  });

  // Tauri re-signs nested binaries with --force under the bundle's identity,
  // so a prior signature is overwritten and a prior ticket binds to a cdhash
  // that no longer exists.
  test("clears the signing hook for the nested build", async () => {
    const s = stub();
    await stageSidecar(s.deps, "darwin-arm64");
    expect(s.runs[0]?.env?.SUBSHELL_RELEASE_SIGN_CMD).toBe("");
  });

  test("scopes the nested build to the one triple being staged", async () => {
    const s = stub();
    await stageSidecar(s.deps, "linux-x64");
    expect(s.runs[0]?.env?.SUBSHELL_SERVER_RELEASE_TRIPLES).toBe("linux-x64");
  });

  // The staged file carries the RUST triple; Tauri strips it on copy.
  test("renames the built server to the name externalBin expects", async () => {
    const s = stub();
    await stageSidecar(s.deps, "darwin-arm64");
    expect(s.moves).toEqual([
      [
        join(SIDECAR_DIR, serverArtifactFileName("darwin-arm64")),
        join(SIDECAR_DIR, desktopSidecarFileName("darwin-arm64")),
      ],
    ]);
  });

  // It describes the bytes BEFORE Tauri re-seals them.
  test("deletes the sidecar's own .sha256", async () => {
    const s = stub();
    await stageSidecar(s.deps, "darwin-arm64");
    expect(s.removed).toEqual([`${join(SIDECAR_DIR, serverArtifactFileName("darwin-arm64"))}.sha256`]);
  });

  test("a failing server build stages nothing", async () => {
    const s = stub({ run: async () => 1 });
    expect(await stageSidecar(s.deps, "darwin-arm64")).toBe(false);
    expect(s.moves).toEqual([]);
  });

  // A build that reports success but produced no file must not be renamed into
  // a missing sidecar that cargo then reports as "binary not found".
  test("a missing artifact after a successful build is a failure", async () => {
    const s = stub({ built: false });
    expect(await stageSidecar(s.deps, "darwin-arm64")).toBe(false);
    expect(s.moves).toEqual([]);
  });
});

describe("bundle selection", () => {
  test("each target names one bundler and one output directory", () => {
    expect(bundleKind("darwin-arm64")).toEqual({ bundles: "app", dir: "macos" });
    expect(bundleKind("linux-x64")).toEqual({ bundles: "deb", dir: "deb" });
  });

  test("an unknown target has no bundler", () => {
    expect(() => bundleKind("linux-arm64")).toThrow(/no bundler/);
  });

  // --bundles is the ENFORCEMENT of the target decision: tauri.conf.json only
  // sets a default, and the Linux default is deb+rpm+appimage.
  test("the build always passes --bundles explicitly", () => {
    for (const target of DESKTOP_TARGETS) {
      expect(tauriBuildArgs(target)).toContain("--bundles");
      expect(tauriBuildArgs(target)).toContain(bundleKind(target).bundles);
    }
  });
});

describe("assertBundleSet", () => {
  test("accepts exactly the requested bundle", () => {
    expect(() => assertBundleSet(["macos"], "darwin-arm64")).not.toThrow();
    expect(() => assertBundleSet(["deb"], "linux-x64")).not.toThrow();
  });

  // The publish glob takes everything under the artifact directory, so a
  // surplus bundle is shipped rather than ignored.
  test("refuses a surplus bundle rather than shipping it", () => {
    expect(() => assertBundleSet(["deb", "appimage"], "linux-x64")).toThrow(/unexpected bundle output/);
    expect(() => assertBundleSet(["macos", "dmg"], "darwin-arm64")).toThrow(/dmg/);
  });

  test("refuses a missing bundle", () => {
    expect(() => assertBundleSet([], "linux-x64")).toThrow(/no deb bundle/);
  });
});

describe("resolveReleaseDir", () => {
  test("honours the env override, resolved to an absolute path", () => {
    const dir = resolveReleaseDir({ [DESKTOP_RELEASE_DIR_ENV]: "dist-rel" });
    expect(dir.startsWith("/")).toBe(true);
    expect(dir.endsWith("dist-rel")).toBe(true);
  });

  test("falls back to the repo's dist-rel", () => {
    const dir = resolveReleaseDir({});
    expect(dir.endsWith("/dist-rel")).toBe(true);
  });

  test("an empty override is not an override", () => {
    expect(resolveReleaseDir({ [DESKTOP_RELEASE_DIR_ENV]: "" })).toBe(resolveReleaseDir({}));
  });
});
