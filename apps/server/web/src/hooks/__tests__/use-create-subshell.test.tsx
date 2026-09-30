import { afterEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render } from "@testing-library/react";
import { type CreateSubshellInput, useCreateSubshell } from "@/hooks/use-create-subshell";

/**
 * The save-as-preset sequence in the launch mutation (review round 3):
 * the new row must be a FAITHFUL copy of what the launch is about to run
 * (the picked preset's settings ride into it; the cross-comm opt-in never
 * does), the launch must come FROM the new row, the working directory must
 * go trimmed like the editor's payload, and a launch that fails must not
 * leave the just-created row orphaned - invisible until refresh and
 * poisonous to the retry via the unique-name index.
 */

type Call = { method: string; url: string; body?: Record<string, unknown> };

const SOURCE_ROW = {
  id: "p-src",
  name: "Src",
  harnessId: "claude-code",
  description: null,
  envJson: '{"ANTHROPIC_MODEL":"sonnet"}',
  flagsJson: '["--effort"]',
  settingsJson: null,
  configIsolation: 0,
  restartOnExit: 1,
  crossCommEnabled: 1,
  nodeId: null,
  workingDir: null,
  promptBlocks: null,
  createdAt: "t",
  updatedAt: "t",
};

function mockFetch(opts: { failLaunch?: boolean } = {}) {
  const calls: Call[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((input: unknown, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const method = init?.method ?? "GET";
    calls.push({
      method,
      url: url.pathname,
      body: init?.body ? (JSON.parse(String(init.body)) as Call["body"]) : undefined,
    });
    if (url.pathname === "/api/presets" && method === "GET") {
      return Promise.resolve(new Response(JSON.stringify([SOURCE_ROW])));
    }
    if (url.pathname === "/api/presets" && method === "POST") {
      return Promise.resolve(new Response(JSON.stringify({ id: "p-new" })));
    }
    if (url.pathname === "/api/subshells" && method === "POST") {
      return opts.failLaunch
        ? Promise.resolve(new Response(JSON.stringify({ message: "node offline" }), { status: 409 }))
        : Promise.resolve(new Response(JSON.stringify({ id: "s-1", promptDelivered: true })));
    }
    if (url.pathname === "/api/presets/p-new" && method === "DELETE") {
      return Promise.resolve(new Response(JSON.stringify({ ok: true })));
    }
    return Promise.resolve(new Response(JSON.stringify({})));
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}

async function launch(input: CreateSubshellInput): Promise<{ err?: unknown; ok?: boolean }> {
  let create: ((i: CreateSubshellInput) => Promise<unknown>) | null = null;
  function Probe() {
    const m = useCreateSubshell();
    create = (i) => m.mutateAsync(i);
    return null;
  }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <Probe />
    </QueryClientProvider>,
  );
  if (create === null) throw new Error("the probe never mounted");
  const run = create;
  let out: { err?: unknown; ok?: boolean } = { ok: true };
  await act(async () => {
    try {
      await run(input);
    } catch (err) {
      out = { err };
    }
  });
  cleanup();
  return out;
}

const BASE: CreateSubshellInput = {
  harnessId: "claude-code",
  presetId: "p-src",
  workingDir: " /tmp ",
  nodeId: "local",
  promptBlocks: [],
};

afterEach(cleanup);

describe("useCreateSubshell save-as-preset (review round 3)", () => {
  it("copies the picked preset's settings into the new row, launches from it, and trims the stored dir", async () => {
    const m = mockFetch();
    try {
      const out = await launch({ ...BASE, saveAsPreset: true, presetName: " Keeper " });
      expect(out.ok).toBe(true);
      const presetPost = m.calls.find((c) => c.url === "/api/presets" && c.method === "POST");
      expect(presetPost?.body).toMatchObject({
        harnessId: "claude-code",
        name: "Keeper",
        env: { ANTHROPIC_MODEL: "sonnet" },
        flags: ["--effort"],
        configIsolation: false,
        restartOnExit: true,
        workingDir: "/tmp",
        promptBlocks: null,
      });
      // The opt-in switch is NEVER inherited: letting agents launch is a
      // per-row explicit act.
      expect(presetPost?.body?.crossCommEnabled).toBeUndefined();
      const launchPost = m.calls.find((c) => c.url === "/api/subshells" && c.method === "POST");
      expect(launchPost?.body?.presetId).toBe("p-new");
    } finally {
      m.restore();
    }
  });

  it("a refused launch takes back the row this click created", async () => {
    const m = mockFetch({ failLaunch: true });
    try {
      const out = await launch({ ...BASE, saveAsPreset: true, presetName: "Keeper" });
      expect(out.err).toBeDefined();
      const order = m.calls
        .filter(
          (c) =>
            (c.url === "/api/presets" && c.method === "POST") ||
            (c.url === "/api/presets/p-new" && c.method === "DELETE"),
        )
        .map((c) => c.method);
      expect(order).toEqual(["POST", "DELETE"]);
    } finally {
      m.restore();
    }
  });

  it("without the checkbox nothing preset-side happens and the picked id rides unchanged", async () => {
    const m = mockFetch();
    try {
      const out = await launch(BASE);
      expect(out.ok).toBe(true);
      expect(m.calls.some((c) => c.method === "POST" && c.url === "/api/presets")).toBe(false);
      const launchPost = m.calls.find((c) => c.url === "/api/subshells" && c.method === "POST");
      expect(launchPost?.body?.presetId).toBe("p-src");
    } finally {
      m.restore();
    }
  });
});
