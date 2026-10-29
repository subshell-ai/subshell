import { afterEach, describe, expect, it } from "bun:test";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PreviewSection } from "@/components/preview/preview-section";
import type { PreviewInfo, UseSubshellPreview } from "@/hooks/use-subshell-preview";
import { publishPreviewFrame } from "@/lib/preview-bus";
import type { SubshellAccess, SubshellView } from "@/types/subshell";

/**
 * The preview tab's render contract (spec §7). The section is
 * presentational: it takes the hook's controller as a prop, so these tests
 * fake the controller and drive only what the surface decides - which row
 * shows which verb, what a gated control says about itself, when the canvas
 * is stale, and how the toolbar's Close routes to the dock tab.
 */

const VIEW_REASON = "Opening a forwarded port needs edit access to this subshell.";
const SCREEN_VIEW_REASON = "Virtual display needs edit access to this subshell.";
const SWITCH_OFF_REASON =
  "Web previews & screens is switched off on this node. Its owner can turn it on in node settings.";

function controller(over: Partial<UseSubshellPreview> = {}): UseSubshellPreview {
  return {
    info: undefined,
    infoLoading: false,
    error: null,
    watching: false,
    watchError: null,
    openPort: async () => ({ proxyBase: "/pv/ref1/" }),
    startWatch: async () => {},
    stopWatch: async () => {},
    refresh: () => {},
    ...over,
  };
}

function info(over: Partial<PreviewInfo> = {}): PreviewInfo {
  return {
    ports: [
      { proto: "tcp", port: 3000, pid: 11 },
      { proto: "tcp6", port: 9333, pid: 12 },
    ],
    cdpPort: 9333,
    screen: null,
    nodeEnabled: true,
    ...over,
  };
}

function row(over: Partial<SubshellView> = {}): SubshellView {
  return {
    id: "pane1",
    name: "pane",
    status: "running",
    alive: true,
    nodeId: "node1",
    lastOutputAt: null,
    waitingSince: null,
    unseenPush: false,
    access: "owner",
    ssh: false,
    ...over,
  } as unknown as SubshellView;
}

type MountProps = Exclude<Parameters<typeof mount>[0], undefined>;

function sectionProps(over: MountProps, c: UseSubshellPreview) {
  return (
    <PreviewSection
      paneId="pane1"
      access={over.access ?? "owner"}
      subshell={over.subshell}
      preview={c}
      onClose={over.onClose ?? (() => {})}
      initialView={over.initialView}
      bannerVisibleMs={over.bannerVisibleMs}
    />
  );
}

function mount(
  over: {
    access?: SubshellAccess;
    info?: PreviewInfo;
    subshell?: SubshellView;
    controller?: Partial<UseSubshellPreview>;
    bannerVisibleMs?: number;
    initialView?: Parameters<typeof PreviewSection>[0]["initialView"];
    onClose?: () => void;
  } = {},
) {
  const c = controller({ ...(over.info === undefined ? {} : { info: over.info }), ...over.controller });
  const view = render(sectionProps(over, c));
  return { view, c };
}

/**
 * The same mount under a router. The switch's remedy line carries a
 * "Open node settings" link, and a `Link` with no router above it throws, so
 * every test here up to now passed no `subshell` at all - which is precisely
 * why the link's own gating was never exercised. `row()` supplies the pane the
 * link needs.
 */
async function mountRouted(over: MountProps) {
  const c = controller({ ...(over.info === undefined ? {} : { info: over.info }), ...over.controller });
  const rootRoute = createRootRoute();
  // The section rides a route component, not RouterProvider's children: this
  // version paints children only while loading, so the idiom the launch
  // harness uses is the one that actually renders.
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => sectionProps(over, c),
  });
  const nodeRoute = createRoute({ getParentRoute: () => rootRoute, path: "/nodes/$id", component: () => null });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, nodeRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
    defaultPreload: false,
  });
  await router.load();
  const view = render(<RouterProvider router={router} />);
  return { view, c };
}

afterEach(() => {
  cleanup();
  localStorage.removeItem("subshell.trustNoticesSeen");
  // A test may have swapped the clock; always leave the real one behind.
  const holder = globalThis as { __restoreNow?: () => void };
  if (holder.__restoreNow) {
    holder.__restoreNow();
    delete holder.__restoreNow;
  }
});

