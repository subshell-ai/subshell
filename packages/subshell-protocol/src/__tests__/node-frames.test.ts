import { describe, expect, it } from "bun:test";
import {
  HARNESS_BINARY_PLACEHOLDER,
  MAX_MANIFEST_PAGE_BYTES,
  MAX_TRANSFER_LIST_FILES,
  MAX_TRANSFER_WINDOW_BYTES,
  NODE_CLOSE_HANDSHAKE_REQUIRED,
  NODE_CLOSE_REPAIR_REQUIRED,
  NODE_CLOSE_SUPERSEDED,
  NODE_CLOSE_UPDATE_REQUIRED,
  NODE_PROTOCOL_VERSION,
  NODE_RESULT_DIGEST_MISMATCH,
  NODE_RESULT_DOWNLOAD_FAILED,
  NODE_RESULT_KILLS_PANES,
  NODE_RESULT_MAINTENANCE,
  NODE_RESULT_NO_SERVICE,
  NODE_RESULT_NOT_COMPILED,
  NODE_RESULT_NOT_SUPERVISED,
  NODE_RESULT_VERSION_MISMATCH,
  NODE_SERVICE_DESTRUCTIVE,
  NODE_SERVICE_VERBS,
  parseNodeCommandBody,
  parseNodeEvent,
  parseNodeRuntimeReport,
  partPathOf,
} from "../node-frames.js";
import {
  isSshGrantFingerprints,
  isSshPaneId,
  SSH_COMMAND_TYPES,
  SSH_RELAY_CLOSE_REASONS,
  type SshRelayOpenCommand,
} from "../ssh-frames.js";
import { SSH_CONFIG_FILE_MAX_BYTES, SSH_MAX_GRANT_FINGERPRINTS } from "../ssh-limits.js";
import { MIN_NODE_VERSION } from "../versions.js";

const launchCmd = {
  type: "launch",
  subshellId: "s1",
  socket: "subshell-abc",
  cwd: "/home/u/repo",
  harnessId: "claude-code",
  preset: { name: "P", env: { A: "b" }, flags: [], settings: null, configIsolation: false },
  subshellEnv: { SUBSHELL_API_KEY: "subshell_x" },
  subshellName: "s1",
  harnessSession: { id: "h1", mode: "start" as const },
  // Protocol 3 made both REQUIRED (inversion spec §5): the node holds no
  // plugin, so a frame without the server-built argv and its resolve rule
  // names a command line nothing on that machine can build.
  argv: [HARNESS_BINARY_PLACEHOLDER],
  resolve: { binaryName: "claude" },
};

/**
 * A complete relay-open pairing (spec 2026-10-08 §5.1): every field the
 * brokered open carries is REQUIRED on the wire, so one fixture serves the
 * accept paths and the field-by-field refusals below.
 */
const relayOpenCmd: SshRelayOpenCommand = {
  type: "ssh_relay_open",
  relayId: "relay-9c31",
  ref: "r-4f2a",
  role: "A",
  aNodeId: "node-a",
  bNodeId: "node-b",
  peerSigningPublicKey: '{"kty":"EC","crv":"P-256","x":"AAA","y":"BBB"}',
  peerEncryptPublicKey: "SGVsbG9Xb3JsZEhlcmVJc1RoaXJ0eXR3b0J5dGVzMTI=",
  grantId: "grant-77",
  fingerprints: ["SHA256:AAAA", "SHA256:BBBB"],
  lifetimeMs: 30_000,
  paneId: "11111111-2222-4333-8444-555555555555",
  // Task 12: the destination's pinned host-key line (A's known_hosts entry,
  // captured at grant creation). Required: a relay-open without it is a
  // relay grant with no pin, which is exactly what the grammar refuses.
  hostPin: "git.example.test ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI00000000000000000000000000000000000000000",
};

