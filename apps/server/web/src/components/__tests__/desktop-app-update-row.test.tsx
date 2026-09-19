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
 * - **The row shows and never applies.** Pressing it goes to the Updates page
 *   (operator's call, 2026-09-18 — it used to raise the assistant directly).
 *   Inside this app that page folds the app and Server rows into one and its
 *   own control opens the assistant, which stays the only surface allowed to
 *   install. The TRAY still raises the window directly, and must: it has to
 *   work with no session, when this page does not exist.
 * - **Admin-gated, because the page is.** A member gets an inert line rather
 *   than a press that lands on a route that will not render for them.
 *
 * It is ONE line in both states since 2026-09-18 (operator's call): the
 * two-line block with an [Update] button and a dismiss × is gone, so the tests
 * for the dismissal went with it — there is nothing loud left to silence, and
 * a dot a person can switch off is a status light that lies.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
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

/**
 * `/api/settings/public`, which decides whether the row is a door: the Updates
 * page is admin-only, so a member gets an inert line rather than a press that
 * lands on a page that will not render for them.
 */
let restoreFetch: (() => void) | null = null;

function fakeSettings(admin: boolean) {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: unknown) => {
    const path = new URL(String(input), "http://localhost").pathname;
    if (path === "/api/settings/public") {
      return Promise.resolve(new Response(JSON.stringify({ serverVersion: "0.11.1", viewerIsAdmin: admin })));
    }
    return Promise.resolve(new Response(JSON.stringify({})));
  }) as typeof fetch;
  return () => (globalThis.fetch = original);
}

/** Where the row navigated, or null — the assertion the IPC one replaced. */
let landedOn: string | null = null;