describe("gated controls explain themselves", () => {
  it("a view grantee sees Open and Screen present but disabled, each with the real reason", () => {
    mount({
      access: "view",
      info: info({ screen: { display: ":90", viewer: { protocol: "vnc", port: 5900 } } }),
    });
    // Two port rows carry two Open controls; the gate is the row-independent
    // fact, so the first one states it.
    // Cast-and-read, this repo's convention: no jest-dom dependency; the
    // disabled-with-reason trio lives on `aria-disabled` + `aria-description`
    // (ExplainedButton).
    const open = screen.getAllByRole("button", { name: /^Open web preview/ })[0];
    expect(open.matches(":disabled, [aria-disabled=true]")).toBe(true);
    expect(open.getAttribute("aria-description")).toBe(VIEW_REASON);
    const watch = screen.getByRole("button", { name: "Watch browser" });
    expect(watch.matches(":disabled, [aria-disabled=true]")).toBe(false);
    const showScreen = screen.getByRole("button", { name: "View screen" });
    expect(showScreen.matches(":disabled, [aria-disabled=true]")).toBe(true);
    expect(showScreen.getAttribute("aria-description")).toBe(SCREEN_VIEW_REASON);
  });

  it.each([{ webPreviewsEnabled: false, virtualDisplayEnabled: true, reason: "Web previews are disabled" }])(
    "links the enablement guide for an individually disabled feature even with no discovered views: %j",
    (state) => {
      mount({
        info: info({
          ports: [],
          cdpPort: null,
          screen: null,
          nodeEnabled: true,
          webPreviewsEnabled: state.webPreviewsEnabled,
          virtualDisplayEnabled: state.virtualDisplayEnabled,
        }),
      });
      expect(screen.getByText(new RegExp(state.reason)).matches(".text-warning")).toBe(true);
      expect(screen.getByRole("link", { name: "How to enable web previews and screens" }).getAttribute("href")).toBe(
        "https://docs.subshell.sh/previews/setup",
      );
    },
  );

  it.each([undefined, { kind: "service" as const, port: 8006, serviceId: "proxmox" }])(
    "does not send web-preview users to virtual-display settings: %j",
    async (initialView) => {
      const calls: unknown[] = [];
      await mountRouted({
        subshell: row(),
        initialView,
        info: info({ ports: [], cdpPort: null, webPreviewsEnabled: true, virtualDisplayEnabled: false }),
        controller: {
          openPort: async (...args) => {
            calls.push(args);
            return { proxyBase: "/pv/proxmox/" };
          },
        },
      });
      if (initialView) await waitFor(() => expect(calls.length).toBe(1));
      expect(screen.queryByText(/Virtual displays are disabled/)).toBeNull();
      expect(screen.queryByRole("link", { name: "Open node settings" })).toBeNull();
      expect(screen.queryByRole("link", { name: "How to enable web previews and screens" })).toBeNull();
    },
  );

  it("a node with the switch off answers with the switch's remedy, not a silent empty list", () => {
    mount({ info: info({ ports: [], cdpPort: null, nodeEnabled: false, reason: "preview-disabled" }) });
    expect(screen.getByText(SWITCH_OFF_REASON)).toBeTruthy();
  });

  /**
   * The colour of the switch's own sentence (operator ruling 2026-10-26). Gold
   * marks a control someone can turn on, and the line beside it is the guide
   * that says who and where; a node that is simply unreachable is not a
   * setting, so it keeps the muted colour and no link. Colour and link are the
   * whole assertion here: the sentence itself is tested above.
   */
  it("says a switched-off node in gold with the guide beside it, and an unreachable one in muted", () => {
    mount({ info: info({ ports: [], cdpPort: null, nodeEnabled: false, reason: "preview-disabled" }) });
    expect(screen.getByText(SWITCH_OFF_REASON).matches(".text-warning")).toBe(true);
    expect(screen.getByRole("link", { name: /How to enable web previews and screens/ }).getAttribute("href")).toBe(
      "https://docs.subshell.sh/previews/setup",
    );
    cleanup();
    mount({ info: info({ ports: [], cdpPort: null, nodeEnabled: false, reason: "node-offline" }) });
    expect(screen.getByText(/This node is offline/).matches(".text-warning")).toBe(false);
    expect(screen.queryByRole("link", { name: /How to enable web previews and screens/ })).toBeNull();
  });

  it("colours the node's own switch answer gold, and its silence about the machine muted", () => {
    // Two producers of one fact. The plane answers the node's master switch with
    // `preview-disabled`; the node answers it itself with a named word and the
    // explanation attached, which the prefix rule has to catch or the same
    // setting reads muted on one path and gold on the other.
    mount({
      info: info({
        ports: [],
        cdpPort: null,
        nodeEnabled: false,
        reason: "preview-node-off: turn on Preview for this node",
      }),
    });
    expect(screen.getByText(/switched off on this node/).matches(".text-warning")).toBe(true);
    expect(screen.getByRole("link", { name: /How to enable web previews and screens/ })).toBeTruthy();
  });

  it("offers the jump to the switch on every path that names it", async () => {
    // The gold sentence and the "Open node settings" link are one answer: the
    // switch is off, and here is where to turn it. Matching the note by prefix
    // and the link by whole string left the node's own named word
    // (`preview-node-off: turn on Preview for this node`) explaining the setting
    // without offering the way to it, which is the pair disagreeing again.
    await mountRouted({ info: info({ nodeEnabled: false, reason: "preview-disabled" }), subshell: row() });
    expect(screen.getByRole("link", { name: "Open node settings" })).toBeTruthy();
    cleanup();
    await mountRouted({
      info: info({ nodeEnabled: false, reason: "preview-node-off: turn on Preview for this node" }),
      subshell: row(),
    });
    expect(screen.getByRole("link", { name: "Open node settings" })).toBeTruthy();
    cleanup();
    for (const reason of [undefined, "preview-ports-unsupported"]) {
      await mountRouted({ info: info({ nodeEnabled: true, reason, webPreviewsEnabled: false }), subshell: row() });
      expect(screen.getByRole("link", { name: "Open node settings" })).toBeTruthy();
      cleanup();
    }
    // And not for a node that is merely unreachable: there is no switch to find.
    await mountRouted({ info: info({ nodeEnabled: false, reason: "node-offline" }), subshell: row() });
    expect(screen.queryByRole("link", { name: "Open node settings" })).toBeNull();
  });

  it("the disabled Watch explains itself the way Open and Screen do", () => {
    mount({ info: info({ nodeEnabled: false, reason: "preview-disabled" }) });
    const watch = screen.getByRole("button", { name: "Watch browser" });
    expect(watch.matches(":disabled, [aria-disabled=true]")).toBe(true);
    expect(watch.getAttribute("aria-description")).toBe(SWITCH_OFF_REASON);
  });
});

