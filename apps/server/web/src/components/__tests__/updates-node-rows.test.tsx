import { afterEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { BROWSER_UA, CLIENT_UA, restoreUA, setUA } from "@/components/__tests__/helpers/desktop-ua";
import { nodeRow, nodeUpdates, updateState } from "@/components/__tests__/helpers/updates-view";
import { NodeRows, rowState } from "@/components/updates/node-rows";
import { releasePageUrl } from "@/components/updates/row-cells";
import type { NodeUpdateRow, NodeUpdates, UpdateTrackerState } from "@/types/updates";

afterEach(() => {
  cleanup();
  restoreUA();
});

/**
 * The rows mount `useNodeUpdate`, which needs a client even when nothing is
 * pressed, and they are `contents` fragments — a grid div is their real
 * parent on the page.
 */
/** Also returns the provider's client: a test that re-renders mid-sequence
 * with a changed fleet must keep the SAME client, or it remounts the tree
 * under review. */
function renderRows(fleet: NodeUpdates) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return {
    client,
    ...render(
      <QueryClientProvider client={client}>
        <div className="grid">
          <NodeRows fleet={fleet} />
        </div>
      </QueryClientProvider>,
    ),
  };
}

const updateAll = () => screen.getByRole("button", { name: /^Update all/ }) as HTMLButtonElement;

describe("rowState", () => {
  const fleet = { minNodeVersion: "0.7.0", protocol: 10 };

  it("says online or offline for a node the server will talk to", () => {
    expect(rowState(nodeRow(), fleet)).toBe("online");
    expect(rowState(nodeRow({ online: false }), fleet)).toBe("offline");
  });

  it("names the server's own floor, because half the sentence is about the server", () => {
    expect(rowState(nodeRow({ held: { reason: "below-floor" }, agentVersion: "0.4.0" }), fleet)).toBe(
      "needs update: below this server's minimum (0.7.0)",
    );
  });

  it("names BOTH protocols, so an operator can tell which end is behind", () => {
    // Sometimes the answer is the server, which a node-shaped sentence would
    // never reach.
    expect(rowState(nodeRow({ held: { reason: "protocol-mismatch" }, protocolVersion: 9 }), fleet)).toBe(
      "needs update: speaks protocol 9, this server speaks 10",
    );
  });
});

describe("row update state, read from the server's tracker", () => {
  // The watches these tests used to stage are gone: the phase is SERVER state
  // (design 2026-09-25), so the rows are rendered, not driven. The same
  // sentence appears for both live phases because to the page they are one
  // fact - the machine is on its way - and only the server knows which half.
  const fleet = (update: UpdateTrackerState | null) =>
    nodeUpdates({
      rows: [
        nodeRow({
          id: "a",
          name: "alpha",
          agentVersion: "0.9.0",
          updateAvailable: true,
          canUpdate: { ok: true, reason: null },
          update,
        }),
      ],
    });

  it("names the version a working update is installing", () => {
    renderRows(fleet(updateState({ phase: "working" })));
    expect(screen.getByText("alpha is installing 0.9.1 and will reconnect by itself.")).toBeTruthy();
  });

  it("names it the same while the machine is restarting", () => {
    renderRows(fleet(updateState({ phase: "restarting" })));
    expect(screen.getByText("alpha is installing 0.9.1 and will reconnect by itself.")).toBeTruthy();
  });

  it("says Updated to once the server has seen the machine back on the new version", () => {
    renderRows(fleet(updateState({ phase: "done", endedAt: "2026-09-25T12:01:00.000Z" })));
    expect(screen.getByText("Updated to 0.9.1.")).toBeTruthy();
    expect(screen.queryByText(/is installing/)).toBeNull();
  });

  it("hedges when the machine has not come back, without ever claiming it failed", () => {
    renderRows(fleet(updateState({ phase: "stalled" })));
    expect(screen.getByText(/has not reported 0\.9\.1 yet/)).toBeTruthy();
    expect(screen.queryByText(/did not land/)).toBeNull();
  });

  it("states a failed update with the server's reason", () => {
    renderRows(fleet(updateState({ phase: "failed", message: "nothing respawns this agent", endedAt: "x" })));
    expect(screen.getByText(/did not land: nothing respawns this agent/)).toBeTruthy();
  });

  it("says nothing extra when no update was ordered", () => {
    renderRows(fleet(null));
    expect(screen.queryByText(/installing|Updated to|did not land/)).toBeNull();
  });
});

