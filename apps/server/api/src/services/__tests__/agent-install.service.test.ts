import { describe, expect, it } from "bun:test";
import { AgentInstallRefused, installBuiltInAgent } from "@/services/agent-install.service.js";

function deps(command: string | undefined, timeoutMs = 5_000) {
  return { commandFor: async (_id: string) => command, timeoutMs, extraPath: async () => [] };
}

describe("installBuiltInAgent", () => {
  it("reports each line as it arrives, and still returns the whole output", async () => {
    // The progress the setup screen shows while an installer runs: without
    // this the page hears nothing until a `curl … | bash` against someone
    // else's host finishes, which is the difference between a slow install
    // and a wedged one.
    const seen: string[] = [];
    const r = await installBuiltInAgent("claude-code", deps("echo one; echo two >&2; echo three"), (l) => seen.push(l));
    expect(r.ok).toBe(true);
    expect(seen.sort()).toEqual(["one", "three", "two"]);
    // The accumulated text is unchanged — a caller that passes no sink gets
    // exactly what it always did.
    expect(r.output).toContain("one");
    expect(r.output).toContain("two");
  });

  it("strips the colour an installer writes for a terminal", async () => {
    // Hermes's installer prints `\x1b[0;36m→\x1b[0m Extracting …`. The setup
    // screen renders lines into HTML, where an escape is not colour but
    // literal `[0;36m` in front of every step - and the same text is what a
    // failed install discloses, so both halves have to be clean.
    const seen: string[] = [];
    const r = await installBuiltInAgent("claude-code", deps("printf '\\033[0;36m-> \\033[0mExtracting\\n'"), (l) =>
      seen.push(l),
    );
    expect(seen).toEqual(["-> Extracting"]);
    expect(r.output).toContain("-> Extracting");
    expect(r.output).not.toContain("\u001b");
    expect(r.output).not.toContain("[0;36m");
  });

  it("emits a final line that never got its newline", async () => {
    // An installer killed mid-sentence has usually just said the most useful
    // thing it will say; holding that back because no "\n" followed loses it.
    const seen: string[] = [];
    await installBuiltInAgent("claude-code", deps("printf 'no newline here'"), (l) => seen.push(l));
    expect(seen).toContain("no newline here");
  });

  it("does not split a line that arrives in two reads", async () => {
    // Chunks are not lines. A sink fed raw chunks would report "half" and
    // "way" as two steps of an install that only had one.
    const seen: string[] = [];
    await installBuiltInAgent("claude-code", deps("printf 'half'; sleep 0.2; printf 'way\n'"), (l) => seen.push(l));
    expect(seen).toEqual(["halfway"]);
  });

  it("runs the command and returns its words", async () => {
    const r = await installBuiltInAgent("claude-code", deps("echo installed; echo warn >&2"));
    expect(r.ok).toBe(true);
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain("installed");
    expect(r.output).toContain("warn");
  });
  it("reports a failing installer as ok:false with its exit code", async () => {
    const r = await installBuiltInAgent("claude-code", deps("echo nope >&2; exit 3"));
    expect(r.ok).toBe(false);
    expect(r.exitCode).toBe(3);
    expect(r.output).toContain("nope");
  });
  it("kills an installer that outlives the timeout", async () => {
    const r = await installBuiltInAgent("claude-code", deps("sleep 30", 300));
    expect(r.ok).toBe(false);
    expect(r.output).toContain("timed out");
  });
  it("returns on the deadline even for a pipeline, whose children hold the pipe open", async () => {
    const started = Date.now();
    const r = await installBuiltInAgent("claude-code", deps("sleep 30 | cat", 300));
    expect(r.ok).toBe(false);
    expect(r.output).toContain("timed out");
    // The point of the test: it must return on the deadline, not when the
    // orphaned `sleep` finishes 30 seconds later.
    expect(Date.now() - started).toBeLessThan(5_000);
  });
  it("refuses an id with no install command as 400", async () => {
    await expect(installBuiltInAgent("terminal", deps(""))).rejects.toBeInstanceOf(AgentInstallRefused);
    await expect(installBuiltInAgent("terminal", deps(""))).rejects.toMatchObject({ status: 400 });
  });
  it("refuses an unknown id as 400", async () => {
    await expect(installBuiltInAgent("nope", deps(undefined))).rejects.toMatchObject({ status: 400 });
  });
  it("refuses a second install of the same id while one runs, as 409", async () => {
    const first = installBuiltInAgent("codex", deps("sleep 0.5"));
    await expect(installBuiltInAgent("codex", deps("echo x"))).rejects.toMatchObject({ status: 409 });
    await first;
  });
  it("caps runaway output", async () => {
    const r = await installBuiltInAgent("pi", deps("head -c 200000 /dev/zero | tr '\\0' a"));
    expect(r.output.length).toBeLessThan(70_000);
    expect(r.output).toContain("[truncated]");
  });
  it("says it truncated even when the output lands exactly on the cap", async () => {
    // The cap is 64 KiB and a pipe hands over power-of-two sized reads, so
    // "one byte past the limit" is the rare case and "exactly at it" is the
    // common one. Writing exactly OUTPUT_CAP bytes, pausing, then writing
    // more makes that boundary deterministic on every platform: the reader
    // drains the first 65536 bytes before the rest exists, whatever the
    // chunk granularity. Counting only what is KEPT stalls at the cap, so
    // the marker never fires and 134 KB vanishes silently.
    const r = await installBuiltInAgent(
      "pi",
      deps("head -c 65536 /dev/zero | tr '\\0' a; sleep 0.2; head -c 100000 /dev/zero | tr '\\0' b"),
    );
    expect(r.output).toContain("[truncated]");
  });
  it("hands the installer an allowlist, not this process's environment", async () => {
    // Pins both halves of installerEnv's rule: a variable this process holds
    // (a stand-in for BETTER_AUTH_SECRET / the database path) must not reach
    // the child, while HOME - which a real installer legitimately needs -
    // still does. Deleting installerEnv and passing `env: process.env` would
    // leave this failing (both would print non-empty).
    process.env.SUBSHELL_TEST_SECRET_MARKER = "must-not-leak";
    try {
      const r = await installBuiltInAgent(
        "claude-code",
        deps('echo "marker=[$SUBSHELL_TEST_SECRET_MARKER]"; echo "home=[$HOME]"'),
      );
      expect(r.ok).toBe(true);
      // Excluded: a variable this process holds must not reach the child.
      expect(r.output).toContain("marker=[]");
      // Included: an installer still needs to know where to put things.
      expect(r.output).not.toContain("home=[]");
    } finally {
      delete process.env.SUBSHELL_TEST_SECRET_MARKER;
    }
  });
});