describe("Open (edit unlocks it)", () => {
  it("edit opens the panel hosting the proxy iframe", async () => {
    const { view } = mount({ access: "edit", info: info() });
    fireEvent.click(screen.getAllByRole("button", { name: /^Open web preview/ })[0]);
    await waitFor(() => expect(view.container.querySelector("iframe")).not.toBeNull());
    expect(view.container.querySelector("iframe")?.getAttribute("src")).toBe("/pv/ref1/");
  });

  it("the toolbar's Close view hands the dock tab its close", async () => {
    let closed = 0;
    mount({
      access: "edit",
      info: info(),
      onClose: () => {
        closed += 1;
      },
    });
    // Opening resolves asynchronously and mounts the menu trigger. Flush that
    // render and its effects before interacting with the newly mounted menu.
    await act(async () => {
      fireEvent.click(screen.getAllByRole("button", { name: /^Open web preview/ })[0]);
    });
    await screen.findByTitle("Preview of port 3000");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "More view actions" }));
    });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Close view" }));
    expect(closed).toBe(1);
  });
});

describe("the Watch canvas", () => {
  function canvas(container: HTMLElement) {
    return container.querySelector("[data-preview-canvas]");
  }

  it("swaps to the newest frame and ignores a lower seq", async () => {
    const { view } = mount({ info: info(), controller: { watching: true } });
    publishPreviewFrame({ type: "preview-stream", id: "pane1", seq: 2, w: 10, h: 8, blob: "AA-BB-CC" });
    await waitFor(() => expect(canvas(view.container)?.getAttribute("data-seq")).toBe("2"));
    publishPreviewFrame({ type: "preview-stream", id: "pane1", seq: 3, w: 10, h: 8, blob: "DD-EE" });
    await waitFor(() => expect(canvas(view.container)?.getAttribute("data-seq")).toBe("3"));
    expect(canvas(view.container)?.getAttribute("data-bytes")).toBe("5");
    publishPreviewFrame({ type: "preview-stream", id: "pane1", seq: 1, w: 10, h: 8, blob: "OLD-BLOB-X" });
    expect(canvas(view.container)?.getAttribute("data-seq")).toBe("3");
    expect(canvas(view.container)?.getAttribute("data-bytes")).toBe("5");
  });

  it("ignores frames for other panes", async () => {
    const { view } = mount({ info: info(), controller: { watching: true } });
    publishPreviewFrame({ type: "preview-stream", id: "other-pane", seq: 9, w: 1, h: 1, blob: "X" });
    // Give any mis-wired subscription a chance to land before calling absence an assert.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(canvas(view.container)?.getAttribute("data-seq")).not.toBe("9");
  });

  it("a fake clock past 5 s with no frame reads stale, and the fps/age badge freezes with it", async () => {
    const realNow = Date.now;
    let fake = 100_000;
    Date.now = () => fake;
    (globalThis as { __restoreNow?: () => void }).__restoreNow = () => {
      Date.now = realNow;
    };
    const { view } = mount({ info: info(), controller: { watching: true } });
    // A tiny tick so the badge recomputes against the fake clock in test time.
    const badge = () => view.container.querySelector("[data-preview-badge]");
    publishPreviewFrame({ type: "preview-stream", id: "pane1", seq: 1, w: 10, h: 8, blob: "AA-BB" });
    await waitFor(() => expect(canvas(view.container)?.getAttribute("data-seq")).toBe("1"));
    // A second frame a simulated second later: the badge must read age off
    // the NEWEST arrival, not mount time and not the first frame. At fake
    // 101 s the newest stamp is 101 s, so the line says "0.0 s ago"; an age
    // anchored at mount or at the first frame would say 1.0 s instead.
    fake = 101_000;
    publishPreviewFrame({ type: "preview-stream", id: "pane1", seq: 2, w: 10, h: 8, blob: "AA-BB-CC" });
    await waitFor(() => expect(canvas(view.container)?.getAttribute("data-seq")).toBe("2"));
    const frozen = badge()?.firstChild?.textContent;
    expect(frozen).toMatch(/\d\.\d fps/);
    expect(frozen).toMatch(/· 0\.0 s ago/);
    // 5 s after the newest arrival: stale.
    fake = 106_001;
    await waitFor(() => expect(screen.getByText(/still there\?/i).textContent).toMatch(/still there\?/i), {
      timeout: 2000,
    });
    // Frozen while stale: the clock line holds its last live reading (the
    // first text node; the stale span appended beside it is the notice, not
    // the clock).
    expect(badge()?.firstChild?.textContent).toBe(frozen);
    // The canvas itself stays: a stale page, not a vanished one.
    expect(canvas(view.container)?.getAttribute("data-seq")).toBe("2");
  });

  it("cdpPort vanishing mid-watch says the browser is gone beside the stale canvas", () => {
    const { view } = mount({
      access: "view",
      info: info({ ports: [], cdpPort: null }),
      controller: { watching: true },
    });
    expect(screen.getByText(/browser is no longer running/i)).toBeTruthy();
    expect(canvas(view.container)).not.toBeNull();
  });

  it("a refused watch renders the named REST error, and no canvas claims frames", () => {
    mount({
      info: info(),
      controller: { watchError: "watch-port-conflict: the bridge is already streaming another port" },
    });
    expect(screen.getByRole("alert").textContent).toContain("watch-port-conflict");
  });
});

