import { afterEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render } from "@testing-library/react";
import { type CreateSubshellInput, useCreateSubshell } from "@/hooks/use-create-subshell";
import { setCurrentWorkspace } from "@/lib/current-workspace";

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
    // The filing path reads the workspace LIST (empty here, so the launch
    // opens its own) and the pane-add POST answers a plain row.
    if (url.pathname === "/api/workspaces" && method === "GET") {
      return Promise.resolve(new Response(JSON.stringify([])));
    }
    if (url.pathname === "/api/workspaces" && method === "POST") {
      return Promise.resolve(new Response(JSON.stringify({ id: "ws-fresh" })));
    }
    return Promise.resolve(new Response(JSON.stringify({})));
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}

async function launch(
  input: CreateSubshellInput,
  opts?: { autoFile?: boolean },
): Promise<{ err?: unknown; ok?: boolean }> {
  let create: ((i: CreateSubshellInput) => Promise<unknown>) | null = null;
  function Probe() {
    const m = useCreateSubshell(opts ?? {});
    create = (i) => m.mutateAsync(i);
    return null;
  }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <Probe />
    </QueryClientProvider>,
  );
  // Read through a fresh binding: TS narrowed the captured `create` to its
  // initializer (null) and cannot see the render-time assignment.
  const run = create as ((i: CreateSubshellInput) => Promise<unknown>) | null;
  if (run === null) throw new Error("the probe never mounted");
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

  it("a picked preset that vanished before Start refuses the whole launch, creating nothing", async () => {
    // Review round 4: the faithful copy must not silently degrade to the
    // bare one when the source row disappeared (another tab deleted it).
    // A bare copy is the settings-loss bug wearing a narrower door.
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
        return Promise.resolve(new Response(JSON.stringify([])));
      }
      return Promise.resolve(new Response(JSON.stringify({})));
    }) as typeof fetch;
    try {
      const out = await launch({ ...BASE, saveAsPreset: true, presetName: "Keeper" });
      expect(out.err).toBeDefined();
      expect(String(out.err)).toContain("no longer exists");
      expect(calls.some((c) => c.method === "POST")).toBe(false);
    } finally {
      globalThis.fetch = original;
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

/**
 * The "always in a workspace, existing one first" filing (operator ruling,
 * spec 2026-10-17 revised 2026-10-18): a launch raised outside any workspace
 * page JOINS a workspace that exists — the remembered one first, else the
 * most recently touched — and only an instance with none opens a fresh one.
 */
describe("useCreateSubshell filing (always in a workspace)", () => {
  function filingFetch(opts: {
    homes: Array<{ id: string; updatedAt: string }>;
    last?: string;
    failPaneAdd?: boolean;
  }) {
    const calls: Call[] = [];
    const original = globalThis.fetch;
    if (opts.last === undefined) localStorage.removeItem("subshell.lastWorkspaceId");
    else localStorage.setItem("subshell.lastWorkspaceId", opts.last);
    globalThis.fetch = ((input: unknown, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      const method = init?.method ?? "GET";
      calls.push({
        method,
        url: url.pathname,
        body: init?.body ? (JSON.parse(String(init.body)) as Call["body"]) : undefined,
      });
      if (url.pathname === "/api/subshells" && method === "POST") {
        return Promise.resolve(new Response(JSON.stringify({ id: "s-1", name: "New pane" })));
      }
      if (url.pathname === "/api/workspaces" && method === "GET") {
        return Promise.resolve(new Response(JSON.stringify(opts.homes)));
      }
      if (/^\/api\/workspaces\/[^/]+\/panes$/.test(url.pathname) && method === "POST") {
        return Promise.resolve(
          opts.failPaneAdd
            ? new Response(JSON.stringify({ message: "gone" }), { status: 404 })
            : new Response(JSON.stringify({ id: "pane-1" })),
        );
      }
      if (url.pathname === "/api/workspaces" && method === "POST") {
        return Promise.resolve(new Response(JSON.stringify({ id: "ws-fresh" })));
      }
      return Promise.resolve(new Response(JSON.stringify({})));
    }) as typeof fetch;
    return { calls, restore: () => (globalThis.fetch = original) };
  }

  const PLAIN: CreateSubshellInput = { harnessId: "claude-code", workingDir: "/tmp" };

  it("joins the remembered workspace through the idempotent pane add", async () => {
    const m = filingFetch({
      homes: [
        { id: "ws-old", updatedAt: "2026-10-01T00:00:00.000Z" },
        { id: "ws-new", updatedAt: "2026-10-10T00:00:00.000Z" },
      ],
      last: "ws-old",
    });
    try {
      const out = await launch(PLAIN);
      expect(out.ok).toBe(true);
      const paneAdd = m.calls.find((c) => c.url === "/api/workspaces/ws-old/panes" && c.method === "POST");
      expect(paneAdd?.body).toMatchObject({ subshellId: "s-1" });
      // No second window: nothing creates a workspace here.
      expect(m.calls.some((c) => c.method === "POST" && c.url === "/api/workspaces")).toBe(false);
      expect(localStorage.getItem("subshell.lastWorkspaceId")).toBe("ws-old");
    } finally {
      m.restore();
    }
  });

  it("joins the most recently touched workspace when the remembered one is gone", async () => {
    const m = filingFetch({
      homes: [
        { id: "ws-a", updatedAt: "2026-10-05T00:00:00.000Z" },
        { id: "ws-b", updatedAt: "2026-10-12T00:00:00.000Z" },
      ],
      last: "ws-retired",
    });
    try {
      const out = await launch(PLAIN);
      expect(out.ok).toBe(true);
      expect(m.calls.some((c) => c.url === "/api/workspaces/ws-b/panes" && c.method === "POST")).toBe(true);
      expect(m.calls.some((c) => c.url === "/api/workspaces/ws-a/panes")).toBe(false);
    } finally {
      m.restore();
    }
  });

  it("falls through to opening a fresh workspace when the join races a retire", async () => {
    const m = filingFetch({ homes: [{ id: "ws-x", updatedAt: "2026-10-10T00:00:00.000Z" }], failPaneAdd: true });
    try {
      const out = await launch(PLAIN);
      expect(out.ok).toBe(true);
      const fresh = m.calls.find((c) => c.url === "/api/workspaces" && c.method === "POST");
      expect(fresh?.body).toMatchObject({ name: "New pane", subshellId: "s-1" });
    } finally {
      m.restore();
    }
  });

  it("opens a workspace around the pane only when the instance has none", async () => {
    const m = filingFetch({ homes: [] });
    try {
      const out = await launch(PLAIN);
      expect(out.ok).toBe(true);
      const fresh = m.calls.find((c) => c.url === "/api/workspaces" && c.method === "POST");
      expect(fresh?.body).toMatchObject({ name: "New pane", subshellId: "s-1" });
      expect(m.calls.some((c) => c.url.includes("/panes"))).toBe(false);
      expect(localStorage.getItem("subshell.lastWorkspaceId")).toBe("ws-fresh");
    } finally {
      m.restore();
    }
  });

  it("files into the workspace on screen, server-side in the create body", async () => {
    // A launch raised while a workspace page is up lands as a tab of THAT
    // page (spec 2026-10-17), and the pane is already filed there by the
    // time the create returns — so the client's own join ladder never runs.
    setCurrentWorkspace("ws-on-screen");
    const m = filingFetch({ homes: [{ id: "ws-on-screen", updatedAt: "2026-10-10T00:00:00.000Z" }] });
    try {
      const out = await launch(PLAIN);
      expect(out.ok).toBe(true);
      const created = m.calls.find((c) => c.url === "/api/subshells" && c.method === "POST");
      expect(created?.body).toMatchObject({ workspaceId: "ws-on-screen" });
      expect(m.calls.some((c) => c.method === "POST" && c.url.includes("/panes"))).toBe(false);
    } finally {
      m.restore();
      setCurrentWorkspace(null);
    }
  });

  it("autoFile:false files into NEITHER the page nor a new window (review 2026-10-17)", async () => {
    // The dialogs that file the pane themselves (new-workspace, add-pane)
    // must not ALSO land it in whatever workspace page happens to be on
    // screen: that put one pane in two workspaces. The gate is on the
    // create body's workspaceId, not just the join ladder.
    setCurrentWorkspace("ws-on-screen");
    const m = filingFetch({ homes: [{ id: "ws-on-screen", updatedAt: "2026-10-10T00:00:00.000Z" }] });
    try {
      const out = await launch(PLAIN, { autoFile: false });
      expect(out.ok).toBe(true);
      const created = m.calls.find((c) => c.url === "/api/subshells" && c.method === "POST");
      expect(created?.body?.workspaceId).toBeUndefined();
      expect(m.calls.some((c) => c.method === "POST" && c.url.includes("/panes"))).toBe(false);
      expect(m.calls.some((c) => c.method === "POST" && c.url === "/api/workspaces")).toBe(false);
    } finally {
      m.restore();
      setCurrentWorkspace(null);
    }
  });
});
