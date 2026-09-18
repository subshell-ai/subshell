import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  hostReleaseTarget,
  parseReleaseManifest,
  RELEASE_MANIFEST_NAME,
  RELEASE_MANIFEST_SIG_NAME,
  releaseAssetNames,
} from "@internal/subshell-protocol";
import { backupsDir } from "@/services/db-backup.js";
import type { ResolvedRelease } from "@/services/releases.js";
import { releaseSeams, resetReleaseCacheForTests, setReleaseUrlForTests } from "@/services/releases.js";
import {
  collectServerUpdateView,
  currentUpdateJob,
  describeBinary,
  resetUpdateJobForTests,
  startServerUpdate,
  updateJobRunning,
} from "@/services/server-update.js";
import { clearPending, readPending, updateDir } from "@/services/update-transaction.js";
import { SERVER_VERSION } from "@/version.js";

/**
 * The in-process update job (spec 2026-09-15 §4.5), against a real fake
 * release server.
 *
 * A REAL server rather than a stubbed `fetch`, for the same reason
 * `releases.test.ts` uses one: the subject is bytes arriving over the network
 * and being hashed on the way past, and the two failures that matter — a
 * digest that does not match, and a binary that will not say what it is — are
 * only observable in what is left on disk afterwards.
 *
 * The host triple is the one thing that cannot be faked: `runJob` asks
 * `hostReleaseTarget(process.platform, process.arch)` which asset to fetch, so
 * the fixture publishes the asset THIS machine would ask for. On a platform
 * with no published artifact (an Intel Mac) that answer is null, which is
 * itself one of the cases below.
 */

const HOST_TARGET = hostReleaseTarget(process.platform, process.arch);

interface Fake {
  url: string;
  stop: () => void;
  assets: Map<string, Uint8Array>;
}

function startFakeRelease(): Fake {
  const state: Partial<Fake> = { assets: new Map() };
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      const name = url.pathname.startsWith("/asset/") ? decodeURIComponent(url.pathname.slice("/asset/".length)) : null;
      const bytes = name ? (state.assets ?? new Map()).get(name) : undefined;
      if (!bytes) return new Response("not found", { status: 404 });
      return new Response(bytes);
    },
  });
  state.url = `http://127.0.0.1:${server.port}`;
  state.stop = () => server.stop(true);
  return state as Fake;
}

const enc = (text: string) => new TextEncoder().encode(text);

function sha256(bytes: Uint8Array): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(bytes);
  return hasher.digest("hex");
}

/** A release whose assets resolve against the fake server. */
function releaseWith(fake: Fake, version: string, body: string, digestOverride?: string): ResolvedRelease {
  // Every non-host platform is irrelevant here: the job asks for exactly one.
  const names = releaseAssetNames("server", HOST_TARGET ?? "linux-x64");
  const bytes = enc(body);
  fake.assets.set(names.binary, bytes);
  // The job's digest comes from the SIGNED MANIFEST (spec 2026-09-17 §5
  // path 2), so the fixture publishes manifest + signature alongside the
  // binary; `digestOverride` spoofs the manifest naming a digest the bytes
  // do not have. `releaseSeams.verifyManifest` (restored in `afterEach`)
  // stands in for the crypto — the real verifier is pinned by the protocol
  // package's fixture trio.
  const manifest = {
    component: "server",
    version,
    nodeProtocol: 12,
    minAgentVersion: "0.11.0",
    commit: "0".repeat(40),
    assets: { [names.binary]: digestOverride ?? sha256(bytes) },
  };
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  fake.assets.set(RELEASE_MANIFEST_NAME, enc(manifestText));
  fake.assets.set(RELEASE_MANIFEST_SIG_NAME, enc("TEST-ARMOR"));
  const assetUrl = (name: string) => `${fake.url}/asset/${encodeURIComponent(name)}`;
  const assets = new Map<string, string>([
    [names.binary, assetUrl(names.binary)],
    [RELEASE_MANIFEST_NAME, assetUrl(RELEASE_MANIFEST_NAME)],
    [RELEASE_MANIFEST_SIG_NAME, assetUrl(RELEASE_MANIFEST_SIG_NAME)],
  ]);
  return {
    component: "server",
    tag: `server-v${version}`,
    version,
    assets,
    manifest: null,
    manifestRead: false,
    manifestOutcome: null,
  };
}

/** The seam, replaced in `beforeEach` and handed back in `afterEach`. */
const realVerify = { ...releaseSeams };

/** Wait for the job to leave the phases that are still doing work. */
async function settle(): Promise<void> {
  for (let i = 0; i < 200 && updateJobRunning(); i++) await Bun.sleep(10);
}

let fake: Fake;
let dir: string;
let binary: string;

