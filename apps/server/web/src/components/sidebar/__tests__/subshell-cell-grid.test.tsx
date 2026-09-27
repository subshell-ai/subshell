import { afterEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import {
  flatCellRows,
  nodeTintBucket,
  paneInitial,
  SubshellCell,
  SubshellCellGrid,
} from "@/components/sidebar/subshell-cell-grid";
import type { SubshellNodeGroup } from "@/lib/subshell-node-groups";
import { groupSubshellsByNode } from "@/lib/subshell-node-groups";
import { setFetchRouter } from "@/test-setup";
import type { SubshellView } from "@/types/subshell";

/**
 * The rail's cell view: the dot's state language at grid size. What is pinned
 * here is that a cell is the SAME one language (the dot's fills and bell, not
 * a second encoding), that it keeps the row's full gesture set (nav, drag,
 * tooltip, right-click menu) on one element, and that the two pure helpers
 * behind it stay honest — the pane-initial glyph (hint not key), and a flat
 * grid whose cell SET can never drift from what grouped mode renders while
 * its cells cluster by machine onto one plate.
 */

function sub(overrides: Partial<SubshellView> = {}): SubshellView {
  return {
    id: "s1",
    presetId: null,
    harnessId: "claude-code",
    nodeId: "local",
    nodeOffline: false,
    name: "auth-refactor",
    nameLocked: false,
    workingDir: "/home/theo/projects/auth",
    status: "running",
    createdAt: "2026-09-25T00:00:00.000Z",
    endedAt: null,
    lastOutputAt: null,
    activity: "idle",
    alive: true,
    exitCode: null,
    startedAt: null,
    backoffCount: 0,
    restartOnExit: false,
    nextRestartAt: null,
    notify: true,
    waitingSince: null,
    unseenPush: false,
    access: "owner",
    ...overrides,
  } as SubshellView;
}

function mockFetch(): () => void {
  setFetchRouter(async (input: RequestInfo | URL) => {
    const url = String(typeof input === "string" || input instanceof URL ? input : input.url);
    const body = url.includes("/api/presets") ? [] : url.includes("/api/plugins") ? { plugins: [] } : {};
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  });
  return () => setFetchRouter(null);
}

function renderCell(ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const rootRoute = createRootRoute();
  const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: () => ui });
  const detailRoute = createRoute({ getParentRoute: () => rootRoute, path: "/subshells/$id" });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, detailRoute]),
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
});

describe("paneInitial (the flat grid's glyph)", () => {
  it("is the name's first letter, uppercased", () => {
    expect(paneInitial("auth-refactor")).toBe("A");
    expect(paneInitial("beta")).toBe("B");
  });

  it("is a hint, not a key: two panes sharing a first letter read identically, by design", () => {
    // The collision rule the machine-letter version earned and the single
    // initial inherits harder (many panes start alike): the tooltip is the
    // truth. Pinned so nobody "fixes" this back into per-grid state.
    expect(paneInitial("mac-build")).toBe(paneInitial("mcp-debug"));
  });

  it("answers the empty string for an empty name rather than crashing", () => {
    expect(paneInitial("")).toBe("");
  });
});

