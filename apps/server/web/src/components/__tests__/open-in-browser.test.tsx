/**
 * "Open in browser" — the two SPA surfaces, and the one rule they share.
 *
 * A desktop window is still a webview: no second tab, no profile switcher, no
 * password manager, no "open this in the browser I already trust". So both
 * shells offer a way out to the system browser, and the SPA is where the
 * SPECIFIC page to open is known — the rail opens the current route, a
 * subshell's menu opens that subshell.
 *
 * Both are gated on `isDesktop()`, which is the WIDE question (either shell),
 * because both work in Subshell Client too — its plane window is granted
 * exactly this one command. In a BROWSER neither renders, and that is the
 * assertion that matters: a browser tab already is the browser, so the row
 * would be a control that re-opens the page you are on.
 *
 * Two things the person will notice, neither of which this feature tries to
 * fix (see `apps/server/web/AGENTS.md`): the browser has no session cookie
 * from the webview, so they sign in again; and the server app opens its
 * LOOPBACK origin, where a passkey works only if `APP_BASE_URL` is loopback.
 */
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AppSidebar } from "@/components/app-sidebar";
import * as quickAdd from "@/components/quick-add";
import { SubshellActionsMenu } from "@/components/subshell-actions-menu";
import { resetDesktopShellForTests } from "@/lib/desktop";
import { setFetchRouter } from "@/test-setup";
import type { SubshellView } from "@/types/subshell";

const SERVER_UA = "Mozilla/5.0 SubshellDesktop/0.5.0 (macos; p=1; b=0.5.0)";
const CLIENT_UA = "Mozilla/5.0 SubshellClient/0.3.0 (linux; p=1)";
const BROWSER_UA = "Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15";

const nav = globalThis.navigator as unknown as Record<string, unknown>;
let previousUserAgent: PropertyDescriptor | undefined;

/**
 * Point `navigator.userAgent` at one shell (or none) for the next render.
 *
 * Bun runs a whole test FILE in one process, so the descriptor is captured
 * once and restored in `afterEach` — a UA left overwritten here is the UA the
 * next file's components read.
 */
function setUA(userAgent: string) {
  previousUserAgent ??= Object.getOwnPropertyDescriptor(nav, "userAgent");
  Object.defineProperty(nav, "userAgent", { value: userAgent, configurable: true, writable: true });
  resetDesktopShellForTests();
}

/** Every invoke the page made, so the path argument can be asserted. */
interface Invocation {
  command: string;
  args: Record<string, unknown> | undefined;
}

/**
 * Install a fake `window.__TAURI__`, the same shape `lib/desktop.ts` reads.
 *
 * The bridge never imports `@tauri-apps/api` (the repo forbids the dynamic
 * import and the browser bundle would carry a dependency it can never use), so
 * a plain global is the whole contract to stand in for.
 */
function fakeTauri() {
  const invocations: Invocation[] = [];
  (window as unknown as Record<string, unknown>).__TAURI__ = {
    core: {
      invoke: (command: string, args?: Record<string, unknown>) => {
        invocations.push({ command, args });
        return Promise.resolve(null);
      },
    },
  };
  return invocations;
}

/**
 * Answers every query these surfaces mount, so nothing reaches the network.
 *
 * Through `setFetchRouter` rather than by swapping `globalThis.fetch`: the
 * better-auth client behind `useCurrentUser` binds fetch at MODULE EVALUATION,
 * so a later swap is invisible to it and the session request goes to the real
 * network.
 */
function stubFetch() {
  setFetchRouter(async (input: RequestInfo | URL) => {
    const url = String(typeof input === "string" || input instanceof URL ? input : input.url);
    const body = url.includes("/api/settings/public")
      ? { viewerIsAdmin: false, instanceName: "Plane" }
      : url.includes("get-session")
        ? { user: { id: "u1", name: "Owner", email: "owner@test" } }
        : [];
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  });
  // The rail calls `useQuickAdd()`, which throws outside its provider; the real
  // provider would mount two dialogs and their data, none of it under test.
  const spy = spyOn(quickAdd, "useQuickAdd").mockReturnValue({
    openLaunch: () => {},
    openNewWorkspace: () => {},
  });
  return () => {
    setFetchRouter(null);
    spy.mockRestore();
  };
}

/** The rail, on a route whose path + search is what the row must open. */
async function renderSidebar(initialEntry: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute({ component: () => <AppSidebar forceExpanded /> });
  const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: "/" });
  const subshellRoute = createRoute({ getParentRoute: () => rootRoute, path: "/subshells/$id" });
  const workspacesRoute = createRoute({ getParentRoute: () => rootRoute, path: "/workspaces" });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, subshellRoute, workspacesRoute]),
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
    defaultPreload: false,
  });
  await router.load();
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

