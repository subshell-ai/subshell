import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, statSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  hostReleaseTarget,
  NODE_RESULT_DIGEST_MISMATCH,
  NODE_RESULT_DOWNLOAD_FAILED,
  NODE_RESULT_MANIFEST_UNVERIFIED,
  NODE_RESULT_NOT_COMPILED,
  NODE_RESULT_VERSION_MISMATCH,
  parseReleaseManifest,
  RELEASE_MANIFEST_NAME,
  RELEASE_MANIFEST_SIG_NAME,
  releaseAssetNames,
} from "@internal/subshell-protocol";
import type { verifyReleaseManifest } from "@internal/subshell-protocol/release-signature";
import {
  applyUpdate,
  completeUpdate,
  failedMarkerPath,
  keepPrevious,
  pendingMarkerPath,
  ROLLBACK_PROBE_TIMEOUT_MS,
  readMarker,
  redactUrl,
  releaseApiUrl,
  resolveNodeBinary,
  resolveNodeRelease,
  revertAfterRefusal,
  rollbackBinaryRuns,
  rollbackUpdate,
  type UpdateFailure,
  type UpdateManifestSource,
  UpdateRefused,
  updateSeams,
} from "../update.js";

/**
 * `applyUpdate` and its transaction, against a real HTTP server and a real
 * filesystem.
 *
 * Both are real on purpose. The thing being tested is a swap of the file this
 * process claims to BE, verified against bytes that arrived over a socket, and
 * a fake for either half would test the fake. What IS injected is the version
 * probe — running a downloaded "binary" that is really 30 bytes of text is the
 * one step no temp directory can make honest — and `process.execPath`, through
 * the module's only reader of it, `selfInvokePrefix`.
 */

/** A throwaway `<dir>/subshell` + data dir, standing in for an installed agent. */
async function installedNode(): Promise<{ root: string; binDir: string; binary: string; dataDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "subshell-update-"));
  const binDir = join(root, "bin");
  const dataDir = join(root, "data");
  await mkdir(binDir, { recursive: true });
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const binary = join(binDir, "subshell");
  await writeFile(binary, "OLD BINARY");
  await chmod(binary, 0o755);
  return { root, binDir, binary, dataDir };
}

/** Serve `body` at `/agent`, so the download path is a real fetch over a real socket. */
function serveArtifact(body: string, status = 200): { url: string; stop: () => void } {
  const server = Bun.serve({
    port: 0,
    fetch: () => new Response(body, { status }),
  });
  return { url: `http://127.0.0.1:${server.port}/agent`, stop: () => void server.stop(true) };
}

const sha256 = (text: string): string => new Bun.CryptoHasher("sha256").update(text).digest("hex");

/**
 * The signed manifest + fake verifier pair (spec 2026-09-17 §5 path 1).
 *
 * The CRYPTO half is pinned in the protocol package against real
 * `tauri signer` fixtures; what lives here is the transaction's response to
 * the verifier's ANSWER — accept, refuse, absent — because a temp directory
 * cannot mint a genuine publisher signature and the swap logic must be tested
 * against all three replies anyway. `assets` names THIS host's artifact,
 * which is exactly what `verifySignedManifest` requires (the digest a node
 * checks is the one the signed map names for the file IT fetched).
 */
const HOST_ASSET = releaseAssetNames(
  "cli-node",
  hostReleaseTarget(process.platform, process.arch) ?? "linux-x64",
).binary;

function signedManifest(digest: string, version = "0.9.1"): UpdateManifestSource {
  return {
    bytes: JSON.stringify({
      component: "cli-node",
      version,
      nodeProtocol: 12,
      minNodeVersion: "0.11.0",
      commit: "0".repeat(40),
      assets: { [HOST_ASSET]: digest },
    }),
    sig: "TEST-ARMOR",
  };
}

const acceptSigned: typeof verifyReleaseManifest = async (bytes, sig, _pub, expected) => {
  const parsed = parseReleaseManifest(typeof bytes === "string" ? bytes : Buffer.from(bytes).toString("utf8"));
  if (parsed === null || sig !== "TEST-ARMOR") return { ok: false, reason: "test: the fixture signature was refused" };
  if (parsed.component !== expected.component || parsed.version !== expected.version) {
    return { ok: false, reason: `test: payload names ${parsed.component} ${parsed.version}` };
  }
  return { ok: true, manifest: parsed };
};

/** Point `selfInvokePrefix` at our fake install: a basename starting `subshell` takes rung 1. */
let realExecPath: string;
const realUpdateSeams = { ...updateSeams };
beforeEach(() => {
  realExecPath = process.execPath;
  // The crypto is the protocol package's business (fixture-pinned there);
  // this suite tests the transaction's response to its ANSWERS.
  updateSeams.verifyManifest = acceptSigned;
});
afterEach(() => {
  Object.defineProperty(process, "execPath", { value: realExecPath, configurable: true, writable: true });
  Object.assign(updateSeams, realUpdateSeams);
});
/**
 * A machine with NO service definition, whatever the host has.
 *
 * The binary ladder asks the definition first, and that read reaches the real
 * launchd/systemd user domain: `homedir()` answers from the password database,
 * not `$HOME`, so no temp directory hides it. Without this every test below
 * resolved the DEVELOPER's own installed agent instead of its fixture — so the
 * whole file passed only on machines that do not run Subshell, and failed on
 * the ones most likely to be running these tests (measured 2026-09-18).
 *
 * `fileExists` false and `readFile` null together mean "no unit, no plist",
 * which is the state CI is in by accident and every other machine should be
 * able to state on purpose.
 */
const NO_SERVICE_DEFINITION = {
  fileExists: async () => false,
  readFile: async () => null,
  // All THREE, because the darwin branch also shells out (`plutil`) and would
  // otherwise still find the developer's real plist through that route alone.
  runCmd: async () => ({ code: 1, out: "", err: "" }),
} as const;

function pretendInstalledAt(binary: string): void {
  Object.defineProperty(process, "execPath", { value: binary, configurable: true, writable: true });
}