it("pressing Watch starts it on the browser row's port", async () => {
  let asked: number | undefined;
  mount({
    info: info(),
    controller: {
      startWatch: async (port) => {
        asked = port;
      },
    },
  });
  fireEvent.click(screen.getByRole("button", { name: "Watch browser" }));
  await waitFor(() => expect(asked).toBe(9333));
});

describe("the screen row", () => {
  it("a live screen offers the Screen action for edit (Task 13's enabled contract; the viewer itself is screen-viewer.test)", () => {
    mount({
      access: "edit",
      info: info({ ports: [], cdpPort: null, screen: { display: ":90", viewer: { protocol: "vnc", port: 5901 } } }),
    });
    // One render contract (round-14 MINOR): the choice always carries the
    // button; edit clears its reason, and no hint text replaces it.
    expect(screen.getByText("Virtual display")).toBeTruthy();
    const button = screen.getByRole("button", { name: "View screen" });
    expect(button.matches(":disabled, [aria-disabled=true]")).toBe(false);
  });

  it("screenLost reads as the loss line, with no Screen control", () => {
    mount({ info: info({ ports: [], cdpPort: null, screenLost: "x11vnc" }) });
    expect(screen.getByText("Display stopped: x11vnc exited")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "View screen" })).toBeNull();
  });
});

