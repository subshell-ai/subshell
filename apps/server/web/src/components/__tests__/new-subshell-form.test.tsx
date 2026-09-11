import { afterEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import {
  canSubmit,
  emptyNewSubshellForm,
  NewSubshellForm,
  type NewSubshellFormValue,
  pickNodeDefault,
  suggestDecision,
} from "@/components/subshell-picker/new-subshell-form";
import { toSubshellCreateBody } from "@/hooks/use-create-subshell";
import type { Node } from "@/types/node";

/**
 * The paired node×profile launch form (spec 2026-09-02 §1): searchable
 * pickers, incompatible options greyed with a reason (the grey grid itself
 * is pinned in lib/__tests__/subshell-compat.test.ts), pin-as-suggestion,
 * and the honest empty-state hints. Assertions run on form state and the
 * DOM around the inputs — the closed state is now an <input> whose value is
 * not a text node; the picker's real behavior is e2e-pinned (12-nodes).
 */
function node(overrides: Partial<Node>): Node {
  return {
    id: "n",
    name: "node",
    kind: "agent",
    os: null,
    arch: null,
    hostname: null,
    status: "online",
    lastSeenAt: null,
    agentVersion: null,
    protocolVersion: null,
    access: "owner",
    canManage: true,
    capabilities: [],
    harnesses: [],
    inventoryStale: false,
    ...overrides,
  };
}

const CLAUDE = { harnessId: "claude-code", name: "Claude Code", enabled: true, installed: true };
const LOCAL = node({ id: "local", name: "this host", kind: "local", access: "view", harnesses: [CLAUDE] });
const AGENT_ONLINE = node({ id: "a1", name: "mac mini", status: "online", harnesses: [CLAUDE] });
const AGENT_INCOMPAT = node({ id: "a3", name: "studio", harnesses: [] });
const AGENT_OFFLINE = node({ id: "a2", name: "old laptop", status: "offline", harnesses: [CLAUDE] });

/** One profile row; only the fields the form reads. */
function profile(p: { nodeId?: string | null; name?: string; id?: string; harnessId?: string }) {
  return {
    id: p.id ?? "p1",
    harnessId: p.harnessId ?? "claude-code",
    name: p.name ?? "prof",
    description: null,
    envJson: null,
    flagsJson: null,
    settingsJson: null,
    configIsolation: 0,
    restartOnExit: 0,
    isDefault: 0,
    nodeId: p.nodeId ?? null,
  };
}

/** Pathname+search of the most recent /api/profiles request — the wire pin. */
let lastProfilesUrl: string | null = null;

/** The `/api/files/recent` answer, or a function of the requested node scope. */
type RecentStub = { paths: { path: string; label: string | null }[]; home: string | null };

function mockFetch(
  nodes: Node[],
  profiles: unknown[] = [],
  recent: RecentStub | ((node: string | null) => RecentStub) = { paths: [], home: null },
) {
  lastProfilesUrl = null;
  const original = globalThis.fetch;
  globalThis.fetch = ((input: unknown) => {
    const url = new URL(String(input), "http://localhost");
    const path = url.pathname;
    if (path === "/api/nodes") return Promise.resolve(new Response(JSON.stringify({ nodes })));
    if (path === "/api/profiles") {
      lastProfilesUrl = path + url.search;
      return Promise.resolve(new Response(JSON.stringify(profiles)));
    }
    if (path === "/api/files/recent") {
      const scope = url.searchParams.get("node");
      const body = typeof recent === "function" ? recent(scope) : recent;
      return Promise.resolve(new Response(JSON.stringify(body)));
    }
    return Promise.resolve(new Response(JSON.stringify({})));
  }) as typeof fetch;
  return () => (globalThis.fetch = original);
}

/** Flush pending query/effect updates inside act() — 50 ms is generous for
 *  these Promise.resolve-backed mocks, and it keeps "not wrapped in act" out
 *  of the log (see the ffe50bc warning-flood fix). */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });
}

/**
 * The form is fully caller-controlled; this harness owns the state it would.
 * `holdValue` ignores onChange instead — pinning the render to `initial` so a
 * test can probe what the hint gate itself decides about a pair the live form
 * would have re-homed away from (e.g. an offline pick).
 */