describe("parseNodeCommandBody", () => {
  it("accepts a well-formed launch and preserves fields", () => {
    const cmd = parseNodeCommandBody(structuredClone(launchCmd));
    expect(cmd).not.toBeNull();
    expect(cmd?.type).toBe("launch");
    if (cmd?.type === "launch") {
      expect(cmd.cwd).toBe("/home/u/repo");
      expect(cmd.socket).toBe("subshell-abc");
      expect(cmd.preset.name).toBe("P");
    }
  });

  it("rejects non-positive launch geometry and prompt timings", () => {
    expect(parseNodeCommandBody({ ...launchCmd, cols: 0 })).toBeNull();
    expect(parseNodeCommandBody({ ...launchCmd, rows: 0 })).toBeNull();
    expect(
      parseNodeCommandBody({ type: "prompt_deliver", subshellId: "s", text: "hi", settleTimeoutMs: 5000, pollMs: 0 }),
    ).toBeNull();
    expect(
      parseNodeCommandBody({ type: "prompt_deliver", subshellId: "s", text: "hi", settleTimeoutMs: -1, pollMs: 250 }),
    ).toBeNull();
    expect(
      parseNodeCommandBody({ type: "prompt_deliver", subshellId: "s", text: "hi", settleTimeoutMs: 5000, pollMs: 250 }),
    ).not.toBeNull();
  });

  it("accepts an explicit undefined preset description (absent-like)", () => {
    const cmd = structuredClone(launchCmd) as Record<string, unknown>;
    (cmd.preset as Record<string, unknown>).description = undefined;
    expect(parseNodeCommandBody(cmd)).not.toBeNull();
  });

  it("validates the remaining command variants", () => {
    expect(parseNodeCommandBody({ type: "log_read", subshellId: "s", fromByte: 0, maxBytes: 100 })).not.toBeNull();
    expect(parseNodeCommandBody({ type: "log_read", subshellId: "s", fromByte: -1, maxBytes: 100 })).toBeNull();
    expect(parseNodeCommandBody({ type: "tail_start", subshellId: "s", subId: "t", fromByte: 0 })).not.toBeNull();
    expect(parseNodeCommandBody({ type: "tail_start", subshellId: "s", subId: "t", fromByte: -1 })).toBeNull();
    expect(parseNodeCommandBody({ type: "stat_dir", path: "/x" })).not.toBeNull();
    expect(parseNodeCommandBody({ type: "stat_dir" })).toBeNull();
    // fs_ls: the path gate is stat_dir's — a string, emptiness
    // legal (agent-home); absoluteness is enforced agent-side, not on the wire.
    expect(parseNodeCommandBody({ type: "fs_ls", path: "/x" })).toEqual({ type: "fs_ls", path: "/x" });
    expect(parseNodeCommandBody({ type: "fs_ls", path: "" })).toEqual({ type: "fs_ls", path: "" });
    expect(parseNodeCommandBody({ type: "fs_ls" })).toBeNull();
    expect(parseNodeCommandBody({ type: "fs_ls", path: 7 })).toBeNull();
    expect(parseNodeCommandBody({ type: "probe", subshellIds: ["a"] })).not.toBeNull();
    expect(parseNodeCommandBody({ type: "probe", subshellIds: ["a", 1] as unknown[] })).toBeNull();
    expect(parseNodeCommandBody({ type: "remove_paths", paths: [] })).not.toBeNull();
    expect(parseNodeCommandBody({ type: "inventory" })).toEqual({ type: "inventory" });
    expect(parseNodeCommandBody({ type: "ping" })).toEqual({ type: "ping" });
  });

  it("rejects launch with a malformed preset (env value not a string)", () => {
    const bad = structuredClone(launchCmd) as Record<string, unknown>;
    (bad.preset as Record<string, unknown>).env = { A: 1 };
    expect(parseNodeCommandBody(bad)).toBeNull();
  });

  it("rejects a launch frame still carrying the OLD `profile` key (protocol 7)", () => {
    const stale = structuredClone(launchCmd) as Record<string, unknown>;
    stale.profile = stale.preset;
    delete stale.preset;
    expect(parseNodeCommandBody(stale)).toBeNull();
  });

  it("rejects unknown command types, non-objects, and JSON garbage", () => {
    expect(parseNodeCommandBody({ type: "reboot" })).toBeNull();
    expect(parseNodeCommandBody(null)).toBeNull();
    expect(parseNodeCommandBody("[]")).toBeNull();
    expect(parseNodeCommandBody({})).toBeNull();
  });

  it("capture: optional positive-int `lines` passes through; garbage is refused", () => {
    expect(parseNodeCommandBody({ type: "capture", subshellId: "s" })).toEqual({ type: "capture", subshellId: "s" });
    expect(parseNodeCommandBody({ type: "capture", subshellId: "s", lines: 100 })).toEqual({
      type: "capture",
      subshellId: "s",
      lines: 100,
    });
    expect(parseNodeCommandBody({ type: "capture", subshellId: "s", lines: 0 })).toBeNull();
    expect(parseNodeCommandBody({ type: "capture", subshellId: "s", lines: 1.5 })).toBeNull();
    expect(parseNodeCommandBody({ type: "capture", subshellId: "s", lines: "100" })).toBeNull();
  });

  it("accepts input/resize/terminate/ping and checks their required fields", () => {
    expect(parseNodeCommandBody({ type: "ping" })).toEqual({ type: "ping" });
    expect(parseNodeCommandBody({ type: "input", subshellId: "s", data: "" })).not.toBeNull();
    expect(parseNodeCommandBody({ type: "input", subshellId: "s" })).toBeNull();
    expect(parseNodeCommandBody({ type: "resize", subshellId: "s", cols: 80, rows: 24 })).not.toBeNull();
    expect(parseNodeCommandBody({ type: "resize", subshellId: "s", cols: 0, rows: 24 })).toBeNull();
    expect(parseNodeCommandBody({ type: "terminate", subshellId: "s" })).not.toBeNull();
  });

  it("validates write_file chunk bounds and base64 payloads", () => {
    expect(
      parseNodeCommandBody({ type: "write_file", path: "/d/x", chunk_b64: "aGk=", chunk: 0, eof: true }),
    ).not.toBeNull();
    expect(
      parseNodeCommandBody({ type: "write_file", path: "/d/x", chunk_b64: "not base64!!", chunk: 0, eof: false }),
    ).toBeNull();
    expect(
      parseNodeCommandBody({ type: "write_file", path: "/d/x", chunk_b64: "aGk=", chunk: -1, eof: false }),
    ).toBeNull();
  });

  it("validates archive_create roots and the files-list cap", () => {
    expect(parseNodeCommandBody({ type: "archive_create", root: "/src", stagingPath: "/data/stage/a.tar.gz" })).toEqual(
      {
        type: "archive_create",
        root: "/src",
        stagingPath: "/data/stage/a.tar.gz",
      },
    );
    expect(
      parseNodeCommandBody({ type: "archive_create", root: "/src", files: ["a.txt", "b/c.txt"], stagingPath: "/s" }),
    ).toEqual({ type: "archive_create", root: "/src", files: ["a.txt", "b/c.txt"], stagingPath: "/s" });
    expect(parseNodeCommandBody({ type: "archive_create", root: "/src" })).toBeNull();
    expect(parseNodeCommandBody({ type: "archive_create", stagingPath: "/s" })).toBeNull();
    // Shape only: `..`/absoluteness inside the list is the writer's path
    // guard's verdict at emit time, not the grammar's.
    expect(parseNodeCommandBody({ type: "archive_create", root: "/src", files: [], stagingPath: "/s" })).toEqual({
      type: "archive_create",
      root: "/src",
      files: [],
      stagingPath: "/s",
    });
    expect(
      parseNodeCommandBody({
        type: "archive_create",
        root: "/src",
        files: ["x", ...Array.from({ length: MAX_TRANSFER_LIST_FILES }, (_, i) => `f${i}`)],
        stagingPath: "/s",
      }),
    ).toBeNull();
  });

  it("validates file_read windows against the shared window cap", () => {
    expect(parseNodeCommandBody({ type: "file_read", path: "/d/x", fromByte: 0, maxBytes: 1024 })).toEqual({
      type: "file_read",
      path: "/d/x",
      fromByte: 0,
      maxBytes: 1024,
    });
    expect(parseNodeCommandBody({ type: "file_read", path: "/d/x", fromByte: -1, maxBytes: 1024 })).toBeNull();
    expect(parseNodeCommandBody({ type: "file_read", path: "/d/x", fromByte: 0, maxBytes: 0 })).toBeNull();
    // The cap is the frame math (spec 2026-10-01 §2): a parser accepting more
    // would advertise a window the link cannot carry.
    expect(
      parseNodeCommandBody({ type: "file_read", path: "/d/x", fromByte: 0, maxBytes: MAX_TRANSFER_WINDOW_BYTES }),
    ).not.toBeNull();
    expect(
      parseNodeCommandBody({ type: "file_read", path: "/d/x", fromByte: 0, maxBytes: MAX_TRANSFER_WINDOW_BYTES + 1 }),
    ).toBeNull();
    expect(parseNodeCommandBody({ type: "file_read", fromByte: 0, maxBytes: 1024 })).toBeNull();
  });

  it("validates transfer_write like write_file, under its own name", () => {
    expect(
      parseNodeCommandBody({ type: "transfer_write", path: "/d/x", chunkB64: "aGk=", chunk: 0, eof: true }),
    ).toEqual({ type: "transfer_write", path: "/d/x", chunkB64: "aGk=", chunk: 0, eof: true });
    expect(
      parseNodeCommandBody({ type: "transfer_write", path: "/d/x", chunkB64: "no!!", chunk: 0, eof: false }),
    ).toBeNull();
    expect(
      parseNodeCommandBody({ type: "transfer_write", path: "/d/x", chunkB64: "aGk=", chunk: -1, eof: false }),
    ).toBeNull();
    expect(parseNodeCommandBody({ type: "transfer_write", path: "/d/x", chunkB64: "aGk=", chunk: 0 })).toBeNull();
  });

  it("validates archive_extract path pair with its digest", () => {
    const sha = "a".repeat(64);
    expect(
      parseNodeCommandBody({
        type: "archive_extract",
        archivePath: "/d/a.tar.gz",
        expectedSha256: sha,
        destRoot: "/dst",
      }),
    ).toEqual({ type: "archive_extract", archivePath: "/d/a.tar.gz", expectedSha256: sha, destRoot: "/dst" });
    expect(parseNodeCommandBody({ type: "archive_extract", archivePath: "/d/a.tar.gz" })).toBeNull();
    expect(parseNodeCommandBody({ type: "archive_extract", destRoot: "/dst" })).toBeNull();
    // The digest is the destination's own re-check; no hash (or a malformed
    // one) is a frame that never intended to verify, so the grammar refuses.
    expect(parseNodeCommandBody({ type: "archive_extract", archivePath: "/d/a", destRoot: "/dst" })).toBeNull();
    expect(
      parseNodeCommandBody({ type: "archive_extract", archivePath: "/d/a", expectedSha256: "ABC", destRoot: "/dst" }),
    ).toBeNull();
    expect(
      parseNodeCommandBody({
        type: "archive_extract",
        archivePath: "/d/a",
        expectedSha256: "A".repeat(64), // uppercase is not lowercase-hex
        destRoot: "/dst",
      }),
    ).toBeNull();
  });

  it("validates tree_manifest paging", () => {
    expect(parseNodeCommandBody({ type: "tree_manifest", root: "/src", maxBytes: 65536 })).toEqual({
      type: "tree_manifest",
      root: "/src",
      maxBytes: 65536,
    });
    expect(parseNodeCommandBody({ type: "tree_manifest", root: "/src", cursor: "a/b", maxBytes: 65536 })).toEqual({
      type: "tree_manifest",
      root: "/src",
      cursor: "a/b",
      maxBytes: 65536,
    });
    // maxBytes is REQUIRED: an unbudgeted page is a caller that forgot the
    // frame cap exists.
    expect(parseNodeCommandBody({ type: "tree_manifest", root: "/src" })).toBeNull();
    expect(parseNodeCommandBody({ type: "tree_manifest", root: "/src", maxBytes: 0 })).toBeNull();
    expect(
      parseNodeCommandBody({ type: "tree_manifest", root: "/src", maxBytes: MAX_MANIFEST_PAGE_BYTES + 1 }),
    ).toBeNull();
    expect(parseNodeCommandBody({ type: "tree_manifest", root: "/src", cursor: 7, maxBytes: 65536 })).toBeNull();
  });

  it("pins the protocol version", () => {
    // Matched EXACTLY: there is no compat window and no per-feature gating,
    // because the server and the agent ship together. Bump this whenever a
    // frame changes and release both sides. (2 is phase 3's bump — the
    // registry spec on `plugin_install` — and the first REAL one: the
    // numbering restarted at 1 on 2026-09-09 with no deployed instances.
    // 3 is the inversion's (spec 2026-09-10 §7): plugins left the wire —
    // `plugin_install`/`plugin_uninstall` are gone, the inventory event no
    // longer carries a plugin set, and `launch` requires `argv` + `resolve`.
    // 12 is signed releases (spec 2026-09-17 §6): the `update` command
    // carries `manifest` + `manifestSig`, and an older agent would silently
    // ignore them and accept payload-only — the exact silent-downgrade the
    // bump exists to close. 11 is SKIPPED, deliberately: the concurrent
    // zero-touch work bumps 10→11 for its `ready` fields, and taking 12 here
    // makes the two bumps safe in either merge order — see the constant's
    // own doc.)
    // 4 replaced `ready.mcpLaunch` with `ready.selfInvoke`: the same
    // self-invocation WITHOUT its subcommand, so the plane can append `report`
    // for harness hooks as well as `mcp` for a pane's registration.
    // 5 is the node Service surface: `restart` folded into `service` as one
    // of five verbs, and `agent_log_read` + `set_server_url` arrived, so a
    // headless node can be supervised, read and repointed from a browser.
    // 6 is `set_log_level`: the agent's own log file gained the level gate the
    // server's has had, and this is the command that flips it. It reveals
    // nothing today — the agent writes no debug-level lines — which is the
    // point of putting the mechanism in ahead of them.)
    // 7 is the preset rename: `launch.profile` became `launch.preset`, wire
    // names only.
    // 8 is node maintenance: `ready.maintenance`, the `maintenance` event and
    // the `set_maintenance` command, so one flag can be set at either end and
    // reconciled by stamp when the two disagree.
    // 9 is `service.linger`: whether the agent's OS user lingers, which is
    // what decides whether an enabled systemd --user unit survives a logout
    // on a machine nobody logs in to.
    // 10 is the `update` command: the plane hands an agent a version, a URL
    // and a digest and it replaces its own binary — the one command that
    // crosses a protocol boundary, which is why its shape is frozen.
    // 12 (skipping 11) is the signed `update`: manifest bytes plus the
    // publisher's signature, verified by the agent before any swap.
    // 13 is `pane_cursor`: the attach replay ends with the client's cursor
    // ON the pane's cursor, without which every live byte after a
    // fresh-terminal replay paints a row-count away from the prompt.
    // 14 is the encrypted node link: the kx handshake, secretstream frames,
    // the register self-heal and close 4410 — a protocol-14 node never writes
    // a plaintext frame.
    // 15 is the archive-transfer surface (spec 2026-10-01 §2): five commands
    // (archive_create, file_read, transfer_write, archive_extract,
    // tree_manifest) plus the window/entry constants both ends must agree on.
    // 16 is the node SSH capability gate (spec 2026-10-07 §4.3): one
    // owner-controlled flag per machine, off by default and fail-closed —
    // `set_ssh_enabled` carries the plane's value, `ready.sshEnabled` states
    // the node's mirror, the `ssh_enabled` event reports a moved file. The
    // bump is the load-bearing part: a pre-16 agent is wire-indistinguishable
    // from a 16 agent whose mirror says no, and a capability gate cannot live
    // with that ambiguity.
    // 17 is the ssh launcher tier (spec 2026-10-07 §4.3/§5): the launch frame's
    // `ssh` block and the `ssh_discover_aliases` / `ssh_resolve_config` arms.
    // A lagging agent ignores the launch block and spawns a bare `ssh` with no
    // `-F` config, so it is HELD (update-only) until crossed, not approximated.
    // 18 is the sealed agent relay (spec 2026-10-08 §5.1): the `relay` link
    // frame (a new frame kind on the established link) and the `ssh_relay_open`
    // / `ssh_relay_close` signed commands. A tier-17 agent understands no relay
    // frame, and the exact-match gate refuses it BEFORE any relay command
    // (spec §11: never half-relaying).
    expect(NODE_PROTOCOL_VERSION).toBe(18);
  });

  it("accepts set_allowed_dirs and rejects a missing or non-array dirs", () => {
    // The parser checks SHAPE only — normalization is the
    // executor's job, so one malformed entry inside a well-formed array must
    // not reject the whole push and leave the node on stale rules.
    expect(parseNodeCommandBody({ type: "set_allowed_dirs", dirs: ["/a", "/b"] })).toEqual({
      type: "set_allowed_dirs",
      dirs: ["/a", "/b"],
    });
    // Empty is meaningful: it CLEARS the rules (unrestricted), so it must parse.
    expect(parseNodeCommandBody({ type: "set_allowed_dirs", dirs: [] })).toEqual({
      type: "set_allowed_dirs",
      dirs: [],
    });
    expect(parseNodeCommandBody({ type: "set_allowed_dirs" })).toBeNull();
    expect(parseNodeCommandBody({ type: "set_allowed_dirs", dirs: "/a" })).toBeNull();
    expect(parseNodeCommandBody({ type: "set_allowed_dirs", dirs: [1, 2] })).toBeNull();
  });

  it("accepts pane_cursor and rejects a missing or non-string id", () => {
    expect(parseNodeCommandBody({ type: "pane_cursor", subshellId: "s1" })).toEqual({
      type: "pane_cursor",
      subshellId: "s1",
    });
    expect(parseNodeCommandBody({ type: "pane_cursor" })).toBeNull();
    expect(parseNodeCommandBody({ type: "pane_cursor", subshellId: 7 })).toBeNull();
  });

  it("accepts pane_size and rejects a missing or non-string id", () => {
    expect(parseNodeCommandBody({ type: "pane_size", subshellId: "s1" })).toEqual({
      type: "pane_size",
      subshellId: "s1",
    });
    expect(parseNodeCommandBody({ type: "pane_size" })).toBeNull();
    expect(parseNodeCommandBody({ type: "pane_size", subshellId: 7 })).toBeNull();
  });

  it("path_exists takes the computed path, and the renamed-away probe_resume no longer parses", () => {
    // `probe_resume` did not survive the inversion (spec 2026-09-10 §5): the
    // command is now a general stat of a path the CONTROL PLANE computed, so
    // the resume-shaped frame must be rejected rather than silently
    // half-supported by either side.
    expect(parseNodeCommandBody({ type: "path_exists", path: "/home/n/.claude/projects/-w-x/abc.jsonl" })).toEqual({
      type: "path_exists",
      path: "/home/n/.claude/projects/-w-x/abc.jsonl",
    });
    expect(parseNodeCommandBody({ type: "path_exists" })).toBeNull();
    expect(parseNodeCommandBody({ type: "path_exists", path: 7 })).toBeNull();
    expect(
      parseNodeCommandBody({ type: "probe_resume", harnessId: "claude-code", harnessSessionId: "abc", cwd: "/w" }),
    ).toBeNull();
  });
});