describe("the shared-pane banner variant", () => {
  it("raises once per device on first Preview open, and stays down after", async () => {
    const shared = row({ shareCount: 2, sharedWithEveryone: false });
    const { view } = mount({ info: info(), subshell: shared, bannerVisibleMs: 30 });
    // The PREVIEW variant's own copy: it says this surface shows more than the terminal.
    expect(screen.getByText(/live view/i)).toBeTruthy();
    // Retire it (auto-fade + mark-seen runs at visibleMs + the fade). The cap is
    // generous on purpose: the dwell is 30 ms, so the only thing this waits past
    // is the event loop, not the product. In the SERIAL CI run every test file
    // shares one process, and earlier files' leaked global timers make the loop
    // crawl - a 2 s cap timed out on CI twice while the parallel local run flew
    // (measured 2026-10-23: 29 s to format the failure). The 10 s cap above sits
    // PAST bun's 5 s default test budget, so the test also carries an explicit
    // 45 s budget (third arg): without it the loop starvation cut the test off
    // at 5 s while the waitFor was still patient (both CI retries, measured).
    // The disappearance poll asserts a BOOLEAN: `expect(node).toBeNull()` makes
    // bun serialize the whole happy-dom graph on every failed poll, which is the
    // 30 s-per-failure the CI run showed even with the cap (2026-10-23: 30350 ms
    // for this test, formatting, on a job that ran the rest in 68 s). A banner
    // that truly never retired would still fail here at the cap.
    await waitFor(() => expect(screen.queryByText(/shared this subshell with 2 other people/i) === null).toBe(true), {
      timeout: 10000,
    });
    view.unmount();
    mount({ info: info(), subshell: shared });
    expect(screen.queryByText(/shared this subshell with 2 other people/i) === null).toBe(true);
  }, 45000);

  it("says nothing when the pane is private", () => {
    mount({ info: info(), subshell: row({ shareCount: 0 }) });
    expect(screen.queryByText(/shared/i)).toBeNull();
  });
});

describe("unsupported discovery", () => {
  it("explains the platform limit instead of promising ports will appear", () => {
    mount({ info: info({ ports: [], cdpPort: null, nodeEnabled: true, reason: "preview-ports-unsupported" }) });
    expect(screen.getByText(/doesn’t support automatic port discovery/)).toBeTruthy();
    expect(screen.queryByText(/Nothing to preview yet/)).toBeNull();
  });
});

it("fills a preview tab and resumes its selected app only once", async () => {
  const opened: number[] = [];
  const c = controller({
    info: info(),
    openPort: async (port) => {
      opened.push(port);
      return { proxyBase: "/pv/tab/" };
    },
  });
  const view = render(
    <PreviewSection
      paneId="pane1"
      access="owner"
      preview={c}
      initialView={{ kind: "app", port: 3000 }}
      onClose={() => {}}
    />,
  );
  await screen.findByTitle("Preview of port 3000");
  expect(screen.queryByText("Web preview") === null).toBe(true);
  expect(screen.getByRole("region", { name: "Web previews & screens" }).className).toContain("h-full");
  view.rerender(
    <PreviewSection
      paneId="pane1"
      access="owner"
      preview={c}
      initialView={{ kind: "app", port: 3000 }}
      onClose={() => {}}
    />,
  );
  expect(opened).toEqual([3000]);
});

it("keeps the chooser free of a toolbar and shows it only after opening a view", async () => {
  const c = controller({ info: info() });
  render(<PreviewSection paneId="pane1" access="owner" preview={c} onClose={() => {}} />);
  expect(screen.getAllByRole("button", { name: /^Open web preview/ }).length).toBeGreaterThan(0);
  expect(screen.queryByRole("button", { name: "Open another preview" }) === null).toBe(true);
  expect(screen.queryByRole("button", { name: "Refresh view" }) === null).toBe(true);
  fireEvent.click(screen.getAllByRole("button", { name: /^Open web preview/ })[0]);
  await screen.findByTitle("Preview of port 3000");
  expect(screen.getByRole("button", { name: "Refresh view" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: /^Open web preview/ }) === null).toBe(true);
});

it("refreshes the selected app without allocating another forwarded lane", async () => {
  let opened = 0;
  const c = controller({
    info: info(),
    openPort: async () => {
      opened += 1;
      return { proxyBase: "/pv/one-lane/" };
    },
  });
  render(<PreviewSection paneId="pane1" access="owner" preview={c} onClose={() => {}} />);
  fireEvent.click(screen.getAllByRole("button", { name: /^Open web preview/ })[0]);
  const first = await screen.findByTitle("Preview of port 3000");
  fireEvent.load(first);
  expect(screen.getByRole("button", { name: "Web preview loaded" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Refresh view" }));
  expect(screen.getByTitle("Preview of port 3000").isSameNode(first)).toBe(false);
  expect(opened).toBe(1);
});
