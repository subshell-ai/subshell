import { afterEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { idleUpdate, updatesView } from "@/components/__tests__/helpers/updates-view";
import { UpdatesTable } from "@/components/updates/updates-table";
import { resetDesktopShellForTests } from "@/lib/desktop";

afterEach(cleanup);

function renderTable() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <UpdatesTable view={updatesView()} update={idleUpdate} onCheck={() => {}} checking={false} />
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

/**
 * Inside Subshell Server the app row and the Server row are ONE row
 * (spec 2026-09-18 D4).
 *
 * The point of these cases is the pair of facts the fold must not lose: the
 * page still STATES both version pairs, and it offers exactly one control —
 * the assistant, which is the only surface allowed to drive either install.
 * A browser keeps both rows and its release-source button, because nothing
 * there can install anything on a machine the page is not running on.
 */
describe("the Components table inside Subshell Server", () => {
  const SERVER_UA = "Mozilla/5.0 SubshellDesktop/0.8.0 (macos; p=1; b=0.10.0)";
  const BROWSER_UA = "Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15";
  const nav = globalThis.navigator as unknown as Record<string, unknown>;
  let previous: PropertyDescriptor | undefined;

  function setUA(userAgent: string) {
    previous ??= Object.getOwnPropertyDescriptor(nav, "userAgent");
    Object.defineProperty(nav, "userAgent", { value: userAgent, configurable: true, writable: true });
    resetDesktopShellForTests();
  }

  afterEach(() => {
    if (previous) Object.defineProperty(nav, "userAgent", previous);
    previous = undefined;
    resetDesktopShellForTests();
    cleanup();
  });

  it("names the app as an app, and the CLI as a CLI", () => {
    setUA(SERVER_UA);
    const { container } = renderTable();
    const labels = Array.from(container.querySelectorAll("p, span")).map((n) => n.textContent);
    // Sentence case, matching the sibling row rather than the product name:
    // it read "Subshell Server", which named neither of the two things whose
    // versions this fold states.
    expect(labels).toContain("Subshell Server app");
    expect(labels).toContain("subshell-server CLI");
    // The plain "Server" row a browser gets is not here.
    expect(labels).not.toContain("Server");
    // The client app is a DIFFERENT product this window cannot install.
    expect(labels).toContain("Subshell Client app");
  });

  /**
   * The CLI's versions sit in the SAME COLUMNS as the app's, which is the
   * whole read this table has (operator's report, 2026-09-18). The first
   * draft put them in a `col-span-full` sentence, where no column scan
   * reaches them.
   */
  it("puts the CLI's versions in the version columns, not in prose", () => {
    setUA(SERVER_UA);
    const { container } = renderTable();
    const cells = Array.from(container.querySelectorAll("div.font-mono")).map((n) => n.textContent);
    // The CLI's own running version, in a real cell.
    expect(cells).toContain(updatesView().server.current);
    // And no sentence carrying versions instead of columns.
    expect(screen.queryByText(/installed with the app\./)).toBeNull();
  });

  /**
   * "Newest" means the newest PUBLISHED release in EVERY row (review I10).
   *
   * It briefly held the version this app bundles, which can be older than what
   * was published — one row's column quietly meaning something else while
   * looking like it obeyed the header, which breaks the table's only read in
   * the way hardest to notice. What the app ships is a fact about the act, so
   * it belongs in the act cell.
   */
  it("keeps Newest meaning the newest published release, even on the CLI row", () => {
    setUA(SERVER_UA);
    const { container } = renderTable();
    const cells = Array.from(container.querySelectorAll("div.font-mono")).map((n) => n.textContent);
    // Non-null via the fixture: `updatesView()` always publishes a server
    // release, and `toContain` will not take `string | undefined`.
    const published = updatesView().server.latest?.version ?? "";
    expect(published).not.toBe("");
    expect(cells).toContain(published);
    // The bundled version (`b=0.10.0` in the UA) is NOT in a version cell.
    expect(cells).not.toContain("0.10.0");
    // It is stated where the act is, because that is what it is about.
    expect(screen.getByText(/ships 0\.10\.0, with the app/)).toBeTruthy();
  });

  // One act, so one button — the CLI half says where its act lives rather
  // than showing a dash, which would read as "nothing to do".
  it("gives the CLI row no button of its own", () => {
    setUA(SERVER_UA);
    renderTable();
    expect(screen.getAllByRole("button", { name: "Open the update assistant" }).length).toBe(1);
    expect(screen.getByText(/with the app/)).toBeTruthy();
  });

  // M13: a shell that does not report what it bundles is a real state (a
  // cached bundle, a build predating the `b=` marker) and the row said so
  // before the restructure dropped it to a bare dash.
  it("still explains a build that does not report the server it ships", () => {
    setUA("Mozilla/5.0 SubshellDesktop/0.8.0 (macos; p=1)");
    renderTable();
    expect(screen.getByText(/does not report the server it ships/)).toBeTruthy();
  });

  it("offers the assistant and no release-source update", () => {
    setUA(SERVER_UA);
    renderTable();
    expect(screen.getByRole("button", { name: "Open the update assistant" })).toBeTruthy();
    // The Server row's own button, by the shape of its label, must not be here.
    expect(screen.queryByRole("button", { name: /^Update to / })).toBeNull();
  });

  it("changes nothing in a browser", () => {
    setUA(BROWSER_UA);
    const { container } = renderTable();
    const labels = Array.from(container.querySelectorAll("p, span")).map((n) => n.textContent);
    expect(labels).toContain("Subshell Server app");
    expect(labels).toContain("Server");
    expect(screen.queryByRole("button", { name: "Open the update assistant" })).toBeNull();
  });

  /**
   * Re-check already invalidated the whole table — `useCheckUpdates` does it
   * on success so no row can keep stating what the previous read said. Only
   * its PLACE changed, so the one thing worth pinning is that it is no longer
   * inside a row, on either surface.
   *
   * One render per case rather than a loop: two mounted tables put two
   * Re-check buttons in the document and `getByRole` refuses the ambiguity.
   */
  function expectRecheckInHeader(ua: string) {
    setUA(ua);
    const { container } = renderTable();
    const recheck = screen.getByRole("button", { name: "Re-check" });
    // Asserted by ancestry from the title, because `CardHeader` is a plain
    // div with no slot attribute to select on.
    const title = screen.getByText("Components", { exact: true });
    expect(title.parentElement?.contains(recheck)).toBe(true);
    // And NOT inside the grid that holds the rows.
    expect(container.querySelector(".grid")?.contains(recheck)).toBe(false);
  }

  it("puts Re-check in the card header inside the app", () => {
    expectRecheckInHeader(SERVER_UA);
  });

  it("puts Re-check in the card header in a browser too", () => {
    expectRecheckInHeader(BROWSER_UA);
  });
});
