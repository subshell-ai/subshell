import { describe, expect, it } from "bun:test";
import { NODE_PROTOCOL_VERSION, parseNodeCommandBody } from "../node-frames.js";
import {
  parseNodeSshAliasList,
  parseNodeSshControlResult,
  parseNodeSshResolveOutcome,
  parseNodeSshRunFacts,
  parseNodeSshRunReadResult,
  parseNodeSshTestOutcome,
} from "../node-results.js";
import { isSshErrorCode, SSH_ERROR_CODES, SSH_ERROR_DESCRIPTIONS } from "../ssh-errors.js";
import { parseSshNodeCommandBody, SSH_COMMAND_TYPES } from "../ssh-frames.js";
import {
  SSH_ACTIVE_RUNS_PER_NODE,
  SSH_ACTIVE_RUNS_PER_OWNER_PER_NODE,
  SSH_AGGREGATE_OUTPUT_STORAGE_BYTES,
  SSH_COMMAND_MAX_CHARS,
  SSH_COMPLETED_RUN_RETENTION_DAYS,
  SSH_MAX_PROXY_HOPS,
  SSH_OUTPUT_WINDOW_MAX_BYTES,
  SSH_PROBE_DEADLINE_MS,
  SSH_READ_LONG_POLL_MAX_MS,
  SSH_RUN_DEADLINE_DEFAULT_MS,
  SSH_RUN_DEADLINE_MAX_MS,
  SSH_RUN_OUTPUT_RETENTION_BYTES,
  SSH_TERMINALS_PER_OWNER_PER_NODE,
} from "../ssh-limits.js";
import { NODE_RESULT_SSH_GENERATION_STALE, SSH_CONTROL_MODES, SSH_RUN_LIFECYCLES } from "../ssh-run-facts.js";
import {
  makeAliasList,
  makeControlResult,
  makeDiscoverAliases,
  makeInputControl,
  makeResolveConfig,
  makeResolveOk,
  makeResolveRefused,
  makeRunCancel,
  makeRunFacts,
  makeRunFactsAccepted,
  makeRunFactsAmbiguous255,
  makeRunFactsCancelled,
  makeRunFactsDeadlineHit,
  makeRunRead,
  makeRunReadResult,
  makeRunReadResultWithData,
  makeRunStart,
  makeRunStartAtLimits,
  makeRunStartMinimum,
  makeRunStatus,
  makeSnapshot,
  makeTerminalLaunch,
  makeTestConnection,
  makeTestFailed,
  makeTestPassed,
} from "./fixtures/ssh-fixtures.js";

/**
 * The Gate A wire census for the SSH family. `parseNodeCommandBody` is the
 * only door: every accepted arm must survive delegation byte-for-fact, and
 * every malformed arm must be refused BEFORE dispatch, which is the posture
 * the transfer family was pinned with in node-frames.test.ts.
 */
