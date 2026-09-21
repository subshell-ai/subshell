import { afterEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NodeMaintenanceCard } from "../components/node-maintenance-card";
import { type ConfirmOptions, setConfirmHandler } from "../lib/confirm";
import type { NodeDetail } from "../types/node";

/**
 * The Maintenance card (spec 2026-09-14 §6), which replaced the local-launch
 * switch on the `local` node's page and now mounts on EVERY node's Overview:
 * the switch is the node's own flag rather than surgery on its share set, so
 * the machine it applies to is whichever one the page is showing.
 *
 * Two things this suite pins that the card cannot afford to get wrong: it is
 * invisible to a viewer who cannot manage the node (the server refuses them,
 * and a switch that 403s teaches a person the app is broken), and turning it
 * ON goes through the confirmation — the flip stops every subshell on that
 * machine, including ones this viewer never sees.
 */
function node(overrides: Partial<NodeDetail> = {}): NodeDetail {
  return {
    id: "a1",
    name: "mac mini",
    kind: "agent",
    os: "darwin",
    arch: "arm64",
    hostname: "mac-mini",
    status: "online",
    lastSeenAt: null,
    agentVersion: null,
    protocolVersion: null,
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
    ...overrides,
  };
}

interface Call {
  method: string;
  url: string;
  body?: string;
}

/**
 * Records every request; the maintenance PUT answers with the flipped view
 * plus what the act did. `failed` rides the answer only when the node refused
 * a kill, which is exactly the case this card must not render as a clean flip.
 */