describe("resolveNodeBinary", () => {
  it("refuses a source run, because there is no single file to swap", async () => {
    // `selfInvokePrefix` rung 2: an interpreter with a real entry script. The
    // refusal has to be NOT_COMPILED rather than a write error — the remedy is
    // updating the checkout, and naming a download would send someone nowhere.
    Object.defineProperty(process, "execPath", { value: "/usr/local/bin/bun", configurable: true, writable: true });
    const argv1 = process.argv[1];
    process.argv[1] = "/repo/apps/node/agent/src/index.ts";
    try {
      await expect(resolveNodeBinary(NO_SERVICE_DEFINITION)).rejects.toMatchObject({
        detail: NODE_RESULT_NOT_COMPILED,
      });
    } finally {
      process.argv[1] = argv1;
    }
  });

  it("names the installed binary and its directory", async () => {
    const { binary, binDir } = await installedNode();
    pretendInstalledAt(binary);
    expect(await resolveNodeBinary(NO_SERVICE_DEFINITION)).toEqual({ binary, dir: binDir, source: "this process" });
  });

  it("prefers the binary the SERVICE DEFINITION names over the one this process is", async () => {
    // The bug this pins. `subshell update` typed in a terminal runs whichever
    // copy is first on PATH, which need not be the one the unit executes — so
    // resolving from `process.execPath` wrote a file nobody runs, and the
    // manager brought the OLD binary back up. An update that reports success
    // and changes nothing is the one thing an update must never do, and it is
    // unfalsifiable from the outside: `version` still answers, just from the
    // copy that was never replaced.
    const { binary, binDir } = await installedNode();
    const other = join(binDir, "subshell-on-path");
    await writeFile(other, "A DIFFERENT COPY");
    await chmod(other, 0o755);
    pretendInstalledAt(other);

    expect(
      await resolveNodeBinary({
        platform: "linux",
        home: "/home/u",
        readFile: async (path) =>
          path === "/home/u/.config/systemd/user/subshell.service"
            ? `[Service]\nExecStart=${binary} run\nRestart=always\n`
            : null,
      }),
    ).toEqual({ binary, dir: binDir, source: "service definition" });
  });

  it("takes the LAST ExecStart= and unquotes a spaced path, as systemd itself does", async () => {
    // systemd's own rule is last-wins, and `systemdQuote` double-quotes any
    // token with whitespace — a macOS-style "Application Support" home is the
    // case that produces one. A reader that split on spaces would hand the
    // updater a truncated path that does not exist.
    const root = await mkdtemp(join(tmpdir(), "subshell-spaced-"));
    const binDir = join(root, "Application Support");
    await mkdir(binDir, { recursive: true });
    const binary = join(binDir, "subshell");
    await writeFile(binary, "OLD");
    await chmod(binary, 0o755);

    expect(
      await resolveNodeBinary({
        platform: "linux",
        home: "/home/u",
        readFile: async () => `ExecStart=/ignored/first\nExecStart="${binary}" run\n`,
      }),
    ).toEqual({ binary, dir: binDir, source: "service definition" });
    await rm(root, { recursive: true, force: true });
  });

  it("refuses a definition naming an interpreter AND a script — replacing token one overwrites `bun`", async () => {
    // The dev-form install `execLine()` writes records TWO tokens. A reader
    // keeping only the first hands the updater a copy of `bun` to overwrite
    // with an agent binary, which breaks every other program on the machine
    // that runs through it.
    await expect(
      resolveNodeBinary({
        platform: "linux",
        home: "/home/u",
        readFile: async () => "ExecStart=/usr/local/bin/bun /repo/apps/node/agent/src/index.ts run\n",
      }),
    ).rejects.toMatchObject({ detail: NODE_RESULT_NOT_COMPILED });
  });

  it("reads launchd's ProgramArguments through plutil, because a plist may be binary1", async () => {
    const { binary, binDir } = await installedNode();
    pretendInstalledAt(join(binDir, "not-this-one"));
    expect(
      await resolveNodeBinary({
        platform: "darwin",
        home: "/Users/u",
        readFile: async () => null, // a binary plist: no text answer exists
        runCmd: async (cmd) =>
          cmd[0] === "/usr/bin/plutil"
            ? { code: 0, out: JSON.stringify([binary, "run"]), err: "" }
            : { code: 1, out: "", err: "no" },
      }),
    ).toEqual({ binary, dir: binDir, source: "service definition" });
  });

  it("falls back to this process when no definition is installed", async () => {
    // A hand-run agent is a real deployment, and it is the rung that used to
    // be the only one.
    const { binary, binDir } = await installedNode();
    pretendInstalledAt(binary);
    expect(await resolveNodeBinary({ platform: "linux", home: "/home/u", readFile: async () => null })).toEqual({
      binary,
      dir: binDir,
      source: "this process",
    });
  });

  it("refuses rather than falling back when the definition names a file that is not there", async () => {
    // Falling back to `process.execPath` here would resurrect the whole bug:
    // the manager runs the named file, so a missing one is a broken install to
    // report, never a licence to replace a different binary instead.
    pretendInstalledAt((await installedNode()).binary);
    await expect(
      resolveNodeBinary({
        platform: "linux",
        home: "/home/u",
        readFile: async () => "ExecStart=/opt/gone/subshell run\n",
      }),
    ).rejects.toMatchObject({ detail: NODE_RESULT_NOT_COMPILED });
  });
});

