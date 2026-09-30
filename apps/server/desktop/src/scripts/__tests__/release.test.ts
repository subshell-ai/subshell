import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DESKTOP_CLIENT_PRODUCT,
  DESKTOP_SERVER_BUNDLE_ID,
  DESKTOP_SERVER_PRODUCT,
  DESKTOP_TARGETS,
  desktopArtifactFileName,
  desktopSidecarFileName,
  RELEASE_MANIFEST_NAME,
  RELEASE_MANIFEST_SIG_NAME,
  type ReleaseManifest,
  SERVER_SIDECAR_NAME,
  SERVER_TARGETS,
  serverArtifactFileName,
} from "@internal/subshell-protocol";

/** The cli-server version the stubbed apps/server/api/package.json reports. */
const STUB_CLI_VERSION = "9.9.9";
/** The digest every stubbed asset matches unless a test overrides `digest`. */
const STUB_DIGEST = "ab".repeat(32);
/** The signed assets map the stubbed verify hands back: every target matches. */
const STUB_ASSETS = Object.fromEntries(SERVER_TARGETS.map((t) => [serverArtifactFileName(t), STUB_DIGEST]));
/** Download URLs the stubbed index hands out; the bytes come back by name. */
const stubUrl = (name: string) => `https://dl.invalid/${name}`;
/** The full asset index of a published release, as the API would answer. */
function stubIndex() {
  return {
    status: 200,
    draft: false,
    assets: Object.fromEntries(
      [...Object.keys(STUB_ASSETS), RELEASE_MANIFEST_NAME, RELEASE_MANIFEST_SIG_NAME].map((n) => [n, stubUrl(n)]),
    ) as Record<string, string>,
  };
}

import {
  assertBundleSet,
  assertUpdaterPubkey,
  bundleArtifact,
  bundleKind,
  bundleRootFor,
  cliReleaseVersion,
  collectArtifact,
  collectUpdaterArtifact,
  DESKTOP_RELEASE_DIR_ENV,
  type DesktopReleaseDeps,
  hostTarget,
  resolveReleaseDir,
  SIDECAR_DIR,
  stageSidecar,
  tauriBuildArgs,
  UPDATER_PUBKEY_PLACEHOLDER,
  updaterSource,
} from "../release.js";