beforeEach(() => {
  fake = startFakeRelease();
  dir = mkdtempSync(join(tmpdir(), "subshell-update-job-"));
  binary = join(dir, "subshell-server");
  writeFileSync(binary, "the old binary", { mode: 0o755 });
  resetUpdateJobForTests();
  clearPending();
  releaseSeams.verifyManifest = async (bytes, sig, _pub, expected) => {
    const parsed = parseReleaseManifest(typeof bytes === "string" ? bytes : Buffer.from(bytes).toString("utf8"));
    if (parsed === null || sig.trim() !== "TEST-ARMOR") {
      return { ok: false, reason: "test: the fixture signature was refused" };
    }
    if (parsed.component !== expected.component || parsed.version !== expected.version) {
      return { ok: false, reason: `test: payload names ${parsed.component} ${parsed.version}` };
    }
    return { ok: true, manifest: parsed };
  };
});

afterEach(() => {
  fake.stop();
  resetUpdateJobForTests();
  clearPending();
  rmSync(dir, { recursive: true, force: true });
  setReleaseUrlForTests(null);
  resetReleaseCacheForTests();
  Object.assign(releaseSeams, realVerify);
});

describe("startServerUpdate", () => {
  it("downloads, verifies, backs up, swaps both ways, and exits for the manager", async () => {
    let restarted = 0;
    startServerUpdate(
      { release: releaseWith(fake, "99.0.0", "the new binary"), binary, forced: false },
      {
        backup: async () => ({ path: join(dir, "snapshot.db") }),
        probeVersion: () => "99.0.0",
        restart: () => {
          restarted++;
        },
      },
    );
    await settle();

    const job = currentUpdateJob();
    expect(job?.phase).toBe("restarting");
    expect(job?.error).toBeNull();
    expect(job?.to).toBe("99.0.0");
    expect(restarted).toBe(1);
    // Both halves of the swap, in one directory — the shape `rename(2)` needs.
    expect(readFileSync(binary, "utf8")).toBe("the new binary");
    expect(readFileSync(`${binary}.previous`, "utf8")).toBe("the old binary");
    // The marker survives the job on purpose: the NEXT boot consumes it.
    const pending = readPending();
    expect(pending?.to).toBe("99.0.0");
    expect(pending?.origin).toBe("api");
    expect(pending?.backup).toBe(join(dir, "snapshot.db"));
  });

  it("leaves the installed binary untouched when the digest does not match", async () => {
    startServerUpdate(
      {
        release: releaseWith(fake, "99.0.0", "the new binary", "0".repeat(64)),
        binary,
        forced: false,
      },
      {
        backup: async () => ({ path: "/unused" }),
        probeVersion: () => "99.0.0",
        restart: () => {
          throw new Error("must not restart on a failed download");
        },
      },
    );
    await settle();

    expect(currentUpdateJob()?.phase).toBe("failed");
    expect(currentUpdateJob()?.error).toContain("did not match the published digest");
    expect(readFileSync(binary, "utf8")).toBe("the old binary");
    expect(existsSync(`${binary}.previous`)).toBe(false);
    // Nothing was opened, so there is nothing for the next boot to act on.
    expect(readPending()).toBeNull();
  });

  it("refuses a binary that reports a different version, and deletes it", async () => {
    startServerUpdate(
      { release: releaseWith(fake, "99.0.0", "the new binary"), binary, forced: false },
      {
        backup: async () => ({ path: "/unused" }),
        // The digest proves the bytes are the ones that release published; it
        // does not prove the release was labelled right.
        probeVersion: () => "0.0.1",
        restart: () => {
          throw new Error("must not restart");
        },
      },
    );
    await settle();

    expect(currentUpdateJob()?.phase).toBe("failed");
    expect(currentUpdateJob()?.error).toContain("reports 0.0.1, not 99.0.0");
    expect(readFileSync(binary, "utf8")).toBe("the old binary");
    expect(readPending()).toBeNull();
  });

  it("fails without swapping when the database cannot be backed up", async () => {
    startServerUpdate(
      { release: releaseWith(fake, "99.0.0", "the new binary"), binary, forced: false },
      {
        backup: async () => {
          throw new Error("the disk is full");
        },
        probeVersion: () => "99.0.0",
        restart: () => {
          throw new Error("must not restart");
        },
      },
    );
    await settle();

    expect(currentUpdateJob()?.error).toContain("the disk is full");
    expect(readFileSync(binary, "utf8")).toBe("the old binary");
    expect(readPending()).toBeNull();
  });

  it("puts the old binary back when the second rename fails", async () => {
    let renames = 0;
    startServerUpdate(
      { release: releaseWith(fake, "99.0.0", "the new binary"), binary, forced: false },
      {
        backup: async () => null,
        probeVersion: () => "99.0.0",
        restart: () => {
          throw new Error("must not restart");
        },
        rename: (from, to) => {
          renames++;
          // The window between the two renames is the only moment this host
          // has no binary at all; failing the second is what tests the undo.
          if (renames === 2) throw new Error("no space left on device");
          Bun.spawnSync({ cmd: ["mv", from, to] });
        },
      },
    );
    await settle();

    expect(currentUpdateJob()?.phase).toBe("failed");
    expect(readFileSync(binary, "utf8")).toBe("the old binary");
    expect(existsSync(`${binary}.previous`)).toBe(false);
    // The marker is cleared too, or the next boot would revert an update that
    // never happened.
    expect(readPending()).toBeNull();
  });

  it("records a backup-less transaction rather than refusing it", async () => {
    startServerUpdate(
      { release: releaseWith(fake, "99.0.0", "the new binary"), binary, forced: true },
      { backup: async () => null, probeVersion: () => "99.0.0", restart: () => {} },
    );
    await settle();

    // A fresh install has no database to snapshot. That is a state to record,
    // not a failure: the revert still puts the binary back.
    expect(readPending()?.backup).toBeNull();
    expect(readPending()?.forced).toBe(true);
  });
});