describe("applyUpdate", () => {
  it("downloads, verifies, swaps, and keeps the old binary as .previous", async () => {
    const { binary, dataDir } = await installedNode();
    pretendInstalledAt(binary);
    const bytes = "NEW BINARY 0.9.1";
    const artifact = serveArtifact(bytes);
    try {
      const applied = await applyUpdate({
        binaryDeps: NO_SERVICE_DEFINITION,
        source: { kind: "url", url: artifact.url, sha256: sha256(bytes), manifest: signedManifest(sha256(bytes)) },
        version: "0.9.1",
        restart: false,
        origin: "cli",
        dataDir,
        probeVersion: async () => "0.9.1",
      });
      expect(applied).toMatchObject({ to: "0.9.1", binary, restarted: false });
    } finally {
      artifact.stop();
    }
    expect(await readFile(binary, "utf8")).toBe(bytes);
    expect(await readFile(`${binary}.previous`, "utf8")).toBe("OLD BINARY");
    // 0755, because the service manager runs this file next.
    expect((await stat(binary)).mode & 0o777).toBe(0o755);
    const marker = await readMarker(pendingMarkerPath(dataDir));
    expect(marker).toMatchObject({ to: "0.9.1", binary, previousBinary: `${binary}.previous`, origin: "cli" });
  });

  it("LEAVES THE BINARY UNTOUCHED on a digest mismatch, and deletes the partial file", async () => {
    // The whole reason the digest is checked before the first chmod: a
    // mismatch must cost nothing, and must leave nothing behind for a confused
    // hand to run.
    const { binary, binDir, dataDir } = await installedNode();
    pretendInstalledAt(binary);
    const artifact = serveArtifact("TAMPERED");
    try {
      await expect(
        applyUpdate({
          binaryDeps: NO_SERVICE_DEFINITION,
          source: {
            kind: "url",
            url: artifact.url,
            sha256: sha256("WHAT WAS PUBLISHED"),
            manifest: signedManifest(sha256("WHAT WAS PUBLISHED")),
          },
          version: "0.9.1",
          restart: false,
          origin: "cli",
          dataDir,
          probeVersion: async () => "0.9.1",
        }),
      ).rejects.toMatchObject({ detail: NODE_RESULT_DIGEST_MISMATCH });
    } finally {
      artifact.stop();
    }
    expect(await readFile(binary, "utf8")).toBe("OLD BINARY");
    expect(await Bun.file(`${binary}.previous`).exists()).toBe(false);
    expect(await readMarker(pendingMarkerPath(dataDir))).toBeNull();
    const leftovers = [...new Bun.Glob("*.download-*").scanSync(binDir)];
    expect(leftovers).toEqual([]);
  });

  /**
   * A refusal names the ADDRESS and never the credential.
   *
   * The plane bakes a single-use `?update_token=nut_…` into the URL it sends,
   * and these sentences are logged on the node — into a file any node owner or
   * `edit` grantee reads over HTTP. A token that reached it would outlive by
   * hours the ten minutes that are supposed to bound it. The host and path
   * stay, because "which address could not be reached" is the whole diagnosis.
   */
  it("keeps the download token out of every refusal it can raise", async () => {
    const { binary, dataDir } = await installedNode();
    pretendInstalledAt(binary);
    const artifact = serveArtifact("TAMPERED");
    const withToken = `${artifact.url}?update_token=nut_SECRETVALUE`;
    try {
      const thrown: unknown = await applyUpdate({
        binaryDeps: NO_SERVICE_DEFINITION,
        source: {
          kind: "url",
          url: withToken,
          sha256: sha256("WHAT WAS PUBLISHED"),
          manifest: signedManifest(sha256("WHAT WAS PUBLISHED")),
        },
        version: "0.9.1",
        restart: false,
        origin: "plane",
        dataDir,
        probeVersion: async () => "0.9.1",
      }).then(
        () => null,
        (e: unknown) => e,
      );
      expect(thrown).toBeInstanceOf(UpdateRefused);
      const message = (thrown as UpdateRefused).message;
      expect(message).not.toContain("nut_SECRETVALUE");
      expect(message).not.toContain("update_token");
      // …and still says WHERE, which is the point of naming the url at all.
      expect(message).toContain(new URL(artifact.url).host);
    } finally {
      artifact.stop();
    }
  });

  it("redacts a query string without losing the address, and refuses to guess at a non-url", () => {
    expect(redactUrl("https://plane.example/api/downloads/node/linux-x64?update_token=nut_x#frag")).toBe(
      "https://plane.example/api/downloads/node/linux-x64",
    );
    // Unparseable is not redactable: say nothing rather than echo bytes after
    // a `?` this code did not understand.
    expect(redactUrl("not a url at all?update_token=nut_x")).toBe("the download url");
  });

  it("refuses a URL that does not answer 200 without touching anything", async () => {
    const { binary, dataDir } = await installedNode();
    pretendInstalledAt(binary);
    // The single-use download token the plane mints is forgotten across its own
    // restart, and this 401 is exactly what the agent then sees.
    const artifact = serveArtifact("no", 401);
    try {
      await expect(
        applyUpdate({
          binaryDeps: NO_SERVICE_DEFINITION,
          source: {
            kind: "url",
            url: artifact.url,
            sha256: sha256("anything"),
            manifest: signedManifest(sha256("anything")),
          },
          version: "0.9.1",
          restart: false,
          origin: "plane",
          dataDir,
        }),
      ).rejects.toMatchObject({ detail: NODE_RESULT_DOWNLOAD_FAILED });
    } finally {
      artifact.stop();
    }
    expect(await readFile(binary, "utf8")).toBe("OLD BINARY");
  });

  it("carries the refusal body's message into the refusal it raises", async () => {
    // The plane's download refusals put a remedy in a JSON `message` (the
    // stale-artifact 409 does); "answered 409" alone would leave the node's
    // owner a fact with no act. The sentence travels in the UpdateRefused,
    // which `commands/update.ts` logs on this machine. The fixture is the
    // REAL body shape: errId + code + statusCode around the full remedy, so
    // the whole body is ~370 characters. That size is the point: a reader
    // that capped BEFORE parsing would cut this into invalid JSON and log
    // the raw envelope, losing the remedy entirely. The assertion on the
    // remedy's TAIL pins the order (parse, then cap).
    const { binary, dataDir } = await installedNode();
    pretendInstalledAt(binary);
    const remedy =
      "This server's published linux-x64 node binary is not the release the update ordered, so the node would install nothing. " +
      "Publish that release's binaries to this server's node-artifacts directory with `bun run release:cli-node`, or update that machine by hand.";
    const artifact = serveArtifact(
      JSON.stringify({ errId: "V1StGXR8_Z5j", code: "NODE_UPDATE_UNAVAILABLE", message: remedy, statusCode: 409 }),
      409,
    );
    try {
      await expect(
        applyUpdate({
          binaryDeps: NO_SERVICE_DEFINITION,
          source: {
            kind: "url",
            url: artifact.url,
            sha256: sha256("anything"),
            manifest: signedManifest(sha256("anything")),
          },
          version: "0.9.1",
          restart: false,
          origin: "plane",
          dataDir,
        }),
      ).rejects.toMatchObject({
        detail: NODE_RESULT_DOWNLOAD_FAILED,
        // The remedy whole, tail included: parsed before any cap.
        message: expect.stringContaining("or update that machine by hand."),
      });
    } finally {
      artifact.stop();
    }
    expect(await readFile(binary, "utf8")).toBe("OLD BINARY");
  });

  it("truncates a non-JSON refusal body instead of quoting it whole", async () => {
    const { binary, dataDir } = await installedNode();
    pretendInstalledAt(binary);
    const artifact = serveArtifact("x".repeat(5000), 503);
    try {
      const err = (await applyUpdate({
        binaryDeps: NO_SERVICE_DEFINITION,
        source: {
          kind: "url",
          url: artifact.url,
          sha256: sha256("anything"),
          manifest: signedManifest(sha256("anything")),
        },
        version: "0.9.1",
        restart: false,
        origin: "plane",
        dataDir,
      }).catch((e: unknown) => e)) as UpdateRefused;
      expect(err).toMatchObject({ detail: NODE_RESULT_DOWNLOAD_FAILED });
      // A proxy error page cannot write an unbounded line into the log: the
      // quoted body is capped, and the cap is marked.
      expect(err.message.length).toBeLessThan(400);
      expect(err.message.endsWith("...")).toBe(true);
    } finally {
      artifact.stop();
    }
  });

  it("refuses when the downloaded binary reports a version other than the one asked for", async () => {
    // A wrong-architecture artifact, or a mis-tagged release: the probe is what
    // catches it before the file becomes the one the service manager runs.
    const { binary, dataDir } = await installedNode();
    pretendInstalledAt(binary);
    const bytes = "NEW";
    const artifact = serveArtifact(bytes);
    try {
      await expect(
        applyUpdate({
          binaryDeps: NO_SERVICE_DEFINITION,
          source: { kind: "url", url: artifact.url, sha256: sha256(bytes), manifest: signedManifest(sha256(bytes)) },
          version: "0.9.1",
          restart: false,
          origin: "cli",
          dataDir,
          probeVersion: async () => "0.8.0",
        }),
      ).rejects.toMatchObject({ detail: NODE_RESULT_VERSION_MISMATCH });
    } finally {
      artifact.stop();
    }
    expect(await readFile(binary, "utf8")).toBe("OLD BINARY");
    expect(await readMarker(pendingMarkerPath(dataDir))).toBeNull();
  });

  it("refuses an update whose release manifest the publisher never signed", async () => {
    // The plane (or a replay of an old-shape command it once sent) delivers a
    // manifest whose signature the verifier refuses. The download already
    // passed its own digest belt — this is the check that catches a release
    // source and a plane AGREEING on bytes the publisher did not sign.
    const { binary, binDir, dataDir } = await installedNode();
    pretendInstalledAt(binary);
    const bytes = "NEW BINARY 0.9.1";
    const artifact = serveArtifact(bytes);
    try {
      await expect(
        applyUpdate({
          binaryDeps: NO_SERVICE_DEFINITION,
          source: {
            kind: "url",
            url: artifact.url,
            sha256: sha256(bytes),
            manifest: { ...signedManifest(sha256(bytes)), sig: "FORGED-ARMOR" },
          },
          version: "0.9.1",
          restart: false,
          origin: "plane",
          dataDir,
          probeVersion: async () => "0.9.1",
        }),
      ).rejects.toMatchObject({ detail: NODE_RESULT_MANIFEST_UNVERIFIED });
    } finally {
      artifact.stop();
    }
    expect(await readFile(binary, "utf8")).toBe("OLD BINARY");
    const leftovers = [...new Bun.Glob("*.download-*").scanSync(binDir)];
    expect(leftovers).toEqual([]);
  });

  it("refuses a command that carried no manifest at all — no silent pre-signing path", async () => {
    // The frozen-shape rule lets an OLD agent ignore the new fields; it does
    // not let a NEW agent accept a command without them. A plane below
    // protocol 12 is refused before this is ever sent; a replayed or stripped
    // command must still not install.
    const { binary, dataDir } = await installedNode();
    pretendInstalledAt(binary);
    const bytes = "NEW BINARY 0.9.1";
    const artifact = serveArtifact(bytes);
    try {
      await expect(
        applyUpdate({
          binaryDeps: NO_SERVICE_DEFINITION,
          source: { kind: "url", url: artifact.url, sha256: sha256(bytes), manifest: null },
          version: "0.9.1",
          restart: false,
          origin: "plane",
          dataDir,
          probeVersion: async () => "0.9.1",
        }),
      ).rejects.toMatchObject({ detail: NODE_RESULT_MANIFEST_UNVERIFIED });
    } finally {
      artifact.stop();
    }
    expect(await readFile(binary, "utf8")).toBe("OLD BINARY");
  });

  it("refuses when the SIGNED manifest names a different digest than the command did", async () => {
    // Command and bytes agree with each other; the publisher's signed map
    // disagrees with both. The manifest outranks the command — that is the
    // split of powers (§4: node-signing key ⇒ ordering, publisher key ⇒
    // payload), and the digest constant is the answer the plane maps.
    const { binary, dataDir } = await installedNode();
    pretendInstalledAt(binary);
    const bytes = "NEW BINARY 0.9.1";
    const artifact = serveArtifact(bytes);
    try {
      await expect(
        applyUpdate({
          binaryDeps: NO_SERVICE_DEFINITION,
          source: { kind: "url", url: artifact.url, sha256: sha256(bytes), manifest: signedManifest("f".repeat(64)) },
          version: "0.9.1",
          restart: false,
          origin: "plane",
          dataDir,
          probeVersion: async () => "0.9.1",
        }),
      ).rejects.toMatchObject({ detail: NODE_RESULT_DIGEST_MISMATCH });
    } finally {
      artifact.stop();
    }
    expect(await readFile(binary, "utf8")).toBe("OLD BINARY");
    expect(await readMarker(pendingMarkerPath(dataDir))).toBeNull();
  });

  it("installs from a local file with no digest, because the operator named the path", async () => {
    const { binary, root, dataDir } = await installedNode();
    pretendInstalledAt(binary);
    const local = join(root, "downloaded-subshell");
    await writeFile(local, "FROM A FILE");
    const applied = await applyUpdate({
      binaryDeps: NO_SERVICE_DEFINITION,
      source: { kind: "file", path: local },
      version: "0.9.2",
      restart: false,
      origin: "desktop",
      dataDir,
      probeVersion: async () => "0.9.2",
    });
    expect(applied.to).toBe("0.9.2");
    expect(await readFile(binary, "utf8")).toBe("FROM A FILE");
  });

  it("restarts through the injected service seam and reports what it did", async () => {
    const { binary, root, dataDir } = await installedNode();
    pretendInstalledAt(binary);
    const local = join(root, "next");
    await writeFile(local, "NEXT");
    const asked: boolean[] = [];
    const applied = await applyUpdate({
      binaryDeps: NO_SERVICE_DEFINITION,
      source: { kind: "file", path: local },
      version: "0.9.3",
      force: true,
      restart: true,
      origin: "cli",
      dataDir,
      probeVersion: async () => "0.9.3",
      restartService: async (force) => {
        asked.push(force);
        return { code: 0, out: "restarted", err: "" };
      },
    });
    expect(asked).toEqual([true]);
    expect(applied.restarted).toBe(true);
  });

  it("reports a refused restart rather than claiming one, keeping the swap", async () => {
    // `controlService` refuses a restart whose definition would kill panes.
    // The swap already happened and must not be undone by that: the file is
    // correct, only the bounce did not occur.
    const { binary, root, dataDir } = await installedNode();
    pretendInstalledAt(binary);
    const local = join(root, "next");
    await writeFile(local, "NEXT");
    const applied = await applyUpdate({
      binaryDeps: NO_SERVICE_DEFINITION,
      source: { kind: "file", path: local },
      version: "0.9.3",
      restart: true,
      origin: "cli",
      dataDir,
      probeVersion: async () => "0.9.3",
      restartService: async () => ({ code: 1, out: "", err: "subshell: this would close 3 subshells\nuse --force" }),
    });
    expect(applied.restarted).toBe(false);
    expect(applied.note).toBe("subshell: this would close 3 subshells");
    expect(await readFile(binary, "utf8")).toBe("NEXT");
  });
});