async function renderForm(initial: NewSubshellFormValue = emptyNewSubshellForm(), holdValue = false) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let latest: NewSubshellFormValue = initial;
  function Harness() {
    const [value, setValue] = useState<NewSubshellFormValue>(initial);
    latest = value;
    return <NewSubshellForm value={value} onChange={holdValue ? () => {} : setValue} />;
  }
  // The honest hints render `<Link>`s (a router context is required) — the
  // same minimal memory-router wrapper the local-launch-card test uses.
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
  // Let the initial queries (nodes, profiles) land inside act(): their
  // results rebuild the combobox items and fire Base UI internal state syncs
  // that would otherwise apply outside act and flood the log with warnings.
  await settle();
  return { latest: () => latest };
}

afterEach(cleanup);

describe("pickNodeDefault", () => {
  it("keeps a valid pick and the local default while local is present", () => {
    const nodes = [LOCAL, AGENT_ONLINE, AGENT_OFFLINE];
    expect(pickNodeDefault(nodes, "local")).toBe("local");
    expect(pickNodeDefault(nodes, "a1")).toBe("a1");
  });
  it("falls to the sole selectable option when local vanished", () => {
    expect(pickNodeDefault([AGENT_ONLINE, AGENT_OFFLINE], "local")).toBe("a1");
  });
  it("forces an explicit choice when local vanished and several nodes remain", () => {
    expect(pickNodeDefault([AGENT_ONLINE, AGENT_INCOMPAT], "local")).toBe("");
  });
});

/**
 * Pin-as-suggestion (spec 2026-09-02 §1): the caller only hands in an EARNED
 * suggestion (row visible, selectable, compatible) — the decision function
 * keeps the old anchor's bookkeeping: explicit picks outrank, release falls
 * back only while the suggestion still owns the pick.
 */
describe("suggestDecision", () => {
  it("holds the suggested node while the user stays silent", () => {
    expect(suggestDecision({ suggestion: AGENT_ONLINE, explicit: false, current: "local", anchoredTo: null })).toEqual({
      nodeId: "a1",
      anchoredTo: "a1",
    });
  });
  it("an explicit pick — the suggested node included — outranks the suggestion", () => {
    const d = suggestDecision({ suggestion: AGENT_ONLINE, explicit: true, current: "local", anchoredTo: "a1" });
    expect(d.nodeId).toBe("local");
  });
  it("releases an unearned suggestion back to local (only while it still owns the pick)", () => {
    expect(suggestDecision({ suggestion: null, explicit: false, current: "a1", anchoredTo: "a1" }).nodeId).toBe(
      "local",
    );
    expect(suggestDecision({ suggestion: null, explicit: true, current: "a1", anchoredTo: "a1" }).nodeId).toBe("a1");
    expect(suggestDecision({ suggestion: null, explicit: false, current: "local", anchoredTo: "a1" }).nodeId).toBe(
      "local",
    );
  });
});

