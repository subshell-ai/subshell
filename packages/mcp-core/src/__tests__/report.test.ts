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

    await runReport(["attention", "turn_complete"], { env: paneEnv, fetch: fetchImpl });

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

    expect(await runReport(["attention", "turn_complete"], { env: paneEnv, fetch: failing })).toBeUndefined();
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