describe("the 4406 rollback", () => {
  it("swaps .previous back, records the failure, and consumes the pending marker", async () => {
    const { binary, root, dataDir } = await installedNode();
    pretendInstalledAt(binary);
    const local = join(root, "next");
    await writeFile(local, "THE REFUSED VERSION");
    await applyUpdate({
      binaryDeps: NO_SERVICE_DEFINITION,
      source: { kind: "file", path: local },
      version: "0.9.4",
      restart: false,
      origin: "plane",
      dataDir,
      probeVersion: async () => "0.9.4",
    });

    const failure = await revertAfterRefusal(
      dataDir,
      "protocol v11 required (this node speaks v10)",
      async () => true, // the fixture `.previous` is text; the probe's own wiring is pinned below
    );
    expect(failure).toMatchObject({ to: "0.9.4", reason: "protocol v11 required (this node speaks v10)" });
    expect(await readFile(binary, "utf8")).toBe("OLD BINARY");
    expect(await Bun.file(`${binary}.previous`).exists()).toBe(false);
    expect(await readMarker(pendingMarkerPath(dataDir))).toBeNull();
    const recorded = await readMarker<UpdateFailure>(failedMarkerPath(dataDir));
    expect(recorded?.reason).toBe("protocol v11 required (this node speaks v10)");
  });

  it("does NOTHING without a marker — a plane refusing an old agent is not a rollback", async () => {
    // The commonest 4406 by far: a node that predates the floor and that
    // nobody just updated. Inventing a swap there would move files for an
    // update that never happened.
    const { binary, dataDir } = await installedNode();
    pretendInstalledAt(binary);
    expect(await revertAfterRefusal(dataDir, "too old")).toBeNull();
    expect(await readFile(binary, "utf8")).toBe("OLD BINARY");
    expect(await Bun.file(failedMarkerPath(dataDir)).exists()).toBe(false);
  });

  it("refuses to pretend when the marker names a .previous that is gone", async () => {
    const { binary, root, dataDir } = await installedNode();
    pretendInstalledAt(binary);
    const local = join(root, "next");
    await writeFile(local, "NEXT");
    await applyUpdate({
      binaryDeps: NO_SERVICE_DEFINITION,
      source: { kind: "file", path: local },
      version: "0.9.5",
      restart: false,
      origin: "plane",
      dataDir,
      probeVersion: async () => "0.9.5",
    });
    await rm(`${binary}.previous`, { force: true });
    expect(await revertAfterRefusal(dataDir, "refused")).toBeNull();
    // The marker survives: deleting it would report a completed update.
    expect(await readMarker(pendingMarkerPath(dataDir))).not.toBeNull();
  });
});