function mockFetch({
  status = 200,
  message = "nope",
  failed,
}: {
  status?: number;
  message?: string;
  failed?: string[];
} = {}) {
  const calls: Call[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((input: unknown, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const method = init?.method ?? "GET";
    calls.push({ method, url: url.pathname, body: init?.body as string | undefined });
    if (status !== 200) {
      return Promise.resolve(new Response(JSON.stringify({ message }), { status }));
    }
    const result = { ...node({ maintenance: true }), stopped: [], ...(failed ? { failed } : {}) };
    return Promise.resolve(new Response(JSON.stringify(result)));
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}

/** Answers every confirm with `answer`, recording what it was asked. */
function mockConfirm(answer: boolean) {
  const seen: ConfirmOptions[] = [];
  const previous = setConfirmHandler((options) => {
    seen.push(options);
    return Promise.resolve(answer);
  });
  return { seen, restore: () => setConfirmHandler(previous) };
}

function renderCard(n: NodeDetail) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <NodeMaintenanceCard node={n} />
    </QueryClientProvider>,
  );
}

/** The PUT bodies sent to this node's maintenance route, in order. */
function putBodies(calls: Call[]) {
  return calls.filter((c) => c.method === "PUT" && c.url === "/api/nodes/a1/maintenance").map((c) => String(c.body));
}

afterEach(cleanup);

describe("NodeMaintenanceCard", () => {
  it("stays hidden for a viewer who cannot manage the node", () => {
    const { restore } = mockFetch();
    try {
      renderCard(node({ access: "edit", canManage: false }));
      expect(screen.queryByText("Maintenance")).toBeNull();
      expect(screen.queryByRole("switch")).toBeNull();
    } finally {
      restore();
    }
  });

  /**
   * The label names the SWITCH and never changes. The old pair put
   * "Accepting subshells" beside an OFF switch: an affirmative label on a
   * negated position reads as "accepting: off", the opposite of the truth.
   * The replacement "Accepting new subshells" state line went the same way
   * by a different road: an off switch announcing its own off-state is a
   * tautology that says nothing anyone acts on, so the state line exists
   * ONLY while the machine is in maintenance (since-when and which-end
   * declared it, are facts).
   */
  it("labels the switch 'Maintenance mode' in BOTH positions and states only the ON position", () => {
    const { restore } = mockFetch();
    try {
      renderCard(node());
      expect(screen.getByText("Maintenance")).toBeDefined();
      expect(screen.getByText("Maintenance mode")).toBeDefined();
      expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("false");
      // OFF is the ordinary state; it gets no line at all.
      expect(screen.queryByText(/Accepting/)).toBeNull();
      expect(screen.queryByText(/In maintenance/)).toBeNull();
      // On: same label, plus the state line.
      cleanup();
      renderCard(node({ maintenance: true }));
      expect(screen.getByText("Maintenance mode")).toBeDefined();
      expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("true");
      expect(screen.getByText("In maintenance")).toBeDefined();
      expect(screen.queryByText(/Accepting/)).toBeNull();
    } finally {
      restore();
    }
  });

  it("names the machine in the switch's own label, not just in the heading", () => {
    // Several cards on this page carry a switch; a bare "Maintenance mode"
    // would read identically on all of them to a screen reader. The visible
    // label must stay a substring of this (label-in-name).
    const { restore } = mockFetch();
    try {
      renderCard(node());
      expect(screen.getByLabelText("Maintenance mode on mac mini")).toBeDefined();
    } finally {
      restore();
    }
  });

  it("keeps the CLI hint off the control-plane host", () => {
    // `subshell maintenance on|off` is the agent's command; `local` runs no
    // agent to type it into, and a hint pointing at a missing binary reads
    // as a bug report.
    renderCard(node({ kind: "local" }));
    expect(document.body.textContent).not.toContain("subshell maintenance on|off");
  });

  it("says since when, and WHICH END declared it", () => {
    const { restore } = mockFetch();
    try {
      renderCard(
        node({
          maintenance: true,
          maintenanceAt: new Date(Date.now() - 12 * 60_000).toISOString(),
          maintenanceSource: "node",
        }),
      );
      // "at the node" is the fact that matters before undoing it: somebody is
      // standing at that machine.
      expect(screen.getByText(/In maintenance since 12m · declared at the node/)).toBeDefined();
    } finally {
      restore();
    }
  });

  it("says 'from this page' for a flip the plane made", () => {
    const { restore } = mockFetch();
    try {
      renderCard(node({ maintenance: true, maintenanceAt: new Date().toISOString(), maintenanceSource: "plane" }));
      expect(screen.getByText(/declared from this page/)).toBeDefined();
    } finally {
      restore();
    }
  });

  it("omits the since clause when nothing stamped it", () => {
    const { restore } = mockFetch();
    try {
      renderCard(node({ maintenance: true, maintenanceAt: null, maintenanceSource: null }));
      expect(screen.getByText("In maintenance")).toBeDefined();
    } finally {
      restore();
    }
  });

  it("asks with the manager-only count before turning it on, then PUTs { on: true }", async () => {
    const fetchMock = mockFetch();
    const confirm = mockConfirm(true);
    try {
      renderCard(node({ runningSubshells: 2 }));
      fireEvent.click(screen.getByRole("switch"));
      await waitFor(() => expect(putBodies(fetchMock.calls)).toEqual(['{"on":true}']));
      expect(confirm.seen[0]?.title).toBe('Start maintenance on "mac mini"?');
      expect(confirm.seen[0]?.description).toContain("2 subshells running here will be stopped");
    } finally {
      confirm.restore();
      fetchMock.restore();
    }
  });

  it("writes nothing when the confirmation is dismissed", async () => {
    const fetchMock = mockFetch();
    const confirm = mockConfirm(false);
    try {
      renderCard(node({ runningSubshells: 2 }));
      fireEvent.click(screen.getByRole("switch"));
      // Give a (wrongly) queued mutation a chance to fire before asserting.
      await new Promise((r) => setTimeout(r, 50));
      expect(putBodies(fetchMock.calls)).toEqual([]);
    } finally {
      confirm.restore();
      fetchMock.restore();
    }
  });

  it("ends maintenance without asking — it only widens what the machine accepts", async () => {
    const fetchMock = mockFetch();
    const confirm = mockConfirm(true);
    try {
      renderCard(node({ maintenance: true, maintenanceAt: new Date().toISOString(), maintenanceSource: "plane" }));
      fireEvent.click(screen.getByRole("switch"));
      await waitFor(() => expect(putBodies(fetchMock.calls)).toEqual(['{"on":false}']));
      expect(confirm.seen).toEqual([]);
    } finally {
      confirm.restore();
      fetchMock.restore();
    }
  });

  it("renders the server's refusal on the card rather than swallowing it", async () => {
    const fetchMock = mockFetch({ status: 403, message: "Only the node's owner can do that" });
    const confirm = mockConfirm(true);
    try {
      renderCard(node({ runningSubshells: 0 }));
      fireEvent.click(screen.getByRole("switch"));
      expect(await screen.findByRole("alert")).toBeDefined();
      expect(screen.getByRole("alert").textContent).toContain("Only the node's owner can do that");
    } finally {
      confirm.restore();
      fetchMock.restore();
    }
  });

  it("says what the node REFUSED to stop, rather than rendering a partial flip as a clean one", async () => {
    // The switch and the state line both move to "in maintenance" either way.
    // Without this line a person is told the machine is quiet and walks away
    // from two panes still running on it.
    const fetchMock = mockFetch({ failed: ["s1", "s2"] });
    const confirm = mockConfirm(true);
    try {
      renderCard(node({ runningSubshells: 5 }));
      fireEvent.click(screen.getByRole("switch"));
      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toContain("2 subshells could not be stopped");
      expect(alert.textContent).toContain("mac mini is in maintenance and will launch nothing");
    } finally {
      confirm.restore();
      fetchMock.restore();
    }
  });

  it("stays silent on a clean flip", async () => {
    const fetchMock = mockFetch();
    const confirm = mockConfirm(true);
    try {
      renderCard(node({ runningSubshells: 5 }));
      fireEvent.click(screen.getByRole("switch"));
      await waitFor(() => expect(putBodies(fetchMock.calls)).toEqual(['{"on":true}']));
      expect(screen.queryByRole("alert")).toBeNull();
    } finally {
      confirm.restore();
      fetchMock.restore();
    }
  });

  it("tells the reader the machine's own CLI does the same thing", () => {
    // Otherwise the person standing at the machine has no way to know the
    // browser switch and `subshell maintenance` are one flag.
    const { restore } = mockFetch();
    try {
      renderCard(node());
      expect(screen.getByText(/subshell maintenance/)).toBeDefined();
    } finally {
      restore();
    }
  });
});
