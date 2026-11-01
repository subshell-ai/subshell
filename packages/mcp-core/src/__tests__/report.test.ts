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

  /**
   * Captures the requests a report makes: the report POST in `seen`, and the
   * self-extension that rides every verb (except `exit`) in `extended`, split
   * so the report-shape cells below keep reading exactly as written.
   */
  function recorder() {
    const seen: Request[] = [];
    const extended: Request[] = [];
    const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
      const req = new Request(String(input), init);
      if (req.url.endsWith("/extend-token")) extended.push(req);
      else seen.push(req);
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    return { seen, extended, fetchImpl };
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
    const { seen, extended, fetchImpl } = recorder();

    await runReport(["session"], {
      env: paneEnv,
      fetch: fetchImpl,
      readStdin: async () => JSON.stringify({ cwd: "/x" }),
    });

    // Nothing reported means nothing happened in the pane worth extending
    // the token for.
    expect(seen).toHaveLength(0);
    expect(extended).toHaveLength(0);
  });

  it("rides every report with a token extend, and `exit` alone with none", async () => {
    // The extend the MCP child arms at its boot: a pane whose MCP is switched
    // off launches no child, so without this its hooks would silently start
    // 401-ing once the 7-day TTL ran out under a pane in daily use.
    const reporting: Array<[string[], () => Promise<string>]> = [
      [["attention", "turn_complete"], async () => "{}"],
      [["attention", "resumed"], async () => "{}"],
      [["session"], async () => JSON.stringify({ session_id: "sess-1" })],
    ];
    for (const [argv, readStdin] of reporting) {
      const { extended, fetchImpl } = recorder();
      await runReport(argv, { env: paneEnv, fetch: fetchImpl, readStdin });
      expect(extended).toHaveLength(1);
      expect(extended[0]?.url).toBe("http://h:3080/api/subshells/sub_42/extend-token");
      expect(extended[0]?.method).toBe("POST");
      expect(extended[0]?.headers.get("authorization")).toBe("Bearer subshell_key123");
    }
    const { seen, extended, fetchImpl } = recorder();
    await runReport(["exit", "7"], { env: paneEnv, fetch: fetchImpl });
    expect(seen).toHaveLength(1); // the exit report itself still lands
    expect(extended).toHaveLength(0); // the token dies with the pane anyway
  });

  it("reports fine when the extend is refused, and a refused extend never reaches the pane", async () => {
    // Best-effort like the report itself: a dead or expired token must not
    // turn the hook's stdout into a server complaint.
    const seen: Request[] = [];
    const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
      const req = new Request(String(input), init);
      if (!req.url.endsWith("/extend-token")) seen.push(req);
      return req.url.endsWith("/extend-token")
        ? new Response("no", { status: 401 })
        : new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const consoleErrors: unknown[] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => consoleErrors.push(args);
    try {
      await runReport(["attention", "turn_complete"], { env: paneEnv, fetch: fetchImpl });
    } finally {
      console.error = origError;
    }
    expect(seen).toHaveLength(1);
    expect(consoleErrors).toHaveLength(0);
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

describe("subagent report: encoding and numeric edges (review probe F-V2-report)", () => {
  const paneEnv = {
    SUBSHELL_API_KEY: "subshell_key123",
    SUBSHELL_BASE_URL: "http://h:3080",
    SUBSHELL_ID: "sub_42",
  } as NodeJS.ProcessEnv;

  /** Captures raw bodies so the test can assert the WIRE is valid JSON, not just the parse. */
  function rawRecorder() {
    const bodies: string[] = [];
    const fetchImpl = (async (input: string | URL, init?: { body?: string | null }) => {
      // The riding extend has no body and belongs to a different cell.
      if (String(input).endsWith("/extend-token")) return new Response("{}", { status: 200 });
      bodies.push(String(init?.body));
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    return { bodies, fetchImpl };
  }

  const startWith = (fetchImpl: typeof fetch, payload: Record<string, unknown>) =>
    runReport(["subagents"], { env: paneEnv, fetch: fetchImpl, readStdin: async () => JSON.stringify(payload) });

  it("caps label fields at the route's UTF-16 maxLength without breaking the JSON wire", async () => {
    // The cap is `.slice(0, 160)` in UTF-16 units, and the report route validates
    // with TypeBox's `value.length <= maxLength`, which counts units too. So a
    // name of 161 units ships as exactly 160 and can never 400 at the boundary,
    // even when the cut lands inside a surrogate pair: JSON.stringify is
    // well-formed (ES2019) and escapes the orphan half as a \udXXX sequence,
    // which is why the body below still round-trips through JSON.parse.
    const { bodies, fetchImpl } = rawRecorder();
    const emojiName = `${"a".repeat(159)}\u{1F600}`; // 161 units: the slice splits the pair
    await startWith(fetchImpl, { hook_event_name: "SubagentStart", agent_id: "c", agent_type: emojiName });
    expect(bodies).toHaveLength(1);
    const body = JSON.parse(bodies[0] as string) as { agents: { name: string }[] };
    expect(body.agents[0]?.name.length).toBe(160);
    const tail = body.agents[0]?.name.charCodeAt(159) ?? 0;
    expect(tail >= 0xd800 && tail <= 0xdbff).toBe(true); // the cut really did split the pair
    expect((bodies[0] as string).includes("\\ud83d")).toBe(true); // escaped, so the wire stays valid JSON
    // Exactly at the cap ships untouched.
    await startWith(fetchImpl, { hook_event_name: "SubagentStart", agent_id: "c", agent_type: "b".repeat(160) });
    expect((JSON.parse(bodies[1] as string) as { agents: { name: string }[] }).agents[0]?.name).toBe("b".repeat(160));
  });

  it("escapes control bytes into the body without dropping or mangling the report", async () => {
    // ESC and BEL are not whitespace, so `trim()` leaves them and nothing else
    // filters them. They reach the body as JSON's mandatory \u00XX escapes: the
    // payload a JS server (and a JSON-aware renderer) parses back is the same
    // string, so the report survives intact and the wire stays valid.
    const { bodies, fetchImpl } = rawRecorder();
    await startWith(fetchImpl, { hook_event_name: "SubagentStart", agent_id: "c", agent_type: "x\u001b\u0007y" });
    expect(bodies).toHaveLength(1);
    const body = JSON.parse(bodies[0] as string) as { agents: { name: string }[] };
    expect(body.agents[0]?.name).toBe("x\u001b\u0007y");
  });

  it("sends nothing for a payload that is not a reportable object, silently", async () => {
    const { bodies, fetchImpl } = rawRecorder();
    // A non-object JSON document parses but has no `hook_event_name`; "" does not
    // parse at all. Every one of them ends in the outer catch: zero POSTs and an
    // undefined resolution, so the hook exits 0 and prints nothing into the pane.
    for (const raw of ["null", "[]", "5", '"str"', "true", "", "{oops"]) {
      await runReport(["subagents"], { env: paneEnv, fetch: fetchImpl, readStdin: async () => raw });
    }
    expect(bodies).toHaveLength(0);
  });

  it("refuses non-string ids and labels rather than coercing them", async () => {
    const { bodies, fetchImpl } = rawRecorder();
    // A numeric id cannot name a child the server would ever see back, so it is
    // the same absence as none; a numeric label falls to the generic name.
    await startWith(fetchImpl, { hook_event_name: "SubagentStart", agent_id: 42, agent_type: "T" });
    expect(bodies).toHaveLength(0);
    await startWith(fetchImpl, { hook_event_name: "SubagentStart", agent_id: "c", agent_type: 42 });
    expect((JSON.parse(bodies[0] as string) as { agents: { name: string }[] }).agents[0]?.name).toBe("Subagent");
    await startWith(fetchImpl, { hook_event_name: "SubagentStart", agent_id: "", agent_type: "T" });
    expect(bodies).toHaveLength(1);
    // A hermes child whose role and goal are not strings still starts, unnamed,
    // with no activity line (Infinity arrives through JSON.parse as null).
    await startWith(fetchImpl, { hook_event_name: "subagent_start", extra: { child_session_id: "h", child_role: 7 } });
    const hermesBody = (JSON.parse(bodies[1] as string) as { agents: Record<string, unknown>[] }).agents[0];
    expect(hermesBody).toEqual({ id: "h", name: "Subagent", status: "running" });
    expect(hermesBody).not.toHaveProperty("activity");
  });

  it("never coerces an exit word that is not a plain 1-3 digit status", async () => {
    // The gate is `/^\d{1,3}$/`: negatives, "NaN", "Infinity", exponents, hex,
    // non-ASCII digits, and padded digits all read as "tmux gave no status",
    // which is null, never a guessed number. (A coerced NaN would have shipped
    // as JSON null anyway; the regex refuses it before serialization instead.)
    const env = { ...paneEnv };
    for (const word of ["-1", "NaN", "Infinity", "1e3", "0x10", "١٢٣", " 7", "7 ", "+7"]) {
      const { bodies, fetchImpl } = rawRecorder();
      await runReport(["exit", word], { env, fetch: fetchImpl });
      expect(JSON.parse(bodies[0] as string)).toEqual({ exitCode: null });
    }
    // Leading zeros are a real status written oddly, not a different status.
    const { bodies, fetchImpl } = rawRecorder();
    await runReport(["exit", "007"], { env, fetch: fetchImpl });
    expect(JSON.parse(bodies[0] as string)).toEqual({ exitCode: 7 });
  });
});

describe("subagent report: frame pairing and unknown-id edges (review probe F-V2-report)", () => {
  const paneEnv = {
    SUBSHELL_API_KEY: "subshell_key123",
    SUBSHELL_BASE_URL: "http://h:3080",
    SUBSHELL_ID: "sub_42",
  } as NodeJS.ProcessEnv;

  function recorder() {
    const seen: { url: string; json: Record<string, unknown> }[] = [];
    const fetchImpl = (async (input: string | URL, init?: { body?: string }) => {
      seen.push({ url: String(input), json: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    return { seen, fetchImpl };
  }

  const feed = (fetchImpl: typeof fetch, payload: unknown) =>
    runReport(["subagents"], { env: paneEnv, fetch: fetchImpl, readStdin: async () => JSON.stringify(payload) });

  it("keeps pairing authority with PostToolUse: a PreToolUse frame never carries an agentId", async () => {
    const { seen, fetchImpl } = recorder();
    await feed(fetchImpl, {
      hook_event_name: "PreToolUse",
      tool_name: "Agent",
      tool_input: { subagent_type: "Explore", description: "Map the repo" },
      // A PreToolUse payload has no tool_response; a forged one must not leak
      // into the frame, because only the tool's own result names the child.
      tool_response: { agentId: "forged" },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.json).toEqual({ event: "describe", agentType: "Explore", activity: "Map the repo" });
    expect("agentId" in (seen[0]?.json ?? {})).toBe(false);
  });

  it("sends the exact-id describe only for a response that names the child, on both tool spellings", async () => {
    const { seen, fetchImpl } = recorder();
    const post = (toolName: string, response: unknown) =>
      feed(fetchImpl, {
        hook_event_name: "PostToolUse",
        tool_name: toolName,
        tool_input: { description: "Label" },
        tool_response: response,
      });
    await post("Agent", { agentId: "a1" });
    await post("Task", { agentId: "a2" }); // the rename's older spelling pairs the same way
    expect(seen.map((entry) => entry.json.agentId)).toEqual(["a1", "a2"]);
    // Absent, empty, non-string, over-cap, and a whole response that is not an
    // object: the frame cannot pair, so it must not queue an unpairable label.
    await post("Agent", { agentId: "" });
    await post("Agent", { agentId: 42 });
    await post("Agent", { agentId: "x".repeat(257) });
    await post("Agent", "done");
    await post("Agent", null);
    expect(seen).toHaveLength(2);
  });

  it("carries the same id through describe, start, and stop so the server pairs without guessing", async () => {
    const { seen, fetchImpl } = recorder();
    // The live sequence one spawn emits through this plugin's hook wiring:
    // PreToolUse (label, type-keyed, unpaired), PostToolUse (label + exact id),
    // SubagentStart (the child announces itself), SubagentStop. A start with a
    // non-absolute transcript path skips the metadata sidecar by contract.
    await feed(fetchImpl, {
      hook_event_name: "PreToolUse",
      tool_name: "Agent",
      tool_input: { subagent_type: "Explore", description: "Map the repo" },
    });
    await feed(fetchImpl, {
      hook_event_name: "PostToolUse",
      tool_name: "Agent",
      tool_input: { subagent_type: "Explore", description: "Map the repo" },
      tool_response: { agentId: "a1" },
    });
    await feed(fetchImpl, {
      hook_event_name: "SubagentStart",
      agent_id: "a1",
      agent_type: "Explore",
      transcript_path: "relative/path.jsonl",
    });
    await feed(fetchImpl, { hook_event_name: "SubagentStop", agent_id: "a1" });
    expect(seen.map((entry) => entry.json)).toEqual([
      { event: "describe", agentType: "Explore", activity: "Map the repo" },
      { event: "describe", agentType: "Explore", activity: "Map the repo", agentId: "a1" },
      { event: "start", agents: [{ id: "a1", name: "Explore", status: "running" }] },
      { event: "stop", agentId: "a1" },
    ]);
    // An unknown id is not this layer's business: stop reports exactly what the
    // harness named, and the server's roster filter makes an unknown id a no-op.
    await feed(fetchImpl, { hook_event_name: "SubagentStop", agent_id: "never-seen" });
    expect(seen[4]?.json).toEqual({ event: "stop", agentId: "never-seen" });
    expect(new Set(seen.map((entry) => entry.url)).size).toBe(1); // every frame: this pane's own endpoint
  });
});

describe("the parent's Stop reconciles the roster to the harness's live set", () => {
  // The regression this pins: a background child killed with TaskStop fires
  // NO lifecycle hook (measured on Claude Code 2.1.296), so a roster built
  // only from start/stop edges pinned a dead fixer as "running" for hours
  // (operator report 2026-10-20). The turn-end Stop payload is the harness's
  // own enumeration of live work, so it ships as a replace-semantics snapshot.
  const paneEnv = {
    SUBSHELL_API_KEY: "subshell_key123",
    SUBSHELL_BASE_URL: "http://h:3080",
    SUBSHELL_ID: "sub_42",
  } as NodeJS.ProcessEnv;

  function recorder() {
    const seen: { url: string; json: Record<string, unknown> }[] = [];
    const fetchImpl = (async (input: string | URL, init?: { body?: string }) => {
      seen.push({ url: String(input), json: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    return { seen, fetchImpl };
  }

  const feed = (fetchImpl: typeof fetch, payload: unknown) =>
    runReport(["subagents"], { env: paneEnv, fetch: fetchImpl, readStdin: async () => JSON.stringify(payload) });

  it("maps the turn-end enumeration to a snapshot of subagent rows only", async () => {
    const { seen, fetchImpl } = recorder();
    // Entry shapes measured live on 2.1.296: a running fixer with a spawn
    // description, a pending one that has not started, a background bash (not
    // an agent), and a junk entry. Status words beyond running/pending land on
    // `idle`, never a false `running`.
    await feed(fetchImpl, {
      hook_event_name: "Stop",
      background_tasks: [
        {
          id: "a1",
          type: "subagent",
          status: "running",
          description: "Fix the bar mark",
          agent_type: "superlite:fixer",
        },
        { id: "a2", type: "subagent", status: "pending" },
        { id: "t1", type: "bash", status: "running", command: "sleep 400" },
        null,
      ],
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe("http://h:3080/api/subshells/sub_42/subagents/report");
    expect(seen[0]?.json).toEqual({
      event: "snapshot",
      agents: [
        { id: "a1", name: "superlite:fixer", status: "running", activity: "Fix the bar mark" },
        { id: "a2", name: "Subagent", status: "waiting" },
      ],
    });
  });

  it("ships the empty snapshot that clears a stale roster when nothing is live", async () => {
    // The killed child is absent here by construction — this is the frame that
    // prunes it. Suppressing the empty set instead would keep the rail lying
    // until the next turn with live work, which may never come.
    const { seen, fetchImpl } = recorder();
    await feed(fetchImpl, { hook_event_name: "Stop", background_tasks: [] });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.json).toEqual({ event: "snapshot", agents: [] });
  });

  it("reports nothing when an older harness has no background_tasks field", async () => {
    const { seen, fetchImpl } = recorder();
    await feed(fetchImpl, { hook_event_name: "Stop", stop_hook_active: true });
    await feed(fetchImpl, { hook_event_name: "Stop", background_tasks: "not-an-array" });
    expect(seen).toHaveLength(0);
  });

  it("keeps SubagentStop an id removal: its own payload still lists the finishing child as running", async () => {
    // Measured live: the SubagentStop payload's background_tasks contains the
    // child it is announcing dead, still "running". Snapshotting from it would
    // re-add exactly what the stop removes, so SubagentStop stays an edge event.
    const { seen, fetchImpl } = recorder();
    await feed(fetchImpl, {
      hook_event_name: "SubagentStop",
      agent_id: "a1",
      background_tasks: [
        { id: "a1", type: "subagent", status: "running", description: "Wrapping up", agent_type: "reviewer" },
      ],
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.json).toEqual({ event: "stop", agentId: "a1" });
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
      fetch: (async (input: string | URL) => {
        // The riding extend is not a POST of the report's own; the gating
        // cells below count what the Stop payload earned.
        if (!String(input).endsWith("/extend-token")) calls += 1;
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