describe("ssh commands via parseNodeCommandBody (delegation)", () => {
  it("the family has exactly the frozen nine types", () => {
    expect([...SSH_COMMAND_TYPES]).toEqual([
      "ssh_discover_aliases",
      "ssh_resolve_config",
      "ssh_test_connection",
      "ssh_run_start",
      "ssh_run_status",
      "ssh_run_read",
      "ssh_run_cancel",
      "ssh_terminal_launch",
      "ssh_input_control",
    ]);
  });

  it("each fixture command round-trips through the delegating parser unchanged", () => {
    for (const cmd of [
      makeDiscoverAliases(),
      makeResolveConfig(),
      makeTestConnection(),
      makeRunStart(),
      makeRunStartAtLimits(),
      makeRunStartMinimum(),
      makeRunStatus(),
      makeRunCancel(),
      makeRunRead(),
      makeTerminalLaunch(),
      makeInputControl(),
    ]) {
      expect(parseNodeCommandBody(structuredClone(cmd))).toEqual(cmd);
    }
  });

  it("the SSH family's commands shipped under protocol 16 and the 17 bump belongs to the session family", () => {
    // The old Gate A note deferred the version bump to the integration; the
    // session-runtime slice (design 2026-10-05) IS that integration and it
    // took 17 for ssh_session_open/send/close + session_frame. The nine SSH
    // commands' grammar is unchanged by that bump.
    expect(NODE_PROTOCOL_VERSION).toBe(17);
  });

  it("a snapshot with any forbidden member set is refused inside every carrier command", () => {
    const bad = { ...makeSnapshot(), proxyCommand: "nc evil 1" } as unknown as ReturnType<typeof makeSnapshot>;
    expect(parseNodeCommandBody(makeTestConnection({ snapshot: bad }))).toBeNull();
    expect(parseNodeCommandBody(makeRunStart({ snapshot: bad }))).toBeNull();
    expect(parseNodeCommandBody(makeTerminalLaunch({ snapshot: bad }))).toBeNull();
  });

  it("run_start refuses: bad digest, over-cap deadline/command, relative remoteDir, missing keys", () => {
    expect(parseNodeCommandBody(makeRunStart({ requestDigest: "zz".repeat(32) }))).toBeNull();
    expect(parseNodeCommandBody({ ...makeRunStart(), requestDigest: undefined })).toBeNull();
    expect(parseNodeCommandBody(makeRunStart({ deadlineMs: SSH_RUN_DEADLINE_MAX_MS + 1 }))).toBeNull();
    expect(parseNodeCommandBody(makeRunStart({ deadlineMs: 0 }))).toBeNull();
    expect(parseNodeCommandBody(makeRunStart({ command: "x".repeat(SSH_COMMAND_MAX_CHARS + 1) }))).toBeNull();
    expect(parseNodeCommandBody(makeRunStart({ command: "" }))).toBeNull();
    expect(parseNodeCommandBody(makeRunStart({ remoteDir: "srv/app" }))).toBeNull();
    const noDir = structuredClone(makeRunStart()) as unknown as Record<string, unknown>;
    delete noDir.remoteDir;
    expect(parseNodeCommandBody(noDir)).toBeNull(); // remoteDir is REQUIRED-null, never absent
  });

  it("run_read refuses: window over cap, negative offsets, wait past the long-poll cap", () => {
    expect(parseNodeCommandBody(makeRunRead({ maxBytes: SSH_OUTPUT_WINDOW_MAX_BYTES + 1 }))).toBeNull();
    expect(parseNodeCommandBody(makeRunRead({ maxBytes: 0 }))).toBeNull();
    expect(parseNodeCommandBody(makeRunRead({ stdoutFromByte: -1 }))).toBeNull();
    expect(parseNodeCommandBody(makeRunRead({ waitMs: SSH_READ_LONG_POLL_MAX_MS + 1 }))).toBeNull();
    expect(parseNodeCommandBody(makeRunRead({ waitMs: 0 }))).not.toBeNull(); // 0 ms means "no waiting", legal
  });

  it("input_control refuses unknown modes and sub-1 generations", () => {
    expect(parseNodeCommandBody(makeInputControl({ mode: "root" as "human" }))).toBeNull();
    expect(parseNodeCommandBody(makeInputControl({ generation: 0 }))).toBeNull();
    expect(parseNodeCommandBody(makeInputControl({ generation: 1.5 }))).toBeNull();
  });

  it("terminal_launch: cols/rows optional-positive, subshellId/socket required", () => {
    const noGrid = structuredClone(makeTerminalLaunch()) as unknown as Record<string, unknown>;
    delete noGrid.cols;
    delete noGrid.rows;
    expect(parseNodeCommandBody(noGrid)).not.toBeNull();
    expect(parseNodeCommandBody(makeTerminalLaunch({ cols: 0 }))).toBeNull();
    expect(parseNodeCommandBody(makeTerminalLaunch({ rows: -3 }))).toBeNull();
    const noSocket = structuredClone(makeTerminalLaunch()) as unknown as Record<string, unknown>;
    delete noSocket.socket;
    expect(parseNodeCommandBody(noSocket)).toBeNull();
  });

  it("resolve_config refuses option-like and empty aliases at the grammar", () => {
    expect(parseNodeCommandBody(makeResolveConfig({ alias: "-oProxyCommand=pwn" }))).toBeNull();
    expect(parseNodeCommandBody(makeResolveConfig({ alias: "" }))).toBeNull();
    expect(parseNodeCommandBody(makeResolveConfig({ alias: "app 02" }))).toBeNull();
  });

  it("an unknown ssh_* type falls through to null (dispatch never sees it)", () => {
    expect(parseNodeCommandBody({ type: "ssh_run_resurrect", runId: "r" })).toBeNull();
    expect(parseSshNodeCommandBody({ type: "ssh_run_resurrect" })).toBeNull();
  });
});

