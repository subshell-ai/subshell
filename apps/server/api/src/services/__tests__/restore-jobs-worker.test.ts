import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { trustedTemporaryDirectory } from "@/services/backups/paths.js";
import { runRestoreWorker } from "@/services/restore-jobs.js";

// Mirror the module's own job-root layout so a test can drop a request.json in
// the place `startRestoreJob` would have written it, WITHOUT running the heavy
// spawn path. The bug under test lives entirely in the worker's read/expiry
// guard and its cleanup, both of which fire before any restore is attempted.
const UUID = "00000000-0000-4000-8000-000000000001";
const root = () => join(trustedTemporaryDirectory(), `subshell-restore-jobs-${process.getuid?.() ?? "user"}`);
const dir = () => join(root(), UUID);

function placeRequest(request: Record<string, unknown>): void {
  mkdirSync(root(), { recursive: true, mode: 0o700 });
  mkdirSync(dir(), { mode: 0o700 });
  // The worker.env a systemd-run launch leaves behind: the secret file that
  // MUST be cleaned even when the worker never gets to run the restore.
  writeFileSync(join(dir(), "worker.env"), 'BETTER_AUTH_SECRET="should-be-removed"\n', { mode: 0o600 });
  writeFileSync(join(dir(), "request.json"), JSON.stringify(request), { mode: 0o600 });
}

const created: string[] = [];
afterEach(() => {
  for (const path of created.splice(0)) rmSync(path, { recursive: true, force: true });
});

function status(): { phase: string; expiresAt: number; error?: string } {
  return JSON.parse(readFileSync(join(dir(), "status.json"), "utf8"));
}

describe("restore worker guard", () => {
  it("writes a failed status and removes worker.env when the request expired", async () => {
    created.push(dir());
    placeRequest({
      staged: UUID,
      source: { dataDir: dir(), databasePath: join(dir(), "db"), configPath: join(dir(), "config.env") },
      pid: process.pid,
      app: false,
      force: false,
      start: true,
      expiresAt: Date.now() - 1,
    });
    expect(await runRestoreWorker(UUID)).toBe(1);
    // Before the finally fix, an expired request threw PAST both the status
    // write and the cleanup: the browser polled "restoring" for the rest of the
    // TTL and the full process.env (secrets included) stayed on disk.
    expect(status().phase).toBe("failed");
    expect(existsSync(join(dir(), "worker.env"))).toBe(false);
  });

  it("writes a failed status and removes worker.env when the request cannot be read", async () => {
    created.push(dir());
    mkdirSync(root(), { recursive: true, mode: 0o700 });
    mkdirSync(dir(), { mode: 0o700 });
    writeFileSync(join(dir(), "worker.env"), "secret\n", { mode: 0o600 });
    // A group-readable request.json is refused by the protected reader.
    const bad = join(dir(), "request.json");
    writeFileSync(bad, "{}", { mode: 0o644 });
    chmodSync(bad, 0o644);
    expect(await runRestoreWorker(UUID)).toBe(1);
    expect(status().phase).toBe("failed");
    expect(existsSync(join(dir(), "worker.env"))).toBe(false);
  });
});