/**
 * The parts of this pipeline worth pinning are the ones whose failure is
 * INVISIBLE: a sidecar staged under the wrong name (cargo says "binary not
 * found" pointing at a path that looks right), a signing hook inherited from
 * the CI shard (wall-clock spent signing bytes Tauri re-seals, plus a digest
 * that matches nothing), a relative publish dir (resolved in the CHILD's cwd,
 * so it lands in apps/server/api/apps/server/desktop/…), a surplus bundle (which the
 * publish glob would ship), and the emitted-bundle → published-name mapping,
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
  const reads: string[] = [];
  let verifyArgs: { component: string; version: string } | undefined;
  const writes: [string, string][] = [];
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
    // The updater `.sig`, whose bytes travel INLINE in `latest.<triple>.json`.
    // Path-aware like the real reader: the fetch path reads the CLI's
    // package.json (the version it must download). The manifest pair
    // travels through fetchBytes, never through here.
    read: async (p) => {
      reads.push(p);
      if (p.includes("server/api/package.json")) return JSON.stringify({ version: STUB_CLI_VERSION });
      return "untrusted comment: signature from tauri secret key\nSIGNATURE\n";
    },
    digest: async () => STUB_DIGEST,
    fetchIndex: async () => stubIndex(),
    fetchBytes: async (url) => ({ status: 200, bytes: new TextEncoder().encode(`bytes-of-${url.split("/").pop()}`) }),
    writeBytes: async (p2, bytes2) => {
      writes.push([p2, `\u0000binary\u0000${bytes2.byteLength}`]);
    },
    verify: async (_manifestText, _sigText, expected) => {
      verifyArgs = expected;
      return { ok: true, manifest: { assets: STUB_ASSETS } as ReleaseManifest };
    },
    write: async (p, text) => {
      writes.push([p, text]);
    },
    runCapture: async () => ({ code: 0, output: "" }),
    log: (l) => logs.push(l),
    ...rest,
  };
  return {
    deps,
    runs,
    removed,
    moves,
    logs,
    listed,
    reads,
    writes,
    get verifyArgs() {
      return verifyArgs;
    },
  };
}

describe("stageSidecar", () => {
  test("stages the asset the cli-server release published, verified against the signed manifest", async () => {
    const s = stub();
    expect(await stageSidecar(s.deps, "darwin-arm64")).toBe(true);
    expect(s.verifyArgs?.component).toBe("cli-server");
    expect(s.verifyArgs?.version).toBe(STUB_CLI_VERSION);
    // Pre-clean of BOTH output names before anything is fetched…
    expect(s.removed.slice(0, 2)).toEqual([
      join(SIDECAR_DIR, desktopSidecarFileName(SERVER_SIDECAR_NAME, "darwin-arm64")),
      join(SIDECAR_DIR, serverArtifactFileName("darwin-arm64")),
    ]);
    // …the asset bytes land at the release name…
    expect(
      s.writes.some(
        ([p2, text]) =>
          p2 === join(SIDECAR_DIR, serverArtifactFileName("darwin-arm64")) && text.startsWith("\u0000binary"),
      ),
    ).toBe(true);
    // …and the rename + exec-mode finish it.
    expect(s.moves).toEqual([
      [
        join(SIDECAR_DIR, serverArtifactFileName("darwin-arm64")),
        join(SIDECAR_DIR, desktopSidecarFileName(SERVER_SIDECAR_NAME, "darwin-arm64")),
      ],
    ]);
    expect(s.runs.at(-1)?.argv).toEqual([
      "chmod",
      "0755",
      join(SIDECAR_DIR, desktopSidecarFileName(SERVER_SIDECAR_NAME, "darwin-arm64")),
    ]);
  });

  // The cut order is CLI first; a desktop shard that outran it fails HERE,
  // softly and by name, and main() repeats the tag in its refusal.
  test("an unpublished cli release refuses the shard softly, naming the tag", async () => {
    const s = stub({ fetchIndex: async () => ({ status: 404, assets: {}, draft: false }) });
    expect(await stageSidecar(s.deps, "darwin-arm64")).toBe(false);
    expect(s.moves).toEqual([]);
    expect(s.logs.some((l) => l.includes(`cli-server-v${STUB_CLI_VERSION}`))).toBe(true);
  });

  // A DRAFT is a cut that died between the draft step and the flip: the tags
  // endpoint answers 200 for it to a push-scoped token, but its bytes never
  // shipped and no release page ever offered them. Bundling a draft is what
  // the whole ordering exists to forbid, so this reads HARD, by name.
  test("a draft release is a hard refusal, not a shipped one", async () => {
    const s = stub({ fetchIndex: async () => ({ ...stubIndex(), draft: true }) });
    await expect(stageSidecar(s.deps, "darwin-arm64")).rejects.toThrow(/exists only as a DRAFT release/);
    expect(s.moves).toEqual([]);
  });

  test("a failing lookup is reported with its status, not as a missing release", async () => {
    const s = stub({ fetchIndex: async () => ({ status: 503, assets: {}, draft: false }) });
    expect(await stageSidecar(s.deps, "darwin-arm64")).toBe(false);
    expect(s.logs.some((l) => l.includes("HTTP 503"))).toBe(true);
  });

  // A PUBLISHED release missing an asset every CLI cut carries is a broken
  // release, not a missing one: hard refusal, never "cut the CLI first".
  test("a published release without the manifest pair is a hard refusal", async () => {
    const s = stub({
      fetchIndex: async () => ({
        status: 200,
        assets: { [serverArtifactFileName("darwin-arm64")]: stubUrl("a") },
        draft: false,
      }),
    });
    await expect(stageSidecar(s.deps, "darwin-arm64")).rejects.toThrow(/published without release-manifest\.json/);
  });

  test("an asset the download refuses to hand over is a hard refusal", async () => {
    const s = stub({
      fetchBytes: async (url) =>
        url.includes("darwin-arm64")
          ? { status: 500, bytes: undefined }
          : { status: 200, bytes: new TextEncoder().encode("x") },
    });
    await expect(stageSidecar(s.deps, "darwin-arm64")).rejects.toThrow(/answered HTTP 500/);
  });

  test("an asset whose digest is not the signed one is a hard refusal", async () => {
    const s = stub({ digest: async () => "cd".repeat(32) });
    await expect(stageSidecar(s.deps, "darwin-arm64")).rejects.toThrow(/is not the signed/);
    expect(s.moves).toEqual([]);
  });

  test("a manifest the publisher key does not vouch for is a hard refusal", async () => {
    const s = stub({ verify: async () => ({ ok: false, reason: "bad sig" }) });
    await expect(stageSidecar(s.deps, "darwin-arm64")).rejects.toThrow(/does not verify: bad sig/);
    expect(s.moves).toEqual([]);
  });

  test("the source escape still builds with compile:release, scoped and unsigned", async () => {
    process.env.SUBSHELL_SIDECAR_FROM_SOURCE = "1";
    try {
      const s = stub();
      expect(await stageSidecar(s.deps, "linux-x64")).toBe(true);
      // `compile` ships a host-only binary with no cross target and no
      // --bytecode; the release build (and this escape) always uses
      // compile:release. The publish dir must be ABSOLUTE (the child resolves
      // in its own cwd), scoped to one triple, sign hook CLEARED.
      expect(s.runs[0]?.argv).toEqual(["bun", "run", "--cwd", "apps/server/api", "compile:release"]);
      expect(s.runs[0]?.env?.SUBSHELL_SERVER_RELEASE_DIR).toBe(SIDECAR_DIR);
      expect(s.runs[0]?.env?.SUBSHELL_SERVER_RELEASE_TRIPLES).toBe("linux-x64");
      expect(s.runs[0]?.env?.SUBSHELL_RELEASE_SIGN_CMD).toBe("");
      expect(s.removed).toEqual([
        `${join(SIDECAR_DIR, serverArtifactFileName("linux-x64"))}.sha256`,
        join(SIDECAR_DIR, RELEASE_MANIFEST_NAME),
        join(SIDECAR_DIR, RELEASE_MANIFEST_SIG_NAME),
      ]);
      expect(s.moves).toEqual([
        [
          join(SIDECAR_DIR, serverArtifactFileName("linux-x64")),
          join(SIDECAR_DIR, desktopSidecarFileName(SERVER_SIDECAR_NAME, "linux-x64")),
        ],
      ]);
    } finally {
      delete process.env.SUBSHELL_SIDECAR_FROM_SOURCE;
    }
  });
});

// The exact-version guard on the fetch path: a prerelease version would name
// a tag no rail ever publishes, and the soft refusal would then lie about a
// false premise.
describe("cliReleaseVersion", () => {
  test("a prerelease version is refused before any fetch", async () => {
    const s = stub({ read: async () => JSON.stringify({ version: "9.9.9-beta.1" }) });
    await expect(cliReleaseVersion(s.deps)).rejects.toThrow(/no usable release version/);
  });

  test("a plain semver version passes", async () => {
    const s = stub();
    expect(await cliReleaseVersion(s.deps)).toBe(STUB_CLI_VERSION);
  });
});

describe("bundle selection", () => {
  test("each target names one bundler, one output directory and one extension", () => {
    // `app,dmg`, not `dmg` — MEASURED 2026-09-15: with `dmg` alone the
    // bundler emits no updater artifact and then deletes the `.app` it built
    // the image from. `dir` stays `dmg`, because the image is still the one
    // thing published under this repo's name.
    expect(bundleKind("darwin-arm64")).toEqual({
      bundles: "app,dmg",
      dir: "dmg",
      suffix: ".dmg",
      intermediates: ["macos", "share"],
    });
    expect(bundleKind("linux-x64")).toEqual({ bundles: "deb", dir: "deb", suffix: ".deb", intermediates: [] });
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

  // --target is the same class of enforcement: a shard scoped to one triple
  // that silently built the RUNNER's arch instead would rename a native binary
  // to the cross triple's published name — an x86_64 label on an arm64 Mach-O,
  // which Gatekeeper, the digest, and every Intel Mac would meet for the first
  // time. Explicit for every target, including the host's own.
  test("the build always passes --target with the Rust triple", () => {
    expect(tauriBuildArgs("darwin-arm64")).toEqual(expect.arrayContaining(["--target", "aarch64-apple-darwin"]));
    expect(tauriBuildArgs("darwin-x64")).toEqual(expect.arrayContaining(["--target", "x86_64-apple-darwin"]));
    expect(tauriBuildArgs("linux-x64")).toEqual(expect.arrayContaining(["--target", "x86_64-unknown-linux-gnu"]));
  });

  // The mirror of that rule: cargo writes `--target` output under the triple,
  // always — a native `--target` build does NOT land in the bare release/ dir.
  // One formula for every triple, or the arm64 shard reads a stale dir.
  test("the bundle root follows the target, not the host", () => {
    expect(bundleRootFor("darwin-arm64").endsWith(join("target", "aarch64-apple-darwin", "release", "bundle"))).toBe(
      true,
    );
    expect(bundleRootFor("darwin-x64").endsWith(join("target", "x86_64-apple-darwin", "release", "bundle"))).toBe(true);
    expect(bundleRootFor("linux-x64").endsWith(join("target", "x86_64-unknown-linux-gnu", "release", "bundle"))).toBe(
      true,
    );
  });
});

describe("the Intel Mac target", () => {
  test("bundleKind ships the same DMG shape as the Apple silicon Mac", () => {
    expect(bundleKind("darwin-x64")).toEqual({
      bundles: "app,dmg",
      dir: "dmg",
      suffix: ".dmg",
      intermediates: ["macos", "share"],
    });
  });

  test("an Intel dev host is buildable natively", () => {
    expect(hostTarget("darwin", "x64")).toBe("darwin-x64");
  });

  test("its updater artifact is the .app.tar.gz beside the image", () => {
    expect(updaterSource("/root", "darwin-x64", DESKTOP_SERVER_PRODUCT, "x.deb")).toBe(
      join("/root", "macos", `${DESKTOP_SERVER_PRODUCT}.app.tar.gz`),
    );
  });

  test("its sidecar stages under the x86_64 Rust triple", async () => {
    const s = stub();
    expect(await stageSidecar(s.deps, "darwin-x64")).toBe(true);
    expect(s.moves[0]?.[1]).toBe(join(SIDECAR_DIR, desktopSidecarFileName(SERVER_SIDECAR_NAME, "darwin-x64")));
  });
});

describe("assertBundleSet", () => {
  test("accepts the requested bundle, plus the DMG's .app intermediate", () => {
    // `share` is create-dmg's staging area the dmg bundler fills — a real
    // measured output of `tauri build --bundles dmg`, tolerated like macos/.
    expect(() => assertBundleSet(["dmg", "macos", "share"], "darwin-arm64")).not.toThrow();
    expect(() => assertBundleSet(["deb"], "linux-x64")).not.toThrow();
  });

  // The publish glob takes everything under the artifact directory, so a
  // surplus bundle is shipped rather than ignored. `macos` is tolerated ONLY
  // as the intermediate the DMG is built from — its contents are never read.
  test("refuses a surplus bundle rather than shipping it", () => {
    expect(() => assertBundleSet(["deb", "appimage"], "linux-x64")).toThrow(/unexpected bundle output/);
    expect(() => assertBundleSet(["dmg", "macos", "appimage"], "darwin-arm64")).toThrow(/appimage/);
    // An .app-only listing means the image step never ran — the intermediate
    // is not a publishable artifact, whatever else it once was.
    expect(() => assertBundleSet(["macos"], "linux-x64")).toThrow(/unexpected bundle output/);
  });

  test("refuses a missing bundle", () => {
    expect(() => assertBundleSet([], "linux-x64")).toThrow(/no deb bundle/);
    expect(() => assertBundleSet(["macos"], "darwin-arm64")).toThrow(/no dmg bundle/);
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
  // A Mac cross-build exists (tauri `--target`, CI-scoped); the UNSCOPED
  // default is still the host — a default nobody can run is not a default.
  test("names the one target this machine can build", () => {
    expect(hostTarget("darwin", "arm64")).toBe("darwin-arm64");
    expect(hostTarget("darwin", "x64")).toBe("darwin-x64");
    expect(hostTarget("linux", "x64")).toBe("linux-x64");
  });

  test("refuses a host with no buildable target rather than picking one", () => {
    // arm64 Linux is the load-bearing refusal: no runner, no webview story.
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

describe("bundleArtifact", () => {
  const ROOT = "/w/apps/server/desktop/src-tauri/target/release/bundle";

  // The bundler's own name is passed IN (globbed), because Tauri derives it
  // from productName (and its own dmg versioning), and the Debian one goes
  // through a package-name sanitizer. What is pinned here is the mapping onto
  // the name this repo publishes.
  test("maps the emitted .dmg onto the versioned, tripled name this repo publishes", () => {
    expect(bundleArtifact(ROOT, "darwin-arm64", "1.2.3", "Subshell Server_1.2.3_aarch64.dmg")).toEqual({
      source: `${ROOT}/dmg/Subshell Server_1.2.3_aarch64.dmg`,
      artifact: `${ROOT}/dmg/Subshell-Server-Desktop-1.2.3-darwin-arm64.dmg`,
    });
  });

  test("maps the emitted .deb onto the canonical package name", () => {
    expect(bundleArtifact(ROOT, "linux-x64", "1.2.3", "Subshell Server_1.2.3_amd64.deb")).toEqual({
      source: `${ROOT}/deb/Subshell Server_1.2.3_amd64.deb`,
      artifact: `${ROOT}/deb/subshell-server-desktop_1.2.3_amd64.deb`,
    });
  });

  // Whatever the bundler called it, the published name is ours — that is the
  // point of the glob, and the reason productName may contain a space.
  test("the published name never depends on what the bundler emitted", () => {
    for (const emitted of ["Subshell Server_1.2.3_aarch64.dmg", "subshell-server_1.2.3_aarch64.dmg", "Whatever.dmg"]) {
      expect(bundleArtifact(ROOT, "darwin-arm64", "1.2.3", emitted).artifact).toBe(
        `${ROOT}/dmg/Subshell-Server-Desktop-1.2.3-darwin-arm64.dmg`,
      );
    }
  });

  // The two desktop apps publish into ONE GitHub release directory per cut.
  test("names the server product, never the client app's", () => {
    for (const target of DESKTOP_TARGETS) {
      const { artifact } = bundleArtifact(ROOT, target, "1.2.3", `emitted${bundleKind(target).suffix}`);
      expect(artifact).toContain(desktopArtifactFileName(DESKTOP_SERVER_PRODUCT, target, "1.2.3"));
      expect(artifact).not.toContain(desktopArtifactFileName(DESKTOP_CLIENT_PRODUCT, target, "1.2.3"));
    }
  });

  test("has no mapping for a target this app does not build", () => {
    expect(() => bundleArtifact(ROOT, "linux-arm64", "1.2.3", "x.deb")).toThrow(/no bundler/);
  });
});

describe("collectArtifact", () => {
  const ROOT = "/w/bundle";

  // The DMG is one signed, notarized, stapled FILE — renamed, never re-wrapped.
  // Re-archiving or re-writing it would change the exact bytes the digest (and
  // the staple's own container) describe. The spaced name rides one rename.
  test("renames the emitted .dmg onto the published name, running nothing", async () => {
    const s = stub({ listing: ["Subshell Server_1.2.3_aarch64.dmg"] });
    const out = await collectArtifact(s.deps, ROOT, "darwin-arm64", "1.2.3");
    expect(s.listed).toEqual([`${ROOT}/dmg`]);
    expect(out).toBe(`${ROOT}/dmg/Subshell-Server-Desktop-1.2.3-darwin-arm64.dmg`);
    expect(s.moves).toEqual([[`${ROOT}/dmg/Subshell Server_1.2.3_aarch64.dmg`, out]]);
    expect(s.runs).toEqual([]);
  });

  // The .deb is renamed rather than re-wrapped: one file already, published
  // under the space-free name the smoke and the install docs know.
  test("renames the emitted .deb onto the published name, archiving nothing", async () => {
    const s = stub({ listing: ["Subshell Server_1.2.3_amd64.deb"] });
    const out = await collectArtifact(s.deps, ROOT, "linux-x64", "1.2.3");
    expect(out).toBe(`${ROOT}/deb/subshell-server-desktop_1.2.3_amd64.deb`);
    expect(s.moves).toEqual([[`${ROOT}/deb/Subshell Server_1.2.3_amd64.deb`, out]]);
    expect(s.runs).toEqual([]);
  });

  // The deb staging tree Tauri leaves beside the package is not a candidate.
  test("ignores everything without the bundler's own extension", async () => {
    const s = stub({ listing: ["Subshell Server_1.2.3_amd64", "Subshell Server_1.2.3_amd64.deb"] });
    expect(await collectArtifact(s.deps, ROOT, "linux-x64", "1.2.3")).toBe(
      `${ROOT}/deb/subshell-server-desktop_1.2.3_amd64.deb`,
    );
  });

  // Zero and many are BOTH refusals: publishing an arbitrary bundle under a
  // canonical name is indistinguishable from a correct cut.
  test("refuses an empty or ambiguous bundle directory rather than guessing", async () => {
    const empty = stub({ listing: [] });
    await expect(collectArtifact(empty.deps, ROOT, "darwin-arm64", "1.2.3")).rejects.toThrow(/no \.dmg in/);
    const many = stub({ listing: ["One.dmg", "Two.dmg"] });
    await expect(collectArtifact(many.deps, ROOT, "darwin-arm64", "1.2.3")).rejects.toThrow(/expected exactly one/);
    expect(many.runs).toEqual([]);
  });
});

describe("the updater artifacts (spec 2026-09-15 § 8)", () => {
  const ROOT = "/build/bundle";

  // MEASURED 2026-09-15 (tauri-cli 2.11, macOS): the updater tarball lands in
  // `bundle/macos/`, beside the `.app` and NOT beside the `.dmg`, named after
  // `productName` with its space — so this path must be built from the product
  // name, not from the published (space-free) one.
  test("looks where the bundler actually writes", () => {
    expect(updaterSource(ROOT, "darwin-arm64", DESKTOP_SERVER_PRODUCT, "ignored.deb")).toBe(
      `${ROOT}/macos/Subshell Server.app.tar.gz`,
    );
    // Linux's updater artifact IS the published `.deb`, already renamed by
    // `collectArtifact` — there is no second file.
    expect(updaterSource(ROOT, "linux-x64", DESKTOP_SERVER_PRODUCT, "subshell-server-desktop_1.2.3_amd64.deb")).toBe(
      `${ROOT}/deb/subshell-server-desktop_1.2.3_amd64.deb`,
    );
  });

  test("publishes the tarball under this repo's name and reads its signature inline", async () => {
    const s = stub();
    const dmg = `${ROOT}/dmg/${desktopArtifactFileName(DESKTOP_SERVER_PRODUCT, "darwin-arm64", "1.2.3")}`;
    const got = await collectUpdaterArtifact(s.deps, ROOT, "darwin-arm64", "1.2.3", dmg);
    expect(got.path).toBe(`${ROOT}/macos/Subshell-Server-Desktop-1.2.3-darwin-arm64.app.tar.gz`);
    expect(got.path).not.toContain(" ");
    // The signature travels INLINE in latest.json; a `.sig` beside the
    // artifact would be an asset nothing reads.
    expect(s.reads).toEqual([`${ROOT}/macos/Subshell Server.app.tar.gz.sig`]);
    expect(got.signature).toContain("SIGNATURE");
    expect(s.moves).toEqual([[`${ROOT}/macos/Subshell Server.app.tar.gz`, got.path]]);
  });

  // The `.deb` is both the published bundle and the update package, so nothing
  // is renamed and nothing is published twice.
  test("leaves the .deb where it is", async () => {
    const s = stub();
    const deb = `${ROOT}/deb/${desktopArtifactFileName(DESKTOP_SERVER_PRODUCT, "linux-x64", "1.2.3")}`;
    const got = await collectUpdaterArtifact(s.deps, ROOT, "linux-x64", "1.2.3", deb);
    expect(got.path).toBe(deb);
    expect(s.moves).toEqual([]);
  });

  // § 12.4 is unmeasured for Linux (the `.deb.sig` question needs the Linux
  // bundler), so the pipeline does not depend on the answer: no `.sig` means
  // sign it. An UNSIGNED updater artifact is one every installed app refuses,
  // which reads as "there are no updates" and is discovered by nobody.
  test("signs the package itself when the bundler emitted no .sig", async () => {
    let asked = 0;
    const s = stub({
      exists: (p) => {
        // The artifact is there; its signature is not.
        if (p.endsWith(".sig")) {
          asked += 1;
          return false;
        }
        return true;
      },
    });
    const deb = `${ROOT}/deb/${desktopArtifactFileName(DESKTOP_SERVER_PRODUCT, "linux-x64", "1.2.3")}`;
    await collectUpdaterArtifact(s.deps, ROOT, "linux-x64", "1.2.3", deb);
    expect(asked).toBeGreaterThan(0);
    // NO key argument. `-f` is `--private-key-path`, not "read it from
    // stdin", and release.yml exports `TAURI_SIGNING_PRIVATE_KEY` — which is
    // the `-k/--private-key` env binding — so passing `-f` beside it makes
    // clap refuse before anything is signed ("the argument
    // '--private-key-path' cannot be used with '--private-key'", measured
    // against this repo's own CLI on 2026-09-15). This is the ORDINARY Linux
    // path: `deb` is not an updater-enabled target, so the bundler writes no
    // `.deb.sig` and this branch runs on every Linux desktop cut. The
    // assertion is a literal list because the bug it caught was an argument
    // that looked right.
    expect(s.runs.at(-1)?.argv).toEqual(["./node_modules/.bin/tauri", "signer", "sign", deb]);
    expect(s.runs.at(-1)?.argv).not.toContain("-f");
  });

  test("refuses when the bundler wrote no updater artifact at all", async () => {
    const s = stub({ exists: () => false });
    const dmg = `${ROOT}/dmg/x.dmg`;
    await expect(collectUpdaterArtifact(s.deps, ROOT, "darwin-arm64", "1.2.3", dmg)).rejects.toThrow(
      /createUpdaterArtifacts/,
    );
  });

  test("refuses an empty signature rather than publishing one nothing accepts", async () => {
    const s = stub({ read: async () => "   \n" });
    const deb = `${ROOT}/deb/${desktopArtifactFileName(DESKTOP_SERVER_PRODUCT, "linux-x64", "1.2.3")}`;
    await expect(collectUpdaterArtifact(s.deps, ROOT, "linux-x64", "1.2.3", deb)).rejects.toThrow(/is empty/);
  });
});

describe("the updater public key", () => {
  const CONF_TEXT = readFileSync(join(import.meta.dir, "../../../src-tauri/tauri.conf.json"), "utf8");

  // The keypair was generated on 2026-09-15 and the committed value is the
  // REAL public key — the one every installed app checks a manifest against.
  // The guard must therefore accept this checkout, and must still refuse the
  // placeholder it would have carried before, which is what stops a cut from
  // shipping a manifest signed by a key nobody holds.
  test("is the real key, which the release guard accepts", () => {
    expect(CONF_TEXT).not.toContain(UPDATER_PUBKEY_PLACEHOLDER);
    expect(() => assertUpdaterPubkey(CONF_TEXT)).not.toThrow();
    const conf = JSON.parse(CONF_TEXT);
    // A minisign public-key file, base64: decodes to the "untrusted comment"
    // line and the key line the updater plugin parses.
    const decoded = Buffer.from(conf.plugins.updater.pubkey, "base64").toString("utf8");
    expect(decoded).toMatch(/^untrusted comment: minisign public key: [0-9A-F]{16}\n[A-Za-z0-9+/=]+\n?$/);
  });

  test("is refused by the release guard while it is the placeholder", () => {
    expect(() =>
      assertUpdaterPubkey(JSON.stringify({ plugins: { updater: { pubkey: UPDATER_PUBKEY_PLACEHOLDER } } })),
    ).toThrow(/signer generate/);
  });

  // The message has to name the two SECRETS as well as the command, because
  // the private half is what CI needs and the measured trap is its shape: on
  // tauri 2.11 only TAURI_SIGNING_PRIVATE_KEY (the file's CONTENTS) is read,
  // and TAURI_SIGNING_PRIVATE_KEY_PATH is ignored. The command names the v2
  // package: bare `tauri` on npm is the retired v1 CLI, which drags in sharp.
  test("says exactly what the operator has to do", () => {
    try {
      assertUpdaterPubkey(JSON.stringify({ plugins: { updater: { pubkey: UPDATER_PUBKEY_PLACEHOLDER } } }));
      throw new Error("expected a refusal");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).toContain("bunx @tauri-apps/cli signer generate");
      expect(message).toContain("TAURI_SIGNING_PRIVATE_KEY");
      expect(message).toContain("TAURI_SIGNING_PRIVATE_KEY_PASSWORD");
      expect(message).toContain("CONTENTS");
    }
  });

  // `createUpdaterArtifacts` is what makes the bundler emit the tarball and
  // the `.sig` at all. Off, the release publishes a `latest.json` naming files
  // that do not exist — and nothing else fails.
  test("is paired with createUpdaterArtifacts", () => {
    const conf = JSON.parse(CONF_TEXT);
    expect(conf.bundle.createUpdaterArtifacts).toBe(true);
    expect(typeof conf.plugins.updater.pubkey).toBe("string");
  });
});

describe("productName", () => {
  const CONF = JSON.parse(readFileSync(join(import.meta.dir, "../../../src-tauri/tauri.conf.json"), "utf8"));

  // The bundler names the `.app`, the DMG volume and the DMG file from
  // `productName`, and this pipeline publishes whatever single `.dmg` the glob
  // finds — so a drift here would not break the build. It would ship an image
  // whose app (and volume) are called something else, which the smoke would
  // hunt for by the contract name and not find: a failure at the wrong layer.
  test("is the product name the release contract publishes under", () => {
    expect(CONF.productName).toBe(DESKTOP_SERVER_PRODUCT);
  });

  // The identifier is IDENTITY, not a label: it keys the macOS settings
  // directory, the notification grant, the single-instance lock and the window
  // state. It is pinned so a change to any of those is a deliberate edit here
  // rather than a silent one — and so it stays distinct from
  // `apps/client/desktop`'s, which shares none of that state.
  test("the bundle identifier is this app's own", () => {
    // The SAME constant the server CLI writes into the LaunchAgent plist's
    // AssociatedBundleIdentifiers — Login-Items attribution fails silently
    // (the entry shows the signing org) if these two ever drift.
    expect(CONF.identifier).toBe(DESKTOP_SERVER_BUNDLE_ID);
    expect(CONF.identifier).not.toBe("dev.subshell.client");
  });
});
