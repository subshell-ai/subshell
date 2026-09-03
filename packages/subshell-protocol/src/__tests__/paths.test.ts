import { describe, expect, test } from "bun:test";
import { defaultSubshellServerDataDir, resolveNodeArtifactsDir } from "../paths.js";

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