function makeSubshell(overrides: Partial<SubshellView> = {}): SubshellView {
  return {
    id: "sub-7",
    presetId: null,
    harnessId: "claude",
    nodeOffline: false,
    name: "subshell",
    nameLocked: false,
    workingDir: "/tmp/project",
    status: "running",
    createdAt: "2026-09-14T00:00:00.000Z",
    endedAt: null,
    lastOutputAt: null,
    activity: "idle",
    alive: true,
    exitCode: null,
    startedAt: null,
    backoffCount: 0,
    restartOnExit: false,
    nextRestartAt: null,
    notify: false,
    waitingSince: null,
    unseenPush: false,
    access: "owner",
    ...overrides,
  };
}

async function renderMenu(subshell: SubshellView) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute();
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => <SubshellActionsMenu subshell={subshell} />,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
    defaultPreload: false,
  });
  await router.load();
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

/** Base UI opens on pointerdown, which happy-dom cannot emulate; ArrowDown is
 *  the keyboard equivalent. */
async function openMenu(subshellName: string) {
  fireEvent.keyDown(screen.getByRole("button", { name: `Actions for ${subshellName}` }), { key: "ArrowDown" });
  await waitFor(() => expect(screen.getAllByRole("menuitem").length).toBeGreaterThan(0));
}

afterEach(() => {
  cleanup();
  if (previousUserAgent) Object.defineProperty(nav, "userAgent", previousUserAgent);
  else delete nav.userAgent;
  previousUserAgent = undefined;
  resetDesktopShellForTests();
  delete (window as unknown as Record<string, unknown>).__TAURI__;
});

describe("the rail's Open in browser row", () => {
  it("opens the CURRENT route, path and search together", async () => {
    const restore = stubFetch();
    try {
      setUA(SERVER_UA);
      const invocations = fakeTauri();
      await renderSidebar("/subshells/sub-7?tab=log");
      fireEvent.click(screen.getByRole("button", { name: "Open in browser" }));
      expect(invocations).toEqual([{ command: "desktop_open_in_browser", args: { path: "/subshells/sub-7?tab=log" } }]);
    } finally {
      restore();
    }
  });

  it("sends a bare path when the route has no search", async () => {
    const restore = stubFetch();
    try {
      setUA(SERVER_UA);
      const invocations = fakeTauri();
      await renderSidebar("/workspaces");
      fireEvent.click(screen.getByRole("button", { name: "Open in browser" }));
      expect(invocations[0]?.args).toEqual({ path: "/workspaces" });
    } finally {
      restore();
    }
  });

  it("renders in Subshell Client too — the command is granted there", async () => {
    const restore = stubFetch();
    try {
      setUA(CLIENT_UA);
      await renderSidebar("/");
      expect(screen.getByRole("button", { name: "Open in browser" })).toBeTruthy();
    } finally {
      restore();
    }
  });

  it("is absent in a browser", async () => {
    const restore = stubFetch();
    try {
      setUA(BROWSER_UA);
      await renderSidebar("/");
      expect(screen.queryByRole("button", { name: "Open in browser" })).toBeNull();
    } finally {
      restore();
    }
  });
});

describe("a subshell's Open in browser item", () => {
  it("opens that subshell's own page", async () => {
    const restore = stubFetch();
    try {
      setUA(SERVER_UA);
      const invocations = fakeTauri();
      await renderMenu(makeSubshell({ id: "sub-42" }));
      await openMenu("subshell");
      fireEvent.click(screen.getByRole("menuitem", { name: "Open in browser" }));
      expect(invocations).toEqual([{ command: "desktop_open_in_browser", args: { path: "/subshells/sub-42" } }]);
    } finally {
      restore();
    }
  });

  it("is offered to an edit grantee, who is exactly who this menu is for", async () => {
    const restore = stubFetch();
    try {
      setUA(CLIENT_UA);
      await renderMenu(makeSubshell({ access: "edit" }));
      await openMenu("subshell");
      expect(screen.getByRole("menuitem", { name: "Open in browser" })).toBeTruthy();
    } finally {
      restore();
    }
  });

  it("is absent in a browser", async () => {
    const restore = stubFetch();
    try {
      setUA(BROWSER_UA);
      await renderMenu(makeSubshell());
      await openMenu("subshell");
      expect(screen.queryByRole("menuitem", { name: "Open in browser" })).toBeNull();
    } finally {
      restore();
    }
  });
});
