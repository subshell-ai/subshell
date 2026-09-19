/**
 * The footer row that tells the person the APP has a newer build (spec
 * 2026-09-17 §5.3), and the four ways it stays out of the way:
 *
 * - **Only Subshell Server renders it.** `desktop_app_update` reports that
 *   app's own version and is granted to that app's window alone; Subshell
 *   Client has no updater for a product it is not, and a browser is not inside
 *   an app at all.
 * - **No answer is no row.** A shell predating the command, or no shell, must
 *   read as absence — never as an error a non-desktop user has to dismiss.
 * - **No known update is not "up to date".** The line still renders the
 *   version and simply carries no dot, claiming nothing about what the next
 *   check will find.
 * - **The row shows and never applies.** Pressing it raises the assistant; the
 *   install, the verify and the restart all live on that bundled page.
 *
 * It is ONE line in both states since 2026-09-18 (operator's call): the
 * two-line block with an [Update] button and a dismiss × is gone, so the tests
 * for the dismissal went with it — there is nothing loud left to silence, and
 * a dot a person can switch off is a status light that lies.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DesktopAppUpdateRow } from "@/components/desktop/desktop-app-update-row";
import { resetDesktopShellForTests } from "@/lib/desktop";

const SERVER_UA = "Mozilla/5.0 SubshellDesktop/0.7.2 (macos; p=1; b=0.7.2)";
const CLIENT_UA = "Mozilla/5.0 SubshellClient/0.3.0 (macos; p=1)";
const BROWSER_UA = "Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15";

const nav = globalThis.navigator as unknown as Record<string, unknown>;
let previousUserAgent: PropertyDescriptor | undefined;

/** Point `navigator.userAgent` at one shell (or none) for the next render. */
function setUA(userAgent: string) {
  previousUserAgent ??= Object.getOwnPropertyDescriptor(nav, "userAgent");
  Object.defineProperty(nav, "userAgent", { value: userAgent, configurable: true, writable: true });
  resetDesktopShellForTests();
}

interface Invocation {
  command: string;
  args: Record<string, unknown> | undefined;
}

/**
 * A shell answering `desktop_app_update` with `answer`, and recording every
 * invoke so the raised screen can be asserted.
 */
function fakeTauri(answer: unknown): Invocation[] {
  const invocations: Invocation[] = [];
  (window as unknown as Record<string, unknown>).__TAURI__ = {
    core: {
      invoke: (command: string, args?: Record<string, unknown>) => {
        invocations.push({ command, args });
        return Promise.resolve(command === "desktop_app_update" ? answer : null);
      },
    },
  };
  return invocations;
}

function renderRow(collapsed = false) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <DesktopAppUpdateRow collapsed={collapsed} />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  delete (window as unknown as Record<string, unknown>).__TAURI__;
  if (previousUserAgent) Object.defineProperty(nav, "userAgent", previousUserAgent);
  // No own descriptor means the real one lives on the prototype — deleting the
  // one `setUA` defined is what uncovers it again, so the next file's
  // components do not read this file's shell.
  else delete nav.userAgent;
  previousUserAgent = undefined;
  resetDesktopShellForTests();
});