describe("completeUpdate", () => {
  it("drops .previous and the marker once the plane has accepted the binary", async () => {
    const { binary, root, dataDir } = await installedNode();
    pretendInstalledAt(binary);
    const local = join(root, "next");
    await writeFile(local, "ACCEPTED");
    await applyUpdate({
      binaryDeps: NO_SERVICE_DEFINITION,
      source: { kind: "file", path: local },
      version: "0.9.6",
      restart: false,
      origin: "plane",
      dataDir,
      probeVersion: async () => "0.9.6",
    });
    const done = await completeUpdate(dataDir);
    expect(done?.to).toBe("0.9.6");
    expect(await Bun.file(`${binary}.previous`).exists()).toBe(false);
    expect(await readMarker(pendingMarkerPath(dataDir))).toBeNull();
    // Idempotent: the daemon may decide "accepted" twice (a frame AND the timer).
    expect(await completeUpdate(dataDir)).toBeNull();
  });
});

describe("rollbackUpdate", () => {
  it("refuses when there is no .previous to go back to", async () => {
    const { binary, dataDir } = await installedNode();
    pretendInstalledAt(binary);
    await expect(rollbackUpdate(dataDir, NO_SERVICE_DEFINITION)).rejects.toBeInstanceOf(UpdateRefused);
  });

  it("puts the previous binary back and names the version it restored", async () => {
    const { binary, root, dataDir } = await installedNode();
    pretendInstalledAt(binary);
    const local = join(root, "next");
    await writeFile(local, "REGRETTED");
    const applied = await applyUpdate({
      binaryDeps: NO_SERVICE_DEFINITION,
      source: { kind: "file", path: local },
      version: "0.9.7",
      restart: false,
      origin: "cli",
      dataDir,
      probeVersion: async () => "0.9.7",
    });
    const back = await rollbackUpdate(dataDir, NO_SERVICE_DEFINITION, async () => true);
    expect(back.binary).toBe(binary);
    expect(back.to).toBe(applied.from);
    expect(await readFile(binary, "utf8")).toBe("OLD BINARY");
    // And nothing is left at `.previous`: one rename MOVED it.
    expect(existsSync(`${binary}.previous`)).toBe(false);
  });

  /**
   * The restore is ONE rename, never an unlink followed by one.
   *
   * `rename(2)` replaces an existing destination atomically, so the unlink
   * bought nothing and opened the window this module's own comments call the
   * one outcome nothing can recover: interrupted between the two, a machine
   * has no agent binary at `binary` AND no `.previous` to put back. The
   * observable proof is that the file never stops existing — asserted here by
   * the destination's inode changing while a file is continuously present.
   */
  it("never unlinks the binary it is about to replace", async () => {
    const { binary, root, dataDir } = await installedNode();
    pretendInstalledAt(binary);
    const local = join(root, "next");
    await writeFile(local, "REGRETTED");
    await applyUpdate({
      binaryDeps: NO_SERVICE_DEFINITION,
      source: { kind: "file", path: local },
      version: "0.9.7",
      restart: false,
      origin: "cli",
      dataDir,
      probeVersion: async () => "0.9.7",
    });
    const beforeIno = statSync(binary).ino;
    const previousIno = statSync(`${binary}.previous`).ino;
    await rollbackUpdate(dataDir, NO_SERVICE_DEFINITION, async () => true);
    // The destination path held a file throughout; what changed is WHICH file.
    expect(statSync(binary).ino).toBe(previousIno);
    expect(statSync(binary).ino).not.toBe(beforeIno);
  });
});