describe("nodeTintBucket (the flat grid's machine plate)", () => {
  it("is deterministic — the same name never moves between calls", () => {
    expect(nodeTintBucket("mac-mini")).toBe(nodeTintBucket("mac-mini"));
    const once = nodeTintBucket("Server");
    for (let i = 0; i < 25; i++) expect(nodeTintBucket("Server")).toBe(once);
  });

  it("stays inside the eight-bucket palette for any name", () => {
    const names = ["Server", "mac-mini", "mbp", "", "x", "studio-display", "gcp-a", "gcp-b", "π-π-π", "dev-box-9"];
    for (const name of names) {
      const bucket = nodeTintBucket(name);
      expect(Number.isInteger(bucket)).toBe(true);
      expect(bucket).toBeGreaterThanOrEqual(0);
      expect(bucket).toBeLessThan(8);
    }
  });

  it("spreads realistic labels across several buckets", () => {
    const names = Array.from({ length: 24 }, (_, i) => `node-${i}`);
    const buckets = new Set(names.map(nodeTintBucket));
    expect(buckets.size).toBeGreaterThanOrEqual(4);
  });

  it("keys on the name alone: two different names may share a bucket or differ", () => {
    // The hash is pure over the label — an admin's rename moves a machine's
    // tint when the new name hashes elsewhere (documented in the function),
    // and distinct names are never promised distinct buckets (hint-not-key,
    // same rule as the glyph). No rename LOGIC exists to test, so this pins
    // the input space instead of inventing one.
    const seen = new Map<string, number>();
    for (const name of ["Server", "mac-mini", "mbp", "work-laptop", "studio-mini"]) {
      seen.set(name, nodeTintBucket(name));
    }
    // Same second pass, same answers — purity, not just determinism.
    for (const [name, bucket] of seen) expect(nodeTintBucket(name)).toBe(bucket);
  });
});

describe("flatCellRows (one grid, same set as grouped mode)", () => {
  const rows = [
    sub({ id: "w", nodeId: "n1", activity: "idle", waitingSince: "2026-09-25T00:00:00.000Z" }),
    sub({ id: "a", nodeId: "n1", activity: "active" }),
    sub({ id: "i", nodeId: "n2", activity: "idle" }),
    sub({ id: "t", nodeId: "n2", status: "terminated", alive: false, activity: "terminated" }),
    sub({ id: "c", nodeId: "n1", crossAgent: true, activity: "idle" }),
  ];
  const nodes = [
    { id: "n1", name: "mac-mini" },
    { id: "n2", name: "mbp" },
  ] as never;

  const groups = groupSubshellsByNode(
    rows.filter((r) => r.crossAgent !== true),
    nodes,
    { limit: 8 },
  );
  const comms = rows.filter((r) => r.crossAgent === true);
  // The spotlight carries `w`, which is ALSO inside its group's cap — the
  // dedup below is being tested on a row that appears twice, the common case.
  const w = rows.find((r) => r.id === "w");
  if (!w) throw new Error("fixture broken");
  const spotlight = [w];

  it("bands the grid: notifications, then machine clusters, then comms — a spotlight row shows in its band AND its cluster", () => {
    // Four bands (operator order 2026-09-26): notifications lead, then the
    // machines, then cross-agent comms last. The spotlight is a SIBLING, not an
    // extraction (operator ruling: bands appear AND keep their cluster), so `w`
    // shows TWICE — once in the top band, once inside its n1 run — while the
    // comms pane `c`, partitioned out of every group, shows once in the bottom
    // band. n1 (a waiting row, rank 0) leads the machine band over n2.
    const flat = flatCellRows(groups, comms, spotlight, new Set());
    expect(flat.map((r) => r.id)).toEqual(["w", "w", "a", "i", "t", "c"]);
    const ids = flat.map((r) => r.id);
    expect(ids.filter((x) => x === "w")).toHaveLength(2);
    expect(ids.filter((x) => x === "c")).toHaveLength(1);
  });

  it("orders machine clusters by liveliest member and cells by band within a cluster", () => {
    // No selection, no spotlight: clusters rank like the grouped mode's groups
    // (the MINIMUM status rank across members), n1 ahead of n2, and each
    // cluster's internals follow the shared band order.
    const flat = flatCellRows(groups, comms, [], new Set());
    expect(flat.map((r) => r.id)).toEqual(["w", "a", "i", "t", "c"]);
  });

  it("promotes a cluster holding a selected pane above more-urgent clusters", () => {
    // The selection outranks urgency ACROSS clusters (operator ask 2026-09-27):
    // n2 (idle/terminated, less urgent) leads when its `i` is a workspace pane,
    // even though n1 has the waiting row. Urgency still orders WITHIN each band.
    const flat = flatCellRows(groups, comms, [], new Set(["i"]));
    expect(flat.map((r) => r.id)).toEqual(["i", "t", "w", "a", "c"]);
  });

  it("carries a group's cap through: a row beyond the cap is absent from flat UNLESS the spotlight lists it", () => {
    // The parity rule: grouped mode shows a capped-out row ONLY in the
    // (uncapped) spotlight; flat must show it exactly then, never more, never
    // less. Now it surfaces in the notifications band.
    const many = Array.from({ length: 10 }, (_, i) => sub({ id: `m${i}`, nodeId: "n1", activity: "idle" }));
    const capped = groupSubshellsByNode(many, nodes, { limit: 8 });
    const withoutSpotlight = flatCellRows(capped, [], [], new Set());
    expect(withoutSpotlight).toHaveLength(8);
    expect(withoutSpotlight.map((r) => r.id)).toEqual(many.slice(0, 8).map((r) => r.id));

    const m9 = many.find((r) => r.id === "m9");
    if (!m9) throw new Error("fixture broken");
    const withSpotlight = flatCellRows(capped, [], [m9], new Set());
    expect(withSpotlight.map((r) => r.id)).toContain("m9");
    expect(withSpotlight).toHaveLength(9);
  });

  it("returns an empty grid for no groups", () => {
    expect(flatCellRows([] as SubshellNodeGroup[], [], [], new Set())).toEqual([]);
  });
});