describe("parseNodeEvent", () => {
  it("accepts ready with capabilities and parses inventory", () => {
    const ev = parseNodeEvent({
      type: "ready",
      agentVersion: "0.1.0",
      protocolVersion: 1,
      os: "darwin",
      arch: "arm64",
      hostname: "mac-mini",
      dataDir: "/Users/u/.local/share/subshell",
      capabilities: ["mcp"],
      // The agent's self-invocation of `subshell mcp` (the interpreter-run
      // branch: command is the interpreter, args lead with the entry script).
      // Optional — a non-mcp agent omits it and the plane falls back.
      selfInvoke: { command: "/usr/local/bin/bun", args: ["/opt/subshell/src/index.ts"] },
      // Spec 2026-09-10 §5: the resume-path home. Optional — absent means the
      // node reported none and the control plane computes the default anyway.
      homeDir: "/Users/u",
    });
    expect(ev?.type).toBe("ready");
    expect(ev).toMatchObject({
      homeDir: "/Users/u",
      selfInvoke: { command: "/usr/local/bin/bun", args: ["/opt/subshell/src/index.ts"] },
    });
    expect(parseNodeEvent({ type: "ready", agentVersion: "0.1.0" })).toBeNull(); // malformed base fields still refuse
    // A non-string homeDir, a mis-shaped selfInvoke, or a non-string arg in it
    // is a malformed frame, not a partial one: the parse is all-or-nothing
    // like every other event here.
    expect(
      parseNodeEvent({
        type: "ready",
        agentVersion: "0.1.0",
        protocolVersion: 1,
        os: "darwin",
        arch: "arm64",
        hostname: "h",
        dataDir: "/d",
        capabilities: [],
        homeDir: 7,
      }),
    ).toBeNull();
    for (const bad of [42, { command: "/usr/bin/subshell" }, { command: 7, args: [] }, { command: "s", args: [1] }]) {
      expect(
        parseNodeEvent({
          type: "ready",
          agentVersion: "0.1.0",
          protocolVersion: 1,
          os: "darwin",
          arch: "arm64",
          hostname: "h",
          dataDir: "/d",
          capabilities: [],
          selfInvoke: bad,
        }),
      ).toBeNull();
    }
    const inv = parseNodeEvent(
      JSON.stringify({
        type: "inventory",
        ts: "2026-08-31T00:00:00Z",
        harnesses: [{ harnessId: "claude-code", installed: true, version: "2.1", binaryPath: "/usr/bin/claude" }],
      }),
    );
    expect(inv?.type).toBe("inventory");
  });

  it("rejects non-positive byte ranges and bad base64 on output", () => {
    const good = { type: "output", subshellId: "s", subId: "t1", fromByte: 0, toByte: 3, data_b64: "aGk=" };
    expect(parseNodeEvent(good)).not.toBeNull();
    expect(parseNodeEvent({ ...good, fromByte: 5, toByte: 3 })).toBeNull();
    expect(parseNodeEvent({ ...good, data_b64: "%%%" })).toBeNull();
  });

  it("parses result ok/error, exit, heartbeat, subshells_report, error; rejects garbage", () => {
    expect(parseNodeEvent({ type: "result", ref: "j1", ok: true })?.type).toBe("result");
    expect(parseNodeEvent({ type: "result", ref: "j1", ok: false, error: "nope" })?.type).toBe("result");
    expect(parseNodeEvent({ type: "result", ref: "j1", ok: false })).toBeNull();
    expect(parseNodeEvent({ type: "heartbeat", ts: "t" })?.type).toBe("heartbeat");
    expect(parseNodeEvent({ type: "exit", subshellId: "s", exitCode: 1, at: "t" })?.type).toBe("exit");
    expect(parseNodeEvent({ type: "subshells_report", subshells: [] })?.type).toBe("subshells_report");
    expect(parseNodeEvent({ type: "error", code: "x", message: "y" })?.type).toBe("error");
    expect(parseNodeEvent("nope")).toBeNull();
    expect(parseNodeEvent({ type: "chat", text: "hi" })).toBeNull();
  });

  it("omits data on ok:true results unless present, and validates it when present", () => {
    const ev = parseNodeEvent({ type: "result", ref: "j1", ok: true });
    expect(ev?.type).toBe("result");
    expect("data" in (ev as object)).toBe(false);
    expect(parseNodeEvent({ type: "result", ref: "j1", ok: true, data: { x: [1, "a", null] } })).not.toBeNull();
    expect(parseNodeEvent({ type: "result", ref: "j1", ok: true, data: undefined })).toBeNull();
  });
});

describe("plugin commands (removed in protocol 3)", () => {
  it("plugin_install and plugin_uninstall no longer parse — plugins left the wire", () => {
    // The node holds no plugin concept (inversion spec §6), so the commands
    // that installed plugins left the wire with it. They now parse to null
    // BEFORE dispatch: the agent's verify step answers `malformed` rather
    // than running a handler that no longer exists, and the dispatch switch's
    // `unsupported` arm is back to being the answer for FUTURE unknown types
    // only (the census this replaced lives here, not in the agent's tests).
    expect(parseNodeCommandBody({ type: "plugin_install", id: "claude-code" })).toBeNull();
    expect(parseNodeCommandBody({ type: "plugin_uninstall", id: "pi" })).toBeNull();
    // Every old shape goes with them — including the phase-3 `spec` variants.
    expect(
      parseNodeCommandBody({ type: "plugin_install", id: "codex", spec: "@subshell-ai/plugin-codex@2.0.0" }),
    ).toBeNull();
    expect(parseNodeCommandBody({ type: "plugin_install" })).toBeNull();
    expect(parseNodeCommandBody({ type: "plugin_install", id: 7 })).toBeNull();
    expect(parseNodeCommandBody({ type: "plugin_uninstall", id: null })).toBeNull();
  });
});

