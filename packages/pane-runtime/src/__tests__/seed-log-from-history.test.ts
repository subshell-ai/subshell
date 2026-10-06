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

  it("creates nothing for a silent pane: mode preamble and blank rows are decoration, not content", async () => {
    // The stub mirrors the REAL capturePane contract (measured): the result
    // leads with all five DECSET forms - the `l` forms included - and pads
    // with blank rows, so a raw trim is never empty for a live-but-silent
    // pane. The guard must strip first.
    const preamble = "\x1b[?1049l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l";
    for (const [i, history] of ["", "\n \r\n", `${preamble}\n\n   \n \n`].entries()) {
      const logFile = join(base, `silent-${i}.log`);
      await seedLogFromHistory(tmuxWithHistory(history), "sock", "p3", logFile);
      expect(() => statSync(logFile)).toThrow();
    }
  });

  it("a failed append (log dir gone mid-flight) returns the note and throws nothing", async () => {
    const logFile = join(base, "no-such-dir", "deep.log");
    const note = await seedLogFromHistory(tmuxWithHistory("MARKER\n"), "sock", "p5", logFile);
    expect(note).toStartWith("log seed failed");
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
