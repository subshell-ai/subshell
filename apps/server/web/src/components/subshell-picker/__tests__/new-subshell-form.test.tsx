import { afterEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { emptyNewSubshellForm, type NewSubshellFormValue } from "@/components/subshell-picker/launch-form-rules";
import { NewSubshellForm } from "@/components/subshell-picker/new-subshell-form";

/**
 * The pre-fill and scoping contract of the shared launch form. The
 * agent/preset grid and the form's defaults live in the sibling suite under
 * components/__tests__ — this file owns the working-directory defaults.
 *
 * `mockEndpoints` serves every endpoint the form reads; recentPaths is what
 * varies. The node list answers with a healthy `local` row on purpose: the
 * directory pre-fill deliberately will not ARM until the node query has
 * settled (review round 2 — arming on the mount default's scope while the
 * list is in flight could strand a directory from a node the pick later
 * leaves, with a one-way flag and no way to re-arm). The real node list also
 * means a loaded-zero agent list fires the form's honest-hint branch,
 * which renders a `<Link>` — hence the memory-router wrapper on every
 * render here.
 */
function mockEndpoints(paths: { path: string; label: string | null }[]) {
  const original = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = ((input: unknown) => {
    const url = String(input);
    urls.push(url);
    if (url.includes("/api/files/recent")) {
      return Promise.resolve(new Response(JSON.stringify({ paths, home: null })));
    }
    if (url.includes("/api/nodes")) {
      const local = {
        id: "local",
        name: "Server",
        kind: "local",
        os: null,
        arch: null,
        hostname: null,
        status: "online",
        lastSeenAt: null,
        agentVersion: null,
        protocolVersion: null,
        access: "owner",
        canManage: true,
        canLaunch: true,
        capabilities: [],
        harnesses: [],
        inventoryStale: false,
      };
      return Promise.resolve(new Response(JSON.stringify({ nodes: [local] })));
    }
    if (url.includes("/api/plugins")) {
      return Promise.resolve(new Response(JSON.stringify({ plugins: [] })));
    }
    return Promise.resolve(new Response(JSON.stringify([]))); // /api/presets, /api/subshells
  }) as typeof fetch;
  const restore = (() => {
    globalThis.fetch = original;
  }) as (() => void) & { urls: string[] };
  restore.urls = urls;
  return restore;
}

/** Flush pending query/effect updates inside act() (50 ms is generous for
 *  Promise.resolve-backed mocks; keeps "not wrapped in act" out of the log). */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });
}

/** A controlled parent like /new and the dialog. */
async function renderForm(initial: NewSubshellFormValue) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Harness() {
    const [value, setValue] = useState(initial);
    setter = setValue;
    return <NewSubshellForm value={value} onChange={setValue} />;
  }
  const rootRoute = createRootRoute();
  const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: Harness });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
    defaultPreload: false,
  });
  // RouterProvider paints nothing until the router has loaded once.
  await router.load();
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  await settle();
}

/** The live controlled parent — writing to it is what a picker's press does. */
let setter: ((v: NewSubshellFormValue | ((v: NewSubshellFormValue) => NewSubshellFormValue)) => void) | null = null;

const dir = () => screen.getByLabelText("Working directory") as HTMLInputElement;

describe("NewSubshellForm working-dir pre-fill", () => {
  afterEach(cleanup);

  it("fills an empty working dir with the most recent path", async () => {
    const restore = mockEndpoints([
      { path: "/srv/app", label: "app" },
      { path: "/srv/older", label: null },
    ]);
    try {
      await renderForm(emptyNewSubshellForm());
      await waitFor(() => expect(dir().value).toBe("/srv/app"));
    } finally {
      restore();
    }
  });

  it("never overwrites a working dir the caller already set", async () => {
    const restore = mockEndpoints([{ path: "/srv/app", label: null }]);
    try {
      await renderForm({ ...emptyNewSubshellForm(), workingDir: "/keep/me" });
      expect(dir().value).toBe("/keep/me");
    } finally {
      restore();
    }
  });

  it("stays empty when the user has no history yet", async () => {
    const restore = mockEndpoints([]);
    try {
      await renderForm(emptyNewSubshellForm());
      expect(dir().value).toBe("");
    } finally {
      restore();
    }
  });

  it("scopes the recent-paths query to the selected node", async () => {
    const restore = mockEndpoints([{ path: "/srv/remote", label: null }]);
    try {
      await renderForm({ ...emptyNewSubshellForm(), nodeId: "node-7" });
      await waitFor(() => expect(dir().value).toBe("/srv/remote"));
      const recentUrl = restore.urls.find((u) => u.includes("/api/files/recent"));
      expect(recentUrl).toContain("node=node-7");
    } finally {
      restore();
    }
  });

  it("respects a user typing over the pre-fill (applies once per mount)", async () => {
    const restore = mockEndpoints([{ path: "/srv/app", label: null }]);
    try {
      await renderForm(emptyNewSubshellForm());
      await waitFor(() => expect(dir().value).toBe("/srv/app"));
      fireEvent.change(dir(), { target: { value: "" } }); // deliberate clear
      await settle();
      expect(dir().value).toBe("");
    } finally {
      restore();
    }
  });
});

