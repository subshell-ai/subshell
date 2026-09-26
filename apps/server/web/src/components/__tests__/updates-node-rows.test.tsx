import { afterEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { nodeRow, nodeUpdates, updateState } from "@/components/__tests__/helpers/updates-view";
import { NodeRows, rowState } from "@/components/updates/node-rows";
import type { NodeUpdates, UpdateTrackerState } from "@/types/updates";

afterEach(cleanup);

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

  it("shows Update all as Updating with a spinner while its sequence runs", async () => {
    // Same idiom as the two per-row buttons (review minor 4): the sequence
    // blocks on each row's five-minute POST, so the header button says so.
    const original = globalThis.fetch;
    const posts: string[] = [];
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "POST") {
        posts.push(url);
        // First row's POST never resolves: the button stays mid-sequence.
        return new Promise<Response>(() => {});
      }
      return new Response("{}", { status: 200 });
    }) as typeof globalThis.fetch;
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
      // The header button carries the sequence counter now ("Updating 1 of
      // 2…"), so the only exact "Updating…" match is row a's own button —
      // which is the working row, and the point of this assertion.
      const updating = (await screen.findAllByRole("button", { name: "Updating…" }))[0] as HTMLButtonElement;
      expect(updating.disabled).toBe(true);
      expect(updating.textContent).toContain("Updating");
      expect(updating.querySelector("svg")).toBeTruthy();
      expect(posts).toEqual(["/api/nodes/a/update"]);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("moves the working row with the sequence and names its position", async () => {
    // Operator report (2026-09-25): Update all disabled every row's button
    // while only the FIRST row ever showed a spinner, for the minutes that
    // one POST takes. The rows read their busy state from a single shared
    // mutation, which can only ever name its latest call, and nothing said
    // where the fleet stood in the sequence.
    const original = globalThis.fetch;
    const deferred = new Map<string, () => void>();
    globalThis.fetch = ((input: unknown, init?: RequestInit) => {
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
      // The watcher's read: both still on the OLD version, so accepted
      // watches stay on their "installing" sentence.
      return Promise.resolve(
        new Response(
          JSON.stringify({
            nodes: [
              { id: "a", agentVersion: "0.9.0" },
              { id: "b", agentVersion: "0.9.0" },
            ],
          }),
          {
            status: 200,
          },
        ),
      );
    }) as typeof globalThis.fetch;
    try {
      const view = renderRows(
        nodeUpdates({
          release: { version: "0.9.1", tag: "cli-node-v0.9.1", publishedAt: null },
          rows: [
            nodeRow({ id: "a", name: "alpha", agentVersion: "0.9.0", canUpdate: { ok: true, reason: null } }),
            nodeRow({ id: "b", name: "beta", agentVersion: "0.9.0", canUpdate: { ok: true, reason: null } }),
          ],
        }),
      );
      const { client } = view;
      // Grab the header button BEFORE pressing it: mid-sequence it no longer
      // answers /^Update all/, so every position assert below reads the same
      // captured element (React keeps the node across renders).
      const allBtn = updateAll();
      fireEvent.click(allBtn);

      // Position 1 of 2 while a's POST is open: the counter names it, only
      // row a spins, row b sits plainly disabled.
      await waitFor(() => expect(allBtn.textContent).toBe("Updating 1 of 2…"));
      expect((await screen.findByRole("button", { name: "Updating…" })).textContent).toBe("Updating…");
      // Row b is the only plain "Update" button left: a string `name` on a
      // role query matches the accessible name exactly, so "Updating…" on
      // row a cannot shadow-match it.
      const plain = screen.getByRole("button", { name: "Update" }) as HTMLButtonElement;
      expect(plain.disabled).toBe(true);

      // a's 202 lands: a keeps a sentence (not a spinner), b takes the
      // spinner, and the counter moves. This is the moment the old state
      // model made unrepresentable to SEE. (ASYNC act: a sync act callback
      // returns before the resolve's microtask chain runs, so the state
      // would land outside it and the next waitFor's first check would be
      // a coin-flip, which is exactly the Linux happy-dom escape trap. The
      // await drains the chain, so the waitFor below lands on settled DOM.)
      await act(async () => {
        deferred.get("a")?.();
      });
      await waitFor(() => expect(allBtn.textContent).toBe("Updating 2 of 2…"));
      // No sentence yet, for either row: the phase lives in the payload now,
      // and the payload the test was rendered with knows nothing.
      expect(screen.getAllByRole("button", { name: "Updating…" }).length).toBe(1);
      expect(screen.queryByText(/is installing/)).toBeNull();

      // The mid-run refetch: a's tracker entry has appeared, a is offline and
      // out of the updatable list, and b is still in flight. The counter must
      // keep counting the fleet the press captured, not the one on screen
      // now, or it reads "1 of 1" while the operator's own press said two;
      // and a's sentence arrives FROM THE PAYLOAD, not from this tab's memory.
      view.rerender(
        <QueryClientProvider client={client}>
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
      expect(allBtn.textContent).toBe("Updating 2 of 2…");
      expect(screen.getByText("alpha is installing 0.9.1 and will reconnect by itself.")).toBeTruthy();
      expect(screen.queryByText(/beta is installing/)).toBeNull();

      // b's 202 lands: the sequence is done; the header button is itself
      // again, counted against the fleet as it stands now.
      await act(async () => {
        deferred.get("b")?.();
      });
      await waitFor(() => expect(allBtn.textContent).toBe("Update all (1)"));
      view.rerender(
        <QueryClientProvider client={client}>
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

  it("says a failed 'Update all' ONCE, on the row it stopped at", async () => {
    // The double-render fix (review 2026-09-17): the hook keeps the failure
    // and the failed row renders its own destructive line, so the old
    // section-bottom `runError` copy printed the same refusal a second time —
    // one failing row showed the message twice. This pins the count at ONE,
    // and that the sequence stopped at the machine that refused.
    const original = globalThis.fetch;
    const posts: string[] = [];
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "POST") {
        posts.push(url);
        return new Response("NODE_NOT_SUPERVISED: nothing respawns this agent", { status: 409 });
      }
      return original(input as RequestInfo, init);
    }) as typeof globalThis.fetch;
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
      await waitFor(() => expect(screen.getAllByText(/NODE_NOT_SUPERVISED/).length).toBe(1));
      // Stop at the first failure: beta was never asked.
      expect(posts).toEqual(["/api/nodes/a/update"]);
    } finally {
      globalThis.fetch = original;
    }
  });
});
