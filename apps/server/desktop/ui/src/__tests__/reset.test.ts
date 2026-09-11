import { describe, expect, it } from "bun:test";
import { armed, refusal, resetRows } from "../lib/reset";

const paths = {
  dataDir: "/data",
  database: "/data/subshell.db",
  logsDir: "/data/subshells",
  nodeArtifacts: "/data/node-artifacts",
};

describe("resetRows / refusal", () => {
  it("names the real paths when the block is complete", () => {
    const rows = resetRows({ configEnv: { path: "/c/config.env", exists: true }, paths } as never);
    expect(rows.map((r) => r.path)).toEqual([
      "/data/subshell.db",
      "/data/subshells",
      "/data/node-artifacts",
      "/data",
      "/c/config.env",
    ]);
    expect(refusal({ configEnv: { path: "/c/config.env", exists: true }, paths } as never)).toBeNull();
  });
  it("refuses, with the same sentence, for absent or partial blocks (R17)", () => {
    expect(refusal({} as never)).toContain("does not report");
    expect(refusal({ paths: { ...paths, dataDir: "" } } as never)).toContain("does not report");
    expect(refusal({ paths: { ...paths, dataDir: "relative" } } as never)).toContain("does not report");
  });
});

describe("armed", () => {
  it("is exact and case-sensitive, and so is the Rust side", () => {
    expect(armed("devbox", "devbox")).toBe(true);
    expect(armed("Devbox", "devbox")).toBe(false);
    expect(armed("devbox ", "devbox")).toBe(true); // trailing space is a typing artifact, trimmed
    expect(armed("", "devbox")).toBe(false);
  });
});