describe("launch server-built argv, resolve rule, and mcp dialect", () => {
  it("a launch without argv or without resolve no longer parses (protocol 3)", () => {
    // Optional-on-the-wire was the Tasks 4–7 migration shape: an agent that
    // ignored argv built it itself. Task 7 demolished that fallback, so a
    // frame missing either half names a spawn nothing on the node can
    // perform — the parser refuses it rather than delivering a command the
    // executor would only answer an error to.
    const noArgv = structuredClone(launchCmd) as Record<string, unknown>;
    delete noArgv.argv;
    expect(parseNodeCommandBody(noArgv)).toBeNull();
    const noResolve = structuredClone(launchCmd) as Record<string, unknown>;
    delete noResolve.resolve;
    expect(parseNodeCommandBody(noResolve)).toBeNull();
    // An explicit undefined is the same refusal — the frame must CARRY both.
    expect(parseNodeCommandBody({ ...launchCmd, argv: undefined })).toBeNull();
    expect(parseNodeCommandBody({ ...launchCmd, resolve: undefined })).toBeNull();
    // mcp stays optional — only the two build-materials fields are required.
    const cmd = parseNodeCommandBody(structuredClone(launchCmd));
    expect(cmd).toMatchObject({ type: "launch" });
    if (cmd?.type === "launch") {
      expect(cmd.mcp === undefined || !("args" in cmd.mcp)).toBe(true);
    }
  });

  it("launch carries argv, a resolve rule, and mcp args/env when present", () => {
    const cmd = parseNodeCommandBody({
      ...structuredClone(launchCmd),
      argv: [HARNESS_BINARY_PLACEHOLDER, "--flag"],
      resolve: { binaryName: "pi" },
      mcp: { path: "/p", fileContent: "{}", args: ["--mcp-config", "/p"], env: { A: "b" } },
    });
    expect(cmd).not.toBeNull();
    if (cmd?.type === "launch") {
      expect(cmd.argv).toEqual([HARNESS_BINARY_PLACEHOLDER, "--flag"]);
      expect(cmd.resolve).toEqual({ binaryName: "pi" });
      expect(cmd.mcp?.args).toEqual(["--mcp-config", "/p"]);
      expect(cmd.mcp?.env).toEqual({ A: "b" });
    }
  });

  it("a non-string-array argv is refused rather than coerced", () => {
    expect(parseNodeCommandBody({ ...launchCmd, argv: "pi --flag" })).toBeNull();
    expect(parseNodeCommandBody({ ...launchCmd, argv: ["pi", 7] })).toBeNull();
  });

  it("a malformed resolve rule is refused; a full one parses", () => {
    expect(parseNodeCommandBody({ ...launchCmd, resolve: "pi" })).toBeNull();
    expect(parseNodeCommandBody({ ...launchCmd, resolve: {} })).toBeNull();
    expect(parseNodeCommandBody({ ...launchCmd, resolve: { binaryName: 7 } })).toBeNull();
    expect(parseNodeCommandBody({ ...launchCmd, resolve: { binaryName: "pi", envOverride: 7 } })).toBeNull();
    expect(
      parseNodeCommandBody({ ...launchCmd, resolve: { binaryName: "pi", knownPaths: ".local/bin/pi" } }),
    ).toBeNull();
    expect(
      parseNodeCommandBody({
        ...launchCmd,
        resolve: { binaryName: "pi", envOverride: "PI_PATH", knownPaths: [".local/bin/pi"] },
      }),
    ).not.toBeNull();
  });

  it("mcp args must be a string array and env a string map", () => {
    const mcp = { path: "/p", fileContent: "{}" };
    expect(parseNodeCommandBody({ ...launchCmd, mcp: { ...mcp, args: "--mcp-config /p" } })).toBeNull();
    expect(parseNodeCommandBody({ ...launchCmd, mcp: { ...mcp, args: ["a", 1] } })).toBeNull();
    expect(parseNodeCommandBody({ ...launchCmd, mcp: { ...mcp, env: { A: 1 } } })).toBeNull();
  });
});

describe("detect command (inversion spec §4)", () => {
  const spec = { id: "hermes", binaryName: "hermes", envOverride: "HERMES_PATH", knownPaths: [".local/bin/hermes"] };
  const envNames = ["CLAUDE_CONFIG_DIR", "HERMES_HOME"];

  it("accepts a well-formed detect and round-trips every spec field", () => {
    expect(parseNodeCommandBody({ type: "detect", specs: [spec], envNames })).toEqual({
      type: "detect",
      specs: [spec],
      envNames,
    });
    // Empty binaryName is the NO-BINARY marker (a plugin with no `detect`
    // block travels as the empty spec, not as absent keys) — shape, not verdict.
    expect(
      parseNodeCommandBody({
        type: "detect",
        specs: [{ id: "term", binaryName: "", envOverride: "", knownPaths: [] }],
        envNames,
      }),
    ).toEqual({
      type: "detect",
      specs: [{ id: "term", binaryName: "", envOverride: "", knownPaths: [] }],
      envNames,
    });
    // An empty specs array is a legal no-op; an empty envNames means the
    // plane's enabled manifests declare nothing — also legal, and the node
    // then answers `env: {}`.
    expect(parseNodeCommandBody({ type: "detect", specs: [], envNames: [] })).toEqual({
      type: "detect",
      specs: [],
      envNames: [],
    });
  });

  it("requires all three lookup fields on every spec (the manifest makes them required)", () => {
    expect(parseNodeCommandBody({ type: "detect", envNames })).toBeNull();
    expect(parseNodeCommandBody({ type: "detect", specs: "hermes", envNames })).toBeNull();
    const { id: _id, ...noId } = spec;
    const { binaryName: _b, ...noBinary } = spec;
    const { envOverride: _e, ...noEnv } = spec;
    const { knownPaths: _k, ...noKnown } = spec;
    expect(parseNodeCommandBody({ type: "detect", specs: [noId], envNames })).toBeNull();
    expect(parseNodeCommandBody({ type: "detect", specs: [noBinary], envNames })).toBeNull();
    expect(parseNodeCommandBody({ type: "detect", specs: [noEnv], envNames })).toBeNull();
    expect(parseNodeCommandBody({ type: "detect", specs: [noKnown], envNames })).toBeNull();
    expect(parseNodeCommandBody({ type: "detect", specs: [{ ...spec, binaryName: 7 }], envNames })).toBeNull();
    expect(parseNodeCommandBody({ type: "detect", specs: [{ ...spec, knownPaths: ["a", 1] }], envNames })).toBeNull();
    expect(parseNodeCommandBody({ type: "detect", specs: [null], envNames })).toBeNull();
  });

  it("requires envNames: absent, non-array, and non-string entries all refuse the frame", () => {
    // The §5 amendment made the list REQUIRED — an absent one is a plane that
    // forgot the field, not a plane asking for nothing (that is `[]`).
    const { envNames: _e, ...noEnvNames } = { type: "detect", specs: [spec], envNames } as const;
    expect(parseNodeCommandBody(noEnvNames)).toBeNull();
    expect(parseNodeCommandBody({ type: "detect", specs: [spec], envNames: "CLAUDE_CONFIG_DIR" })).toBeNull();
    expect(parseNodeCommandBody({ type: "detect", specs: [spec], envNames: ["A", 7] })).toBeNull();
  });
});

describe("ready.runtime (additive)", () => {
  const base = {
    type: "ready",
    agentVersion: "0.2.0",
    protocolVersion: NODE_PROTOCOL_VERSION,
    os: "linux",
    arch: "x64",
    hostname: "h",
    dataDir: "/d",
    capabilities: [],
  };
  const runtime = {
    startedAt: "2026-09-12T10:00:00.000Z",
    supervised: true,
    service: {
      manager: "systemd",
      installed: true,
      definitionPath: "/u/.config/systemd/user/subshell.service",
      state: "running",
      pid: 42,
      enabled: true,
      linger: true,
      paneSafety: "keeps",
    },
    configPath: "/u/.config/subshell/config.json",
    agentLogPath: "/u/.config/subshell/logs/agent.log",
    logging: { debug: false, source: "default" },
    logPath: null,
    logHint: "journalctl --user -u subshell.service -f",
    tmuxPath: "/usr/bin/tmux",
    binaryPath: "/u/.local/bin/subshell",
  };

  it("accepts a ready with a well-formed runtime and without one", () => {
    expect(parseNodeEvent({ ...base, runtime })).toMatchObject({ type: "ready", runtime });
    expect(parseNodeEvent(base)).toMatchObject({ type: "ready" });
  });

  it("drops a malformed runtime but keeps the ready", () => {
    const ev = parseNodeEvent({ ...base, runtime: { startedAt: 5 } });
    expect(ev?.type).toBe("ready");
    expect(ev && "runtime" in ev ? ev.runtime : undefined).toBeUndefined();
  });

  it("parseNodeRuntimeReport refuses a bad manager, paneSafety, or field type", () => {
    expect(parseNodeRuntimeReport(runtime)).toEqual(runtime as never);
    expect(parseNodeRuntimeReport({ ...runtime, service: { ...runtime.service, manager: "upstart" } })).toBeNull();
    expect(parseNodeRuntimeReport({ ...runtime, service: { ...runtime.service, paneSafety: "maybe" } })).toBeNull();
    expect(parseNodeRuntimeReport({ ...runtime, service: { ...runtime.service, manager: null } })).not.toBeNull();
    expect(parseNodeRuntimeReport({ ...runtime, binaryPath: 7 })).toBeNull();
    expect(parseNodeRuntimeReport({ ...runtime, logPath: null, logHint: null })).not.toBeNull();
    expect(parseNodeRuntimeReport(null)).toBeNull();
  });

  it("holds `linger` to the same strictness as every other service field", () => {
    // STRICT, unlike `logging`: the version gate is exact-match, so an agent
    // that omits this field is one the plane refused at connect. A tolerated
    // absence would mean rendering "unknown" for a machine that merely
    // predates the field — indistinguishable from logind declining to say,
    // which is a different machine with a different fix.
    expect(parseNodeRuntimeReport({ ...runtime, service: { ...runtime.service, linger: false } })?.service.linger).toBe(
      false,
    );
    expect(parseNodeRuntimeReport({ ...runtime, service: { ...runtime.service, linger: null } })?.service.linger).toBe(
      null,
    );
    expect(parseNodeRuntimeReport({ ...runtime, service: { ...runtime.service, linger: "yes" } })).toBeNull();
    const { linger: _gone, ...withoutLinger } = runtime.service;
    expect(parseNodeRuntimeReport({ ...runtime, service: withoutLinger })).toBeNull();
  });

  it("defaults a missing or malformed `logging` instead of rejecting the report", () => {
    const off = { debug: false, source: "default" as const };
    // Lenient where every other field is strict, on purpose: this one is
    // cosmetic — the current position of a switch — and the rest of the report
    // is what the card is FOR. Losing supervision, service state, paths and
    // every verb because a sub-object was malformed is the wrong trade.
    const { logging: _dropped, ...without } = runtime;
    expect(parseNodeRuntimeReport(without)?.logging).toEqual(off);
    expect(parseNodeRuntimeReport({ ...runtime, logging: "yes" })?.logging).toEqual(off);
    expect(parseNodeRuntimeReport({ ...runtime, logging: { debug: true, source: "nonsense" } })?.logging).toEqual({
      debug: true,
      source: "default",
    });
    // A well-formed one still comes through verbatim.
    expect(parseNodeRuntimeReport({ ...runtime, logging: { debug: true, source: "process env" } })?.logging).toEqual({
      debug: true,
      source: "process env",
    });
  });
});

