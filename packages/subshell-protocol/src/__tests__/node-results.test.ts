import { describe, expect, it } from "bun:test";
import {
  FS_LS_MAX_ENTRIES,
  MAX_ARCHIVE_BYTES,
  MAX_MANIFEST_PAGE_ENTRIES,
  type NodePreviewPortWire,
  parseNodeArchiveCreateResult,
  parseNodeArchiveExtractResult,
  parseNodeCaptureResult,
  parseNodeCommandBody,
  parseNodeDetectResults,
  parseNodeEvent,
  parseNodeFileReadResult,
  parseNodeFsLsResult,
  parseNodeLaunchResult,
  parseNodeLogReadResult,
  parseNodePaneCursorResult,
  parseNodePaneSizeResult,
  parseNodePathExistsResult,
  parseNodePreviewCloseResult,
  parseNodePreviewOpenResult,
  parseNodePreviewPortsResult,
  parseNodeProbeEntries,
  parseNodePromptDeliver,
  parseNodeStatDirResult,
  parseNodeTreeManifestPage,
  parseNodeWriteFileResult,
} from "../index.js";

describe("node result contracts (spec §3.3, phase-2 wire note)", () => {
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

describe("parseNodePaneCursorResult", () => {
  it("narrows a viewport cursor", () => {
    expect(parseNodePaneCursorResult({ x: 0, y: 0 })).toEqual({ x: 0, y: 0 });
    expect(parseNodePaneCursorResult({ x: 4, y: 2 })).toEqual({ x: 4, y: 2 });
    // Unknown members are tolerated the same way the size parser tolerates them.
    expect(parseNodePaneCursorResult({ x: 1, y: 1, future: true })).toEqual({ x: 1, y: 1 });
  });

  it("collapses nonsense and negatives into null — no restore beats a wrong one", () => {
    for (const bad of [
      null,
      undefined,
      "x",
      {},
      { x: 0 },
      { y: 0 },
      { x: -1, y: 0 },
      { x: 0, y: -1 },
      { x: 1.5, y: 0 },
    ]) {
      expect(parseNodePaneCursorResult(bad)).toBeNull();
    }
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

  it("archive_create: non-negative size plus a 64-hex digest, nothing else passes", () => {
    const sha = "a".repeat(64);
    expect(parseNodeArchiveCreateResult({ size: 4096, sha256: sha })).toEqual({ size: 4096, sha256: sha });
    expect(parseNodeArchiveCreateResult({ size: 0, sha256: sha })).not.toBeNull();
    expect(parseNodeArchiveCreateResult({ size: MAX_ARCHIVE_BYTES, sha256: sha })).not.toBeNull(); // at the cap passes
    for (const bad of [
      { size: -1, sha256: sha },
      { size: MAX_ARCHIVE_BYTES + 1, sha256: sha }, // a lying huge size must not plan an unbounded relay
      { size: 1.5, sha256: sha },
      { size: 10, sha256: sha.toUpperCase() }, // uppercase hex is not the wire spelling
      { size: 10, sha256: "a".repeat(63) },
      { size: 10, sha256: "z".repeat(64) },
      { size: 10 },
      null,
    ]) {
      expect(parseNodeArchiveCreateResult(bad)).toBeNull();
    }
  });

  it("file_read answers the log_read window shape, under its own validator", () => {
    const ok = { bytes_b64: "aGk=", next: 2, size: 2 };
    expect(parseNodeFileReadResult(ok)).toEqual(ok);
    // The log_read invariant carries over: an empty read may not report a
    // cursor past EOF.
    expect(parseNodeFileReadResult({ bytes_b64: "", next: 3, size: 2 })).toBeNull();
    expect(parseNodeFileReadResult({ bytes_b64: "no!!", next: 2, size: 2 })).toBeNull();
    expect(parseNodeFileReadResult("aGk=")).toBeNull();
  });

  it("archive_extract counts files and bytes, non-negative integers only", () => {
    expect(parseNodeArchiveExtractResult({ files: 3, bytes: 5000 })).toEqual({ files: 3, bytes: 5000 });
    expect(parseNodeArchiveExtractResult({ files: 0, bytes: 0 })).not.toBeNull();
    for (const bad of [{ files: -1, bytes: 0 }, { files: 0, bytes: -5 }, { files: 1 }, { bytes: 1 }, {}, null]) {
      expect(parseNodeArchiveExtractResult(bad)).toBeNull();
    }
  });

  it("tree_manifest pages: sorted rows with real digests, cursor-or-null", () => {
    const sha = "b".repeat(64);
    const page = { entries: [{ relPath: "a/b.txt", size: 4, mtime: 10, sha256: sha }], nextCursor: "a/b.txt" };
    expect(parseNodeTreeManifestPage(page)).toEqual(page);
    expect(parseNodeTreeManifestPage({ entries: [], nextCursor: null })).toEqual({ entries: [], nextCursor: null });
    const emptyPage = { entries: Array.from({ length: MAX_MANIFEST_PAGE_ENTRIES }, () => page.entries[0]) };
    expect(parseNodeTreeManifestPage({ ...emptyPage, nextCursor: "z" })).not.toBeNull();
    for (const bad of [
      { entries: Array.from({ length: MAX_MANIFEST_PAGE_ENTRIES + 1 }, () => page.entries[0]), nextCursor: "z" },
      { entries: [{ relPath: "", size: 4, mtime: 10, sha256: sha }], nextCursor: null }, // empty relPath
      { entries: [{ relPath: "a", size: 4, mtime: 10, sha256: "b".repeat(63) }], nextCursor: null },
      { entries: [{ relPath: "a", size: -1, mtime: 10, sha256: sha }], nextCursor: null },
      { entries: [{ relPath: "a", size: 4, mtime: 1.5, sha256: sha }], nextCursor: null },
      { entries: [{ relPath: "a", size: 4, mtime: 10, sha256: sha }] }, // no cursor key at all
      { entries: [{ relPath: "a", size: 4, mtime: 10, sha256: sha }], nextCursor: "" }, // empty cursor is not a resume point
      { entries: "a/b.txt", nextCursor: null },
      null,
    ]) {
      expect(parseNodeTreeManifestPage(bad)).toBeNull();
    }
  });
});

// Protocol 23 (pane-preview spec 2026-10-21 §4). Imported through the barrel:
// these are the shapes Task 4's node answers and the plane reads, and both
// ends validate them, so a drift here is a node that cannot report.
describe("preview results (protocol 23)", () => {
  const REF = "a".repeat(32);

  it("preview_open answers by kind: a pending forward, a subscriber count for a screencast", () => {
    expect(parseNodePreviewOpenResult({ ref: REF, pending: true })).toEqual({ ref: REF, pending: true });
    expect(parseNodePreviewOpenResult({ ref: REF, subscribers: 2 })).toEqual({ ref: REF, subscribers: 2 });
    expect(parseNodePreviewOpenResult({ ref: REF, subscribers: 0 })).toEqual({ ref: REF, subscribers: 0 }); // first, nobody else watching yet
    expect(parseNodePreviewOpenResult({ ref: REF, pending: false })).toBeNull(); // no such answer exists
    expect(parseNodePreviewOpenResult({ ref: REF })).toBeNull(); // neither shape
    expect(parseNodePreviewOpenResult({ ref: "short", pending: true })).toBeNull();
    expect(parseNodePreviewOpenResult({ ref: REF, subscribers: 1.5 })).toBeNull();
    expect(parseNodePreviewOpenResult(null)).toBeNull();
  });

  it("preview_close says whether a lane was actually closed", () => {
    expect(parseNodePreviewCloseResult({ ref: REF, closed: true })).toEqual({ ref: REF, closed: true });
    expect(parseNodePreviewCloseResult({ ref: REF, closed: false })).toEqual({ ref: REF, closed: false }); // already gone is still an answer
    expect(parseNodePreviewCloseResult({ ref: REF })).toBeNull();
    expect(parseNodePreviewCloseResult({ closed: true })).toBeNull();
    expect(parseNodePreviewCloseResult({ ref: REF, closed: "yes" })).toBeNull();
  });

  it("ports_get reports ports, a nullable CDP hint, a nullable screen, and an optional screenLost", () => {
    const titled = {
      ports: [{ proto: "tcp" as const, port: 3000, pid: 7, title: "My website" }],
      cdpPort: null,
      screen: null,
    };
    expect(parseNodePreviewPortsResult(titled)).toEqual(titled);
    // A title over the cap is the one field where refusing the whole answer would
    // cost the person every well-formed row in the pane: the probe already caps
    // what it sends, so length is a defect to recover from, not a shape violation.
    const overLong = parseNodePreviewPortsResult({
      ...titled,
      ports: [{ ...titled.ports[0], title: "x".repeat(201) }],
    });
    expect(overLong?.ports[0]?.title).toBe("x".repeat(200));
    expect(parseNodePreviewPortsResult({ ...titled, ports: [{ ...titled.ports[0], title: 7 }] })).toBeNull();
    // The route that serializes this counts UTF-16 units while the label cap
    // counts code points, so an emoji-heavy title has to be trimmed in the units
    // the consumer measures, and never by splitting a pair in half.
    const astral = parseNodePreviewPortsResult({
      ...titled,
      ports: [{ ...titled.ports[0], title: "🚀".repeat(150) }],
    });
    const cappedTitle = astral?.ports[0]?.title ?? "";
    expect(cappedTitle.length).toBeLessThanOrEqual(200);
    expect([...cappedTitle].join("")).toBe(cappedTitle);
    expect(cappedTitle).toBe("🚀".repeat(100));
    // A page authors its own title, and it renders for every viewer, so the
    // boundary takes the NAME path: combining marks compose, invisible format
    // characters and lone surrogates go, a control becomes a space. And a title
    // with nothing left in it is absent rather than empty, so the picker falls
    // back to "Web preview" instead of offering a blank row.
    expect(
      parseNodePreviewPortsResult({
        ...titled,
        ports: [{ proto: "tcp", port: 3000, pid: 7, title: " cafe\u0301 \u200e\u202ex\ud800\u0007y " }],
      }),
    ).toEqual({
      ports: [{ proto: "tcp", port: 3000, pid: 7, title: "caf\u00e9 x y" }],
      cdpPort: null,
      screen: null,
    });
    expect(
      parseNodePreviewPortsResult({
        ...titled,
        ports: [{ proto: "tcp", port: 3000, pid: 7, title: "\u0000\u001f \u200e" }],
      }),
    ).toEqual({ ports: [{ proto: "tcp", port: 3000, pid: 7 }], cdpPort: null, screen: null });
    const ports: NodePreviewPortWire[] = [{ proto: "tcp", port: 5173, pid: 42 }];
    expect(parseNodePreviewPortsResult({ ports, cdpPort: null, screen: null })).toEqual({
      ports,
      cdpPort: null,
      screen: null,
    });
    expect(
      parseNodePreviewPortsResult({ ports: [{ proto: "tcp6", port: 3000, pid: 7 }], cdpPort: 9222, screen: null }),
    ).not.toBeNull();
    expect(
      parseNodePreviewPortsResult({
        ports: [],
        cdpPort: null,
        screen: { display: ":1", viewer: { protocol: "vnc", port: 5901 } },
      }),
    ).not.toBeNull();
    // screenLost rides ONLY with a null screen: the answer says the display
    // died and there is nothing left to report, never both at once.
    expect(parseNodePreviewPortsResult({ ports, cdpPort: null, screen: null, screenLost: "Xvfb" })).toEqual({
      ports,
      cdpPort: null,
      screen: null,
      screenLost: "Xvfb",
    });
    expect(
      parseNodePreviewPortsResult({
        ports,
        cdpPort: null,
        screen: { display: ":1", viewer: { protocol: "vnc", port: 5901 } },
        screenLost: "x11vnc",
      }),
    ).toBeNull();
    expect(parseNodePreviewPortsResult({ ports, cdpPort: null, screen: null, screenLost: "" })).toBeNull();
    expect(
      parseNodePreviewPortsResult({ ports: [{ proto: "udp", port: 53, pid: 1 }], cdpPort: null, screen: null }),
    ).toBeNull();
    expect(
      parseNodePreviewPortsResult({ ports: [{ proto: "tcp", port: 0, pid: 1 }], cdpPort: null, screen: null }),
    ).toBeNull();
    expect(parseNodePreviewPortsResult({ ports, cdpPort: null })).toBeNull(); // screen is required and nullable, not absent
    expect(parseNodePreviewPortsResult({ ports, cdpPort: 0, screen: null })).toBeNull();
    expect(
      parseNodePreviewPortsResult({
        ports,
        cdpPort: null,
        screen: { display: "", viewer: { protocol: "vnc", port: 5901 } },
      }),
    ).toBeNull();
    expect(
      parseNodePreviewPortsResult({
        ports,
        cdpPort: null,
        screen: { display: ":1", viewer: { protocol: "vnc", port: 70_000 } },
      }),
    ).toBeNull();
  });

  it("launch echoes a screen when it allocated one, and the absent answer stays absent", () => {
    // This optional echo is why `launch` leaves the header's dataless set.
    // null/undefined/{} all read as "no screen": the command carries data only
    // when a display was allocated.
    expect(parseNodeLaunchResult(undefined)).toEqual({});
    expect(parseNodeLaunchResult(null)).toEqual({});
    expect(parseNodeLaunchResult({})).toEqual({});
    expect(parseNodeLaunchResult({ screen: { display: ":1", viewer: { protocol: "vnc", port: 5901 } } })).toEqual({
      screen: { display: ":1", viewer: { protocol: "vnc", port: 5901 } },
    });
    expect(parseNodeLaunchResult({ screen: { display: ":1" } })).toBeNull();
    expect(parseNodeLaunchResult({ screen: { display: ":1", viewer: { protocol: "vnc", port: 0 } } })).toBeNull();
    expect(parseNodeLaunchResult({ screen: "yes" })).toBeNull();
    expect(parseNodeLaunchResult("screen")).toBeNull();
  });
});

it("accepts opaque display identifiers and rejects unknown viewer protocols", () => {
  const screen = { display: "native-monitor-123", viewer: { protocol: "vnc" as const, port: 6001 } };
  expect(parseNodeLaunchResult({ screen })).toEqual({ screen });
  expect(
    parseNodeLaunchResult({ screen: { ...screen, viewer: { protocol: "unimplemented", port: 6001 } } }),
  ).toBeNull();
  expect(parseNodeLaunchResult({ screen: { ...screen, viewer: { protocol: "vnc", port: 0 } } })).toBeNull();
});
