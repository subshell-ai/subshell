import { afterEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NodeRuntimeCard } from "@/components/nodes/node-runtime-card";
import { setConfirmHandler } from "@/lib/confirm";
import type { NodeDetail, NodeRuntime } from "@/types/node";

const restore: (() => void)[] = [];
afterEach(() => {
  cleanup();
  for (const undo of restore.splice(0)) undo();
});

/** An online agent node the viewer owns — the only case the card renders for. */
const base: NodeDetail = {
  id: "n1",
  name: "devbox",
  kind: "agent",
  os: "linux",
  arch: "x64",
  hostname: "devbox.local",
  status: "online",
  lastSeenAt: "2026-09-12T10:00:00.000Z",
  agentVersion: "0.2.0",
  protocolVersion: 4,
  access: "owner",
  canManage: true,
  allowedDirs: [],
  capabilities: [],
  harnesses: [],
  inventoryStale: false,
};

/** A supervised systemd agent, with the fields each test varies. */
function runtime(over: Partial<NodeRuntime> = {}): NodeRuntime {
  return {
    startedAt: "2026-09-12T10:00:00.000Z",
    supervised: true,
    service: {
      manager: "systemd",
      installed: true,
      definitionPath: "/u/.config/systemd/user/subshell.service",
      state: "running",
      pid: 511,
      enabled: true,
      paneSafety: "keeps",
    },
    configPath: "/u/.config/subshell/config.json",
    logPath: null,
    logHint: "journalctl --user -u subshell.service -f",
    tmuxPath: null,
    binaryPath: "/u/.local/bin/subshell",
    ...over,
  };
}

function renderCard(node: NodeDetail) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <NodeRuntimeCard node={node} />
    </QueryClientProvider>,
  );
}

const restartButton = () => screen.getByRole("button", { name: "Restart agent" }) as HTMLButtonElement;

describe("NodeRuntimeCard", () => {
  it("renders nothing without a runtime report", () => {
    // Absent for an offline node, for a `view` grantee, and for `local` — in
    // every one of those the card would be asserting facts it does not have.
    renderCard(base);
    expect(screen.queryByText("Runtime")).toBeNull();
  });

  it("shows supervision, paths and the journal hint, and offers Restart when supervised", () => {
    renderCard({ ...base, runtime: runtime() });
    expect(screen.getByText("Runtime")).toBeTruthy();
    expect(screen.getByText(/systemd \(pid 511\)/)).toBeTruthy();
    expect(screen.getByText("journalctl --user -u subshell.service -f")).toBeTruthy();
    expect(screen.getByText("/u/.config/subshell/config.json")).toBeTruthy();
    // A node without tmux accepts no launches, which is invisible until
    // someone tries — so it is said here rather than discovered there.
    expect(screen.getByText(/not found: this node accepts no launches/)).toBeTruthy();
    expect(restartButton().disabled).toBe(false);
  });

  it("disables Restart with the reason when not supervised", () => {
    renderCard({
      ...base,
      runtime: runtime({
        supervised: false,
        service: {
          manager: null,
          installed: false,
          definitionPath: null,
          state: "unknown",
          pid: null,
          enabled: null,
          paneSafety: "unknown",
        },
        tmuxPath: "/usr/bin/tmux",
      }),
    });
    expect(restartButton().disabled).toBe(true);
    expect(screen.getByText(/Not supervised/)).toBeTruthy();
  });

  it("sends force only when the node's definition would close its own subshells", async () => {
    const posted: unknown[] = [];
    const originalFetch = globalThis.fetch;
    restore.push(() => {
      globalThis.fetch = originalFetch;
    });
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      if (init?.method === "POST") {
        posted.push(JSON.parse(String(init.body)));
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      // The waiter's poll: still the old process, so the wait keeps going.
      return new Response(JSON.stringify({ ...base, runtime: runtime({ service: killing() }) }), { status: 200 });
    }) as typeof globalThis.fetch;

    const previousConfirm = setConfirmHandler(async () => true);
    restore.push(() => {
      setConfirmHandler(previousConfirm);
    });

    renderCard({ ...base, runtime: runtime({ service: killing() }) });
    expect(screen.getByText(/close every subshell running there/)).toBeTruthy();
    fireEvent.click(restartButton());
    await waitFor(() => expect(posted).toEqual([{ force: true }]));
  });

  it("asks first, and sends nothing when the answer is no", async () => {
    const posted: unknown[] = [];
    const originalFetch = globalThis.fetch;
    restore.push(() => {
      globalThis.fetch = originalFetch;
    });
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      if (init?.method === "POST") posted.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof globalThis.fetch;

    const previousConfirm = setConfirmHandler(async () => false);
    restore.push(() => {
      setConfirmHandler(previousConfirm);
    });

    renderCard({ ...base, runtime: runtime() });
    fireEvent.click(restartButton());
    await waitFor(() => expect(restartButton().disabled).toBe(false));
    expect(posted).toEqual([]);
  });
});

/** A service definition that takes the panes down with the process. */
function killing(): NodeRuntime["service"] {
  return {
    manager: "systemd",
    installed: true,
    definitionPath: "/u/.config/systemd/user/subshell.service",
    state: "running",
    pid: 511,
    enabled: true,
    paneSafety: "kills",
  };
}