/** A well-formed agent-node row the picker can select. */
const BOX = {
  id: "node-9",
  name: "Box",
  kind: "agent",
  os: "linux",
  arch: "x64",
  hostname: "box",
  status: "online",
  lastSeenAt: null,
  agentVersion: "0.14.0",
  protocolVersion: 12,
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

/**
 * Serves `local` instantly and node-9 on a released promise, with TWO
 * selectable machines so the Machine pick exists. The hold is the whole
 * point: the switch happens while `local`'s recents answer is still the
 * freshest data in the cache, so the fill after the switch can only come
 * from an answer that KNOWS which machine it describes.
 */
function mockTwoNodes() {
  const original = globalThis.fetch;
  let releaseNode9: ((v: unknown) => void) | null = null;
  const node9 = new Promise<unknown>((r) => {
    releaseNode9 = r;
  });
  globalThis.fetch = ((input: unknown) => {
    const url = String(input);
    if (url.includes("/api/files/recent")) {
      if (url.includes("node=node-9")) {
        return node9.then((body) => new Response(JSON.stringify(body)));
      }
      return Promise.resolve(new Response(JSON.stringify({ paths: [{ path: "/srv/app", label: null }], home: null })));
    }
    if (url.includes("/api/nodes")) {
      const local = {
        id: "local",
        name: "Server",
        kind: "local",
        os: null,
        arch: null,
        hostname: null,
        status: "online",
        lastSeenAt: null,
        agentVersion: null,
        protocolVersion: null,
        access: "owner",
        canManage: true,
        canLaunch: true,
        capabilities: [],
        harnesses: [],
        inventoryStale: false,
        maintenance: false,
      };
      return Promise.resolve(new Response(JSON.stringify({ nodes: [local, BOX] })));
    }
    if (url.includes("/api/plugins")) {
      return Promise.resolve(new Response(JSON.stringify({ plugins: [] })));
    }
    return Promise.resolve(new Response(JSON.stringify([]))); // /api/presets, /api/subshells
  }) as typeof fetch;
  return {
    restore: () => (globalThis.fetch = original),
    release: (body: unknown) => releaseNode9?.(body),
  };
}

describe("NewSubshellForm machine switch", () => {
  afterEach(cleanup);

  it("drops the previous machine's directory on the switch and re-seeds from the new one", async () => {
    // The directory is a claim about the SELECTED machine's filesystem. A
    // pick that survives the switch is a path the new machine probably does
    // not have — today it survives, the picker opens on it, and the person
    // waits for a remote 404 before they can start over. (Operator report,
    // 2026-09-20.)
    const { restore, release } = mockTwoNodes();
    try {
      await renderForm(emptyNewSubshellForm());
      await waitFor(() => expect(dir().value).toBe("/srv/app"));
      // Exactly what the Machine select's handler emits.
      await act(async () => {
        setter?.((v) => ({ ...v, nodeId: "node-9" }));
      });
      // Gone at once, and it stays empty while node-9's own query is still
      // in flight — the recents key re-scoped with the pick, so the machine
      // just left has no answer to fill this one with.
      await settle();
      expect(dir().value).toBe("");
      release({ paths: [{ path: "/node9/work", label: null }], home: null });
      await waitFor(() => expect(dir().value).toBe("/node9/work"));
    } finally {
      restore();
    }
  });

  it("keeps a caller-supplied node+directory pair on mount", async () => {
    // The clone dialog pre-fills a PAIR. The clear rides a machine CHANGE,
    // not a mount — clearing here would throw away the thing the clone was
    // asked to reuse.
    const { restore, release } = mockTwoNodes();
    try {
      release({ paths: [], home: null });
      await renderForm({ ...emptyNewSubshellForm(), nodeId: "node-9", workingDir: "/keep/me" });
      await settle();
      expect(dir().value).toBe("/keep/me");
    } finally {
      restore();
    }
  });
});