describe("SubshellCell", () => {
  it("is a Link to the subshell, with the status word in its accessible name", async () => {
    const restore = mockFetch();
    try {
      renderCell(
        <SubshellCell subshell={sub()} active={false} labels={{ nodeLabel: "mac-mini", agentLabel: "Claude Code" }} />,
      );
      const link = await screen.findByRole("link");
      expect(link.getAttribute("href")).toBe("/subshells/s1");
      expect(link.getAttribute("aria-label")).toBe("auth-refactor: idle");
      expect(link.getAttribute("draggable")).toBe("true");
    } finally {
      restore();
    }
  });

  it("wears the dot's own fill for its state, and the open one gets a ring", async () => {
    const restore = mockFetch();
    try {
      renderCell(
        <SubshellCell
          subshell={sub({ nodeOffline: true })}
          active
          labels={{ nodeLabel: "mac-mini", agentLabel: "Claude Code" }}
        />,
      );
      const link = await screen.findByRole("link");
      expect(link.className).toContain("bg-destructive");
      // The "you are here" ring is the theme ink (`--foreground`: frost on the
      // void) DIMMED to /70 — the operator's live ask was the full-brightness
      // frost reading as the loudest thing on the rail — not `--ring`
      // (orchid). Focus keeps the ring token, at width 2, so a
      // focused-but-not-selected cell cannot look selected.
      expect(link.className).toContain("ring-1");
      expect(link.className).toContain("ring-foreground/70");
      expect(link.className).toContain("focus-visible:ring-ring");
      // Hover answers "which one am I on" with the same INK at full
      // brightness — the selection reading at its loudest, never the focus
      // orchid (operator ask: cells need a hover outline).
      expect(link.className).toContain("hover:ring-1");
      expect(link.className).toContain("hover:ring-foreground");
    } finally {
      restore();
    }
  });

  it("the blinking cell is a two-state tile: active/idle pulses, a legible letter every beat (operator ask 2026-09-27)", async () => {
    const restore = mockFetch();
    try {
      renderCell(
        <SubshellCell
          subshell={sub({ activity: "active", lastOutputAt: null })}
          active
          labels={{ nodeLabel: "mbp", agentLabel: "Claude Code", initial: "A" }}
        />,
      );
      const link = await screen.findByRole("link");
      // A cell cannot blink to nothing the way the dot does (no letter to
      // strand, no outline to empty), so it blinks BETWEEN two states: a full
      // green ACTIVE tile with a dark initial pulsing over a half-green IDLE
      // tile with a white initial on the opposite beat. Exactly one tile is
      // opaque at any moment, so a box with a readable letter is always there.
      // The anchor carries only posture: relative, a transparent field, and
      // NEITHER a fill nor a pulse of its own (both live on the two child
      // tiles). The interim "green survives as an edge" reading (the ring) and
      // the single-fade reading (empty tile / stranded letter) are both dead.
      const has = (el: Element | undefined, tok: string) => !!el && el.className.split(/\s+/).includes(tok);
      expect(link.className).toContain("relative");
      expect(link.className).toContain("bg-transparent");
      expect(link.className).not.toContain("bg-success");
      expect(link.className).not.toContain("subshell-dot-blink");
      expect(link.className).not.toContain("border-success");

      const spans = [...link.querySelectorAll("span")];
      expect(spans.find((s) => s.className.includes("bg-muted"))).toBeUndefined();

      // The IDLE tile (under): half green, white initial, complementary pulse.
      const idle = spans.find((s) => has(s, "bg-success/50"));
      expect(idle).toBeTruthy();
      expect(has(idle, "subshell-dot-blink-alt")).toBe(true);
      expect(has(idle, "text-foreground")).toBe(true);
      expect(has(idle, "absolute") && has(idle, "inset-0") && has(idle, "rounded-md")).toBe(true);
      expect(idle?.getAttribute("aria-hidden")).toBe("true");
      expect(idle?.textContent).toBe("A");

      // The ACTIVE tile (over): full green, dark initial, the plain pulse.
      const activeTile = spans.find((s) => has(s, "bg-success") && has(s, "subshell-dot-blink"));
      expect(activeTile).toBeTruthy();
      expect(has(activeTile, "subshell-dot-blink-alt")).toBe(false);
      expect(has(activeTile, "text-background")).toBe(true);
      expect(has(activeTile, "absolute") && has(activeTile, "inset-0") && has(activeTile, "rounded-md")).toBe(true);
      expect(activeTile?.getAttribute("aria-hidden")).toBe("true");
      expect(activeTile?.textContent).toBe("A");

      // Exactly one pulse of each kind across the cell, and both carry the
      // initial — so the link's own text reads the letter twice even though a
      // viewer only ever sees one (the visible half differs by opacity, not DOM).
      expect(spans.filter((s) => s.className.includes("subshell-dot-blink-alt"))).toHaveLength(1);
      expect(
        spans.filter((s) => s.className.includes("subshell-dot-blink") && !s.className.includes("-alt")),
      ).toHaveLength(1);
      expect(link.textContent).toBe("AA");
      // The viewed pane still rings on the anchor.
      expect(link.className).toContain("ring-1");
      expect(link.className).toContain("ring-foreground/70");
    } finally {
      restore();
    }
  });

  it("non-blinking states render exactly as before: fill on the anchor, no plate", async () => {
    const restore = mockFetch();
    try {
      renderCell(
        <>
          <SubshellCell subshell={sub({ id: "q" })} active={false} labels={{ nodeLabel: "m", agentLabel: "A" }} />
          <SubshellCell
            subshell={sub({ id: "z", status: "terminated", alive: false, activity: "terminated" })}
            active={false}
            labels={{ nodeLabel: "m", agentLabel: "A" }}
          />
        </>,
      );
      const links = await screen.findAllByRole("link");
      const [idle, ended] = links.map((l) => l as HTMLElement);
      if (!idle || !ended) throw new Error("fixture broke");
      expect(idle.className).toContain("bg-success/50");
      expect(idle.className).not.toContain("bg-muted");
      expect(idle.querySelectorAll("span")).toHaveLength(0);
      // `terminated` stays a hollow ring: border + nothing behind it.
      expect(ended.className).toContain("border-muted-foreground");
      expect(ended.className).not.toContain("bg-muted");
      expect(ended.querySelectorAll("span")).toHaveLength(0);
    } finally {
      restore();
    }
  });

  it("letter color per state: dark on the two solid fills, white elsewhere (delegated ruling 2026-09-27)", async () => {
    const restore = mockFetch();
    try {
      renderCell(
        <>
          <SubshellCell
            subshell={sub({ id: "w", waitingSince: "2026-09-25T00:00:00.000Z" })}
            active={false}
            labels={{ nodeLabel: "m", agentLabel: "A", initial: "W" }}
          />
          <SubshellCell
            subshell={sub({ id: "o", nodeOffline: true })}
            active={false}
            labels={{ nodeLabel: "m", agentLabel: "A", initial: "O" }}
          />
          <SubshellCell
            subshell={sub({ id: "i" })}
            active={false}
            labels={{ nodeLabel: "m", agentLabel: "A", initial: "I" }}
          />
        </>,
      );
      await screen.findAllByRole("link");
      // Scope to each cell's own link (a tooltip wrapper span elsewhere in the
      // document carries no color class and would collide with a document-wide
      // query) and select the letter by the color utility it must wear.
      const linkFor = (t: string) => (screen.getAllByRole("link") as HTMLElement[]).find((l) => l.textContent === t);
      // `waiting` (bg-warning) and `node-offline` (bg-destructive) defeat white
      // (1.34:1 / 2.77:1): a dark knockout.
      expect(linkFor("W")?.querySelector("span.text-background")).not.toBeNull();
      expect(linkFor("W")?.querySelector("span.text-foreground")).toBeNull();
      expect(linkFor("O")?.querySelector("span.text-background")).not.toBeNull();
      // `idle` (bg-success/50) keeps white (4.34:1).
      expect(linkFor("I")?.querySelector("span.text-foreground")).not.toBeNull();
      expect(linkFor("I")?.querySelector("span.text-background")).toBeNull();
    } finally {
      restore();
    }
  });

  it("shows the bell for an owner's unseen push, not the fill or an initial", async () => {
    const restore = mockFetch();
    try {
      renderCell(
        <SubshellCell
          subshell={sub({ unseenPush: true })}
          active={false}
          labels={{ nodeLabel: "mac-mini", agentLabel: "Claude Code", initial: "M" }}
        />,
      );
      const link = await screen.findByRole("link");
      expect(link.querySelector("svg")).toBeTruthy();
      // The initial is REPLACED by the bell, never stacked under it.
      expect(link.textContent).toBe("");
      // And the screen reader hears the bell too (2026-09-25 review): the
      // glyph is aria-hidden, so the accessible name must carry the SAME
      // announcement the dot gives, not just the state word.
      expect(link.getAttribute("aria-label")).toBe("auth-refactor: unseen notification (idle)");
    } finally {
      restore();
    }
  });

  it("keeps a grantee's unseen push a plain cell — the bell is owner-only", async () => {
    const restore = mockFetch();
    try {
      renderCell(
        <SubshellCell
          subshell={sub({ unseenPush: true, access: "view" })}
          active={false}
          labels={{ nodeLabel: "mac-mini", agentLabel: "Claude Code", initial: "A" }}
        />,
      );
      const link = await screen.findByRole("link");
      expect(link.querySelector("svg")).toBeNull();
      expect(link.textContent).toBe("A");
    } finally {
      restore();
    }
  });

  it("carries the pane's initial in flat mode, and nothing in grouped mode", async () => {
    const restore = mockFetch();
    try {
      renderCell(
        <div>
          <SubshellCell
            subshell={sub({ id: "f" })}
            active={false}
            labels={{ nodeLabel: "mbp", agentLabel: "Claude Code", initial: "A" }}
          />
          <SubshellCell
            subshell={sub({ id: "g" })}
            active={false}
            labels={{ nodeLabel: "mbp", agentLabel: "Claude Code" }}
          />
        </div>,
      );
      const links = await screen.findAllByRole("link");
      expect(links[0]?.textContent).toBe("A");
      expect(links[1]?.textContent).toBe("");
    } finally {
      restore();
    }
  });

  it("merges the full-detail tooltip onto the cell itself, hover-reach on focus", async () => {
    const restore = mockFetch();
    try {
      renderCell(
        <SubshellCell subshell={sub()} active={false} labels={{ nodeLabel: "mac-mini", agentLabel: "Claude Code" }} />,
      );
      const link = await screen.findByRole("link");
      expect(link.hasAttribute("data-base-ui-tooltip-trigger")).toBe(true);
      expect(link.getAttribute("title")).toBeNull();
      fireEvent.focus(link);
      // Composed through TooltipLabelledLines: each line is a block whose
      // LABEL is its own bolded span. Anchor on the label, walk up to the
      // popup, and assert the assembled text keeps every line whole.
      const nameLabel = await screen.findByText("Name:");
      expect(nameLabel.className).toContain("font-strong");
      const popup = nameLabel.closest("[class*='bg-popover']");
      expect(popup).not.toBeNull();
      expect(popup?.textContent).toContain("Name: auth-refactor");
      expect(popup?.textContent).toContain("Node: mac-mini");
      expect(popup?.textContent).toContain("Agent: Claude Code");
      expect(popup?.textContent).toContain("Status: idle");
      expect(popup?.textContent).toContain("Directory: /home/theo/projects/auth");
      // The side the operator asked for: the popup opens BELOW the cell, not
      // to its right (a right-side popup lands on the next cell in the rail).
      expect(popup?.getAttribute("data-side")).toBe("bottom");
    } finally {
      restore();
    }
  });
});

