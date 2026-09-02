import { describe, expect, test } from "bun:test";
import { defaultSessionDataDir, resolveNodeArtifactsDir } from "../paths.js";

/**
 * The env ladder both the backend's NODE_ARTIFACTS_DIR (constants.ts) and
 * the agent's release pipeline (scripts/release.ts) derive from — pinned ONCE
 * here because the whole point of the shared module is that the two consumers
 * can no longer drift.
 */

describe("defaultSessionDataDir", () => {
  test("file-backed DATABASE_PATH → its dirname", () => {
    expect(defaultSessionDataDir({ DATABASE_PATH: "/srv/mote/data/mote.db" })).toBe("/srv/mote/data");
  });

  test("non-file-backed paths fall back to ./data (URI, memory, bare filename)", () => {
    expect(defaultSessionDataDir({ DATABASE_PATH: "file:/srv/db.sqlite?mode=rw" })).toBe("./data");
    expect(defaultSessionDataDir({ DATABASE_PATH: "file::memory:?cache=shared" })).toBe("./data");
    expect(defaultSessionDataDir({ DATABASE_PATH: "mote.db" })).toBe("./data");
  });

  test("unset DATABASE_PATH uses the ./data/mote.db default (→ ./data)", () => {
    expect(defaultSessionDataDir({})).toBe("./data");
  });

  test("root-level db path yields '.' not the empty string", () => {
    expect(defaultSessionDataDir({ DATABASE_PATH: "/mote.db" })).toBe(".");
  });
});

describe("resolveNodeArtifactsDir", () => {
  test("MOTE_NODE_ARTIFACTS_DIR wins outright (no join, no defaulting)", () => {
    expect(resolveNodeArtifactsDir({ MOTE_NODE_ARTIFACTS_DIR: "/opt/artifacts", SESSION_DATA_DIR: "/sd" })).toBe(
      "/opt/artifacts",
    );
  });

  test("empty-string overrides count as UNSET (both apps treat '' as absent)", () => {
    expect(resolveNodeArtifactsDir({ MOTE_NODE_ARTIFACTS_DIR: "", SESSION_DATA_DIR: "/sd" })).toBe(
      "/sd/node-artifacts",
    );
  });

  test("SESSION_DATA_DIR → <it>/node-artifacts", () => {
    expect(resolveNodeArtifactsDir({ SESSION_DATA_DIR: "/srv/mote/sessions" })).toBe(
      "/srv/mote/sessions/node-artifacts",
    );
  });

  test("nothing set → derived from DATABASE_PATH", () => {
    expect(resolveNodeArtifactsDir({ DATABASE_PATH: "/srv/mote/data/mote.db" })).toBe("/srv/mote/data/node-artifacts");
    expect(resolveNodeArtifactsDir({})).toBe("./data/node-artifacts");
  });
});