describe("service command", () => {
  it("parses every verb, with and without force", () => {
    for (const verb of NODE_SERVICE_VERBS) {
      expect(parseNodeCommandBody({ type: "service", verb })).toEqual({ type: "service", verb });
      expect(parseNodeCommandBody({ type: "service", verb, force: true })).toEqual({
        type: "service",
        verb,
        force: true,
      });
    }
    expect(parseNodeCommandBody({ type: "service", verb: "restart", force: "yes" })).toBeNull();
  });

  // A verb this protocol does not know must be refused at the PARSER, not
  // reach the agent's switch and fall through to an `unsupported` result that
  // reads like a version mismatch.
  it("refuses a verb it does not know", () => {
    expect(parseNodeCommandBody({ type: "service", verb: "reload" })).toBeNull();
    expect(parseNodeCommandBody({ type: "service" })).toBeNull();
    expect(parseNodeCommandBody({ type: "service", verb: 1 })).toBeNull();
  });

  // `restart` was its own command through protocol 4. It is a VERB now, and
  // the old spelling must not quietly parse into anything.
  it("no longer knows the standalone restart command (protocol 5)", () => {
    expect(parseNodeCommandBody({ type: "restart" })).toBeNull();
    expect(parseNodeCommandBody({ type: "restart", force: true })).toBeNull();
  });

  it("names the refusal strings as constants", () => {
    expect(NODE_RESULT_NOT_SUPERVISED).toBe("not supervised");
    expect(NODE_RESULT_KILLS_PANES).toBe("kills panes");
    expect(NODE_RESULT_NO_SERVICE).toBe("no service definition");
  });

  // Only the verbs that can end a pane may ask for `force`. Offering it on
  // `start` or `install` would teach a person that the flag is noise.
  it("marks exactly the destructive verbs", () => {
    expect([...NODE_SERVICE_DESTRUCTIVE].sort()).toEqual(["restart", "stop", "uninstall"]);
    for (const verb of NODE_SERVICE_DESTRUCTIVE) expect(NODE_SERVICE_VERBS).toContain(verb);
  });
});

describe("agent_log_read command", () => {
  it("parses a well-formed range", () => {
    expect(parseNodeCommandBody({ type: "agent_log_read", fromByte: 0, maxBytes: 64_000 })).toEqual({
      type: "agent_log_read",
      fromByte: 0,
      maxBytes: 64_000,
    });
  });

  it("refuses a negative offset, a non-positive cap, and missing fields", () => {
    expect(parseNodeCommandBody({ type: "agent_log_read", fromByte: -1, maxBytes: 10 })).toBeNull();
    expect(parseNodeCommandBody({ type: "agent_log_read", fromByte: 0, maxBytes: 0 })).toBeNull();
    expect(parseNodeCommandBody({ type: "agent_log_read", fromByte: 0 })).toBeNull();
    expect(parseNodeCommandBody({ type: "agent_log_read", fromByte: "0", maxBytes: 10 })).toBeNull();
  });

  // The pane log holds what an operator TYPED. These two must never be
  // reachable through one name, so the names are pinned rather than assumed.
  it("is a different command from a subshell's pane log_read", () => {
    expect(parseNodeCommandBody({ type: "agent_log_read", fromByte: 0, maxBytes: 1 })).not.toBeNull();
    expect(parseNodeCommandBody({ type: "log_read", fromByte: 0, maxBytes: 1 })).toBeNull();
  });
});

describe("set_server_url command", () => {
  it("parses a non-empty url", () => {
    expect(parseNodeCommandBody({ type: "set_server_url", url: "https://plane.example.com" })).toEqual({
      type: "set_server_url",
      url: "https://plane.example.com",
    });
  });

  it("refuses an absent or empty url", () => {
    expect(parseNodeCommandBody({ type: "set_server_url", url: "" })).toBeNull();
    expect(parseNodeCommandBody({ type: "set_server_url" })).toBeNull();
    expect(parseNodeCommandBody({ type: "set_server_url", url: 1 })).toBeNull();
  });
});

// Named for the bump that INTRODUCED these frames rather than the current one.
// The fixture's agent version tracks the live floor so it never reads as a
// build that could not connect — nothing here asserts against either number.
describe("maintenance (arrived at protocol 8)", () => {
  const base = {
    type: "ready",
    agentVersion: MIN_NODE_VERSION,
    protocolVersion: NODE_PROTOCOL_VERSION,
    os: "linux",
    arch: "x64",
    hostname: "h",
    dataDir: "/d",
    capabilities: [],
  };
  const state = { on: true, changedAt: "2026-09-14T10:00:00.000Z" };

  it("carries the node's state on ready, and drops a malformed one without refusing the ready", () => {
    // Lenient for the same reason `runtime` is: the rest of the frame is what
    // brings the node online, and a node whose mirror file is nonsense must
    // still connect — it is then reconciled from the plane's own record.
    expect(parseNodeEvent({ ...base, maintenance: state })).toMatchObject({ type: "ready", maintenance: state });
    expect(parseNodeEvent(base)).toMatchObject({ type: "ready" });
    const bad = parseNodeEvent({ ...base, maintenance: { on: "yes" } });
    expect(bad?.type).toBe("ready");
    expect(bad && "maintenance" in bad ? bad.maintenance : undefined).toBeUndefined();
  });

  it("parses the standalone event strictly — it is the only carrier of a flip", () => {
    // Strict where the `ready` field is lenient: this frame IS the change, so
    // a malformed one dropped silently would leave the plane believing the
    // opposite of what the machine is doing.
    expect(parseNodeEvent({ type: "maintenance", ...state })).toEqual({ type: "maintenance", ...state });
    expect(parseNodeEvent({ type: "maintenance", on: false, changedAt: state.changedAt })).toEqual({
      type: "maintenance",
      on: false,
      changedAt: state.changedAt,
    });
    expect(parseNodeEvent({ type: "maintenance", on: true })).toBeNull();
    expect(parseNodeEvent({ type: "maintenance", changedAt: state.changedAt })).toBeNull();
    expect(parseNodeEvent({ type: "maintenance", on: "yes", changedAt: state.changedAt })).toBeNull();
    expect(parseNodeEvent({ type: "maintenance", on: true, changedAt: 5 })).toBeNull();
  });

  it("parses the set_maintenance command and refuses a partial one", () => {
    expect(parseNodeCommandBody({ type: "set_maintenance", ...state })).toEqual({ type: "set_maintenance", ...state });
    expect(parseNodeCommandBody({ type: "set_maintenance", on: false, changedAt: state.changedAt })).toEqual({
      type: "set_maintenance",
      on: false,
      changedAt: state.changedAt,
    });
    expect(parseNodeCommandBody({ type: "set_maintenance", on: true })).toBeNull();
    expect(parseNodeCommandBody({ type: "set_maintenance", changedAt: state.changedAt })).toBeNull();
    expect(parseNodeCommandBody({ type: "set_maintenance", on: 1, changedAt: state.changedAt })).toBeNull();
  });

  it("names the refusal the plane matches by equality", () => {
    // The plane compares `NodeRpcError.detail` to this exact string to map a
    // refused launch onto its 409. A prefixed or reworded message is a 500.
    expect(NODE_RESULT_MAINTENANCE).toBe("in maintenance");
  });
});

