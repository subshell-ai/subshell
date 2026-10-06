import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedLogFromHistory } from "../seed-log.js";
import type { TmuxRunner } from "../tmux-runner.js";

/**
 * The pipe-pane attach race backfill (the CI harness cell proof): a pane
 * that printed BEFORE the capture child attached has its first bytes only in
 * tmux history. seedLogFromHistory copies history into the log exactly while
 * the log has received nothing; once the stream is flowing, reconstruction
 * must never be prepended. Units run without a tmux server (the packages
 * shard has none; the live proof is the e2e cell in spec 22).
 */

function tmuxWithHistory(history: string): TmuxRunner {
  return { capturePane: async () => history } as unknown as TmuxRunner;
}

const base = mkdtempSync(join(tmpdir(), "subshell-seed-"));

describe("seedLogFromHistory", () => {
  it("writes history into a log the pipe never reached, newline-terminated at 0600", async () => {
    const logFile = join(base, "empty.log");
    await seedLogFromHistory(tmuxWithHistory("SEED-MARKER-1"), "sock", "p1", logFile);
    const text = readFileSync(logFile, "utf8");
    expect(text).toBe("SEED-MARKER-1\n"); // the missing newline was appended
    expect(statSync(logFile).mode & 0o777).toBe(0o600);
  });

  it("leaves a flowing stream untouched: a non-empty file IS the tail already arriving", async () => {
    const logFile = join(base, "flowing.log");
    writeFileSync(logFile, "live-bytes\n");
    await seedLogFromHistory(tmuxWithHistory("EARLIER-STUFF"), "sock", "p2", logFile);
    expect(readFileSync(logFile, "utf8")).toBe("live-bytes\n");
  });

  it("creates nothing for a silent pane (empty or whitespace-only history)", async () => {
    for (const [i, history] of ["", "\n \r\n"].entries()) {
      const logFile = join(base, `silent-${i}.log`);
      await seedLogFromHistory(tmuxWithHistory(history), "sock", "p3", logFile);
      expect(() => statSync(logFile)).toThrow();
    }
  });

  it("a throwing capture is the best-effort it claims: no throw, no file", async () => {
    const boom = {
      capturePane: async () => {
        throw new Error("no server");
      },
    } as unknown as TmuxRunner;
    const logFile = join(base, "boom.log");
    await seedLogFromHistory(boom, "sock", "p4", logFile);
    expect(() => statSync(logFile)).toThrow();
  });
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true }); // bun evaluates the whole file before running tests; cleanup belongs here
});