describe("describeBinary", () => {
  it("flattens a checkout into one reason a page can render", () => {
    const view = describeBinary({
      kind: "source",
      argv: ["/usr/bin/bun", "/repo/src/index.ts"],
      source: "service definition",
      reason: "this server runs from a checkout; update it with git",
    });
    expect(view.kind).toBe("source");
    expect(view.path).toBeNull();
    expect(view.reason).toContain("/usr/bin/bun /repo/src/index.ts");
  });

  it("names an unwritable compiled binary as a reason, not as another kind", () => {
    // "unknown" would say this host names no binary, which is false and sends
    // an operator to the wrong fix.
    const view = describeBinary({
      kind: "compiled",
      path: join(dir, "does-not-exist", "subshell-server"),
      source: "service definition",
    });
    expect(view.kind).toBe("compiled");
    expect(view.reason).toContain("cannot replace");
  });

  it("reports a replaceable binary with no reason at all", () => {
    const view = describeBinary({ kind: "compiled", path: binary, source: "this process" });
    expect(view).toEqual({ kind: "compiled", path: binary, reason: null });
  });
});

describe("collectServerUpdateView", () => {
  it("names the empty release source as a blocker and asks the network for nothing", async () => {
    // `IS_TEST` pins SUBSHELL_RELEASE_URL empty, so this is the default state
    // of the suite as well as the air-gapped deployment.
    const view = await collectServerUpdateView();
    expect(view.source.enabled).toBe(false);
    expect(view.current).toBe(SERVER_VERSION);
    expect(view.latest).toBeNull();
    expect(view.latestError).toBeNull();
    expect(view.updateAvailable).toBe(false);
    expect(view.canApply.ok).toBe(false);
    expect(view.canApply.reasons).toContain("no release source is configured (SUBSHELL_RELEASE_URL is empty)");
  });

  it("reports the reason the source could not be read rather than failing the page", async () => {
    setReleaseUrlForTests("http://127.0.0.1:1/releases");
    const view = await collectServerUpdateView();
    expect(view.source.enabled).toBe(true);
    expect(view.latest).toBeNull();
    expect(view.latestError).toContain("could not read the releases");
  });

  it("names an open transaction, whichever surface opened it", async () => {
    mkdirSync(updateDir(), { recursive: true, mode: 0o700 });
    writeFileSync(
      join(updateDir(), "pending.json"),
      JSON.stringify({
        from: "1.0.0",
        to: "2.0.0",
        binary,
        previousBinary: `${binary}.previous`,
        backup: null,
        startedAt: new Date().toISOString(),
        origin: "cli",
        forced: false,
      }),
    );
    const view = await collectServerUpdateView();
    expect(view.canApply.reasons).toContain("an update is already in progress");
  });

  /**
   * The card's whole claim about backups is "the newest one is from THEN", and
   * it is the sentence an operator reads before pressing a button that
   * migrates their database. `listBackups` answers newest-first — the order
   * `prune` slices the tail off and the order `status --json` reads `[0]`
   * from — and reading the tail here reported the OLDEST snapshot instead, so
   * on a host with the default five the card said the database was last backed
   * up four updates ago. Two files is the smallest case that can tell the two
   * readings apart.
   */
  it("names the NEWEST snapshot as the latest backup, not the oldest", async () => {
    const backups = backupsDir();
    mkdirSync(backups, { recursive: true, mode: 0o700 });
    const oldest = join(backups, "subshell-v0.6.0-20260101-000000.db");
    const newest = join(backups, "subshell-v0.7.0-20260915-120000.db");
    writeFileSync(oldest, "old", { mode: 0o600 });
    writeFileSync(newest, "new", { mode: 0o600 });

    const view = await collectServerUpdateView();
    expect(view.backups.count).toBe(2);
    expect(view.backups.latest?.path).toBe(newest);

    rmSync(oldest, { force: true });
    rmSync(newest, { force: true });
  });
});
