import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  NODE_RESULT_DIGEST_MISMATCH,
  NODE_RESULT_DOWNLOAD_FAILED,
  NODE_RESULT_NOT_COMPILED,
  NODE_RESULT_VERSION_MISMATCH,
} from "@internal/subshell-protocol";
import {
  applyUpdate,
  completeUpdate,
  failedMarkerPath,
  pendingMarkerPath,
  readMarker,
  releaseApiUrl,
  resolveAgentBinary,
  revertAfterRefusal,
  rollbackUpdate,
  type UpdateFailure,
  UpdateRefused,
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
async function installedAgent(): Promise<{ root: string; binDir: string; binary: string; dataDir: string }> {
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

/** Point `selfInvokePrefix` at our fake install: a basename starting `subshell` takes rung 1. */
let realExecPath: string;
beforeEach(() => {
  realExecPath = process.execPath;
});
afterEach(() => {
  Object.defineProperty(process, "execPath", { value: realExecPath, configurable: true, writable: true });
});
function pretendInstalledAt(binary: string): void {
  Object.defineProperty(process, "execPath", { value: binary, configurable: true, writable: true });
}

describe("resolveAgentBinary", () => {
  it("refuses a source run, because there is no single file to swap", async () => {
    // `selfInvokePrefix` rung 2: an interpreter with a real entry script. The
    // refusal has to be NOT_COMPILED rather than a write error — the remedy is
    // updating the checkout, and naming a download would send someone nowhere.
    Object.defineProperty(process, "execPath", { value: "/usr/local/bin/bun", configurable: true, writable: true });
    const argv1 = process.argv[1];
    process.argv[1] = "/repo/apps/node/agent/src/index.ts";
    try {
      await expect(resolveAgentBinary()).rejects.toMatchObject({ detail: NODE_RESULT_NOT_COMPILED });
    } finally {
      process.argv[1] = argv1;
    }
  });

  it("names the installed binary and its directory", async () => {
    const { binary, binDir } = await installedAgent();
    pretendInstalledAt(binary);
    expect(await resolveAgentBinary()).toEqual({ binary, dir: binDir });
  });
});

describe("applyUpdate", () => {
  it("downloads, verifies, swaps, and keeps the old binary as .previous", async () => {
    const { binary, dataDir } = await installedAgent();
    pretendInstalledAt(binary);
    const bytes = "NEW BINARY 0.9.1";
    const artifact = serveArtifact(bytes);
    try {
      const applied = await applyUpdate({
        source: { kind: "url", url: artifact.url, sha256: sha256(bytes) },
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
    const { binary, binDir, dataDir } = await installedAgent();
    pretendInstalledAt(binary);
    const artifact = serveArtifact("TAMPERED");
    try {
      await expect(
        applyUpdate({
          source: { kind: "url", url: artifact.url, sha256: sha256("WHAT WAS PUBLISHED") },
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

  it("refuses a URL that does not answer 200 without touching anything", async () => {
    const { binary, dataDir } = await installedAgent();
    pretendInstalledAt(binary);
    // The single-use download token the plane mints is forgotten across its own
    // restart, and this 401 is exactly what the agent then sees.
    const artifact = serveArtifact("no", 401);
    try {
      await expect(
        applyUpdate({
          source: { kind: "url", url: artifact.url, sha256: sha256("anything") },
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

  it("refuses when the downloaded binary reports a version other than the one asked for", async () => {
    // A wrong-architecture artifact, or a mis-tagged release: the probe is what
    // catches it before the file becomes the one the service manager runs.
    const { binary, dataDir } = await installedAgent();
    pretendInstalledAt(binary);
    const bytes = "NEW";
    const artifact = serveArtifact(bytes);
    try {
      await expect(
        applyUpdate({
          source: { kind: "url", url: artifact.url, sha256: sha256(bytes) },
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

  it("installs from a local file with no digest, because the operator named the path", async () => {
    const { binary, root, dataDir } = await installedAgent();
    pretendInstalledAt(binary);
    const local = join(root, "downloaded-subshell");
    await writeFile(local, "FROM A FILE");
    const applied = await applyUpdate({
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
    const { binary, root, dataDir } = await installedAgent();
    pretendInstalledAt(binary);
    const local = join(root, "next");
    await writeFile(local, "NEXT");
    const asked: boolean[] = [];
    const applied = await applyUpdate({
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
    const { binary, root, dataDir } = await installedAgent();
    pretendInstalledAt(binary);
    const local = join(root, "next");
    await writeFile(local, "NEXT");
    const applied = await applyUpdate({
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
    const { binary, root, dataDir } = await installedAgent();
    pretendInstalledAt(binary);
    const local = join(root, "next");
    await writeFile(local, "THE REFUSED VERSION");
    await applyUpdate({
      source: { kind: "file", path: local },
      version: "0.9.4",
      restart: false,
      origin: "plane",
      dataDir,
      probeVersion: async () => "0.9.4",
    });

    const failure = await revertAfterRefusal(dataDir, "protocol v11 required (this node speaks v10)");
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
    const { binary, dataDir } = await installedAgent();
    pretendInstalledAt(binary);
    expect(await revertAfterRefusal(dataDir, "too old")).toBeNull();
    expect(await readFile(binary, "utf8")).toBe("OLD BINARY");
    expect(await Bun.file(failedMarkerPath(dataDir)).exists()).toBe(false);
  });

  it("refuses to pretend when the marker names a .previous that is gone", async () => {
    const { binary, root, dataDir } = await installedAgent();
    pretendInstalledAt(binary);
    const local = join(root, "next");
    await writeFile(local, "NEXT");
    await applyUpdate({
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
    const { binary, root, dataDir } = await installedAgent();
    pretendInstalledAt(binary);
    const local = join(root, "next");
    await writeFile(local, "ACCEPTED");
    await applyUpdate({
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
    const { binary, dataDir } = await installedAgent();
    pretendInstalledAt(binary);
    await expect(rollbackUpdate(dataDir)).rejects.toBeInstanceOf(UpdateRefused);
  });

  it("puts the previous binary back and names the version it restored", async () => {
    const { binary, root, dataDir } = await installedAgent();
    pretendInstalledAt(binary);
    const local = join(root, "next");
    await writeFile(local, "REGRETTED");
    const applied = await applyUpdate({
      source: { kind: "file", path: local },
      version: "0.9.7",
      restart: false,
      origin: "cli",
      dataDir,
      probeVersion: async () => "0.9.7",
    });
    const back = await rollbackUpdate(dataDir);
    expect(back.binary).toBe(binary);
    expect(back.to).toBe(applied.from);
    expect(await readFile(binary, "utf8")).toBe("OLD BINARY");
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
