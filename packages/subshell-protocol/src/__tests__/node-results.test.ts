import { describe, expect, it } from "bun:test";
import {
  FS_LS_MAX_ENTRIES,
  NODE_CLOSE_SUPERSEDED,
  NODE_CLOSE_UPDATE_REQUIRED,
  parseNodeCaptureResult,
  parseNodeCommandBody,
  parseNodeDetectResults,
  parseNodeEvent,
  parseNodeFsLsResult,
  parseNodeLogReadResult,
  parseNodePaneSizeResult,
  parseNodePathExistsResult,
  parseNodeProbeEntries,
  parseNodePromptDeliver,
  parseNodeStatDirResult,
  parseNodeWriteFileResult,
} from "../index.js";

describe("node result contracts (spec §3.3, phase-2 wire note)", () => {
  it("hoists the two shared close codes", () => {
    expect(NODE_CLOSE_UPDATE_REQUIRED).toBe(4406);
    expect(NODE_CLOSE_SUPERSEDED).toBe(4409);
  });

  it("probe entries: accept well-formed (incl. optional fields), reject junk", () => {
    expect(
      parseNodeProbeEntries([
        { subshellId: "a", alive: true, exitCode: null },
        { subshellId: "b", alive: false, exitCode: 1, title: "t", command: "c", capture: "screen" },
      ]),
    ).toHaveLength(2);
    expect(parseNodeProbeEntries(null)).toBeNull();
    expect(parseNodeProbeEntries([{ subshellId: "a" }])).toBeNull(); // alive missing
    expect(parseNodeProbeEntries([{ subshellId: "a", alive: true, exitCode: 1.5 }])).toBeNull();
    expect(parseNodeProbeEntries([{ subshellId: "a", alive: true, exitCode: null, title: 7 }])).toBeNull();
  });

  it("log_read requires a strict-base64 payload and monotonic offsets", () => {
    expect(parseNodeLogReadResult({ bytes_b64: "aGk=", next: 2, size: 2 })).not.toBeNull();
    expect(parseNodeLogReadResult({ bytes_b64: "!!", next: 0, size: 1 })).toBeNull();
    expect(parseNodeLogReadResult({ bytes_b64: "", next: 5, size: 3 })).toBeNull(); // empty read must not jump past EOF
    expect(parseNodeLogReadResult({ bytes_b64: "", next: 3, size: 3 })).not.toBeNull(); // empty tail read is legal
    expect(parseNodeLogReadResult({ bytes_b64: "aGk=", next: -1, size: 2 })).toBeNull();
  });

  it("the scalar results validate narrowly", () => {
    expect(parseNodeCaptureResult("screen")).toBe("screen");
    expect(parseNodeCaptureResult(42)).toBeNull();
    expect(parseNodeStatDirResult({ path: "/x", isDirectory: true })).not.toBeNull();
    expect(parseNodeStatDirResult({ path: "/x", isDirectory: "yes" })).toBeNull();
    expect(parseNodePromptDeliver({ promptDelivered: false })).not.toBeNull();
    expect(parseNodePromptDeliver({})).toBeNull();
    expect(parseNodePathExistsResult({ exists: true })).not.toBeNull();
    expect(parseNodePathExistsResult({ exists: false })).not.toBeNull(); // "absent" is a real answer, not a missing one
    expect(parseNodePathExistsResult({ exists: null })).toBeNull();
    expect(parseNodePathExistsResult({})).toBeNull();
    expect(parseNodeWriteFileResult({ path: "/x", received: 12 })).not.toBeNull();
    expect(parseNodeWriteFileResult({ path: "", received: 0 })).toBeNull();
  });

  it("fs_ls: dir-only entries with a nullable parent and a boolean truncated flag", () => {
    expect(FS_LS_MAX_ENTRIES).toBe(1000);
    expect(
      parseNodeFsLsResult({
        path: "/home/u",
        parent: "/",
        entries: [{ name: "projects", path: "/home/u/projects", kind: "dir" }],
        truncated: false,
      }),
    ).not.toBeNull();
    expect(parseNodeFsLsResult({ path: "/", parent: null, entries: [], truncated: true })).not.toBeNull();
    expect(parseNodeFsLsResult({ path: "/x", parent: undefined, entries: [], truncated: false })).toBeNull();
    expect(parseNodeFsLsResult({ path: "/x", parent: "/", entries: [], truncated: "no" })).toBeNull();
    expect(parseNodeFsLsResult({ path: "/x", parent: "/", truncated: false })).toBeNull(); // entries missing
    // A `file` entry is off-contract — the listing is directories only.
    expect(
      parseNodeFsLsResult({
        path: "/x",
        parent: "/",
        entries: [{ name: "f", path: "/x/f", kind: "file" }],
        truncated: false,
      }),
    ).toBeNull();
    expect(
      parseNodeFsLsResult({ path: "/x", parent: "/", entries: [{ name: "d", path: "/x/d" }], truncated: false }),
    ).toBeNull(); // kind missing
  });
});

