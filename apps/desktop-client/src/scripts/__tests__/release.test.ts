import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AGENT_SIDECAR_NAME,
  DESKTOP_CLIENT_PRODUCT,
  DESKTOP_SERVER_PRODUCT,
  DESKTOP_TARGETS,
  desktopArtifactFileName,
  desktopSidecarFileName,
  nodeArtifactFileName,
  rustTargetTriple,
} from "@internal/subshell-protocol";
import {
  assertBundleSet,
  bundleArtifact,
  bundleKind,
  collectArtifact,
  DESKTOP_RELEASE_DIR_ENV,
  type DesktopReleaseDeps,
  hostTarget,
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
 * so it lands in apps/client/apps/desktop-client/…), a surplus bundle (which
 * the publish glob would ship), and the bundle-path → artifact-name mapping,
 * which is the piece a Tauri upgrade moves.
 *
 * `tauri build`'s own argv is deliberately NOT pinned — that is Tauri's
 * contract, not ours, and a test of it only breaks on upgrades.
 */

/** A recording stub: every effect captured, nothing executed. */
function stub(over: Partial<DesktopReleaseDeps> & { built?: boolean; listing?: string[] } = {}) {
  const runs: { argv: string[]; cwd: string; env?: Record<string, string> }[] = [];
  const removed: string[] = [];
  const moves: [string, string][] = [];
  const logs: string[] = [];
  const listed: string[] = [];
  const { built = true, listing = [], ...rest } = over;
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
    // What `tauri build` left behind, as the pipeline would read it — the
    // artifact name is DISCOVERED here, never predicted.
    list: async (dir) => {
      listed.push(dir);
      return listing;
    },
    log: (l) => logs.push(l),
    ...rest,
  };
  return { deps, runs, removed, moves, logs, listed };
}

