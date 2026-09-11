import { describe, expect, it } from "bun:test";
import { AgentInstallRefused, installBuiltInAgent } from "@/services/agent-install.service.js";

function deps(command: string | undefined, timeoutMs = 5_000) {
  return { commandFor: async (_id: string) => command, timeoutMs, extraPath: async () => [] };
}

describe("installBuiltInAgent", () => {
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
});