// The maintenance frames' sibling set (spec 2026-10-07 §4.3): same three
// carriers, one writer (the plane) instead of two, and the fail-closed
// default inverted — an absent mirror refuses.
describe("ssh gate (arrived at protocol 16)", () => {
  const base = {
    type: "ready",
    agentVersion: MIN_NODE_VERSION,
    protocolVersion: NODE_PROTOCOL_VERSION,
    os: "linux",
    arch: "x64",
    hostname: "h",
    dataDir: "/d",
    capabilities: [],
  };
  const state = { on: true, changedAt: "2026-10-07T10:00:00.000Z" };

  it("carries the mirror on ready, and drops a malformed one without refusing the ready", () => {
    // Lenient exactly like `maintenance`: the rest of the frame brings the
    // node online, and the plane's answer to silence is its own row — a row
    // that says on pushes the value down, so a dropped field strands nobody.
    expect(parseNodeEvent({ ...base, sshEnabled: state })).toMatchObject({ type: "ready", sshEnabled: state });
    expect(parseNodeEvent(base)).toMatchObject({ type: "ready" });
    const bad = parseNodeEvent({ ...base, sshEnabled: { on: "yes" } });
    expect(bad?.type).toBe("ready");
    expect(bad && "sshEnabled" in bad ? bad.sshEnabled : undefined).toBeUndefined();
  });

  it("parses the standalone event strictly — it is the mid-session carrier", () => {
    expect(parseNodeEvent({ type: "ssh_enabled", ...state })).toEqual({ type: "ssh_enabled", ...state });
    expect(parseNodeEvent({ type: "ssh_enabled", on: false, changedAt: state.changedAt })).toEqual({
      type: "ssh_enabled",
      on: false,
      changedAt: state.changedAt,
    });
    expect(parseNodeEvent({ type: "ssh_enabled", on: true })).toBeNull();
    expect(parseNodeEvent({ type: "ssh_enabled", changedAt: state.changedAt })).toBeNull();
    expect(parseNodeEvent({ type: "ssh_enabled", on: "yes", changedAt: state.changedAt })).toBeNull();
  });

  it("parses the set_ssh_enabled command and refuses a partial one", () => {
    expect(parseNodeCommandBody({ type: "set_ssh_enabled", ...state })).toEqual({
      type: "set_ssh_enabled",
      ...state,
    });
    expect(parseNodeCommandBody({ type: "set_ssh_enabled", on: false, changedAt: state.changedAt })).toEqual({
      type: "set_ssh_enabled",
      on: false,
      changedAt: state.changedAt,
    });
    expect(parseNodeCommandBody({ type: "set_ssh_enabled", on: true })).toBeNull();
    expect(parseNodeCommandBody({ type: "set_ssh_enabled", changedAt: state.changedAt })).toBeNull();
    expect(parseNodeCommandBody({ type: "set_ssh_enabled", on: 1, changedAt: state.changedAt })).toBeNull();
  });
});

describe("ssh command arms and the launch ssh block", () => {
  it("ssh discovery/resolve arms delegate to the ssh grammar", () => {
    expect(parseNodeCommandBody({ type: "ssh_discover_aliases" })).toEqual({ type: "ssh_discover_aliases" });
    expect(parseNodeCommandBody({ type: "ssh_resolve_config", alias: "box-a" })).toEqual({
      type: "ssh_resolve_config",
      alias: "box-a",
    });
    // alias hygiene lives in ssh-frames' parser (port-verified): option-like and whitespace are refused there
    expect(parseNodeCommandBody({ type: "ssh_resolve_config", alias: "-x" })).toBeNull();
    expect(parseNodeCommandBody({ type: "ssh_resolve_config", alias: "a b" })).toBeNull();
  });

  it("the ssh_register_identity arm is its type alone (spec 2026-10-08 §4.3)", () => {
    expect(parseNodeCommandBody({ type: "ssh_register_identity" })).toEqual({ type: "ssh_register_identity" });
    // Nothing beyond the type travels: the machine answers about itself, so
    // a plane-sent field could only be an injection attempt at its own slot.
    expect(parseNodeCommandBody({ type: "ssh_register_identity", signingPublicKey: "x" })).toEqual({
      type: "ssh_register_identity",
    });
    expect(parseNodeCommandBody({ type: "ssh_register_identity" })).not.toBeNull();
    // The family's census: exactly these seven types, and the count is the
    // tripwire - a further arm must show up here before it ships.
    expect([...SSH_COMMAND_TYPES].sort()).toEqual([
      "ssh_agent_identities",
      "ssh_discover_aliases",
      "ssh_host_key",
      "ssh_register_identity",
      "ssh_relay_close",
      "ssh_relay_open",
      "ssh_resolve_config",
    ]);
    expect(SSH_COMMAND_TYPES).toHaveLength(7);
    // Every census type is a type the dispatcher actually narrows.
    for (const t of SSH_COMMAND_TYPES) {
      const body =
        t === "ssh_resolve_config"
          ? { type: t, alias: "box-a" }
          : t === "ssh_relay_open"
            ? relayOpenCmd
            : t === "ssh_relay_close"
              ? { type: t, ref: "r-1", reason: "lifetime-expiry" }
              : t === "ssh_host_key"
                ? { type: t, host: "git.example.test", port: 22, user: null }
                : { type: t };
      expect(parseNodeCommandBody(body)).not.toBeNull();
    }
  });

  it("the ssh_agent_identities arm is its type alone (spec 2026-10-08 §5.4: the roster command asks the WHOLE roster)", () => {
    expect(parseNodeCommandBody({ type: "ssh_agent_identities" })).toEqual({ type: "ssh_agent_identities" });
    // Nothing beyond the type travels: the command enumerates A's entire public
    // roster, so a plane-sent selection could only be a widening attempt.
    expect(parseNodeCommandBody({ type: "ssh_agent_identities", fingerprints: ["x"] })).toEqual({
      type: "ssh_agent_identities",
    });
    expect(parseNodeCommandBody({ type: "ssh_agent_identities", grantId: "g" })).toEqual({
      type: "ssh_agent_identities",
    });
  });

  it("the ssh_host_key arm names a destination and nothing else (spec 2026-10-08 §9, Task 12)", () => {
    // The capture command asks for ONE destination's known_hosts entries: host
    // always, port always (ssh's own lookup spells the port), user as its
    // honest null when the snapshot named none. Stray members do not ride.
    expect(parseNodeCommandBody({ type: "ssh_host_key", host: "git.example.test", port: 22, user: null })).toEqual({
      type: "ssh_host_key",
      host: "git.example.test",
      port: 22,
      user: null,
    });
    expect(
      parseNodeCommandBody({ type: "ssh_host_key", host: "git.example.test", port: 2222, user: "deploy" }),
    ).toEqual({ type: "ssh_host_key", host: "git.example.test", port: 2222, user: "deploy" });
    expect(
      parseNodeCommandBody({ type: "ssh_host_key", host: "[2001:db8::1]", port: 22, user: null, smuggled: "x" }),
    ).not.toHaveProperty("smuggled");
    // Refusals: the host takes the alias grammar (option-like, whitespace,
    // control chars, over-long); the port is a positive 16-bit int; the user
    // is null or an alias-grammar name.
    expect(parseNodeCommandBody({ type: "ssh_host_key", host: "-oProxyCommand=x", port: 22, user: null })).toBeNull();
    expect(parseNodeCommandBody({ type: "ssh_host_key", host: "a b", port: 22, user: null })).toBeNull();
    expect(
      parseNodeCommandBody({ type: "ssh_host_key", host: `h${"x".repeat(300)}`, port: 22, user: null }),
    ).toBeNull();
    expect(parseNodeCommandBody({ type: "ssh_host_key", host: "h", port: 0, user: null })).toBeNull();
    expect(parseNodeCommandBody({ type: "ssh_host_key", host: "h", port: 65536, user: null })).toBeNull();
    expect(parseNodeCommandBody({ type: "ssh_host_key", host: "h", port: 22.5, user: null })).toBeNull();
    expect(parseNodeCommandBody({ type: "ssh_host_key", host: "h", port: 22, user: "a b" })).toBeNull();
    expect(parseNodeCommandBody({ type: "ssh_host_key", host: "h", port: 22, user: 7 })).toBeNull();
    expect(parseNodeCommandBody({ type: "ssh_host_key", host: "h", port: 22 })).toBeNull(); // user must be present (null is spelled)
    expect(parseNodeCommandBody({ type: "ssh_host_key", host: "h", port: 22, user: undefined })).toBeNull();
  });

  it("launch accepts an ssh block and refuses malformed ones", () => {
    const good = { ...launchCmd, ssh: { configPath: "/d/ssh/s1/config", fileContent: "Host *\n" } };
    expect(parseNodeCommandBody(good)).toMatchObject({
      type: "launch",
      ssh: { configPath: "/d/ssh/s1/config", fileContent: "Host *\n" },
    });
    expect(parseNodeCommandBody({ ...launchCmd, ssh: { configPath: "relative", fileContent: "Host *\n" } })).toBeNull();
    expect(
      parseNodeCommandBody({
        ...launchCmd,
        ssh: { configPath: "/d/ssh/s1/config", fileContent: "x".repeat(SSH_CONFIG_FILE_MAX_BYTES + 1) },
      }),
    ).toBeNull();
    expect(
      parseNodeCommandBody({
        ...launchCmd,
        ssh: { configPath: "/d/ssh/s1/config", fileContent: "x".repeat(SSH_CONFIG_FILE_MAX_BYTES) },
      }),
    ).not.toBeNull();
    expect(parseNodeCommandBody({ ...launchCmd, ssh: "x" })).toBeNull();
  });
});