describe("input generation fence on the existing writers", () => {
  it("input accepts an optional positive-int inputGeneration and refuses nonsense", () => {
    const base = { type: "input", subshellId: "s", data: "ls\n" } as const;
    expect(parseNodeCommandBody(base)).toEqual(base);
    expect(parseNodeCommandBody({ ...base, inputGeneration: 7 })).toEqual({ ...base, inputGeneration: 7 });
    expect(parseNodeCommandBody({ ...base, inputGeneration: 0 })).toBeNull();
    expect(parseNodeCommandBody({ ...base, inputGeneration: "7" })).toBeNull();
    expect(parseNodeCommandBody({ ...base, inputGeneration: undefined })).toBeNull();
  });

  it("prompt_deliver carries the same optional fence", () => {
    const base = { type: "prompt_deliver", subshellId: "s", text: "t", settleTimeoutMs: 1000, pollMs: 50 } as const;
    expect(parseNodeCommandBody({ ...base, inputGeneration: 3 })).toEqual({ ...base, inputGeneration: 3 });
    expect(parseNodeCommandBody({ ...base, inputGeneration: -2 })).toBeNull();
  });

  it("the stale-generation refusal is the bare equality constant", () => {
    expect(NODE_RESULT_SSH_GENERATION_STALE).toBe("stale input generation");
  });
});

describe("ssh result validators", () => {
  it("facts: accepted, completed, cancelled, deadline-hit and the 255-ambiguous case all parse", () => {
    for (const facts of [
      makeRunFactsAccepted(),
      makeRunFacts(),
      makeRunFactsCancelled(),
      makeRunFactsDeadlineHit(),
      makeRunFactsAmbiguous255(),
    ]) {
      expect(parseNodeSshRunFacts(structuredClone(facts))).toEqual(facts);
    }
  });

  it("facts: lifecycle and the two-exit-code honesty fields are required and checked", () => {
    expect(parseNodeSshRunFacts({ ...makeRunFacts(), lifecycle: "failed" })).toBeNull();
    expect(parseNodeSshRunFacts({ ...makeRunFacts(), remoteStatus: "0" })).toBeNull();
    expect(parseNodeSshRunFacts({ ...makeRunFacts(), remoteStatusConfirmed: undefined })).toBeNull();
    expect(parseNodeSshRunFacts({ ...makeRunFacts(), localExitSignal: 15 })).toBeNull();
  });

  it("facts: the unknown lifecycle may carry ONLY the ambiguous 255", () => {
    // The fixture truth, now enforced in the shared grammar: `unknown` with
    // the 255 is the OpenSSH transport/remote ambiguity stated honestly
    // (man.openbsd.org/ssh#EXIT_STATUS), but any other non-null status would
    // be an observation that settles the question - such an answer cannot
    // hide under `unknown` and the reader refuses it.
    expect(parseNodeSshRunFacts(makeRunFactsAmbiguous255())).toEqual(makeRunFactsAmbiguous255());
    expect(parseNodeSshRunFacts({ ...makeRunFacts(), lifecycle: "unknown", remoteStatus: null })).not.toBeNull();
    expect(parseNodeSshRunFacts({ ...makeRunFacts(), lifecycle: "unknown", remoteStatus: 0 })).toBeNull();
    expect(parseNodeSshRunFacts({ ...makeRunFacts(), lifecycle: "unknown", remoteStatus: 1 })).toBeNull();
    expect(parseNodeSshRunFacts({ ...makeRunFacts(), lifecycle: "running", remoteStatus: null })).not.toBeNull(); // the null-status states are untouched by the cross-check
  });

  it("SSH_RUN_LIFECYCLES is exactly the four frozen states; modes exactly two", () => {
    expect([...SSH_RUN_LIFECYCLES]).toEqual(["accepted", "running", "completed", "unknown"]);
    expect([...SSH_CONTROL_MODES]).toEqual(["agent", "human"]);
  });

  it("read: empty and data-carrying windows parse; the fixture base64 decodes to what it claims", () => {
    expect(parseNodeSshRunReadResult(makeRunReadResult())).toEqual(makeRunReadResult());
    const withData = parseNodeSshRunReadResult(makeRunReadResultWithData());
    expect(withData).not.toBeNull();
    expect(Buffer.from(withData!.stdoutB64, "base64").toString("utf8")).toBe("hi\n");
    expect(Buffer.from(withData!.stderrB64, "base64").toString("utf8")).toBe("oh\n");
  });

  it("read: bad base64, negative totals, and a combined window past the cap are refused", () => {
    expect(parseNodeSshRunReadResult({ ...makeRunReadResult(), stdoutB64: "!!!" })).toBeNull();
    expect(parseNodeSshRunReadResult({ ...makeRunReadResult(), stderrTotal: -1 })).toBeNull();
    // 200 KiB raw each side is 400 KiB combined: over the 256 KiB window even
    // though each string is individually legal base64.
    const big = Buffer.alloc(200 * 1024, 0x61).toString("base64");
    expect(parseNodeSshRunReadResult({ ...makeRunReadResult(), stdoutB64: big, stderrB64: big })).toBeNull();
    // 192 KiB + 60 KiB is inside the cap: a legal window near the boundary.
    const a = Buffer.alloc(192 * 1024, 0x61).toString("base64");
    const b = Buffer.alloc(60 * 1024, 0x62).toString("base64");
    expect(parseNodeSshRunReadResult({ ...makeRunReadResult(), stdoutB64: a, stderrB64: b })).not.toBeNull();
  });

  it("alias list: cap enforced, flags required, garbage refused", () => {
    expect(parseNodeSshAliasList(makeAliasList())).toEqual(makeAliasList());
    expect(parseNodeSshAliasList({ aliases: ["a", 7], includeCycle: false, truncated: false })).toBeNull();
    expect(parseNodeSshAliasList({ aliases: ["a"], truncated: false })).toBeNull();
  });

  it("resolve: the accepted arm revalidates the snapshot; the refusal arm requires a code and settings list", () => {
    expect(parseNodeSshResolveOutcome(makeResolveOk())).toEqual(makeResolveOk());
    expect(parseNodeSshResolveOutcome(makeResolveRefused())).toEqual(makeResolveRefused());
    expect(
      parseNodeSshResolveOutcome({ accepted: true, snapshot: { ...makeSnapshot(), forwards: "LocalForward 1 2" } }),
    ).toBeNull();
    expect(parseNodeSshResolveOutcome({ accepted: false, code: "nope", settings: [] })).toBeNull();
    expect(parseNodeSshResolveOutcome({ accepted: false, code: "quota_runs", settings: "why" })).toBeNull();
  });

  it("test: passed needs nothing, failed MUST name a code", () => {
    expect(parseNodeSshTestOutcome(makeTestPassed())).toEqual(makeTestPassed());
    expect(parseNodeSshTestOutcome(makeTestFailed())).toEqual(makeTestFailed());
    expect(parseNodeSshTestOutcome({ passed: false })).toBeNull();
  });

  it("control result: mode and generation are checked", () => {
    expect(parseNodeSshControlResult(makeControlResult())).toEqual(makeControlResult());
    expect(parseNodeSshControlResult({ ...makeControlResult(), generation: 0 })).toBeNull();
    expect(parseNodeSshControlResult({ ...makeControlResult(), mode: "admin" })).toBeNull();
  });
});