describe("NodeRows", () => {
  it("puts the fleet's release in every row's Newest cell", () => {
    // The old card description ("Nodes can be updated to 0.9.0.") is the
    // Newest column now — one voice with the desktop and Server rows.
    renderRows(nodeUpdates({ rows: [nodeRow({ agentVersion: "0.8.0", canUpdate: { ok: true, reason: null } })] }));
    expect(screen.getByText("0.9.0", { exact: true })).toBeTruthy();
    expect(screen.getByText("0.8.0", { exact: true })).toBeTruthy();
  });

  it("says why there is no release rather than rendering an empty promise", () => {
    renderRows(
      nodeUpdates({
        release: null,
        reason: "newest node release 0.9.0 speaks protocol 9; this server speaks 10 — update the server first",
        rows: [nodeRow()],
      }),
    );
    expect(
      screen.getByText(/No node release can be offered: newest node release 0.9.0 speaks protocol 9/),
    ).toBeTruthy();
    expect(screen.getByText("—", { exact: true })).toBeTruthy();
  });

  it("labels the section", () => {
    renderRows(nodeUpdates());
    expect(screen.getByText("Nodes", { exact: true })).toBeTruthy();
  });

  it("says so when nothing is enrolled, and offers no Update all", () => {
    renderRows(nodeUpdates());
    expect(screen.getByText("No machines are enrolled as nodes.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Update all/ })).toBeNull();
  });

  it("disables every row's button with the reason the server gave", () => {
    renderRows(nodeUpdates({ rows: [nodeRow({ canUpdate: { ok: false, reason: "this node is offline" } })] }));
    expect((screen.getByRole("button", { name: "Update" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("this node is offline")).toBeTruthy();
  });

  it("counts only the rows that CAN be updated in Update all", () => {
    renderRows(
      nodeUpdates({
        rows: [
          nodeRow({ id: "a", name: "a", canUpdate: { ok: true, reason: null } }),
          nodeRow({ id: "b", name: "b", canUpdate: { ok: false, reason: "this node is offline" } }),
        ],
      }),
    );
    expect(updateAll().textContent).toBe("Update all (1)");
    expect(updateAll().disabled).toBe(false);
  });

  it("disables Update all when no row can take one", () => {
    renderRows(nodeUpdates({ rows: [nodeRow()] }));
    expect(updateAll().textContent).toBe("Update all (0)");
    expect(updateAll().disabled).toBe(true);
  });

  it("shows the pressed row's button as Updating while its POST is in flight", async () => {
    // The POST blocks for the node's whole download-and-restart window (up to
    // five minutes), so the row has to say it is working rather than sit
    // disabled and labelled "Update".
    const original = globalThis.fetch;
    let release: () => void = () => {};
    globalThis.fetch = ((_input: unknown, _init?: RequestInit) =>
      new Promise<Response>((resolve) => {
        release = () => resolve(new Response("{}", { status: 202 }));
      })) as typeof globalThis.fetch;
    try {
      renderRows(nodeUpdates({ rows: [nodeRow({ id: "a", name: "alpha", canUpdate: { ok: true, reason: null } })] }));
      fireEvent.click(screen.getByRole("button", { name: "Update" }));
      const updating = (await screen.findByRole("button", { name: "Updating…" })) as HTMLButtonElement;
      expect(updating.disabled).toBe(true);
      expect(updating.querySelector("svg")).toBeTruthy();
      // Async act: the resolve's microtask chain needs the await to land
      // inside act, or the state updates escape it (the sibling sequence
      // test's comment carries the full reason).
      await act(async () => {
        release();
      });
    } finally {
      globalThis.fetch = original;
    }
  });

  it("announces a refused single-row update as an alert", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async (_input: unknown, _init?: RequestInit) =>
      new Response("NODE_NOT_SUPERVISED: nothing respawns this agent", {
        status: 409,
      })) as typeof globalThis.fetch;
    try {
      renderRows(nodeUpdates({ rows: [nodeRow({ id: "a", name: "alpha", canUpdate: { ok: true, reason: null } })] }));
      fireEvent.click(screen.getByRole("button", { name: "Update" }));
      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toContain("NODE_NOT_SUPERVISED");
    } finally {
      globalThis.fetch = original;
    }
  });

  it("shows Update all as Updating with a spinner while its batch runs", async () => {
    // Parallel by contract now (spec 2026-09-30): the whole batch is asked at
    // once, and the header button says so while anything is still settling.
    const original = globalThis.fetch;
    const posts: string[] = [];
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "POST") {
        posts.push(url);
        return new Promise<Response>(() => {}); // never resolves: the batch stays open
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    try {
      renderRows(
        nodeUpdates({
          rows: [
            nodeRow({ id: "a", name: "alpha", canUpdate: { ok: true, reason: null } }),
            nodeRow({ id: "b", name: "beta", canUpdate: { ok: true, reason: null } }),
          ],
        }),
      );
      const allBtn = updateAll();
      fireEvent.click(allBtn);
      // The whole point: BOTH machines were asked while the first is still
      // answering. Sequential dispatch left posts at length 1.
      await waitFor(() => expect(posts.length).toBe(2));
      expect(posts).toContain("/api/nodes/a/update");
      expect(posts).toContain("/api/nodes/b/update");
      expect(allBtn.textContent).toBe("Updating…");
      expect(allBtn.disabled).toBe(true);
      expect(allBtn.querySelector("svg")).toBeTruthy();
      // Header and both rows: three spinners for one fact, the fleet moving.
      await waitFor(() => expect(screen.getAllByRole("button", { name: "Updating…" }).length).toBe(3));
    } finally {
      globalThis.fetch = original;
    }
  });

  it("runs each row to its own end and keeps a settled row spinning from the tracker alone", async () => {
    // The tracker-on-refresh contract (spec 2026-09-30): a row's busy state
    // comes from the server's fact, so the tab that sees a row's POST answer
    // still spins it while the tracker calls it live, and a reader who never
    // pressed reads the same spin.
    const original = globalThis.fetch;
    const deferred = new Map<string, () => void>();
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "POST") {
        const id = url.split("/")[3];
        return new Promise<Response>((resolve) => {
          deferred.set(id, () =>
            resolve(
              new Response(JSON.stringify({ ok: true, from: "0.9.0", to: "0.9.1", url: "/d/linux-x64" }), {
                status: 202,
              }),
            ),
          );
        });
      }
      return Promise.resolve(new Response("{}", { status: 200 }));
    }) as unknown as typeof globalThis.fetch;
    try {
      const fleetA = nodeUpdates({
        release: { version: "0.9.1", tag: "cli-node-v0.9.1", publishedAt: null },
        rows: [
          nodeRow({ id: "a", name: "alpha", agentVersion: "0.9.0", canUpdate: { ok: true, reason: null } }),
          nodeRow({ id: "b", name: "beta", agentVersion: "0.9.0", canUpdate: { ok: true, reason: null } }),
        ],
      });
      const view = renderRows(fleetA);
      const allBtn = updateAll();
      fireEvent.click(allBtn);

      // Both in flight at once, both spinning, plus the header.
      await waitFor(() => expect(deferred.size).toBe(2));
      expect(screen.getAllByRole("button", { name: "Updating…" }).length).toBe(3);

      // a's 202 lands. Its POST settles, the payload knows nothing yet, so a
      // plainly waits while b keeps moving; the batch (and its lock) stays on.
      await act(async () => {
        deferred.get("a")?.();
      });
      await waitFor(() => expect(screen.getAllByRole("button", { name: "Updating…" }).length).toBe(2));
      expect(screen.getByRole("button", { name: "Update" }).textContent).toBe("Update");
      expect(allBtn.textContent).toBe("Updating…");

      // The mid-run refetch: a's tracker entry has appeared, a is offline and
      // out of the updatable list, b is still in flight. a's spinner and
      // sentence now come FROM THE PAYLOAD, not this tab's memory - that is
      // what a refreshed page would read too.
      view.rerender(
        <QueryClientProvider client={view.client}>
          <div className="grid">
            <NodeRows
              fleet={nodeUpdates({
                release: { version: "0.9.1", tag: "cli-node-v0.9.1", publishedAt: null },
                rows: [
                  nodeRow({
                    id: "a",
                    name: "alpha",
                    agentVersion: "0.9.0",
                    canUpdate: { ok: false, reason: "this node is offline" },
                    update: updateState({ phase: "restarting" }),
                  }),
                  nodeRow({ id: "b", name: "beta", agentVersion: "0.9.0", canUpdate: { ok: true, reason: null } }),
                ],
              })}
            />
          </div>
        </QueryClientProvider>,
      );
      expect(screen.getByText("alpha is installing 0.9.1 and will reconnect by itself.")).toBeTruthy();
      expect(screen.getAllByRole("button", { name: "Updating…" }).length).toBe(3); // a is spinning again

      // b's 202 lands: the batch closes and the header is itself again, but
      // still LOCKED, because a's tracker says a is still moving.
      await act(async () => {
        deferred.get("b")?.();
      });
      await waitFor(() => expect(allBtn.textContent).toBe("Update all (1)"));
      expect(allBtn.disabled).toBe(true);
      view.rerender(
        <QueryClientProvider client={view.client}>
          <div className="grid">
            <NodeRows
              fleet={nodeUpdates({
                release: { version: "0.9.1", tag: "cli-node-v0.9.1", publishedAt: null },
                rows: [
                  nodeRow({
                    id: "a",
                    name: "alpha",
                    agentVersion: "0.9.0",
                    canUpdate: { ok: false, reason: "this node is offline" },
                    update: updateState({ phase: "restarting" }),
                  }),
                  nodeRow({
                    id: "b",
                    name: "beta",
                    agentVersion: "0.9.0",
                    canUpdate: { ok: true, reason: null },
                    update: updateState({ phase: "restarting" }),
                  }),
                ],
              })}
            />
          </div>
        </QueryClientProvider>,
      );
      expect(screen.getByText("beta is installing 0.9.1 and will reconnect by itself.")).toBeTruthy();
    } finally {
      globalThis.fetch = original;
    }
  });

  it("names the platform nothing is published for instead of leaving the row blank", () => {
    renderRows(nodeUpdates({ rows: [nodeRow({ target: null })] }));
    expect(screen.getByText(/no published platform/)).toBeTruthy();
  });

  it("states a refusal once when the tracker has also recorded it", async () => {
    // Two paths now know a press failed: this tab's mutation (whose alert the
    // row renders) and the server tracker (whose `failed` entry arrives with
    // the next payload). Where BOTH speak - the press that was refused after
    // the entry opened - the tracker's sentence wins and the hook's alert is
    // suppressed, or the same refusal shows up twice, 2026-09-17's lesson
    // re-armed with a second source.
    const original = globalThis.fetch;
    globalThis.fetch = (async (_input: unknown, _init?: RequestInit) =>
      new Response("NODE_NOT_SUPERVISED: nothing respawns this agent", { status: 409 })) as typeof globalThis.fetch;
    try {
      const fleetBefore = nodeUpdates({
        rows: [nodeRow({ id: "a", name: "alpha", agentVersion: "0.9.0", canUpdate: { ok: true, reason: null } })],
      });
      const view = renderRows(fleetBefore);
      fireEvent.click(screen.getByRole("button", { name: "Update" }));
      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toContain("NODE_NOT_SUPERVISED");

      view.rerender(
        <QueryClientProvider client={view.client}>
          <div className="grid">
            <NodeRows
              fleet={nodeUpdates({
                rows: [
                  nodeRow({
                    id: "a",
                    name: "alpha",
                    agentVersion: "0.9.0",
                    canUpdate: { ok: true, reason: null },
                    update: updateState({ phase: "failed", message: "nothing respawns this agent", endedAt: "x" }),
                  }),
                ],
              })}
            />
          </div>
        </QueryClientProvider>,
      );
      expect(screen.queryByRole("alert")).toBeNull();
      expect(screen.getAllByText(/nothing respawns this agent/).length).toBe(1);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("says a failed 'Update all' ONCE per failing row and asks them all anyway", async () => {
    // Parallel contract (spec 2026-09-30): a refusal no longer stops the
    // batch, because every row's story is its own - the tracker tells the
    // ones that opened an entry, this tab's failure map the ones refused
    // before one. The 2026-09-17 lesson survives in the COUNT: one failing
    // row shows its refusal exactly once.
    const original = globalThis.fetch;
    const posts: string[] = [];
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "POST") {
        posts.push(url);
        return new Response("NODE_NOT_SUPERVISED: nothing respawns this agent", { status: 409 });
      }
      return original(input as RequestInfo, init);
    }) as unknown as typeof globalThis.fetch;
    try {
      renderRows(
        nodeUpdates({
          rows: [
            nodeRow({ id: "a", name: "alpha", canUpdate: { ok: true, reason: null } }),
            nodeRow({ id: "b", name: "beta", canUpdate: { ok: true, reason: null } }),
          ],
        }),
      );
      fireEvent.click(updateAll());
      await waitFor(() => expect(screen.getAllByRole("alert").length).toBe(2));
      expect(screen.getAllByText(/NODE_NOT_SUPERVISED/).length).toBe(2);
      expect(posts).toContain("/api/nodes/a/update");
      expect(posts).toContain("/api/nodes/b/update");
    } finally {
      globalThis.fetch = original;
    }
  });

  it("keeps a sibling row's refusal when another row is pressed again", async () => {
    // A retry is one row's act: it clears that row's own line (the hook does
    // that before sending) and must leave every other row's story standing.
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      if (init?.method === "POST") {
        return new Response("NODE_NOT_SUPERVISED: nothing respawns this agent", { status: 409 });
      }
      return original(input as RequestInfo, init);
    }) as unknown as typeof globalThis.fetch;
    try {
      setUA(BROWSER_UA);
      renderRows(
        nodeUpdates({
          rows: [
            nodeRow({ id: "a", name: "alpha", canUpdate: { ok: true, reason: null } }),
            nodeRow({ id: "b", name: "beta", canUpdate: { ok: true, reason: null } }),
          ],
        }),
      );
      fireEvent.click(updateAll());
      await waitFor(() => expect(screen.getAllByRole("alert").length).toBe(2));
      // Retry row a (both rows answer "Update" after the batch failed, so
      // the selector takes the first); both refusals must still stand.
      fireEvent.click(screen.getAllByRole("button", { name: "Update" })[0]);
      await waitFor(() => expect(screen.getAllByRole("alert").length).toBe(2));
    } finally {
      globalThis.fetch = original;
    }
  });

  it("keeps the row spinning and the fleet locked from the tracker alone, as a refreshed page reads it", () => {
    // No press, no fetch stub: one live tracker entry on the payload IS the
    // whole state, which is the point of it being server state.
    renderRows(
      nodeUpdates({
        rows: [
          nodeRow({
            id: "a",
            name: "alpha",
            canUpdate: { ok: true, reason: null },
            update: updateState({ phase: "restarting" }),
          }),
        ],
      }),
    );
    const rowBtn = screen.getByRole("button", { name: "Updating…" }) as HTMLButtonElement;
    expect(rowBtn.disabled).toBe(true);
    expect(updateAll().disabled).toBe(true);
  });

  it("hands a stalled row back to the human instead of locking the fleet on it", () => {
    // STALL_MS-not-busy: two minutes without confirmation and the row says
    // so; a permanently disabled button would take that handoff away.
    renderRows(
      nodeUpdates({
        rows: [
          nodeRow({
            id: "a",
            name: "alpha",
            canUpdate: { ok: true, reason: null },
            update: updateState({ phase: "stalled" }),
          }),
        ],
      }),
    );
    expect(updateAll().disabled).toBe(false);
    expect(screen.getByRole("button", { name: "Update" }).textContent).toBe("Update");
  });

  it("links the Nodes section to the offered node release", () => {
    // One link for the section, not one per row (operator ruling 2026-09-30):
    // every row is offered the same release page. The UA is pinned so the
    // memoized shell read can never shadow the browser answer.
    setUA(BROWSER_UA);
    renderRows(nodeUpdates({ rows: [nodeRow()] }));
    const link = screen.getByRole("link", { name: "Notes" }) as HTMLAnchorElement;
    expect(link.href).toBe(releasePageUrl("cli-node-v0.9.0"));
  });

  it("keeps the Notes link out of the app windows", () => {
    // The dash-inside-the-app rule the desktop rows follow: a target="_blank"
    // anchor is inert in a Tauri webview, so the release stays unlinked here
    // even while a node release IS offered.
    setUA(CLIENT_UA);
    renderRows(nodeUpdates({ rows: [nodeRow()] }));
    expect(screen.queryByRole("link", { name: "Notes" })).toBeNull();
  });

  it("offers no Notes when no node release can be offered", () => {
    renderRows(nodeUpdates({ release: null, reason: "the release source is off", rows: [nodeRow()] }));
    expect(screen.queryByRole("link", { name: "Notes" })).toBeNull();
  });

  it("renders a row whose payload lacks the update key, answering the plain button", () => {
    // The shared nullish-tolerant read (isUpdateLive): a cached or hand-stubbed
    // row can omit the field entirely; the row renders rather than throwing
    // inside render. Same deletion idiom as updates-poll.test.ts.
    const bare = Object.fromEntries(
      Object.entries(nodeRow({ canUpdate: { ok: true, reason: null } })).filter(([k]) => k !== "update"),
    );
    renderRows(nodeUpdates({ rows: [bare as unknown as NodeUpdateRow] }));
    expect(screen.getByRole("button", { name: "Update" }).textContent).toBe("Update");
  });
});