describe("phase-2 additive frame fields (protocol stays v1)", () => {
  const launchCmd = {
    type: "launch",
    subshellId: "s1",
    socket: "subshell-abc",
    cwd: "/home/u/repo",
    harnessId: "claude-code",
    preset: { name: "P", env: {}, flags: [], settings: null, configIsolation: false },
    subshellEnv: { SUBSHELL_API_KEY: "subshell_x" },
    subshellName: "s1",
    // Required on every well-formed launch since protocol 3 — this fixture's
    // subject is `bestEffortLog`, so it carries the two build-materials fields
    // just to stay parseable.
    argv: ["claude"],
    resolve: { binaryName: "claude" },
  };

  it("launch.bestEffortLog is an optional boolean", () => {
    expect(parseNodeCommandBody({ ...launchCmd, bestEffortLog: true })).not.toBeNull();
    expect(parseNodeCommandBody({ ...launchCmd, bestEffortLog: false })).not.toBeNull();
    expect(parseNodeCommandBody({ ...launchCmd, bestEffortLog: "yes" })).toBeNull();
    expect(parseNodeCommandBody({ ...launchCmd })).not.toBeNull(); // absent ⇒ today's behavior
  });

  it("ready.selfInvoke is an optional { command, args }", () => {
    const ready = {
      type: "ready",
      agentVersion: "0.2.0",
      protocolVersion: 1,
      os: "linux",
      arch: "x64",
      hostname: "box",
      dataDir: "/home/u/.local/share/subshell",
      capabilities: [],
    };
    expect(parseNodeEvent({ ...ready, selfInvoke: { command: "/usr/bin/subshell", args: [] } })?.type).toBe("ready");
    expect(parseNodeEvent(ready)?.type).toBe("ready"); // a non-mcp agent omits it; the plane falls back
    expect(parseNodeEvent({ ...ready, selfInvoke: "/usr/bin/subshell mcp" })).toBeNull();
    expect(parseNodeEvent({ ...ready, selfInvoke: { command: "/usr/bin/subshell" } })).toBeNull(); // args required
    expect(parseNodeEvent({ ...ready, selfInvoke: { args: [] } })).toBeNull(); // command required
  });
});