/**
 * The rollback PROBE (round-3 review, finding 2), against the DEFAULT probe —
 * no seam — with a real executable stub as the good copy and the suite's
 * plain-text `.previous` as the bad one. `rename(2)` is unconditional, so a
 * truncated copy (the shape an interrupted pre-atomic copy-fallback left)
 * would otherwise land at the path the service manager EXECs.
 */
describe("the rollback probe", () => {
  /** Install `bytes` so the running binary is NEW and `.previous` is the fixture. */
  async function installedSwap(): Promise<{ binary: string; dataDir: string; bytes: string }> {
    const { binary, dataDir } = await installedNode();
    pretendInstalledAt(binary);
    const bytes = "INSTALLED 0.9.9";
    const artifact = serveArtifact(bytes);
    try {
      await applyUpdate({
        binaryDeps: NO_SERVICE_DEFINITION,
        source: {
          kind: "url",
          url: artifact.url,
          sha256: sha256(bytes),
          manifest: signedManifest(sha256(bytes), "0.9.9"),
        },
        version: "0.9.9",
        restart: false,
        origin: "cli",
        dataDir,
        probeVersion: async () => "0.9.9",
      });
    } finally {
      artifact.stop();
    }
    return { binary, dataDir, bytes };
  }

  it("`--rollback` refuses a .previous that cannot run and touches nothing", async () => {
    const { binary, dataDir, bytes } = await installedSwap();
    // The fixture `.previous` is plain text — a regular file the old code
    // would have renamed onto the live path; the probe asks it first.
    await expect(rollbackUpdate(dataDir, NO_SERVICE_DEFINITION)).rejects.toMatchObject({
      detail: NODE_RESULT_NOT_COMPILED,
      message: expect.stringContaining("did not answer `version`"),
    });
    expect(await readFile(binary, "utf8")).toBe(bytes); // the running install stays
    expect(await Bun.file(`${binary}.previous`).exists()).toBe(true); // copy kept as evidence
    expect(await readMarker(pendingMarkerPath(dataDir))).not.toBeNull(); // the open transaction survives
  });

  it("`--rollback` installs a .previous that answers version — the real probe, no seam", async () => {
    const { binary, dataDir } = await installedSwap();
    const stub = '#!/bin/sh\necho "subshell 0.0.1"\n';
    await writeFile(`${binary}.previous`, stub);
    await chmod(`${binary}.previous`, 0o755);
    const back = await rollbackUpdate(dataDir, NO_SERVICE_DEFINITION);
    expect(back.binary).toBe(binary);
    expect(await readFile(binary, "utf8")).toBe(stub);
    expect(await Bun.file(`${binary}.previous`).exists()).toBe(false);
  });

  it("the automatic 4406 revert records instead of swapping in an unbootable copy", async () => {
    // The divergence from `--rollback` is the human: mid-boot nobody can act
    // on a refusal, so the revert keeps the bootable (if refused) new binary,
    // keeps the copy as evidence, consumes the marker, and records the remedy.
    const { binary, dataDir, bytes } = await installedSwap();
    const failure = await revertAfterRefusal(dataDir, "protocol v99 required");
    expect(failure?.reason).toContain("cannot be run");
    expect(failure?.reason).toContain("reinstall by hand");
    expect(await readFile(binary, "utf8")).toBe(bytes); // NOT the truncated copy
    expect(await Bun.file(`${binary}.previous`).exists()).toBe(true);
    expect(await readMarker(pendingMarkerPath(dataDir))).toBeNull(); // next boot converges on "too old"
    const recorded = await readMarker<UpdateFailure>(failedMarkerPath(dataDir));
    expect(recorded?.reason).toContain("cannot be run");
  });

  /**
   * Finding 4: the probe's OWN bound. An unbounded `await proc.exited` turns
   * "refuse the rename" into "hang before the `exit(1)` the 4406 revert owes
   * the service manager" — termination is mandatory exactly on that path, so
   * the probe may take any amount of time except unlimited. Server twin:
   * `spawnSync(..., timeout: 10_000)`.
   */
  it("a probe whose binary never exits answers FALSE at the bound, not at the sleep", async () => {
    const dir = await mkdtemp(join(tmpdir(), "subshell-probe-bound-"));
    const hang = join(dir, "hang-binary");
    await writeFile(hang, "#!/bin/sh\nexec sleep 30\n");
    await chmod(hang, 0o755);
    const t0 = Date.now();
    expect(await rollbackBinaryRuns(hang, 300)).toBe(false);
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(5_000); // the bound fired, not the 30 s sleep
    expect(elapsed).toBeGreaterThanOrEqual(250); // …and it actually waited for it
    // The production default IS the server twin's number — the two probes ask
    // one question and must give up on it together.
    expect(ROLLBACK_PROBE_TIMEOUT_MS).toBe(10_000);
  });

  it("the probe still reads the exit code it always read: 0 runs, nonzero does not", async () => {
    const dir = await mkdtemp(join(tmpdir(), "subshell-probe-code-"));
    const good = join(dir, "good");
    const bad = join(dir, "bad");
    await writeFile(good, "#!/bin/sh\nexit 0\n");
    await writeFile(bad, "#!/bin/sh\nexit 1\n");
    await chmod(good, 0o755);
    await chmod(bad, 0o755);
    expect(await rollbackBinaryRuns(good, 5_000)).toBe(true);
    expect(await rollbackBinaryRuns(bad, 5_000)).toBe(false);
    // A binary that CHATTES must not deadlock the probe on an undrained pipe
    // either — stdout is piped and drained now, and 200 KB exceeds any pipe.
    const chatty = join(dir, "chatty");
    await writeFile(chatty, "#!/bin/sh\nyes 2>/dev/null | head -c 200000\nexit 0\n");
    await chmod(chatty, 0o755);
    expect(await rollbackBinaryRuns(chatty, 5_000)).toBe(true);
  });
});

