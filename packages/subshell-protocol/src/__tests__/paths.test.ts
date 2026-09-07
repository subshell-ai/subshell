import { describe, expect, test } from "bun:test";
import {
  CLI_SUFFIX,
  defaultSubshellServerDataDir,
  NODE_TARGETS,
  nodeArtifactFileName,
  resolveNodeArtifactsDir,
  SERVER_TARGETS,
  serverArtifactFileName,
} from "../paths.js";

/**
 * The env ladder both the backend's NODE_ARTIFACTS_DIR (constants.ts) and
 * the agent's release pipeline (scripts/release.ts) derive from — pinned ONCE
 * here because the whole point of the shared module is that the two consumers
 * can no longer drift.
 */

describe("defaultSubshellServerDataDir", () => {
  test("file-backed DATABASE_PATH → its dirname", () => {
    expect(defaultSubshellServerDataDir({ DATABASE_PATH: "/srv/subshell/data/subshell.db" })).toBe(
      "/srv/subshell/data",
    );
  });

  test("non-file-backed paths fall back to ./data (URI, memory, bare filename)", () => {
    expect(defaultSubshellServerDataDir({ DATABASE_PATH: "file:/srv/db.sqlite?mode=rw" })).toBe("./data");
    expect(defaultSubshellServerDataDir({ DATABASE_PATH: "file::memory:?cache=shared" })).toBe("./data");
    expect(defaultSubshellServerDataDir({ DATABASE_PATH: "subshell.db" })).toBe("./data");
  });

  test("unset DATABASE_PATH uses the ./data/subshell.db default (→ ./data)", () => {
    expect(defaultSubshellServerDataDir({})).toBe("./data");
  });

  test("root-level db path yields '.' not the empty string", () => {
    expect(defaultSubshellServerDataDir({ DATABASE_PATH: "/subshell.db" })).toBe(".");
  });
});

describe("resolveNodeArtifactsDir", () => {
  test("SUBSHELL_NODE_ARTIFACTS_DIR wins outright (no join, no defaulting)", () => {
    expect(
      resolveNodeArtifactsDir({ SUBSHELL_NODE_ARTIFACTS_DIR: "/opt/artifacts", SUBSHELL_SERVER_DATA_DIR: "/sd" }),
    ).toBe("/opt/artifacts");
  });

  test("empty-string overrides count as UNSET (both apps treat '' as absent)", () => {
    expect(resolveNodeArtifactsDir({ SUBSHELL_NODE_ARTIFACTS_DIR: "", SUBSHELL_SERVER_DATA_DIR: "/sd" })).toBe(
      "/sd/node-artifacts",
    );
  });

  test("SUBSHELL_SERVER_DATA_DIR → <it>/node-artifacts", () => {
    expect(resolveNodeArtifactsDir({ SUBSHELL_SERVER_DATA_DIR: "/srv/subshell/subshells" })).toBe(
      "/srv/subshell/subshells/node-artifacts",
    );
  });

  test("nothing set → derived from DATABASE_PATH", () => {
    expect(resolveNodeArtifactsDir({ DATABASE_PATH: "/srv/subshell/data/subshell.db" })).toBe(
      "/srv/subshell/data/node-artifacts",
    );
    expect(resolveNodeArtifactsDir({})).toBe("./data/node-artifacts");
  });
});

describe("NODE_TARGETS / SERVER_TARGETS", () => {
  test("node set is the three served triples — no Intel Mac (spec 2026-08-31 §8)", () => {
    expect(NODE_TARGETS).toEqual(["linux-x64", "linux-arm64", "darwin-arm64"]);
  });

  test("server set is the plan-2 triple set — narrower: NO darwin-x64", () => {
    expect(SERVER_TARGETS).toEqual(["linux-x64", "linux-arm64", "darwin-arm64"]);
    expect((SERVER_TARGETS as readonly string[]).includes("darwin-x64")).toBe(false);
  });

  test("the two artifact names never collide on a shared triple", () => {
    for (const triple of SERVER_TARGETS) {
      expect(nodeArtifactFileName(triple)).toBe(`subshell-cli-${triple}`);
      expect(serverArtifactFileName(triple)).toBe(`subshell-server-cli-${triple}`);
      expect(serverArtifactFileName(triple)).not.toBe(nodeArtifactFileName(triple));
    }
  });

  // The suffix is on the ARTIFACT name only: what an operator installs is
  // still `subshell-server` / `subshell`, so a downloaded file must never
  // arrive already carrying the installed binary's exact name (that is what
  // makes "rename it on install" a real step rather than a no-op).
  test("no artifact name is the installed binary's name", () => {
    expect(CLI_SUFFIX).toBe("cli");
    for (const triple of NODE_TARGETS) {
      expect(nodeArtifactFileName(triple)).not.toBe("subshell");
    }
    for (const triple of SERVER_TARGETS) {
      expect(serverArtifactFileName(triple)).not.toBe("subshell-server");
      // …and dropping the platform triple does NOT give it either, which is
      // why the install instructions name the destination explicitly.
      expect(serverArtifactFileName(triple).replace(`-${triple}`, "")).toBe("subshell-server-cli");
    }
  });
});
