import { afterEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { nodeRow, nodeUpdates } from "@/components/__tests__/helpers/updates-view";
import { NodeRows, rowState } from "@/components/updates/node-rows";
import type { NodeUpdates } from "@/types/updates";

afterEach(cleanup);

/**
 * The rows mount `useNodeUpdate`, which needs a client even when nothing is
 * pressed, and they are `contents` fragments — a grid div is their real
 * parent on the page.
 */
function renderRows(fleet: NodeUpdates) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <div className="grid">
        <NodeRows fleet={fleet} />
      </div>
    </QueryClientProvider>,
  );
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

  it("names the platform nothing is published for instead of leaving the row blank", () => {
    renderRows(nodeUpdates({ rows: [nodeRow({ target: null })] }));
    expect(screen.getByText(/no published platform/)).toBeTruthy();
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