/**
 * The copy-fallback's ATOMICITY (same finding): an interrupted copy may cost
 * a stray `.tmp-<pid>` at most — never a TRUNCATED `.previous` standing where
 * the rollback paths look for a working binary.
 */
describe("keepPrevious", () => {
  const strayTmps = (binDir: string): string[] => [...new Bun.Glob("*.previous.tmp-*").scanSync(binDir)].sort();

  it("copies atomically when links are refused: full bytes at .previous, no tmp", async () => {
    const { binary, binDir } = await installedNode();
    await keepPrevious(binary, {
      link: async () => {
        throw Object.assign(new Error("link refused"), { code: "EXDEV" });
      },
    });
    expect(await readFile(`${binary}.previous`, "utf8")).toBe("OLD BINARY");
    expect(strayTmps(binDir)).toEqual([]); // renamed INTO place, not left behind
  });

  it("a copy that throws mid-write leaves NOTHING at .previous and sweeps the tmp", async () => {
    const { binary, binDir } = await installedNode();
    await writeFile(`${binary}.previous`, "stale copy from an earlier swap");
    await expect(
      keepPrevious(binary, {
        link: async () => {
          throw new Error("no links here");
        },
        copy: async (_from, to) => {
          await writeFile(to, "OLD"); // partway, then the disk filled
          throw Object.assign(new Error("No space left on device"), { code: "ENOSPC" });
        },
      }),
    ).rejects.toThrow(/No space left/);
    expect(await Bun.file(`${binary}.previous`).exists()).toBe(false); // stale cleared, partial never landed
    expect(strayTmps(binDir)).toEqual([]);
  });
});

