import { describe, expect, it } from "bun:test";
import { NODE_PROTOCOL_VERSION, parseNodeCommandBody } from "../node-frames.js";
import { parseNodeSshAliasList, parseNodeSshResolveOutcome } from "../node-results.js";
import {
  isSshErrorCode,
  NODE_RESULT_SSH_GENERATION_STALE,
  SSH_ERROR_CODES,
  SSH_ERROR_DESCRIPTIONS,
} from "../ssh-errors.js";
import { parseSshNodeCommandBody, SSH_COMMAND_TYPES } from "../ssh-frames.js";
import { SSH_MAX_PROXY_HOPS, SSH_PROBE_DEADLINE_MS } from "../ssh-limits.js";
import {
  makeAliasList,
  makeDiscoverAliases,
  makeResolveConfig,
  makeResolveOk,
  makeResolveRefused,
  makeSnapshot,
} from "./fixtures/ssh-fixtures.js";

/**
 * The wire census for the surviving SSH reads (design 2026-10-05 §7).
 * `parseNodeCommandBody` is the only door: every accepted arm must survive
 * delegation byte-for-fact, every malformed arm must be refused BEFORE
 * dispatch, and the retired destination-execution `type` strings must no
 * longer parse at all - a peer still sending them is answered like any
 * unknown command, never dispatched.
 */
describe("ssh commands via parseNodeCommandBody (delegation)", () => {
  it("the family has exactly the two surviving types", () => {
    expect([...SSH_COMMAND_TYPES]).toEqual(["ssh_discover_aliases", "ssh_resolve_config"]);
  });

  it("each fixture command round-trips through the delegating parser unchanged", () => {
    for (const cmd of [makeDiscoverAliases(), makeResolveConfig()]) {
      expect(parseNodeCommandBody(structuredClone(cmd))).toEqual(cmd);
    }
  });

  it("the SSH reads shipped under protocol 16 and the 17 bump belongs to the session family", () => {
    // The session-runtime slice (design 2026-10-05) took 17 for
    // ssh_session_open/send/close + session_frame. The two SSH reads'
    // grammar is unchanged by that bump, and the retirement pruned the
    // unreleased 16 arms without touching the number.
    expect(NODE_PROTOCOL_VERSION).toBe(17);
  });

  it("retired destination-execution types no longer parse (the wire has no such door)", () => {
    const withSnapshot = { ...makeSnapshot() };
    expect(parseNodeCommandBody({ type: "ssh_test_connection", snapshot: withSnapshot })).toBeNull();
    expect(parseNodeCommandBody({ type: "ssh_run_start", runId: "r" })).toBeNull();
    expect(parseNodeCommandBody({ type: "ssh_run_status", runId: "r" })).toBeNull();
    expect(parseNodeCommandBody({ type: "ssh_run_read", runId: "r" })).toBeNull();
    expect(parseNodeCommandBody({ type: "ssh_run_cancel", runId: "r" })).toBeNull();
    expect(parseNodeCommandBody({ type: "ssh_terminal_launch", subshellId: "s", socket: "x" })).toBeNull();
    expect(
      parseNodeCommandBody({ type: "ssh_input_control", subshellId: "s", mode: "human", generation: 2 }),
    ).toBeNull();
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
    expect(parseNodeSshResolveOutcome({ accepted: false, code: "quota_runs", settings: [] })).toBeNull();
    expect(parseNodeSshResolveOutcome({ accepted: false, code: "unsupported_setting", settings: "why" })).toBeNull();
  });
});

describe("the surviving limits", () => {
  it("the probe deadline and chain cap keep their numbers", () => {
    expect(SSH_PROBE_DEADLINE_MS).toBe(30 * 1000);
    expect(SSH_MAX_PROXY_HOPS).toBe(4); // the chain cap the snapshot enforces
  });
});

describe("the frozen error set", () => {
  it("covers the surviving surfaces and every description exists for every code", () => {
    for (const code of [
      "unsupported_setting",
      "host_key_unknown",
      "host_key_changed",
      "key_unavailable",
      "auth_mode_unsupported",
      "config_ambiguous",
      "stale_command",
      "run_conflict",
      "run_unknown",
      "connection_failed",
      "runtime_missing",
      "session_quota",
      "session_protocol",
    ] as const) {
      expect((SSH_ERROR_CODES as readonly string[]).includes(code)).toBe(true);
    }
    // The destination product's quota/storage refusals deleted with it; the
    // set is frozen only for what the surviving surfaces can still answer.
    expect(isSshErrorCode("quota_runs")).toBe(false);
    expect(isSshErrorCode("quota_terminals")).toBe(false);
    expect(isSshErrorCode("storage_full")).toBe(false);
    for (const code of SSH_ERROR_CODES) {
      expect(SSH_ERROR_DESCRIPTIONS[code].length).toBeGreaterThan(10);
      expect(isSshErrorCode(code)).toBe(true);
    }
    expect(isSshErrorCode("quota_prompts")).toBe(false);
    expect(isSshErrorCode(undefined)).toBe(false);
  });
});