describe("the spec limits table is pinned", () => {
  it("every row of SSH-SUPPORT.md §3 has its number", () => {
    expect(SSH_RUN_DEADLINE_DEFAULT_MS).toBe(5 * 60 * 1000);
    expect(SSH_RUN_DEADLINE_MAX_MS).toBe(60 * 60 * 1000);
    expect(SSH_ACTIVE_RUNS_PER_OWNER_PER_NODE).toBe(4);
    expect(SSH_ACTIVE_RUNS_PER_NODE).toBe(16);
    expect(SSH_TERMINALS_PER_OWNER_PER_NODE).toBe(4);
    expect(SSH_RUN_OUTPUT_RETENTION_BYTES).toBe(10 * 1024 * 1024);
    expect(SSH_AGGREGATE_OUTPUT_STORAGE_BYTES).toBe(1024 * 1024 * 1024);
    expect(SSH_COMPLETED_RUN_RETENTION_DAYS).toBe(7);
    expect(SSH_OUTPUT_WINDOW_MAX_BYTES).toBe(256 * 1024);
    expect(SSH_READ_LONG_POLL_MAX_MS).toBe(30 * 1000);
    expect(SSH_PROBE_DEADLINE_MS).toBe(30 * 1000);
  });

  it("derived bounds agree with what the parsers actually enforce", () => {
    expect(SSH_MAX_PROXY_HOPS).toBeGreaterThan(0); // the chain cap the snapshot enforces
    expect(SSH_COMMAND_MAX_CHARS).toBe(20_000); // same refusal line as pane exec
  });
});

describe("the frozen error set", () => {
  it("contains the brief-named codes and every description exists for every code", () => {
    for (const code of [
      "unsupported_setting",
      "host_key_unknown",
      "host_key_changed",
      "key_unavailable",
      "auth_mode_unsupported",
      "quota_runs",
      "quota_terminals",
      "storage_full",
      "config_ambiguous",
      "stale_command",
    ] as const) {
      expect((SSH_ERROR_CODES as readonly string[]).includes(code)).toBe(true);
    }
    for (const code of SSH_ERROR_CODES) {
      expect(SSH_ERROR_DESCRIPTIONS[code].length).toBeGreaterThan(10);
      expect(isSshErrorCode(code)).toBe(true);
    }
    expect(isSshErrorCode("quota_prompts")).toBe(false);
    expect(isSshErrorCode(undefined)).toBe(false);
  });
});