describe("resolveNodeRelease", () => {
  /**
   * A fake release source: one `Bun.serve`, routes keyed by pathname, and a
   * record of every path it was asked for. The record is half the test —
   * `resolveNodeRelease` must cost exactly the list read plus two small
   * metadata reads, never the artifact and never the sidecar — and the
   * sidecar route existing-but-unserved is what makes a regression that
   * re-reads it fail on the digest instead of passing quietly.
   */
  function serveReleaseSource(): {
    origin: string;
    routes: Record<string, string>;
    requested: string[];
    stop: () => void;
  } {
    const requested: string[] = [];
    const routes: Record<string, string> = {};
    const server = Bun.serve({
      port: 0,
      fetch: (req) => {
        const path = new URL(req.url).pathname;
        requested.push(path);
        const body = routes[path];
        return body === undefined ? new Response("not here", { status: 404 }) : new Response(body);
      },
    });
    return { origin: `http://127.0.0.1:${server.port}`, routes, requested, stop: () => void server.stop(true) };
  }

  /** The gh-JSON list shape `resolveNodeRelease` reads: tags with named assets. */
  function releaseList(origin: string, tag: string, names: string[]): string {
    return JSON.stringify([
      { tag_name: "cli-node-v0.8.0", draft: false, assets: [] },
      {
        tag_name: tag,
        draft: false,
        assets: names.map((name) => ({ name, browser_download_url: `${origin}/dl/${name}` })),
      },
    ]);
  }

  const MANIFEST_DIGEST = sha256("THE PUBLISHED BINARY");
  const SIDECAR_DIGEST = sha256("bytes nobody published");

  const releaseManifest = (version = "0.9.1"): string =>
    JSON.stringify({
      component: "cli-node",
      version,
      nodeProtocol: 12,
      minNodeVersion: "0.11.0",
      commit: "0".repeat(40),
      // The decoy triple proves the lookup is by THIS host's exact published
      // filename: resolveNodeRelease must ask for HOST_ASSET, not for a
      // plausible sibling.
      assets: { [HOST_ASSET]: MANIFEST_DIGEST, "subshell-node-cli-other-triple": "a".repeat(64) },
    });

  /** The whole fake release: list, manifest, sig, artifact, and a LYING sidecar. */
  function fakeRelease(source: ReturnType<typeof serveReleaseSource>, manifestText: string): void {
    const { origin, routes } = source;
    routes["/releases"] = releaseList(origin, "cli-node-v0.9.1", [
      HOST_ASSET,
      `${HOST_ASSET}.sha256`,
      RELEASE_MANIFEST_NAME,
      RELEASE_MANIFEST_SIG_NAME,
    ]);
    routes[`/dl/${HOST_ASSET}`] = "THE PUBLISHED BINARY";
    routes[`/dl/${HOST_ASSET}.sha256`] = `${SIDECAR_DIGEST}  ${HOST_ASSET}\n`;
    routes[`/dl/${RELEASE_MANIFEST_NAME}`] = manifestText;
    routes[`/dl/${RELEASE_MANIFEST_SIG_NAME}`] = "TEST-ARMOR";
  }

  /** Run one resolve against the fake, with the env restored either way. */
  async function resolveAgainst(
    source: ReturnType<typeof serveReleaseSource>,
  ): Promise<{ ok: true; offer: Awaited<ReturnType<typeof resolveNodeRelease>> } | { ok: false; error: Error }> {
    const before = process.env.SUBSHELL_RELEASE_URL;
    process.env.SUBSHELL_RELEASE_URL = `${source.origin}/releases`;
    try {
      return { ok: true as const, offer: await resolveNodeRelease() };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err : new Error(String(err)) };
    } finally {
      if (before === undefined) delete process.env.SUBSHELL_RELEASE_URL;
      else process.env.SUBSHELL_RELEASE_URL = before;
    }
  }

  it("verifies the publisher before the bytes move and takes the digest from the SIGNED manifest", async () => {
    // The CLI path's ACCEPTANCE case (spec 2026-09-17 §4). This function is a
    // node's own trust anchor — it holds no REST credential, so it checks the
    // publisher directly rather than asking its plane. The seams were the
    // executor's only; the CLI now runs through the same object (whose
    // defaults ARE the production call), which is what lets this suite stand
    // in for the crypto — pinned for real against `tauri signer` fixtures in
    // the protocol package.
    const source = serveReleaseSource();
    const manifestText = releaseManifest();
    fakeRelease(source, manifestText);
    try {
      const result = await resolveAgainst(source);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // Newest node release wins…
      expect(result.offer).toMatchObject({ version: "0.9.1", tag: "cli-node-v0.9.1" });
      // …for THIS host's exact artifact, not the decoy triple in the list…
      expect(result.offer.url).toBe(`${source.origin}/dl/${HOST_ASSET}`);
      // …with the digest the signed map names, never the sidecar's. A
      // regression re-reading the sidecar answers SIDECAR_DIGEST and fails here.
      expect(result.offer.sha256).toBe(MANIFEST_DIGEST);
      // The verified pair rides into applyUpdate, which re-checks the digest
      // against the bytes as they arrive.
      expect(result.offer.manifest).toEqual({ bytes: manifestText, sig: "TEST-ARMOR" });
      // Two small metadata reads and the list — never the artifact, never the
      // sidecar. An unsigned release costs exactly this much.
      expect([...source.requested].sort()).toEqual(
        [`/dl/${RELEASE_MANIFEST_NAME}`, `/dl/${RELEASE_MANIFEST_SIG_NAME}`, "/releases"].sort(),
      );
    } finally {
      source.stop();
    }
  });

  it("answers a refused signature with the tag and the reason, and never names --from", async () => {
    // `${tag} is not installable: ${reason}` — verbatim, because the sentence
    // is the operator's only diagnosis, and because this branch deliberately
    // does NOT point at `--from`: "the publisher did not sign this" is not
    // answered by hand-installing some other file. Nothing is downloaded and
    // nothing is written — `resolveNodeRelease` touches no filesystem.
    updateSeams.verifyManifest = async () => ({
      ok: false as const,
      reason: "test: the fixture signature was refused",
    });
    const source = serveReleaseSource();
    fakeRelease(source, releaseManifest());
    try {
      const result = await resolveAgainst(source);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toBe("cli-node-v0.9.1 is not installable: test: the fixture signature was refused");
      expect(result.error.message).not.toContain("--from");
      expect([...source.requested].sort()).toEqual(
        [`/dl/${RELEASE_MANIFEST_NAME}`, `/dl/${RELEASE_MANIFEST_SIG_NAME}`, "/releases"].sort(),
      );
    } finally {
      source.stop();
    }
  });
});

describe("releaseApiUrl", () => {
  it("is the project's API unset, the operator's when set, and NOTHING when empty", async () => {
    const before = process.env.SUBSHELL_RELEASE_URL;
    try {
      delete process.env.SUBSHELL_RELEASE_URL;
      expect(releaseApiUrl()).toContain("api.github.com");
      process.env.SUBSHELL_RELEASE_URL = "https://mirror.example/releases";
      expect(releaseApiUrl()).toBe("https://mirror.example/releases");
      // Empty is the air-gapped configuration and must not fall back to the
      // default — that would be a host fetching from the internet after an
      // operator said it should not.
      process.env.SUBSHELL_RELEASE_URL = "";
      expect(releaseApiUrl()).toBeNull();
      process.env.SUBSHELL_RELEASE_URL = "   ";
      expect(releaseApiUrl()).toBeNull();
    } finally {
      if (before === undefined) delete process.env.SUBSHELL_RELEASE_URL;
      else process.env.SUBSHELL_RELEASE_URL = before;
    }
  });
});
