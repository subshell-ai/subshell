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
  SERVER_SIDECAR_NAME,
  serverArtifactFileName,
} from "@internal/subshell-protocol";
import {
  assertBundleSet,
  assertUpdaterPubkey,
  bundleArtifact,
  bundleKind,
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
    read: async (p) => {
      reads.push(p);
      return "untrusted comment: signature from tauri secret key\nSIGNATURE\n";
    },
    write: async (p, text) => {
      writes.push([p, text]);
    },
    runCapture: async () => ({ code: 0, output: "" }),
    log: (l) => logs.push(l),
    ...rest,
  };
  return { deps, runs, removed, moves, logs, listed, reads, writes };
}

describe("stageSidecar", () => {
  test("builds the SERVER with compile:release, never compile", async () => {
    const s = stub();
    expect(await stageSidecar(s.deps, "darwin-arm64")).toBe(true);
    // `compile` ships the tracked embedded-web stub, and the binary then
    // throws at boot on a machine with no apps/server/web/dist.
    expect(s.runs[0]?.argv).toEqual(["bun", "run", "--cwd", "apps/server/api", "compile:release"]);
  });

  // resolveArtifactsDir() on the server side resolves in the CHILD's cwd, so a
  // relative override would land in apps/server/api/apps/server/desktop/…
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
        join(SIDECAR_DIR, desktopSidecarFileName(SERVER_SIDECAR_NAME, "darwin-arm64")),
      ],
    ]);
  });

  // The `.sha256` describes the bytes BEFORE Tauri re-seals them; the release
  // manifest describes the SERVER release rather than this app's, and this
  // directory is a build input rather than a publish dir.
  test("deletes the nested build's .sha256 and release manifest", async () => {
    const s = stub();
    await stageSidecar(s.deps, "darwin-arm64");
    expect(s.removed).toEqual([
      `${join(SIDECAR_DIR, serverArtifactFileName("darwin-arm64"))}.sha256`,
      join(SIDECAR_DIR, RELEASE_MANIFEST_NAME),
    ]);
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
    expect(s.runs.at(-1)?.argv).toEqual(["./node_modules/.bin/tauri", "signer", "sign", "-f", "-", deb]);
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

  // The committed value is a PLACEHOLDER until the operator generates the
  // keypair. This test does not demand the real one — that would fail every
  // checkout — it pins that the guard SEES the placeholder, which is what
  // stops a cut from shipping a manifest signed by a key nobody holds.
  test("is refused by the release guard while it is the placeholder", () => {
    expect(CONF_TEXT).toContain(UPDATER_PUBKEY_PLACEHOLDER);
    expect(() => assertUpdaterPubkey(CONF_TEXT)).toThrow(/tauri signer generate/);
    expect(() => assertUpdaterPubkey('{"plugins":{"updater":{"pubkey":"dW50cnVzdGVk…"}}}')).not.toThrow();
  });

  // The message has to name the two SECRETS as well as the command, because
  // the private half is what CI needs and the measured trap is its shape: on
  // tauri 2.11 only TAURI_SIGNING_PRIVATE_KEY (the file's CONTENTS) is read,
  // and TAURI_SIGNING_PRIVATE_KEY_PATH is ignored.
  test("says exactly what the operator has to do", () => {
    try {
      assertUpdaterPubkey(CONF_TEXT);
      throw new Error("expected a refusal");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).toContain("bunx tauri signer generate");
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