function renderRow(collapsed = false, admin = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  restoreFetch?.();
  restoreFetch = fakeSettings(admin);
  landedOn = null;
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const homeRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => <DesktopAppUpdateRow collapsed={collapsed} />,
  });
  const updatesRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/settings/updates",
    component: () => {
      landedOn = "/settings/updates";
      return null;
    },
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([homeRoute, updatesRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
    defaultPreload: false,
  });
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  restoreFetch?.();
  restoreFetch = null;
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
    await waitFor(() => expect(screen.getByText(/Subshell Server App 0\.7\.2/)).toBeTruthy());
    // The VERSION IS NOT IN THE VISIBLE LINE (operator's report, 2026-09-19):
    // the sidebar truncated it to an ellipsis, so it moved to the tooltip and
    // the accessible name, which is what the next assertion reads.
    expect(screen.queryByText(/available/)).toBeNull();
    // One row, and its accessible name carries both facts. No [Update]
    // button: pressing the row is what the button did.
    expect(
      screen.getByRole("button", { name: "Subshell Server App 0.7.2 — v0.8.0 available. Open updates." }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Update" })).toBeNull();
  });

  it("asks the shell exactly once per load, and nothing else to start", async () => {
    setUA(SERVER_UA);
    const invocations = fakeTauri({ currentVersion: "0.7.2", availableVersion: "0.8.0" });
    renderRow();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Subshell Server App 0.7.2 — v0.8.0 available. Open updates." }),
      ).toBeTruthy(),
    );
    expect(invocations.filter((i) => i.command === "desktop_app_update")).toHaveLength(1);
  });

  it("goes to the Updates page, and installs nothing itself", async () => {
    setUA(SERVER_UA);
    const invocations = fakeTauri({ currentVersion: "0.7.2", availableVersion: "0.8.0" });
    renderRow();
    const row = await screen.findByRole("button", {
      name: "Subshell Server App 0.7.2 — v0.8.0 available. Open updates.",
    });
    fireEvent.click(row);
    await waitFor(() => expect(landedOn).toBe("/settings/updates"));
    expect(invocations.filter((i) => i.command === "desktop_open_assistant")).toEqual([]);
  });

  it("still claims nothing when no update is known, and carries no dot", async () => {
    setUA(SERVER_UA);
    fakeTauri({ currentVersion: "0.7.2", availableVersion: null });
    renderRow();
    await waitFor(() => expect(screen.getByText(/Subshell Server App 0\.7\.2/)).toBeTruthy());
    // Not "up to date" — nothing here claims what the next check will find.
    expect(screen.queryByText(/available/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Dismiss update notice" })).toBeNull();
  });

  it("renders the upgrade icon ONLY when there is news", async () => {
    setUA(SERVER_UA);
    fakeTauri({ currentVersion: "0.7.2", availableVersion: null });
    const { container } = renderRow();
    await waitFor(() => expect(screen.getByText(/Subshell Server App 0\.7\.2/)).toBeTruthy());
    // The icon is always in the DOM for alignment; what changes is whether its
    // SLOT is `invisible`. So the news test reads the slot, not the glyph.
    expect(container.querySelector("span[aria-hidden]")?.className).toContain("invisible");
    cleanup();
    fakeTauri({ currentVersion: "0.7.2", availableVersion: "0.8.0" });
    const withNews = renderRow();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Subshell Server App 0.7.2 — v0.8.0 available. Open updates." }),
      ).toBeTruthy(),
    );
    expect(withNews.container.querySelector("span[aria-hidden]")?.className).not.toContain("invisible");
    expect(withNews.container.querySelectorAll(".text-warning")).toHaveLength(1);
  });

  /**
   * The two footer rows have to line up. `DesktopServerPill` always draws its
   * status circle, so its text carries the dot's indent; a version row whose
   * dot was conditionally ABSENT started flush left whenever there was no
   * news, and the two lines disagreed (operator's report, 2026-09-18). The
   * spacer is therefore always in the layout and merely `invisible`.
   */
  it("keeps the marker's space whether or not there is news, so the rows align", async () => {
    setUA(SERVER_UA);
    fakeTauri({ currentVersion: "0.7.2", availableVersion: null });
    const quiet = renderRow();
    await waitFor(() => expect(screen.getByText(/Subshell Server App 0\.7\.2/)).toBeTruthy());
    const quietSpacer = quiet.container.querySelector("span[aria-hidden]");
    expect(quietSpacer).not.toBeNull();
    expect(quietSpacer?.className).toContain("invisible");

    cleanup();
    fakeTauri({ currentVersion: "0.7.2", availableVersion: "0.8.0" });
    const loud = renderRow();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Subshell Server App 0.7.2 — v0.8.0 available. Open updates." }),
      ).toBeTruthy(),
    );
    const loudSpacer = loud.container.querySelector("span[aria-hidden]");
    expect(loudSpacer?.className).not.toContain("invisible");
    expect(loudSpacer?.querySelector("svg")).not.toBeNull();

    // Same box either way — that IS the alignment. `size-3.5` since
    // 2026-09-19: the marker became a 14px ArrowUpCircle, and
    // `DesktopServerPill` centres its 8px status dot in a slot of this same
    // width so the two footer rows still start their text at one x.
    expect(quietSpacer?.className).toContain("size-3.5");
    expect(loudSpacer?.className).toContain("size-3.5");
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
    await waitFor(() => expect(screen.getByText("Subshell Server App 0.8.0")).toBeTruthy());
    // The slot is always in the layout for alignment; "no news" is the slot
    // being `invisible`. Asserting `.bg-warning` here would now pass
    // vacuously — that class no longer exists anywhere.
    expect(container.querySelector("span[aria-hidden]")?.className).toContain("invisible");
    expect(screen.queryByText(/available/)).toBeNull();
  });

  /**
   * "No update known" is not "up to date" — the daily check may not have run
   * today or may not have answered — so the version line is a DOOR to the
   * screen that can find out (operator's call, 2026-09-18). It was the last
   * place in the app where knowing the version led nowhere, and it is the same
   * fix the tray item's "Check for Updates…" label got the same day.
   */
  it("is still a door when there is no update known", async () => {
    setUA(SERVER_UA);
    const invocations = fakeTauri({ currentVersion: "0.7.2", availableVersion: null });
    renderRow();
    // The visible text is a version, which does not say it is pressable — the
    // accessible name has to carry the act. "no update known" is not "up to
    // date", and the page it opens is where an admin finds out.
    const row = await screen.findByRole("button", { name: "Subshell Server App 0.7.2. Open updates." });
    fireEvent.click(row);
    await waitFor(() => expect(landedOn).toBe("/settings/updates"));
    // It goes to the PAGE, never straight at the bundled window: inside this
    // app that page folds the app and Server rows into one and its own control
    // opens the assistant, which stays the only surface allowed to install.
    expect(invocations.filter((i) => i.command === "desktop_open_assistant")).toEqual([]);
    expect(invocations.filter((i) => i.command === "desktop_install_app_update")).toEqual([]);
  });

  /**
   * A member cannot open `/settings/updates` — it is one of the nine admin
   * routes — but replacing THIS app is not an admin-only act, and the
   * assistant has always opened for anyone. Making the row inert for them
   * took away their only in-page route to it (review, 2026-09-19), so the
   * destination follows what the person can actually reach.
   */
  it("sends a member to the assistant instead of an admin route", async () => {
    setUA(SERVER_UA);
    const invocations = fakeTauri({ currentVersion: "0.7.2", availableVersion: "0.8.0" });
    renderRow(false, false);
    const row = await screen.findByRole("button", {
      name: "Subshell Server App 0.7.2 — v0.8.0 available. Check for updates.",
    });
    fireEvent.click(row);
    expect(invocations).toContainEqual({ command: "desktop_open_assistant", args: { screen: "update" } });
    // And NOT the admin page, which would render nothing for them.
    expect(landedOn).toBeNull();
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
      name: "Subshell Server App 0.7.2 — v0.8.0 available. Open updates.",
    });
    // The text is `sr-only` in the rail: readable to a screen reader, and not
    // laid out in 56px.
    expect(button.querySelector(".sr-only")).not.toBeNull();
    fireEvent.click(button);
    await waitFor(() => expect(landedOn).toBe("/settings/updates"));
    expect(invocations.filter((i) => i.command === "desktop_open_assistant")).toEqual([]);
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
