import { describe, expect, it } from "bun:test";
import { armed, emptySteps, knownStep, RESET_STEPS, refusal, resetRows, resetStarted } from "../lib/reset";

const paths = {
  dataDir: "/data",
  database: "/data/subshell.db",
  logsDir: "/data/subshells",
  nodeArtifacts: "/data/node-artifacts",
};
// The port is part of the complete block (2026-09-13): Rust refuses a plan
// it cannot dial-verify, and the screen refuses exactly what Rust refuses —
// one sentence, not a typed-hostname surprise after arming fails.
const listen = { port: 3080 };
const good = { configEnv: { path: "/c/config.env", exists: true }, paths, listen };

describe("resetRows / refusal", () => {
  it("names the real paths when the block is complete", () => {
    const rows = resetRows(good as never);
    expect(rows.map((r) => r.path)).toEqual([
      "/data/subshell.db",
      "/data/subshells",
      "/data/node-artifacts",
      "/data",
      "/c/config.env",
    ]);
    expect(refusal(good as never)).toBeNull();
  });
  it("refuses, with the same sentence, for absent or partial blocks (R17)", () => {
    expect(refusal({} as never)).toContain("does not report");
    expect(refusal({ paths: { ...paths, dataDir: "" } } as never)).toContain("does not report");
    expect(refusal({ paths: { ...paths, dataDir: "relative" } } as never)).toContain("does not report");
  });
  it("refuses without a usable listen port — no dial, no plan", () => {
    // The exact shapes a chain cannot verify a stop with: the block missing,
    // the CLI's invalid-port null, and zero.
    expect(refusal({ configEnv: { path: "/c/config.env" }, paths } as never)).toContain("does not report");
    expect(refusal({ ...good, listen: { port: null } } as never)).toContain("does not report");
    expect(refusal({ ...good, listen: { port: 0 } } as never)).toContain("does not report");
  });
});

describe("the reset meter's step table", () => {
  it("starts every row pending, in the chain's own order", () => {
    expect(Object.values(emptySteps()).every((s) => s === "pending")).toBe(true);
    expect(RESET_STEPS.map((s) => s.key)).toEqual(["plan", "stop", "panes", "service", "files"]);
  });
  it("accepts only words it has a row for", () => {
    // A page newer than its binary is this window's normal condition; an
    // unknown word must not invent a row or corrupt a state.
    expect(knownStep("stop", "running")).toBe(true);
    expect(knownStep("files", "failed")).toBe(true);
    expect(knownStep("delete-the-world", "running")).toBe(false);
    expect(knownStep("plan", "exploded")).toBe(false);
    expect(knownStep(undefined, "done")).toBe(false);
  });
});

describe("armed", () => {
  it("is exact and case-sensitive, and so is the Rust side", () => {
    expect(armed("devbox", "devbox")).toBe(true);
    expect(armed("Devbox", "devbox")).toBe(false);
    expect(armed("devbox ", "devbox")).toBe(true); // trailing space is a typing artifact, trimmed
    expect(armed("", "devbox")).toBe(false);
    // The fail-open the PR review caught: an empty hostname is a FAILED READ
    // of hostname(1), not a name - and two empties must never arm a wipe.
    expect(armed("", "")).toBe(false);
    expect(armed("   ", "")).toBe(false);
  });
});

describe("resetStarted", () => {
  // It decides which of the two panes is the screen, so it is the difference
  // between a confirmation box and a progress meter.
  it("is false while every row is still pending", () => {
    expect(resetStarted(emptySteps())).toBe(false);
  });

  it("is true the moment the first row moves", () => {
    expect(resetStarted({ ...emptySteps(), plan: "running" })).toBe(true);
  });

  it("stays true for a half-run that failed", () => {
    expect(resetStarted({ ...emptySteps(), plan: "done", stop: "failed" })).toBe(true);
  });
});
