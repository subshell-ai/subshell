import { afterEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { idleUpdate, updatesView } from "@/components/__tests__/helpers/updates-view";
import { UpdatesTable } from "@/components/updates/updates-table";

afterEach(cleanup);

function renderTable() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <UpdatesTable
        view={updatesView()}
        update={idleUpdate}
        onCheck={() => {}}
        checking={false}
        serverVersion="0.6.0"
      />
    </QueryClientProvider>,
  );
}

describe("the Components table", () => {
  it("titles the card and names the four columns", () => {
    renderTable();
    expect(screen.getByText("Components", { exact: true })).toBeTruthy();
    for (const heading of ["Name", "Running", "Newest", "Update"]) {
      expect(screen.getByText(heading, { exact: true })).toBeTruthy();
    }
  });

  /**
   * DOM order, asserted through the flat list of text elements rather than
   * coordinates: the row order is the operator's deliberate 2026-09-17 call —
   * the two desktop apps, then Server, then the fleet — and nothing else on
   * the page would notice a swap. Exact textContent matches name the row
   * labels; "Server" must not match inside "Subshell Server app".
   */
  it("orders the rows desktop apps, Server, then Nodes", () => {
    const { container } = renderTable();
    const labels = Array.from(container.querySelectorAll("p, span")).map((n) => n.textContent);
    const pos = (label: string) => labels.indexOf(label);
    for (const label of ["Subshell Server app", "Subshell Client app", "Server", "Nodes"]) {
      expect(pos(label)).toBeGreaterThanOrEqual(0);
    }
    expect(pos("Subshell Server app")).toBeLessThan(pos("Subshell Client app"));
    expect(pos("Subshell Client app")).toBeLessThan(pos("Server"));
    expect(pos("Server")).toBeLessThan(pos("Nodes"));
  });

  it("answers every row with the same columns", () => {
    renderTable();
    // The Server row runs 0.6.0 against a 0.7.0 release; the desktop server
    // release carries the same 0.7.0, so two cells say it and one says 0.6.0.
    expect(screen.getByText("0.6.0", { exact: true })).toBeTruthy();
    expect(screen.getAllByText("0.7.0", { exact: true }).length).toBe(2);
    // Desktop rows in a browser: neither app's version is knowable from here.
    // The absence is stated with "—", never left blank (the fleet is empty,
    // so only the two desktop Running cells answer this way).
    expect(screen.getAllByText("—", { exact: true }).length).toBe(2);
  });
});
