import { describe, expect, it } from "bun:test";
import { runReport } from "../report.js";

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
