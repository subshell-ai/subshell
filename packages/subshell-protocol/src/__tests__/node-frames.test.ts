import { describe, expect, it } from "bun:test";
import {
  HARNESS_BINARY_PLACEHOLDER,
  NODE_PROTOCOL_VERSION,
  NODE_RESULT_KILLS_PANES,
  NODE_RESULT_MAINTENANCE,
  NODE_RESULT_NO_SERVICE,
  NODE_RESULT_NOT_SUPERVISED,
  NODE_SERVICE_DESTRUCTIVE,
  NODE_SERVICE_VERBS,
  parseNodeCommandBody,
  parseNodeEvent,
  parseNodeRuntimeReport,
} from "../node-frames.js";
import { MIN_AGENT_VERSION } from "../versions.js";

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

  it("pins the protocol version", () => {
    // Matched EXACTLY: there is no compat window and no per-feature gating,
    // because the server and the agent ship together. Bump this whenever a
    // frame changes and release both sides. (2 is phase 3's bump — the
    // registry spec on `plugin_install` — and the first REAL one: the
    // numbering restarted at 1 on 2026-09-09 with no deployed instances.
    // 3 is the inversion's (spec 2026-09-10 §7): plugins left the wire —
    // `plugin_install`/`plugin_uninstall` are gone, the inventory event no
    // longer carries a plugin set, and `launch` requires `argv` + `resolve`.
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
    expect(NODE_PROTOCOL_VERSION).toBe(9);
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
    agentVersion: MIN_AGENT_VERSION,
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
