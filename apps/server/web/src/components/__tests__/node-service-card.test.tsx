import { afterEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NodeServiceCard } from "@/components/nodes/node-service-card";
import { setConfirmHandler } from "@/lib/confirm";
import type { NodeDetail, NodeRuntime } from "@/types/node";

/**
 * The verbs that act on a node's agent process (spec 2026-09-12, node half).
 *
 * The three cases that moved here from `node-runtime-card.test.tsx` are the
 * ones about ACTING; that card is facts only now. The rest are about the two
 * verbs a browser cannot undo.
 */

const restore: (() => void)[] = [];
afterEach(() => {
  cleanup();
  for (const undo of restore.splice(0)) undo();
});

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
  protocolVersion: 5,
  access: "owner",
  canManage: true,
  canLaunch: true,
  allowedDirs: [],
  capabilities: [],
  harnesses: [],
  inventoryStale: false,
  maintenance: false,
  maintenanceAt: null,
  maintenanceSource: null,
  held: null,
};

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
      linger: true,
      paneSafety: "keeps",
    },
    configPath: "/u/.config/subshell/config.json",
    agentLogPath: "/u/.config/subshell/logs/agent.log",
    logging: { debug: false, source: "default" },
    logPath: null,
    logHint: "journalctl --user -u subshell.service -f",
    tmuxPath: null,
    binaryPath: "/usr/local/bin/subshell",
    ...over,
  };
}

function renderServiceCard(node: NodeDetail): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <NodeServiceCard node={node} />
    </QueryClientProvider>,
  );
}

const verbButton = (label: string) => screen.getByRole("button", { name: label }) as HTMLButtonElement;

/** A service definition that takes the panes down with the process. */
function killing(): NodeRuntime["service"] {
  return {
    manager: "systemd",
    installed: true,
    definitionPath: "/u/.config/systemd/user/subshell.service",
    state: "running",
    pid: 511,
    enabled: true,
    linger: true,
    paneSafety: "kills",
  };
}

describe("NodeServiceCard", () => {
  it("renders nothing without a runtime report", () => {
    renderServiceCard(base);
    expect(screen.queryByText("Service")).toBeNull();
  });

  it("offers every verb, and disables Restart with the reason when not supervised", () => {
    renderServiceCard({ ...base, runtime: runtime({ supervised: false }) });
    for (const label of ["Restart", "Start", "Stop", "Install service", "Uninstall service"]) {
      expect(verbButton(label)).toBeTruthy();
    }
    expect(verbButton("Restart").disabled).toBe(true);
  });

  /**
   * The two one-way verbs. A command reaches a node over the agent's own
   * socket, so nothing here can start an agent that is not running — an
   * `edit` grantee is trusted to interrupt a machine, not to take it off the
   * instance until someone walks to it.
   */
  it("disables stop and uninstall for anyone but the owner", () => {
    renderServiceCard({ ...base, access: "edit", runtime: runtime() });
    expect(verbButton("Stop").disabled).toBe(true);
    expect(verbButton("Uninstall service").disabled).toBe(true);
    // The reachable verbs stay available to the same grantee.
    expect(verbButton("Restart").disabled).toBe(false);
    expect(verbButton("Start").disabled).toBe(false);
  });

  it("never sends force on a verb that cannot close a subshell", async () => {
    const posted: unknown[] = [];
    const originalFetch = globalThis.fetch;
    restore.push(() => {
      globalThis.fetch = originalFetch;
    });
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      if (init?.method === "POST") posted.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof globalThis.fetch;
    const previousConfirm = setConfirmHandler(async () => true);
    restore.push(() => {
      setConfirmHandler(previousConfirm);
    });

    // A definition that WOULD kill panes — so `force` would be sent for a
    // destructive verb, and must still not be for this one.
    renderServiceCard({ ...base, runtime: runtime({ service: killing() }) });
    fireEvent.click(verbButton("Start"));
    await waitFor(() => expect(posted).toEqual([{ verb: "start" }]));
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

    // The warning a person reads lives in the CONFIRMATION now, not on the
    // card — so what this pins is the wire: a pane-killing definition means
    // `force`, and nothing else does.
    renderServiceCard({ ...base, runtime: runtime({ service: killing() }) });
    fireEvent.click(verbButton("Restart"));
    await waitFor(() => expect(posted).toEqual([{ verb: "restart", force: true }]));
  });

  /**
   * "…starts with the machine" was false on Linux: a `systemd --user` unit
   * starts with the LOGIN unless its owner lingers, which is the exact
   * confusion the Runtime card's "Comes back" fact exists to remove. The
   * confirmation now says only what is true on both platforms.
   */
  it("promises what installing a definition actually buys, on both platforms", async () => {
    const asked: string[] = [];
    const previousConfirm = setConfirmHandler(async (request) => {
      asked.push(request.description ?? "");
      return false;
    });
    restore.push(() => {
      setConfirmHandler(previousConfirm);
    });

    renderServiceCard({ ...base, runtime: runtime() });
    fireEvent.click(verbButton("Install service"));
    await waitFor(() => expect(asked).toHaveLength(1));
    expect(asked[0]).toContain("comes back on its own");
    expect(asked[0]).not.toContain("starts with the machine");
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

    renderServiceCard({ ...base, runtime: runtime() });
    fireEvent.click(verbButton("Restart"));
    await waitFor(() => expect(verbButton("Restart").disabled).toBe(false));
    expect(posted).toEqual([]);
  });
});