describe("stageSidecar", () => {
  test("builds the AGENT with compile:release, never compile", async () => {
    const s = stub();
    expect(await stageSidecar(s.deps, "darwin-arm64")).toBe(true);
    // `compile` is the host-only dev build — no cross target and no
    // --bytecode, so a darwin bundle built on a Linux shard would carry an ELF.
    expect(s.runs[0]?.argv).toEqual(["bun", "run", "--cwd", "apps/client", "compile:release"]);
  });

  // resolveArtifactsDir() on the agent side resolves in the CHILD's cwd, so a
  // relative override would land in apps/client/apps/desktop-client/…
  test("passes an ABSOLUTE publish directory", async () => {
    const s = stub();
    await stageSidecar(s.deps, "darwin-arm64");
    const dir = s.runs[0]?.env?.SUBSHELL_NODE_ARTIFACTS_DIR;
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
    expect(s.runs[0]?.env?.SUBSHELL_RELEASE_TRIPLES).toBe("linux-x64");
  });

  // The staged file carries the RUST triple; Tauri strips it on copy.
  test("renames the built agent to the name externalBin expects", async () => {
    const s = stub();
    await stageSidecar(s.deps, "darwin-arm64");
    expect(s.moves).toEqual([
      [
        join(SIDECAR_DIR, nodeArtifactFileName("darwin-arm64")),
        join(SIDECAR_DIR, desktopSidecarFileName(AGENT_SIDECAR_NAME, "darwin-arm64")),
      ],
    ]);
    // Anything grepping for the STAGED name inside a built bundle finds
    // nothing, so the two spellings are worth stating apart.
    expect(s.moves[0]?.[1]).toContain(rustTargetTriple("darwin-arm64"));
    expect(s.moves[0]?.[1]).not.toContain("darwin-arm64");
  });

  // It describes the bytes BEFORE Tauri re-seals them.
  test("deletes the sidecar's own .sha256", async () => {
    const s = stub();
    await stageSidecar(s.deps, "darwin-arm64");
    expect(s.removed).toEqual([`${join(SIDECAR_DIR, nodeArtifactFileName("darwin-arm64"))}.sha256`]);
  });

  test("a failing agent build stages nothing", async () => {
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
  test("each target names one bundler, one output directory and one extension", () => {
    expect(bundleKind("darwin-arm64")).toEqual({ bundles: "app", dir: "macos", suffix: ".app" });
    expect(bundleKind("linux-x64")).toEqual({ bundles: "deb", dir: "deb", suffix: ".deb" });
  });

  test("an unknown target has no bundler", () => {
    expect(() => bundleKind("linux-arm64")).toThrow(/no bundler/);
  });

  // --bundles is the ENFORCEMENT of the target decision: tauri.conf.json only
  // sets a default, and the Linux default includes an AppImage whose bundler
  // downloads linuxdeploy at build time.
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

describe("bundleArtifact", () => {
  const ROOT = "/w/apps/desktop-client/src-tauri/target/release/bundle";

  // The bundler's own name is passed IN (globbed), because Tauri derives it
  // from productName and the Debian one goes through a package-name sanitizer.
  // What is pinned here is the mapping onto the name this repo publishes.
  test("maps the emitted .app to the tarball this repo publishes", () => {
    expect(bundleArtifact(ROOT, "darwin-arm64", "1.2.3", "Subshell Client.app")).toEqual({
      source: `${ROOT}/macos/Subshell Client.app`,
      artifact: `${ROOT}/macos/Subshell-Client.app.tar.gz`,
      archive: true,
    });
  });

  // The .deb is already one file: nothing to archive, only a rename onto the
  // canonical name the smoke and the install docs know.
  test("maps the emitted .deb onto the canonical package name", () => {
    expect(bundleArtifact(ROOT, "linux-x64", "1.2.3", "Subshell Client_1.2.3_amd64.deb")).toEqual({
      source: `${ROOT}/deb/Subshell Client_1.2.3_amd64.deb`,
      artifact: `${ROOT}/deb/subshell-client_1.2.3_amd64.deb`,
      archive: false,
    });
  });

  // Whatever the bundler called it, the published name is ours — that is the
  // point of the glob, and the reason productName may contain a space.
  test("the published name never depends on what the bundler emitted", () => {
    for (const emitted of ["Subshell Client.app", "subshell-client.app", "Whatever.app"]) {
      expect(bundleArtifact(ROOT, "darwin-arm64", "1.2.3", emitted).artifact).toBe(
        `${ROOT}/macos/Subshell-Client.app.tar.gz`,
      );
    }
  });

  // The two desktop apps publish into ONE GitHub release directory per cut.
  // A product name copy-pasted from apps/desktop-server would overwrite that
  // app's asset with this one, and both would still be plausibly named.
  test("names the client product, never the server app's", () => {
    for (const target of DESKTOP_TARGETS) {
      const { artifact } = bundleArtifact(ROOT, target, "1.2.3", `emitted${bundleKind(target).suffix}`);
      expect(artifact).toContain(desktopArtifactFileName(DESKTOP_CLIENT_PRODUCT, target, "1.2.3"));
      expect(artifact).not.toContain(desktopArtifactFileName(DESKTOP_SERVER_PRODUCT, target, "1.2.3"));
    }
  });

  test("has no mapping for a target this app does not build", () => {
    expect(() => bundleArtifact(ROOT, "linux-arm64", "1.2.3", "x.deb")).toThrow(/no bundler/);
  });
});

describe("collectArtifact", () => {
  const ROOT = "/w/bundle";

  // An AppleDouble `._` member surviving into the archive breaks the extracted
  // bundle's signature, and the failure then reads as a signing bug. The
  // spaced `.app` name is one argv element, so nothing has to quote it.
  test("archives the emitted .app with --no-mac-metadata, from its own directory", async () => {
    const s = stub({ listing: ["Subshell Client.app"] });
    const out = await collectArtifact(s.deps, ROOT, "darwin-arm64", "1.2.3");
    expect(s.listed).toEqual([`${ROOT}/macos`]);
    expect(out).toBe(`${ROOT}/macos/Subshell-Client.app.tar.gz`);
    expect(s.runs).toHaveLength(1);
    expect(s.runs[0]?.argv).toEqual([
      "tar",
      "--no-mac-metadata",
      "-czf",
      `${ROOT}/macos/Subshell-Client.app.tar.gz`,
      "-C",
      `${ROOT}/macos`,
      "Subshell Client.app",
    ]);
  });

  // The .deb is renamed rather than re-wrapped: one file already, published
  // under the space-free name the smoke and the install docs know.
  test("renames the emitted .deb onto the published name, archiving nothing", async () => {
    const s = stub({ listing: ["Subshell Client_1.2.3_amd64.deb"] });
    const out = await collectArtifact(s.deps, ROOT, "linux-x64", "1.2.3");
    expect(out).toBe(`${ROOT}/deb/subshell-client_1.2.3_amd64.deb`);
    expect(s.moves).toEqual([[`${ROOT}/deb/Subshell Client_1.2.3_amd64.deb`, out]]);
    expect(s.runs).toEqual([]);
  });

  // The deb staging tree Tauri leaves beside the package is not a candidate.
  test("ignores everything without the bundler's own extension", async () => {
    const s = stub({ listing: ["Subshell Client_1.2.3_amd64", "Subshell Client_1.2.3_amd64.deb"] });
    expect(await collectArtifact(s.deps, ROOT, "linux-x64", "1.2.3")).toBe(
      `${ROOT}/deb/subshell-client_1.2.3_amd64.deb`,
    );
  });

  // Zero and many are BOTH refusals: publishing an arbitrary bundle under a
  // canonical name is indistinguishable from a correct cut.
  test("refuses an empty or ambiguous bundle directory rather than guessing", async () => {
    const empty = stub({ listing: [] });
    await expect(collectArtifact(empty.deps, ROOT, "darwin-arm64", "1.2.3")).rejects.toThrow(/no \.app in/);
    const many = stub({ listing: ["One.app", "Two.app"] });
    await expect(collectArtifact(many.deps, ROOT, "darwin-arm64", "1.2.3")).rejects.toThrow(/expected exactly one/);
    expect(many.runs).toEqual([]);
  });

  // A failed archive must fail the cut: publishing the previous run's tarball
  // would ship an app nobody built.
  test("a failed archive is a failed target", async () => {
    const s = stub({ listing: ["Subshell Client.app"], run: async () => 2 });
    await expect(collectArtifact(s.deps, ROOT, "darwin-arm64", "1.2.3")).rejects.toThrow(/could not archive/);
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

describe("hostTarget", () => {
  // `tauri build` links against the host webview, so a cross-build is not a
  // slow path — it is not a path. A default nobody can run is not a default.
  test("names the one target this machine can build", () => {
    expect(hostTarget("darwin", "arm64")).toBe("darwin-arm64");
    expect(hostTarget("linux", "x64")).toBe("linux-x64");
  });

  test("refuses a host with no buildable target rather than picking one", () => {
    expect(() => hostTarget("darwin", "x64")).toThrow(/cannot be built on darwin-x64/);
    expect(() => hostTarget("win32", "x64")).toThrow(/cannot be built/);
    expect(() => hostTarget("linux", "arm64")).toThrow(/cannot be built/);
  });

  test("every host target is a real desktop target", () => {
    for (const [platform, arch] of [
      ["darwin", "arm64"],
      ["linux", "x64"],
    ] as const) {
      expect(DESKTOP_TARGETS).toContain(hostTarget(platform, arch) as never);
    }
  });
});

describe("productName", () => {
  const CONF = JSON.parse(readFileSync(join(import.meta.dir, "../../../src-tauri/tauri.conf.json"), "utf8"));

  // The bundler names the `.app` directory from `productName`, and this
  // pipeline tars whatever it finds — so a drift here would not break the
  // build. It would publish `Subshell-Client.app.tar.gz` containing an `.app`
  // called something else, which is a worse failure: a silent one.
  test("is the product name the release contract publishes under", () => {
    expect(CONF.productName).toBe(DESKTOP_CLIENT_PRODUCT);
  });

  /**
   * An identifier is an identity, not a label — it keys the macOS settings
   * directory, the notification permission grant, the single-instance lock and
   * the window-state store, and macOS tracks an app BY it. Pinned so a change
   * to any of that is a deliberate edit here rather than a silent one, and so
   * it stays distinct from `apps/desktop-server`'s: the two apps are installed
   * side by side and must not share a settings file.
   */
  test("the bundle identifier matches the product name and is this app's own", () => {
    expect(CONF.identifier).toBe("dev.subshell.client");
    expect(CONF.identifier).not.toBe("dev.subshell.server");
    expect(CONF.productName).toContain("Client");
  });
});