describe("DesktopAppUpdateRow", () => {
  it("names the app, its version, and what is available", async () => {
    setUA(SERVER_UA);
    fakeTauri({ currentVersion: "0.7.2", availableVersion: "0.8.0" });
    renderRow();
    await waitFor(() => expect(screen.getByText(/Subshell Server 0\.7\.2/)).toBeTruthy());
    expect(screen.getByText(/v0\.8\.0 available/)).toBeTruthy();
    // One row, and its accessible name carries both facts. No [Update]
    // button: pressing the row is what the button did.
    expect(
      screen.getByRole("button", { name: "Subshell Server 0.7.2 — v0.8.0 available. Check for updates." }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Update" })).toBeNull();
  });

  it("asks the shell exactly once per load, and nothing else to start", async () => {
    setUA(SERVER_UA);
    const invocations = fakeTauri({ currentVersion: "0.7.2", availableVersion: "0.8.0" });
    renderRow();
    await waitFor(() => expect(screen.getByText(/v0\.8\.0 available/)).toBeTruthy());
    expect(invocations.filter((i) => i.command === "desktop_app_update")).toHaveLength(1);
  });

  it("raises the assistant at the app-update screen, and installs nothing itself", async () => {
    setUA(SERVER_UA);
    const invocations = fakeTauri({ currentVersion: "0.7.2", availableVersion: "0.8.0" });
    renderRow();
    const row = await screen.findByRole("button", {
      name: "Subshell Server 0.7.2 — v0.8.0 available. Check for updates.",
    });
    fireEvent.click(row);
    expect(invocations).toContainEqual({ command: "desktop_open_assistant", args: { screen: "update" } });
  });

  it("still claims nothing when no update is known, and carries no dot", async () => {
    setUA(SERVER_UA);
    fakeTauri({ currentVersion: "0.7.2", availableVersion: null });
    renderRow();
    await waitFor(() => expect(screen.getByText(/Subshell Server 0\.7\.2/)).toBeTruthy());
    // Not "up to date" — nothing here claims what the next check will find.
    expect(screen.queryByText(/available/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Dismiss update notice" })).toBeNull();
  });

  it("renders the dot ONLY when there is news", async () => {
    setUA(SERVER_UA);
    fakeTauri({ currentVersion: "0.7.2", availableVersion: null });
    const { container } = renderRow();
    await waitFor(() => expect(screen.getByText(/Subshell Server 0\.7\.2/)).toBeTruthy());
    expect(container.querySelectorAll(".bg-warning")).toHaveLength(0);
    cleanup();
    fakeTauri({ currentVersion: "0.7.2", availableVersion: "0.8.0" });
    const withNews = renderRow();
    await waitFor(() => expect(screen.getByText(/v0\.8\.0 available/)).toBeTruthy());
    expect(withNews.container.querySelectorAll(".bg-warning")).toHaveLength(1);
  });

  /**
   * The backstop, at the ROW rather than only in the model: a new page meeting
   * an old binary whose stored notice outlived the install it announced must
   * not paint a dot beside the version it names.
   */
  it("carries no dot when the 'available' version is the one running", async () => {
    setUA(SERVER_UA);
    fakeTauri({ currentVersion: "0.8.0", availableVersion: "0.8.0" });
    const { container } = renderRow();
    await waitFor(() => expect(screen.getByText("Subshell Server 0.8.0")).toBeTruthy());
    expect(container.querySelectorAll(".bg-warning")).toHaveLength(0);
    expect(screen.queryByText(/available/)).toBeNull();
  });

  /**
   * "No update known" is not "up to date" — the daily check may not have run
   * today or may not have answered — so the version line is a DOOR to the
   * screen that can find out (operator's call, 2026-09-18). It was the last
   * place in the app where knowing the version led nowhere, and it is the same
   * fix the tray item's "Check for Updates…" label got the same day.
   */
  it("opens the update screen when there is no update known", async () => {
    setUA(SERVER_UA);
    const invocations = fakeTauri({ currentVersion: "0.7.2", availableVersion: null });
    renderRow();
    // The visible text is a version, which does not say it is pressable — the
    // accessible name has to carry the act.
    const row = await screen.findByRole("button", { name: "Subshell Server 0.7.2. Check for updates." });
    fireEvent.click(row);
    expect(invocations).toContainEqual({ command: "desktop_open_assistant", args: { screen: "update" } });
    // The SAME screen the [Update] press raises — one door, not a second one
    // that only checks.
    expect(invocations.filter((i) => i.command === "desktop_install_app_update")).toEqual([]);
  });

  it("renders nothing in a browser, which is inside no app", async () => {
    setUA(BROWSER_UA);
    renderRow();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByText(/Subshell Server/)).toBeNull();
  });

  // The invoke-gate is the point, not just the absence of a row: an older shell
  // that knows no such command answers null through `desktopInvoke`, and the
  // row must degrade to silence rather than to an error.
  it("renders nothing when the shell cannot answer", async () => {
    setUA(SERVER_UA);
    const invocations = fakeTauri(null);
    renderRow();
    // Wait for the read to have RUN and landed, so the absence is the answer
    // rendering as silence rather than a query still in flight.
    await waitFor(() => expect(invocations.some((i) => i.command === "desktop_app_update")).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByText(/Subshell Server/)).toBeNull();
  });

  it("asks nothing and renders nothing in Subshell Client", async () => {
    setUA(CLIENT_UA);
    const invocations = fakeTauri({ currentVersion: "0.3.0", availableVersion: "0.4.0" });
    renderRow();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(invocations).toHaveLength(0);
    expect(screen.queryByText(/Subshell/)).toBeNull();
  });

  it("collapses to one icon button that still says which version", async () => {
    setUA(SERVER_UA);
    const invocations = fakeTauri({ currentVersion: "0.7.2", availableVersion: "0.8.0" });
    renderRow(true);
    // The label names the offer, not an act the row never performs —
    // clicking opens the update screen, it does not update.
    const button = await screen.findByRole("button", {
      name: "Subshell Server 0.7.2 — v0.8.0 available. Check for updates.",
    });
    // The text is `sr-only` in the rail: readable to a screen reader, and not
    // laid out in 56px.
    expect(button.querySelector(".sr-only")).not.toBeNull();
    fireEvent.click(button);
    expect(invocations).toContainEqual({ command: "desktop_open_assistant", args: { screen: "update" } });
  });

  it("collapses to nothing when there is no update to offer", async () => {
    setUA(SERVER_UA);
    const invocations = fakeTauri({ currentVersion: "0.7.2", availableVersion: null });
    renderRow(true);
    await waitFor(() => expect(invocations.some((i) => i.command === "desktop_app_update")).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByText(/Subshell Server/)).toBeNull();
  });
});