describe("parseNodePaneSizeResult", () => {
  it("takes a real grid", () => {
    expect(parseNodePaneSizeResult({ cols: 132, rows: 43 })).toEqual({ cols: 132, rows: 43 });
  });

  it("refuses everything that is not one, so a bad answer cannot become a pane size", () => {
    // The control plane pins every viewer's terminal to whatever comes back
    // here, so a zero, a fraction or a NaN would tell them all to lay out a
    // grid the pane cannot have. Null is the safe answer and the caller
    // already handles it (announce nothing rather than a guess).
    for (const bad of [
      null,
      undefined,
      "80x24",
      {},
      { cols: 80 },
      { rows: 24 },
      { cols: 0, rows: 24 },
      { cols: 80, rows: 0 },
      { cols: -1, rows: 24 },
      { cols: 80.5, rows: 24 },
      { cols: Number.NaN, rows: 24 },
      { cols: "80", rows: "24" },
    ]) {
      expect(parseNodePaneSizeResult(bad)).toBeNull();
    }
  });

  it("ignores extra members rather than refusing them", () => {
    // Additive fields from a newer agent must not break an older control
    // plane — the same tolerance every other result parser here shows.
    expect(parseNodePaneSizeResult({ cols: 100, rows: 30, future: true })).toEqual({ cols: 100, rows: 30 });
  });
});

describe("detect result contract (inversion spec §4)", () => {
  it("accepts the raw-text answer shape, including every optional field", () => {
    const answer = parseNodeDetectResults({
      results: [
        { harnessId: "hermes", installed: true, binaryPath: "/x/hermes", rawVersion: "Hermes v1.2.3 (build 9)" },
        { harnessId: "ghost", installed: false, reason: "not-on-path" },
        { harnessId: "term", installed: false, reason: "no-binary", checkedAt: "2026-09-10T00:00:00.000Z" },
      ],
      // The §5 amendment: values for the env names the command asked about,
      // present-only — an unset variable stays absent, which is what triggers
      // the plugin's fallback.
      env: { CLAUDE_CONFIG_DIR: "/custom" },
    });
    expect(answer?.rows).toHaveLength(3);
    expect(answer?.rows[0]).toMatchObject({ rawVersion: "Hermes v1.2.3 (build 9)" });
    // Raw on purpose: version is what the CONTROL PLANE stores after
    // parseVersion; the wire never carries a parsed one.
    expect(answer?.rows[0]).not.toHaveProperty("version");
    expect(answer?.env).toEqual({ CLAUDE_CONFIG_DIR: "/custom" });
  });

  it("accepts an empty results array, an empty env, and ignores extra members", () => {
    expect(parseNodeDetectResults({ results: [], env: {} })).toEqual({ rows: [], env: {} });
    expect(
      parseNodeDetectResults({ results: [{ harnessId: "x", installed: false, future: 1 }], env: {} })?.rows,
    ).toHaveLength(1);
  });

  it("refuses junk: no wrapper, no array, a missing or mis-typed env, and rows missing or mis-typing their verdict", () => {
    for (const bad of [
      null,
      undefined,
      [],
      {},
      { results: [] }, // no env — REQUIRED since the §5 amendment
      { results: [], env: null },
      { results: [], env: { A: 7 } }, // values are strings
      { results: [], env: "CLAUDE_CONFIG_DIR=/custom" },
      { results: null, env: {} },
      { results: {}, env: {} },
      { results: [{ installed: false }], env: {} }, // no harnessId
      { results: [{ harnessId: "x" }], env: {} }, // no installed verdict
      { results: [{ harnessId: "x", installed: "yes" }], env: {} },
      { results: [{ harnessId: "x", installed: false, reason: "unknown" }], env: {} },
      { results: [{ harnessId: "x", installed: true, rawVersion: 7 }], env: {} },
      { results: [{ harnessId: "x", installed: true, binaryPath: null }], env: {} },
    ]) {
      expect(parseNodeDetectResults(bad)).toBeNull();
    }
  });

  it("the inventory EVENT does not gain rawVersion semantics (the wire split is the point)", () => {
    // The event entry keeps `version`; the detect row keeps `rawVersion`.
    // (The event parser has never gated `reason` on the closed union, and
    // tightening it is not this task's change.)
    const ev = parseNodeEvent({
      type: "inventory",
      ts: "t",
      harnesses: [{ harnessId: "x", installed: true, version: "1.0" }],
    });
    expect(ev?.type).toBe("inventory");
    expect(JSON.stringify(ev)).not.toContain("rawVersion");
  });
});
