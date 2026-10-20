import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { postTimeoutMs, runReport } from "../report.js";

/**
 * The out-of-band reporting verb both binaries expose (`<self> report …`).
 * Harness hooks invoke it, so every case here is about it staying SILENT and
 * exit-0 shaped: a hook that throws prints into the user's session.
 */
describe("runReport", () => {
  /** A pane env complete enough for a report to be attempted. */
  const paneEnv = {
    SUBSHELL_API_KEY: "subshell_key123",
    SUBSHELL_BASE_URL: "http://h:3080",
    SUBSHELL_ID: "sub_42",
  } as NodeJS.ProcessEnv;

  /** Captures the single request a report makes. */
  function recorder() {
    const seen: Request[] = [];
    const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
      seen.push(new Request(String(input), init));
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    return { seen, fetchImpl };
  }

  it("reports child lifecycle metadata without forwarding prompts or transcripts", async () => {
    const { seen, fetchImpl } = recorder();
    for (const payload of [
      { hook_event_name: "SubagentStart", agent_id: "child", agent_type: "Explore", prompt: "private" },
      { hook_event_name: "SubagentStop", agent_id: "child", agent_transcript_path: "private" },
      {
        hook_event_name: "subagent_start",
        extra: {
          child_session_id: "hermes-child",
          child_role: "Review",
          child_goal: "Review the migration plan",
          child_summary: "private",
        },
      },
      { hook_event_name: "subagent_stop", extra: { child_session_id: "hermes-child", child_summary: "private" } },
    ])
      await runReport(["subagents"], {
        env: paneEnv,
        fetch: fetchImpl,
        readStdin: async () => JSON.stringify(payload),
      });
    expect(await Promise.all(seen.map((request) => request.json()))).toEqual([
      { event: "start", agents: [{ id: "child", name: "Explore", status: "running" }] },
      { event: "stop", agentId: "child" },
      // Hermes names its child's task in the start payload, and the goal line
      // IS the tooltip content; its stop-side summary is output text and
      // stays as private as the prompt.
      {
        event: "start",
        agents: [{ id: "hermes-child", name: "Review", status: "running", activity: "Review the migration plan" }],
      },
      { event: "stop", agentId: "hermes-child" },
    ]);
  });

  it("turns an Agent spawn's PreToolUse input into a describe report, keeping the prompt out", async () => {
    const { seen, fetchImpl } = recorder();
    const spawn = (toolInput: Record<string, unknown>, toolName = "Agent") =>
      runReport(["subagents"], {
        env: paneEnv,
        fetch: fetchImpl,
        readStdin: async () =>
          JSON.stringify({ hook_event_name: "PreToolUse", tool_name: toolName, tool_input: toolInput }),
      });
    await spawn({ subagent_type: "code-reviewer", description: "Review the migration plan", prompt: "private" });
    expect(await seen[0]?.json()).toEqual({
      event: "describe",
      agentType: "code-reviewer",
      activity: "Review the migration plan",
    });
    // No description means nothing to pair; a non-Agent tool is not a spawn.
    await spawn({ subagent_type: "code-reviewer", description: "  " });
    await spawn({ command: "ls private-thing" }, "Bash");
    expect(seen).toHaveLength(1);
    // A spawn with no declared type still carries its label under the open key.
    await spawn({ description: "Investigate the flake" });
    expect(await seen[1]?.json()).toEqual({ event: "describe", agentType: "", activity: "Investigate the flake" });
    // The rename's older spelling is the matcher's other arm, so it pairs the
    // same way.
    await spawn({ subagent_type: "scout", description: "Map the repo" }, "Task");
    expect(await seen[2]?.json()).toEqual({ event: "describe", agentType: "scout", activity: "Map the repo" });
  });

  it("reports exact background child names without forwarding output or prompts", async () => {
    const { seen, fetchImpl } = recorder();
    await runReport(["subagents"], {
      env: paneEnv,
      fetch: fetchImpl,
      readStdin: async () =>
        JSON.stringify({
          hook_event_name: "PostToolUse",
          tool_name: "Agent",
          tool_input: {
            name: "Reviewer",
            description: "Review changes",
            subagent_type: "general-purpose",
            prompt: "private",
          },
          tool_response: { agentId: "child", status: "async_launched", outputFile: "private", content: "private" },
        }),
    });
    expect(await seen[0]?.json()).toEqual({
      event: "describe",
      agentType: "general-purpose",
      agentName: "Reviewer",
      activity: "Review changes",
      agentId: "child",
    });
  });

  it("recovers a resumed Claude child's description from bounded metadata only", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claude-label-"));
    try {
      await mkdir(join(dir, "session", "subagents"), { recursive: true });
      const meta = join(dir, "session", "subagents", "agent-child.meta.json");
      const { seen, fetchImpl } = recorder();
      const run = () =>
        runReport(["subagents"], {
          env: paneEnv,
          fetch: fetchImpl,
          readStdin: async () =>
            JSON.stringify({
              hook_event_name: "SubagentStart",
              agent_id: "child",
              agent_type: "general-purpose",
              transcript_path: join(dir, "session.jsonl"),
            }),
        });
      await writeFile(
        meta,
        JSON.stringify({ description: "Report system info", prompt: "private", toolUseId: "private" }),
      );
      await run();
      expect(await seen[0]?.json()).toEqual({
        event: "start",
        agents: [{ id: "child", name: "general-purpose", status: "running", activity: "Report system info" }],
      });
      await writeFile(meta, "x".repeat(17000));
      await run();
      expect((await seen[1]?.json())?.agents[0].activity).toBeUndefined();
      await rm(meta);
      await writeFile(join(dir, "secret"), JSON.stringify({ description: "private" }));
      await symlink(join(dir, "secret"), meta);
      await run();
      expect((await seen[2]?.json())?.agents[0].activity).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("ignores tool descriptions that cannot represent live subagent summaries", async () => {
    const { seen, fetchImpl } = recorder();
    await runReport(["subagents"], {
      env: paneEnv,
      fetch: fetchImpl,
      readStdin: async () =>
        JSON.stringify({
          hook_event_name: "PreToolUse",
          agent_id: "child",
          tool_name: "Bash",
          tool_input: { description: "Sleep for 6 minutes", command: "private" },
        }),
    });
    expect(seen).toHaveLength(0);
    await runReport(["subagents"], {
      env: paneEnv,
      fetch: fetchImpl,
      readStdin: async () =>
        JSON.stringify({
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_input: { description: "Parent task", command: "private" },
        }),
    });
    expect(seen).toHaveLength(0);
  });

  it("routes the roster report to the pane's own endpoint, and handles the reset, fallback and cap edges", async () => {
    const { seen, fetchImpl } = recorder();
    // SessionStart with source "clear" (or "fork"): the children died with
    // the old conversation, so the roster is dropped rather than re-reported.
    await runReport(["subagents"], {
      env: paneEnv,
      fetch: fetchImpl,
      readStdin: async () => JSON.stringify({ hook_event_name: "SessionStart", source: "clear" }),
    });
    expect(seen).toHaveLength(1);
    await runReport(["subagents"], {
      env: paneEnv,
      fetch: fetchImpl,
      readStdin: async () => JSON.stringify({ hook_event_name: "SessionStart", source: "fork" }),
    });
    expect(seen).toHaveLength(2);
    expect(await seen[1]?.json()).toEqual({ event: "reset" });
    // An in-pane /resume is a DIFFERENT conversation on the same row, so it
    // resets too (a stale roster never re-announces itself). /compact keeps
    // ONE conversation and its live children, and startup announces nothing:
    // neither posts at all.
    await runReport(["subagents"], {
      env: paneEnv,
      fetch: fetchImpl,
      readStdin: async () => JSON.stringify({ hook_event_name: "SessionStart", source: "resume" }),
    });
    expect(seen).toHaveLength(3);
    expect(await seen[2]?.json()).toEqual({ event: "reset" });
    for (const source of ["compact", "startup"]) {
      await runReport(["subagents"], {
        env: paneEnv,
        fetch: fetchImpl,
        readStdin: async () => JSON.stringify({ hook_event_name: "SessionStart", source }),
      });
    }
    expect(seen).toHaveLength(3);
    // The endpoint is built from the pane's own env id, like every other verb:
    // a report can only ever describe its own subshell.
    expect(seen[0]?.url).toBe("http://h:3080/api/subshells/sub_42/subagents/report");
    expect(await seen[0]?.json()).toEqual({ event: "reset" });
    // A start payload with no usable type label still reports, under the
    // generic name the sidebar numbers.
    await runReport(["subagents"], {
      env: paneEnv,
      fetch: fetchImpl,
      readStdin: async () => JSON.stringify({ hook_event_name: "SubagentStart", agent_id: "x" }),
    });
    expect(await seen[3]?.json()).toEqual({
      event: "start",
      agents: [{ id: "x", name: "Subagent", status: "running" }],
    });
    // An over-long id is refused SILENTLY: no request, nothing thrown — the
    // hook stays invisible in the user's session.
    await runReport(["subagents"], {
      env: paneEnv,
      fetch: fetchImpl,
      readStdin: async () =>
        JSON.stringify({ hook_event_name: "SubagentStart", agent_id: "x".repeat(257), agent_type: "A" }),
    });
    expect(seen).toHaveLength(4);
  });

  it("posts the attention kind to the subshell's own attention endpoint", async () => {
    const { seen, fetchImpl } = recorder();

    await runReport(["attention", "turn_complete"], {
      env: paneEnv,
      fetch: fetchImpl,
      readStdin: async () => "",
    });

    expect(seen).toHaveLength(1);
    const req = seen[0] as Request;
    expect(req.url).toBe("http://h:3080/api/subshells/sub_42/attention");
    expect(req.method).toBe("POST");
    expect(req.headers.get("authorization")).toBe("Bearer subshell_key123");
    expect(await req.json()).toEqual({ kind: "turn_complete" });
  });

  it("gives `resumed` the short POST budget and every other report the full one", () => {
    // PreToolUse runs the resumed report before EVERY tool call: a 2 s stall
    // per call during a plane brownout is the failure this budget exists to
    // avoid. A lost clear self-heals on the next prompt or tool. Pinned on
    // the pure decision — Bun's AbortSignal.timeout exposes no `.timeout`
    // to read back off the wire.
    expect(postTimeoutMs(["attention", "resumed"])).toBe(750);
    expect(postTimeoutMs(["attention", "needs_attention"])).toBe(2000);
    expect(postTimeoutMs(["attention", "turn_complete"])).toBe(2000);
    expect(postTimeoutMs(["session"])).toBe(2000);
    expect(postTimeoutMs(["exit", "0"])).toBe(2000);
  });

  it("posts `resumed` without reading stdin", async () => {
    // The UserPromptSubmit / PreToolUse payloads carry the user's prompt text
    // and full tool input — nothing of them may be read, waited on, or sent.
    // The POST is the whole report.
    const { seen, fetchImpl } = recorder();
    let stdinRead = false;

    await runReport(["attention", "resumed"], {
      env: paneEnv,
      fetch: fetchImpl,
      readStdin: async () => {
        stdinRead = true;
        return "{}";
      },
    });

    expect(seen).toHaveLength(1);
    expect(await (seen[0] as Request).json()).toEqual({ kind: "resumed" });
    expect(stdinRead).toBe(false);
  });

  it("forwards ONLY session_id from the SessionStart payload on stdin", async () => {
    const { seen, fetchImpl } = recorder();
    const payload = JSON.stringify({
      session_id: "sess-abc",
      transcript_path: "/home/u/.claude/projects/x/sess-abc.jsonl",
      cwd: "/home/u/secret-project",
      source: "clear",
    });

    await runReport(["session"], { env: paneEnv, fetch: fetchImpl, readStdin: async () => payload });

    expect(seen).toHaveLength(1);
    const req = seen[0] as Request;
    expect(req.url).toBe("http://h:3080/api/subshells/sub_42/harness-session");
    expect(await req.json()).toEqual({ sessionId: "sess-abc" });
  });

  it("sends nothing when the SessionStart payload carries no session_id", async () => {
    const { seen, fetchImpl } = recorder();

    await runReport(["session"], {
      env: paneEnv,
      fetch: fetchImpl,
      readStdin: async () => JSON.stringify({ cwd: "/x" }),
    });

    expect(seen).toHaveLength(0);
  });

  it("swallows a failing transport rather than throwing into the hook", async () => {
    const failing = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;

    expect(
      await runReport(["attention", "turn_complete"], {
        env: paneEnv,
        fetch: failing,
        readStdin: async () => "",
      }),
    ).toBeUndefined();
  });

  it("swallows unparseable stdin rather than throwing into the hook", async () => {
    const { seen, fetchImpl } = recorder();

    await runReport(["session"], { env: paneEnv, fetch: fetchImpl, readStdin: async () => "not json at all" });

    expect(seen).toHaveLength(0);
  });

  it("sends nothing when the pane env is incomplete", async () => {
    const { seen, fetchImpl } = recorder();

    await runReport(["attention", "turn_complete"], {
      env: { SUBSHELL_ID: "sub_42" } as NodeJS.ProcessEnv,
      fetch: fetchImpl,
    });

    expect(seen).toHaveLength(0);
  });

  it("sends nothing for an unknown verb, or an attention with no kind", async () => {
    const { seen, fetchImpl } = recorder();

    await runReport(["nonsense"], { env: paneEnv, fetch: fetchImpl });
    await runReport(["attention"], { env: paneEnv, fetch: fetchImpl });
    await runReport(["attention", "made_up_kind"], { env: paneEnv, fetch: fetchImpl });
    await runReport([], { env: paneEnv, fetch: fetchImpl });

    expect(seen).toHaveLength(0);
  });
});

describe("report exit — the pane's own death (spec 2026-09-19 §4.3)", () => {
  const env = {
    SUBSHELL_API_KEY: "subshell_k",
    SUBSHELL_BASE_URL: "http://localhost:3080",
    SUBSHELL_ID: "s1",
  } as NodeJS.ProcessEnv;

  it("posts the status tmux gave it to the subshell's own exit route", async () => {
    const calls: { url: string; body: unknown }[] = [];
    await runReport(["exit", "7"], {
      env,
      fetch: (async (url: string, init: { body: string }) => {
        calls.push({ url, body: JSON.parse(init.body) });
        return new Response("{}", { status: 200 });
      }) as never,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://localhost:3080/api/subshells/s1/exit");
    expect(calls[0]?.body).toEqual({ exitCode: 7 });
  });

  it("keeps a clean exit as 0 rather than losing it", async () => {
    let body: unknown;
    await runReport(["exit", "0"], {
      env,
      fetch: (async (_u: string, init: { body: string }) => {
        body = JSON.parse(init.body);
        return new Response("{}", { status: 200 });
      }) as never,
    });
    expect(body).toEqual({ exitCode: 0 });
  });

  /**
   * tmux leaves `#{pane_dead_status}` EMPTY when it has none to give, and the
   * hook interpolates that as an empty word. Coercing it would turn "could not
   * be read" into "exited cleanly" — 0 is a real answer.
   */
  it("reports null when tmux gave no status, never 0", async () => {
    for (const argv of [["exit"], ["exit", ""], ["exit", "not-a-number"]]) {
      let body: unknown;
      await runReport(argv, {
        env,
        fetch: (async (_u: string, init: { body: string }) => {
          body = JSON.parse(init.body);
          return new Response("{}", { status: 200 });
        }) as never,
      });
      expect(body).toEqual({ exitCode: null });
    }
  });

  it("does nothing at all outside a pane, like every other report verb", async () => {
    let called = false;
    await runReport(["exit", "7"], {
      env: {},
      fetch: (async () => {
        called = true;
        return new Response("{}", { status: 200 });
      }) as never,
    });
    expect(called).toBe(false);
  });
});

describe("turn_complete gating on the Stop payload (spec 2026-09-23)", () => {
  const paneEnv = {
    SUBSHELL_API_KEY: "subshell_key123",
    SUBSHELL_BASE_URL: "http://h:3080",
    SUBSHELL_ID: "sub_42",
  } as NodeJS.ProcessEnv;

  /** Runs one report and returns how many POSTs it made. */
  async function posts(argv: string[], stdin: () => Promise<string>): Promise<number> {
    let calls = 0;
    await runReport(argv, {
      env: paneEnv,
      readStdin: stdin,
      fetch: (async () => {
        calls += 1;
        return new Response("{}", { status: 200 });
      }) as never,
    });
    return calls;
  }

  it("reports nothing when the Stop payload names running background work", async () => {
    expect(
      await posts(["attention", "turn_complete"], async () =>
        JSON.stringify({ background_tasks: [{ id: "t1", type: "subagent", status: "running" }] }),
      ),
    ).toBe(0);
  });

  it("reports nothing when a scheduled cron will wake the session", async () => {
    expect(
      await posts(["attention", "turn_complete"], async () =>
        JSON.stringify({ background_tasks: [], session_crons: [{ id: "c1" }] }),
      ),
    ).toBe(0);
  });

  it("reports when both arrays are present and empty (reachable-and-done)", async () => {
    expect(
      await posts(["attention", "turn_complete"], async () =>
        JSON.stringify({ background_tasks: [], session_crons: [] }),
      ),
    ).toBe(1);
  });

  it("reports when the payload predates the fields (older Claude Code)", async () => {
    expect(await posts(["attention", "turn_complete"], async () => JSON.stringify({ session_id: "x" }))).toBe(1);
  });

  it("fails toward the push on empty, malformed, and wrong-typed stdin", async () => {
    for (const raw of ["", "not json at all", JSON.stringify({ background_tasks: {} })]) {
      expect(await posts(["attention", "turn_complete"], async () => raw)).toBe(1);
    }
  });

  it("needs_attention never reads stdin, even one naming a park", async () => {
    expect(
      await posts(["attention", "needs_attention"], async () => {
        throw new Error("stdin must not be read for needs_attention");
      }),
    ).toBe(1);
  });
});