describe("ssh_relay_open / ssh_relay_close arms (spec 2026-10-08 §5.1)", () => {
  it("narrows a complete open pairing, every field carried through", () => {
    expect(parseNodeCommandBody(structuredClone(relayOpenCmd))).toEqual(structuredClone(relayOpenCmd));
    expect(parseNodeCommandBody(JSON.stringify(relayOpenCmd))).toEqual(relayOpenCmd);
    // Role B is the same grammar; the plane decides which machine gets which.
    expect(parseNodeCommandBody({ ...relayOpenCmd, role: "B" })).toMatchObject({ role: "B" });
    // An empty fingerprint set parses: scoping (serve nothing) is the
    // responder's rule (§5.4), not a reason to refuse the frame.
    expect(parseNodeCommandBody({ ...relayOpenCmd, fingerprints: [] })).toMatchObject({ fingerprints: [] });
  });

  it("refuses an open missing any half of the pairing", () => {
    // The command IS the pairing; a partial one names no complete session,
    // so every field is required (same posture as `update`'s three).
    for (const drop of [
      "relayId",
      "ref",
      "role",
      "aNodeId",
      "bNodeId",
      "peerSigningPublicKey",
      "peerEncryptPublicKey",
      "grantId",
      "fingerprints",
      "lifetimeMs",
      "paneId",
      "hostPin",
    ] as const) {
      const partial = structuredClone(relayOpenCmd) as unknown as Record<string, unknown>;
      delete partial[drop];
      expect(parseNodeCommandBody(partial)).toBeNull();
    }
  });

  it("refuses malformed open fields", () => {
    expect(parseNodeCommandBody({ ...relayOpenCmd, role: "C" })).toBeNull(); // only A or B
    expect(parseNodeCommandBody({ ...relayOpenCmd, relayId: "" })).toBeNull(); // ids are non-empty
    expect(parseNodeCommandBody({ ...relayOpenCmd, grantId: 42 })).toBeNull();
    expect(parseNodeCommandBody({ ...relayOpenCmd, fingerprints: "SHA256:AAAA" })).toBeNull(); // array, not string
    expect(parseNodeCommandBody({ ...relayOpenCmd, fingerprints: ["ok", 7] })).toBeNull();
    // The grant's selection is capped by SSH_MAX_GRANT_FINGERPRINTS, and the
    // refusal is hard - never a silent truncation (§5.4).
    expect(
      parseNodeCommandBody({
        ...relayOpenCmd,
        fingerprints: Array.from({ length: SSH_MAX_GRANT_FINGERPRINTS + 1 }, (_, i) => `SHA256:${i}`),
      }),
    ).toBeNull();
    expect(
      parseNodeCommandBody({
        ...relayOpenCmd,
        fingerprints: Array.from({ length: SSH_MAX_GRANT_FINGERPRINTS }, (_, i) => `SHA256:${i}`),
      }),
    ).not.toBeNull();
    expect(parseNodeCommandBody({ ...relayOpenCmd, lifetimeMs: 0 })).toBeNull(); // positive or refuse
    expect(parseNodeCommandBody({ ...relayOpenCmd, lifetimeMs: 1.5 })).toBeNull();
    // The encryption half is a base64 key (same spelling the link pins carry);
    // junk at the grammar is malformed, not "the pin will sort it out".
    expect(parseNodeCommandBody({ ...relayOpenCmd, peerEncryptPublicKey: "!!!" })).toBeNull();
    expect(parseNodeCommandBody({ ...relayOpenCmd, peerEncryptPublicKey: "" })).toBeNull();
  });

  it("refuses a peer signing key whose JSON is not a plain public-JWK record (Task 4 review)", () => {
    // The shape gate mirrors parseNodeSshIdentity: a non-empty string is not
    // enough; it must PARSE to a plain record. A bare word and a serialized
    // PRIVATE JWK are the two shapes the old isIdStr-only check let through,
    // so both are named here. Deep private-material refusal (importability,
    // curve, coordinates) stays `bytesOfJwk` on the node - Task 6.
    expect(parseNodeCommandBody({ ...relayOpenCmd, peerSigningPublicKey: "not json" })).toBeNull();
    expect(parseNodeCommandBody({ ...relayOpenCmd, peerSigningPublicKey: "hello" })).toBeNull();
    // A real private-JWK spelling: plain record, carries the `d` member.
    expect(
      parseNodeCommandBody({
        ...relayOpenCmd,
        peerSigningPublicKey: '{"kty":"EC","crv":"P-256","x":"AAA","y":"BBB","d":"pr1v4t3"}',
      }),
    ).toBeNull();
    // JSON scalars and arrays are not records.
    expect(parseNodeCommandBody({ ...relayOpenCmd, peerSigningPublicKey: "null" })).toBeNull();
    expect(parseNodeCommandBody({ ...relayOpenCmd, peerSigningPublicKey: "[1,2]" })).toBeNull();
    // The public shape (the fixture) still parses, and a public JWK with
    // EXTRA public members is still a record.
    expect(
      parseNodeCommandBody({
        ...relayOpenCmd,
        peerSigningPublicKey: '{"kty":"EC","crv":"P-256","x":"AAA","y":"BBB","use":"sig"}',
      }),
    ).not.toBeNull();
  });

  it("rebuilds the open from validated fields; stray wire members do not ride", () => {
    const parsed = parseNodeCommandBody({ ...relayOpenCmd, sneaky: { should: "not pass" } });
    expect(parsed).not.toBeNull();
    expect(parsed).not.toHaveProperty("sneaky");
    expect(parsed).toEqual(relayOpenCmd);
  });

  it("refuses a hostPin that is not one known_hosts line (spec 2026-10-08 §9, Task 12)", () => {
    // The pin carriage is A's recorded key line delivered to B; the grammar's
    // job is the SHAPE: one printable line, bounded, never a comment, never a
    // multi-line smuggle (the node writes it verbatim into B's 0600 pinned
    // file, so a newline would be a second, plane-authored trust entry).
    // Deep truth (does the key match D) stays OpenSSH's at connect time.
    expect(parseNodeCommandBody({ ...relayOpenCmd, hostPin: "" })).toBeNull(); // empty is no pin
    expect(parseNodeCommandBody({ ...relayOpenCmd, hostPin: "   " })).toBeNull();
    expect(parseNodeCommandBody({ ...relayOpenCmd, hostPin: "host ssh-rsa AAA\nsecond ssh-rsa BBB" })).toBeNull();
    expect(parseNodeCommandBody({ ...relayOpenCmd, hostPin: "host ssh-rsa AAA\rBBB" })).toBeNull(); // CR smuggle
    expect(parseNodeCommandBody({ ...relayOpenCmd, hostPin: "host ssh-rsa AAA\tB\tBB" })).toBeNull(); // tab smuggle
    expect(parseNodeCommandBody({ ...relayOpenCmd, hostPin: "# comment line" })).toBeNull();
    expect(parseNodeCommandBody({ ...relayOpenCmd, hostPin: 7 })).toBeNull();
    expect(parseNodeCommandBody({ ...relayOpenCmd, hostPin: `host ssh-rsa ${"A".repeat(4084)}` })).toBeNull(); // 4097 > SSH_MAX_HOST_PIN_LINE_CHARS
    // Honest spellings parse: plain, hashed-pattern, and user-qualified lines
    // all carry A's recorded trust in OpenSSH's own known_hosts form.
    expect(
      parseNodeCommandBody({ ...relayOpenCmd, hostPin: "[git.example.test]:2222 ssh-ed25519 AAAAC3Nza==" }),
    ).not.toBeNull();
    expect(
      parseNodeCommandBody({
        ...relayOpenCmd,
        hostPin:
          "git.example.test ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI00000000000000000000000000000000000000000 comment@host",
      }),
    ).not.toBeNull();
    expect(
      parseNodeCommandBody({
        ...relayOpenCmd,
        hostPin: "|1|bnVsbHNhbHRudWxsc2FsdA==|dGhlaGFzaHRoYXRpc25vdHRoaXM=|ssh-ed25519 AAAAC3NzaC1lZDI1NTE5",
      }),
    ).not.toBeNull();
    expect(parseNodeCommandBody({ ...relayOpenCmd, hostPin: `host ssh-rsa ${"A".repeat(4083)}` })).not.toBeNull(); // at the bound (4096 total)
  });

  it("refuses fingerprint entries outside the SHA256 display form", () => {
    // The tight form is what stops control chars (and plain junk) reaching a
    // future audit row through a field that promises to be a fingerprint.
    expect(parseNodeCommandBody({ ...relayOpenCmd, fingerprints: ["ok"] })).toBeNull(); // no prefix
    expect(parseNodeCommandBody({ ...relayOpenCmd, fingerprints: ["SHA256:"] })).toBeNull(); // empty digest
    expect(parseNodeCommandBody({ ...relayOpenCmd, fingerprints: ["SHA256:AAA\tBBB"] })).toBeNull(); // control char
    expect(parseNodeCommandBody({ ...relayOpenCmd, fingerprints: [`SHA256:${"A".repeat(129)}`] })).toBeNull(); // over the bound
    expect(parseNodeCommandBody({ ...relayOpenCmd, fingerprints: [`SHA256:${"a-_0".repeat(32)}`] })).not.toBeNull(); // alphabet, at bound
  });

  it("validates the paneId against the path-composition shape (Task 8 (b))", () => {
    // The B-side proxy socket is `<dataDir>/ssh/<paneId>/agent.sock` and
    // pane-runtime's own guard refuses anything outside
    // `^[a-zA-Z0-9_-]{1,64}$`; the grammar names the SAME shape so a command
    // that could only fail the node's guard fails here first, before the
    // plane signs it. A uuid (the normal subshell id) is in the class.
    expect(parseNodeCommandBody({ ...relayOpenCmd, paneId: "pane-42" })).toMatchObject({ paneId: "pane-42" });
    expect(parseNodeCommandBody({ ...relayOpenCmd, paneId: "A9_z-x" })).toMatchObject({ paneId: "A9_z-x" });
    expect(parseNodeCommandBody({ ...relayOpenCmd, paneId: "x".repeat(64) })).not.toBeNull(); // at bound
    // Every refusal below is a shape the socket-path guard could not take:
    // traversal, absolute paths, empty, over-bound, and whitespace/control.
    expect(parseNodeCommandBody({ ...relayOpenCmd, paneId: "" })).toBeNull();
    expect(parseNodeCommandBody({ ...relayOpenCmd, paneId: "x".repeat(65) })).toBeNull();
    expect(parseNodeCommandBody({ ...relayOpenCmd, paneId: "../escape" })).toBeNull();
    expect(parseNodeCommandBody({ ...relayOpenCmd, paneId: "a/b" })).toBeNull();
    expect(parseNodeCommandBody({ ...relayOpenCmd, paneId: "/abs" })).toBeNull();
    expect(parseNodeCommandBody({ ...relayOpenCmd, paneId: "a.b" })).toBeNull();
    expect(parseNodeCommandBody({ ...relayOpenCmd, paneId: "a b" })).toBeNull();
    expect(parseNodeCommandBody({ ...relayOpenCmd, paneId: "a\nb" })).toBeNull();
    expect(parseNodeCommandBody({ ...relayOpenCmd, paneId: 42 })).toBeNull();
    // The exported predicate is the ONE spelling of the rule; the parse arm
    // and the plane's openRelay consult it, so a drift here is a drift there.
    expect(isSshPaneId("pane-42")).toBe(true);
    expect(isSshPaneId("x".repeat(64))).toBe(true);
    expect(isSshPaneId("x".repeat(65))).toBe(false);
    expect(isSshPaneId("a/b")).toBe(false);
    expect(isSshPaneId("")).toBe(false);
    expect(isSshPaneId(7)).toBe(false);
    expect(isSshPaneId(null)).toBe(false);
  });

  it("exposes the grant fingerprint-set predicate for the plane's pre-signing check", () => {
    // The plane validates a grant's selection with the SAME rule its own
    // parser enforces on receipt; one definition, two directions.
    expect(isSshGrantFingerprints([])).toBe(true); // §5.4: empty names nothing, serves nothing
    expect(isSshGrantFingerprints(["SHA256:AAAA"])).toBe(true);
    expect(isSshGrantFingerprints(["SHA256:AAAA", "not-a-fingerprint"])).toBe(false);
    expect(
      isSshGrantFingerprints(Array.from({ length: SSH_MAX_GRANT_FINGERPRINTS + 1 }, (_, i) => `SHA256:${i}`)),
    ).toBe(false);
    expect(isSshGrantFingerprints("SHA256:AAAA")).toBe(false);
  });

  it("narrows the close: routing ref and a NAMED reason from the typed union, nothing else", () => {
    // The census members are the ONLY accepted spellings; each round-trips.
    for (const reason of SSH_RELAY_CLOSE_REASONS) {
      expect(parseNodeCommandBody({ type: "ssh_relay_close", ref: "r-4f2a", reason })).toEqual({
        type: "ssh_relay_close",
        ref: "r-4f2a",
        reason,
      });
    }
    expect(parseNodeCommandBody({ type: "ssh_relay_close", ref: "r-4f2a", reason: "grant-revoked" })).toEqual({
      type: "ssh_relay_close",
      ref: "r-4f2a",
      reason: "grant-revoked",
    });
    // An unknown reason is a malformed close: §5.1's "closed with a named
    // reason" cannot hold if the grammar accepts any string.
    expect(parseNodeCommandBody({ type: "ssh_relay_close", ref: "r-4f2a", reason: "because-i-said-so" })).toBeNull();
    // The old underscore spellings are not the names either.
    expect(parseNodeCommandBody({ type: "ssh_relay_close", ref: "r-4f2a", reason: "grant_revoked" })).toBeNull();
    expect(parseNodeCommandBody({ type: "ssh_relay_close", ref: "r-4f2a" })).toBeNull(); // reason required
    expect(parseNodeCommandBody({ type: "ssh_relay_close", reason: "lifetime-expiry" })).toBeNull(); // ref required
    expect(parseNodeCommandBody({ type: "ssh_relay_close", ref: "", reason: "child-exit" })).toBeNull();
    expect(parseNodeCommandBody({ type: "ssh_relay_close", ref: "r", reason: "" })).toBeNull();
    expect(parseNodeCommandBody({ type: "ssh_relay_close", ref: "r", reason: 3 })).toBeNull();
    // A stray member on a valid close does not ride (the open arm's rebuild
    // style; the close always rebuilt, and it still drops the extra).
    expect(parseNodeCommandBody({ type: "ssh_relay_close", ref: "r-1", reason: "a-dropped", extra: 1 })).toEqual({
      type: "ssh_relay_close",
      ref: "r-1",
      reason: "a-dropped",
    });
  });
});