describe("SubshellCellGrid", () => {
  it("lays one cell per row in a wrapping grid", async () => {
    const restore = mockFetch();
    try {
      const rows = [sub({ id: "a", name: "one" }), sub({ id: "b", name: "two" })];
      renderCell(
        <SubshellCellGrid
          rows={rows}
          selectedIds={new Set()}
          labelsFor={() => ({ nodeLabel: "mac-mini", agentLabel: "Claude Code" })}
        />,
      );
      await waitFor(() => expect(screen.getAllByRole("link")).toHaveLength(2));
      // The right-click menu wraps each cell in its anchor span, so walk up
      // with `closest` rather than assuming the grid is the parent.
      const links = screen.getAllByRole("link");
      const grid = links[0]?.closest(".flex-wrap");
      expect(grid).not.toBeNull();
      expect(grid).toBe(links[1]?.closest(".flex-wrap"));
      // Every cell navigates; the grid itself is inert.
      expect(screen.getAllByRole("link").map((l) => l.getAttribute("href"))).toEqual(["/subshells/a", "/subshells/b"]);
      // No tint prop, no plate: the grouped grids render cells unwrapped.
      expect(links[0]?.closest("[class*='bg-node-tint']")).toBeNull();
    } finally {
      restore();
    }
  });

  it("plates runs of the same machine like a button group: one plate per run", async () => {
    const restore = mockFetch();
    try {
      // Two mac-mini cells then one mbp cell — the order flatCellRows
      // guarantees (contiguous clusters), so grouping here is by CONSECUTIVE
      // equal tint: same-machine run → ONE shared plate; the machine change
      // starts a new one. Tints stubbed 0/1 so the run boundaries are the
      // fixture's, not hash luck.
      const rows = [
        sub({ id: "a", name: "one", nodeId: "n1" }),
        sub({ id: "b", name: "two", nodeId: "n1" }),
        sub({ id: "c", name: "three", nodeId: "n2" }),
      ];
      renderCell(
        <SubshellCellGrid
          rows={rows}
          selectedIds={new Set()}
          labelsFor={() => ({ nodeLabel: "m", agentLabel: "A" })}
          tintOf={(s) => (s.nodeId === "n1" ? 0 : 1)}
        />,
      );
      const links = await screen.findAllByRole("link");
      const plateA = links[0]?.closest("[class*='bg-node-tint']");
      expect(plateA).not.toBeNull();
      // The shared plate holds BOTH n1 cells, and nothing else.
      expect(plateA?.querySelectorAll("a")).toHaveLength(2);
      expect(links[1]?.closest("[class*='bg-node-tint']")).toBe(plateA);
      const plateC = links[2]?.closest("[class*='bg-node-tint']");
      expect(plateC).not.toBeNull();
      expect(plateC).not.toBe(plateA);
      expect(plateC?.querySelectorAll("a")).toHaveLength(1);
      // Two DIFFERENT tint runs must not sit inside one plate.
      expect(plateA?.className).not.toBe(plateC?.className);
      // Grouped-button shape: outer rounding, 6px inner rhythm matching the
      // GROUPED view's cell-to-cell exactly (operator: "we should have the
      // same gap as we do in the grouped view"), and a 4px tint gutter on ALL
      // sides — the selection ring paints OUTSIDE the cell box, so p-0.5 left
      // it touching the plate edge (p-1 clears ring-1 on every side).
      expect(plateA?.className).toContain("p-1");
      expect(plateA?.className).toContain("gap-1.5");
      expect(plateA?.className).toContain("rounded-lg");
      // Outer rhythm between plates: the SAME 6px as the grouped grid's cells
      // — plate separation reads larger than it is because each plate adds
      // its own 4px gutter (6 + 4 + 4 = 14px cell-to-cell across a boundary).
      expect(plateA?.parentElement?.className).toContain("gap-1.5");
      // The tinted grid's own inset is px-2, NOT the px-3 the plain grid
      // uses: a plate carries a 4px gutter, so px-3 would land the first
      // cell 16px in while headers and grouped cells sit at 12. Two insets,
      // one visual line (operator live review of the flat grid).
      expect(plateA?.parentElement?.className).toContain("px-2");
      // A plate is layout, not semantics: no aria-hidden subtree (that would
      // hide the links), no interactive content beyond the cells.
      expect(plateA?.getAttribute("aria-hidden")).toBeNull();
    } finally {
      restore();
    }
  });

  it("a single-cell machine is just a plate with one cell — no special casing", async () => {
    const restore = mockFetch();
    try {
      renderCell(
        <SubshellCellGrid
          rows={[sub({ id: "a", name: "one", nodeId: "n1" })]}
          selectedIds={new Set()}
          labelsFor={() => ({ nodeLabel: "mac-mini", agentLabel: "A" })}
          tintOf={(s) => nodeTintBucket(s.nodeId ?? "")}
        />,
      );
      const link = await screen.findByRole("link");
      const plate = link.closest("[class*='bg-node-tint']");
      expect(plate).not.toBeNull();
      expect(plate?.querySelectorAll("a")).toHaveLength(1);
    } finally {
      restore();
    }
  });

  it("rings EVERY pane in the selection set, not just one", async () => {
    const restore = mockFetch();
    try {
      const rows = [sub({ id: "a", name: "one" }), sub({ id: "b", name: "two" }), sub({ id: "c", name: "three" })];
      renderCell(
        <SubshellCellGrid
          rows={rows}
          selectedIds={new Set(["a", "c"])}
          labelsFor={() => ({ nodeLabel: "m", agentLabel: "A" })}
        />,
      );
      await waitFor(() => expect(screen.getAllByRole("link")).toHaveLength(3));
      const ringFor = (id: string) =>
        (screen.getAllByRole("link") as HTMLElement[]).find((l) => l.getAttribute("href") === `/subshells/${id}`)
          ?.className;
      // A workspace with several shells open rings them all (operator ask
      // 2026-09-27): the ring is a set membership, not the single focused pane.
      expect(ringFor("a")).toContain("ring-foreground/70");
      expect(ringFor("c")).toContain("ring-foreground/70");
      expect(ringFor("b")).not.toContain("ring-foreground/70");
    } finally {
      restore();
    }
  });
});