describe("NewSubshellForm pairing + defaults", () => {
  it("defaults to Local, is submittable, and the Node field comes first", async () => {
    const restore = mockFetch([LOCAL, AGENT_ONLINE, AGENT_OFFLINE], [profile({})]);
    try {
      const { latest } = await renderForm();
      expect(screen.getByPlaceholderText("Choose a node")).toBeDefined();
      await waitFor(() => expect(latest().nodeId).toBe("local"));
      const labels = Array.from(document.querySelectorAll("label"), (l) => l.textContent);
      expect(labels.indexOf("Node")).toBeLessThan(labels.indexOf("Profile"));
      expect(canSubmit({ profileId: "p1", workingDir: "/tmp/x", name: "", nodeId: "local" })).toBe(true);
      // Wire pin: the form lists profiles across nodes — profiles that only
      // run on another node must still be selectable here (spec §4a).
      expect(lastProfilesUrl).toBe("/api/profiles?node=any");
    } finally {
      restore();
    }
  });

  it("drops to an empty pick (no submit) when local is gone and a choice is due", async () => {
    const restore = mockFetch([AGENT_ONLINE, AGENT_INCOMPAT], [profile({})]);
    try {
      const { latest } = await renderForm();
      // BOTH nodes are selectable (studio is online — `isSelectable` never
      // consults harnesses), so the unchanged rule yields "an explicit
      // choice is due": the pick empties and submit stays blocked.
      await waitFor(() => expect(latest().nodeId).toBe(""));
      expect(canSubmit({ profileId: "p1", workingDir: "/tmp/x", name: "", nodeId: "" })).toBe(false);
    } finally {
      restore();
    }
  });

  it("auto-picks the sole selectable node when local is gone (unchanged rule)", async () => {
    const restore = mockFetch([AGENT_ONLINE, AGENT_OFFLINE], [profile({})]);
    try {
      const { latest } = await renderForm();
      await waitFor(() => expect(latest().nodeId).toBe("a1"));
    } finally {
      restore();
    }
  });

  it("a pinned profile suggests its node and forwards it on the wire", async () => {
    const restore = mockFetch([LOCAL, AGENT_ONLINE], [profile({ nodeId: "a1" })]);
    try {
      const { latest } = await renderForm({ profileId: "p1", workingDir: "/tmp/x", name: "", nodeId: "local" });
      await waitFor(() => expect(latest().nodeId).toBe("a1"));
      expect(toSubshellCreateBody(latest()).nodeId).toBe("a1");
    } finally {
      restore();
    }
  });

  it("a suggestion is never earned by an offline node — Local stands", async () => {
    const restore = mockFetch([LOCAL, AGENT_OFFLINE], [profile({ nodeId: "a2" })]);
    try {
      // renderForm already settles queries/effects inside act(); the
      // assertion below is that the suggestion was NOT applied by them.
      const { latest } = await renderForm({ profileId: "p1", workingDir: "/tmp/x", name: "", nodeId: "local" });
      expect(latest().nodeId).toBe("local");
      expect(toSubshellCreateBody(latest()).nodeId).toBe("local");
    } finally {
      restore();
    }
  });

  it("a suggestion is never earned by an incompatible node — Local stands", async () => {
    const restore = mockFetch([LOCAL, AGENT_INCOMPAT], [profile({ nodeId: "a3" })]);
    try {
      // renderForm settles for us — see the offline-suggestion test above.
      const { latest } = await renderForm({ profileId: "p1", workingDir: "/tmp/x", name: "", nodeId: "local" });
      expect(latest().nodeId).toBe("local");
    } finally {
      restore();
    }
  });

  it("no compatible profile on the picked node → the honest hint, with a link", async () => {
    const restore = mockFetch([node({ id: "a1", name: "bare", harnesses: [] })], [profile({})]);
    try {
      await renderForm({ profileId: "", workingDir: "/tmp/x", name: "", nodeId: "a1" });
      // The node name sits inside the hint's <Link>, so the sentence spans
      // multiple nodes — match the paragraph on its full textContent.
      const hint = await screen.findByText(
        (_text, el) => el?.tagName === "P" && /No profiles run on bare/.test(el.textContent ?? ""),
      );
      expect(hint.querySelector("a[href*='/nodes/']")).not.toBeNull();
    } finally {
      restore();
    }
  });

  it("loaded-zero profiles on the picked node → the hint still shows (empty ≠ loading)", async () => {
    const restore = mockFetch([node({ id: "a1", name: "bare", harnesses: [] })], []);
    try {
      await renderForm({ profileId: "", workingDir: "/tmp/x", name: "", nodeId: "a1" });
      // Profiles LOADED with zero rows is exactly the dead-end the hint
      // names; only the undefined (still-loading) signal stays quiet.
      expect(
        await screen.findByText(
          (_text, el) => el?.tagName === "P" && /No profiles run on bare/.test(el.textContent ?? ""),
        ),
      ).toBeDefined();
    } finally {
      restore();
    }
  });

  it("an offline chosen node never gets the 'no profiles run here' misdiagnosis", async () => {
    const restore = mockFetch([LOCAL, AGENT_OFFLINE], [profile({})]);
    try {
      // holdValue pins the pick on the offline node — the live form re-homes
      // it — so this probes the gate itself: the row reasons already say
      // "node offline"; the hint must not claim the node runs no profiles.
      await renderForm({ profileId: "", workingDir: "/tmp/x", name: "", nodeId: "a2" }, true);
      expect(
        screen.queryByText((_text, el) => el?.tagName === "P" && /No profiles run on/.test(el.textContent ?? "")),
      ).toBeNull();
    } finally {
      restore();
    }
  });

  it("profile usable on no visible node → the mirror hint", async () => {
    const restore = mockFetch([AGENT_INCOMPAT], [profile({ id: "p1", name: "orphan" })]);
    try {
      await renderForm({ profileId: "p1", workingDir: "/tmp/x", name: "", nodeId: "a3" });
      expect(await screen.findByText(/No available node runs claude-code/)).toBeDefined();
    } finally {
      restore();
    }
  });

  it("falls back to the node's home directory when there are no recent paths", async () => {
    const restore = mockFetch([LOCAL], [], { paths: [], home: "/home/ada" });
    try {
      const { latest } = await renderForm();
      await waitFor(() => expect(latest().workingDir).toBe("/home/ada"));
    } finally {
      restore();
    }
  });

  it("prefers a recent path over home", async () => {
    const restore = mockFetch([LOCAL], [], { paths: [{ path: "/srv/app", label: null }], home: "/home/ada" });
    try {
      const { latest } = await renderForm();
      await waitFor(() => expect(latest().workingDir).toBe("/srv/app"));
    } finally {
      restore();
    }
  });

  it("never overwrites a directory the caller already holds", async () => {
    const restore = mockFetch([LOCAL], [], { paths: [], home: "/home/ada" });
    try {
      const { latest } = await renderForm({ ...emptyNewSubshellForm(), workingDir: "/typed/by/hand" });
      await settle();
      expect(latest().workingDir).toBe("/typed/by/hand");
    } finally {
      restore();
    }
  });

  it("selects the first launchable profile when none is chosen", async () => {
    // p-term is grey (this host's inventory carries no terminal), so the
    // first LAUNCHABLE option is p-claude — the default reads the same
    // disabled set the dropdown renders, not list order alone.
    const restore = mockFetch([LOCAL], [profile({ id: "p-claude" }), profile({ id: "p-term", harnessId: "terminal" })]);
    try {
      const { latest } = await renderForm();
      await waitFor(() => expect(latest().profileId).toBe("p-claude"));
    } finally {
      restore();
    }
  });

  it("never selects a profile that cannot run on the chosen node", async () => {
    // buildProfileOptions disables what the node cannot run; the auto-select
    // must read that, or it parks the form on a launch the server will refuse.
    const TERM = { harnessId: "terminal", name: "Terminal", enabled: true, installed: true };
    const restore = mockFetch(
      [node({ id: "local", name: "this host", kind: "local", access: "view", harnesses: [TERM] })],
      [profile({ id: "p-claude" }), profile({ id: "p-term", harnessId: "terminal" })],
    );
    try {
      const { latest } = await renderForm();
      await waitFor(() => expect(latest().profileId).toBe("p-term"));
    } finally {
      restore();
    }
  });

  // The review finding this pair pins: `selectedNode` derives from `value`,
  // but pickNodeDefault can move the pick WITHIN the same effect pass (local
  // vanished at mount → sole agent becomes the pick). Reading the disabled
  // set off the stale row left the form parked on a profile the NEW node
  // cannot run — the exact 409 the auto-select promises to avoid — and
  // prefilled the directory from the node being left.
  it("re-homes the pick at mount before deciding the profile default", async () => {
    const TERM = { harnessId: "terminal", name: "Terminal", enabled: true, installed: true };
    const AGENT_ONLY = node({ id: "a1", name: "mac", harnesses: [TERM] });
    const restore = mockFetch(
      [AGENT_ONLY],
      [profile({ id: "p-claude" }), profile({ id: "p-term", harnessId: "terminal" })],
    );
    try {
      const { latest } = await renderForm();
      await waitFor(() => expect(latest().nodeId).toBe("a1"));
      await waitFor(() => expect(latest().profileId).toBe("p-term"));
    } finally {
      restore();
    }
  });

  it("takes the directory default from the node the pick ends up on", async () => {
    const TERM = { harnessId: "terminal", name: "Terminal", enabled: true, installed: true };
    const AGENT_ONLY = node({ id: "a1", name: "mac", harnesses: [TERM] });
    const restore = mockFetch([AGENT_ONLY], [], (n) => ({
      paths: [],
      home: n === "a1" ? "/home/on-a1" : "/home/left-behind",
    }));
    try {
      const { latest } = await renderForm();
      await waitFor(() => expect(latest().workingDir).toBe("/home/on-a1"));
      expect(latest().nodeId).toBe("a1");
    } finally {
      restore();
    }
  });
});

describe("optional subshell name input", () => {
  it("caps the draft at the backend's 120-char rule", async () => {
    const restore = mockFetch([LOCAL]);
    try {
      await renderForm();
      const input = screen.getByLabelText("Subshell name (optional)") as HTMLInputElement;
      expect(input.maxLength).toBe(120);
    } finally {
      restore();
    }
  });
});