describe("update command (protocol 10, spec 2026-09-15 §5.1)", () => {
  it("pins the wire shape as a LITERAL, because this one is frozen across protocol bumps", () => {
    // Every other command travels between two ends that agreed on
    // NODE_PROTOCOL_VERSION, so renaming a field there costs a version number
    // and nothing else. `update` is the one the plane sends to an agent whose
    // protocol it does NOT share (§5.3 holds such a socket precisely so this
    // can reach it), so the parser below must keep accepting exactly these
    // four names forever. Written as a literal object rather than built from
    // constants: a test that derived the shape from the same source as the
    // code could not see a rename at all.
    const wire = {
      type: "update",
      version: "0.9.0",
      url: "https://plane.example/api/downloads/node/linux-x64?update_token=nut_abc",
      sha256: "a".repeat(64),
      force: true,
    };
    expect(parseNodeCommandBody(wire)).toEqual({
      type: "update",
      version: "0.9.0",
      url: "https://plane.example/api/downloads/node/linux-x64?update_token=nut_abc",
      sha256: "a".repeat(64),
      force: true,
    });
  });

  it("omits force when it was not sent, rather than defaulting it", () => {
    const parsed = parseNodeCommandBody({
      type: "update",
      version: "0.9.0",
      url: "https://plane.example/x",
      sha256: "b".repeat(64),
    });
    expect(parsed).toEqual({
      type: "update",
      version: "0.9.0",
      url: "https://plane.example/x",
      sha256: "b".repeat(64),
    });
    expect(parsed && "force" in parsed).toBe(false);
  });

  it("refuses a frame missing or mistyping any of the three required fields", () => {
    const ok = { type: "update", version: "0.9.0", url: "https://p/x", sha256: "c".repeat(64) };
    expect(parseNodeCommandBody({ ...ok, version: undefined })).toBeNull();
    expect(parseNodeCommandBody({ ...ok, url: undefined })).toBeNull();
    expect(parseNodeCommandBody({ ...ok, sha256: undefined })).toBeNull();
    // Empty strings are refused too: an empty url is not a url, and an empty
    // digest would make the verify step trivially unsatisfiable rather than
    // skipped — refuse it where it is cheap to say why.
    expect(parseNodeCommandBody({ ...ok, version: "" })).toBeNull();
    expect(parseNodeCommandBody({ ...ok, url: "" })).toBeNull();
    expect(parseNodeCommandBody({ ...ok, sha256: "" })).toBeNull();
    expect(parseNodeCommandBody({ ...ok, version: 9 })).toBeNull();
    expect(parseNodeCommandBody({ ...ok, force: "yes" })).toBeNull();
  });

  it("names every refusal the plane matches by equality", () => {
    // Same rule as NODE_RESULT_MAINTENANCE above: the route compares
    // `NodeRpcError.detail` to these exact strings to pick its 409 code, so a
    // reworded constant is a 500 naming nothing an operator can act on.
    expect(NODE_RESULT_NOT_COMPILED).toBe("not a compiled agent");
    expect(NODE_RESULT_DOWNLOAD_FAILED).toBe("download failed");
    expect(NODE_RESULT_DIGEST_MISMATCH).toBe("digest mismatch");
    expect(NODE_RESULT_VERSION_MISMATCH).toBe("installed binary reports a different version");
  });
});

describe("node-link close codes (spec 2026-09-24, ruling R12b)", () => {
  it("exports the two handshake codes by value — pinned as numbers", () => {
    // Imported by number (like link-session.test.ts does) so a silent value
    // change fails HERE, at the definition, not at whichever consumer happened
    // to compare against the constant.
    expect(NODE_CLOSE_HANDSHAKE_REQUIRED).toBe(4410);
    expect(NODE_CLOSE_REPAIR_REQUIRED).toBe(4411);
    expect(NODE_CLOSE_UPDATE_REQUIRED).toBe(4406);
    expect(NODE_CLOSE_SUPERSEDED).toBe(4409);
  });

  it("4411 is unique among every code /ws/node ever sends", () => {
    // The handler-local ones are literals because they live in the backend
    // (`node-ws-handler.ts` 4401/1009, `node-registry.ts` 4403, and 1012 is the
    // service-restart close `performRestart` puts on node sockets); 1000 is the
    // R7 register-ok close and every graceful teardown. A collision here would
    // make the agent drop its control pin on a refusal that meant something
    // else — which is the exact incident R12b exists to prevent.
    const codes = [
      1000,
      1009,
      1012,
      4401,
      4403,
      NODE_CLOSE_UPDATE_REQUIRED,
      NODE_CLOSE_SUPERSEDED,
      NODE_CLOSE_HANDSHAKE_REQUIRED,
      NODE_CLOSE_REPAIR_REQUIRED,
    ];
    expect(new Set(codes).size).toBe(codes.length);
  });
});

describe("partPathOf (the shared .part derivation, spec 2026-10-01 §4)", () => {
  it("dot-prefixes the basename beside the final path, POSIX separators only", () => {
    // The exact strings the plane's abort cleanup and the node's sweep match;
    // a rename that changes any of these strands the other two consumers.
    expect(partPathOf("/data/transfers/abc.tar.gz")).toBe("/data/transfers/.abc.tar.gz.part");
    expect(partPathOf("/x/y/.hidden")).toBe("/x/y/..hidden.part"); // dotfile keeps its dot
    expect(partPathOf("bare")).toBe(".bare.part"); // no directory part, no leading dot invented
  });
  it("is the inverse of the sweep's isStagingName shape (a .part temp of a .tar.gz)", () => {
    const final = "/data/transfers/uuid.tar.gz";
    const temp = partPathOf(final);
    const base = temp.slice(temp.lastIndexOf("/") + 1);
    expect(base.startsWith(".")).toBe(true);
    expect(base.endsWith(".tar.gz.part")).toBe(true);
  });
});
