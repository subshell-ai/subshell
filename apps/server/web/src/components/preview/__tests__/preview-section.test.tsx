import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PreviewSection } from "@/components/preview/preview-section";
import type { PreviewInfo, UseSubshellPreview } from "@/hooks/use-subshell-preview";
import { publishPreviewFrame } from "@/lib/preview-bus";
import type { SubshellAccess, SubshellView } from "@/types/subshell";

/**
 * The Preview section's render contract (spec §7, task-12 brief Step 1).
 * The section is presentational: it takes the hook's controller as a prop, so
 * these tests fake the controller and drive only what the surface decides -
 * which row shows which verb, what a gated control says about itself, when
 * the canvas is stale, and what never renders on a phone.
 */

const VIEW_REASON = "Opening a forwarded port needs edit access to this subshell.";
const SCREEN_VIEW_REASON = "Virtual display needs edit access to this subshell.";
const SCREEN_PHONE_REASON =
  "View screen is available on larger screens. You can still watch browser frames on this phone.";
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

function mount(
  over: {
    access?: SubshellAccess;
    info?: PreviewInfo;
    subshell?: SubshellView;
    controller?: Partial<UseSubshellPreview>;
    isPhone?: boolean;
    bannerVisibleMs?: number;
  } = {},
) {
  const c = controller({ ...(over.info === undefined ? {} : { info: over.info }), ...over.controller });
  const view = render(
    <PreviewSection
      paneId="pane1"
      access={over.access ?? "owner"}
      subshell={over.subshell}
      preview={c}
      isPhone={over.isPhone}
      bannerVisibleMs={over.bannerVisibleMs}
    />,
  );
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
      info: info({ screen: { display: ":90", rfbPort: 5900 } }),
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

  it("a node with the switch off answers with the switch's remedy, not a silent empty list", () => {
    mount({ info: info({ ports: [], cdpPort: null, nodeEnabled: false, reason: "preview-disabled" }) });
    expect(screen.getByText(SWITCH_OFF_REASON)).toBeTruthy();
  });

  it("the disabled Watch explains itself the way Open and Screen do", () => {
    mount({ info: info({ nodeEnabled: false, reason: "preview-disabled" }) });
    const watch = screen.getByRole("button", { name: "Watch browser" });
    expect(watch.matches(":disabled, [aria-disabled=true]")).toBe(true);
    expect(watch.getAttribute("aria-description")).toBe(SWITCH_OFF_REASON);
  });
});

describe("Open (edit unlocks it)", () => {
  it("edit opens the panel hosting the proxy iframe and a new-tab link with the proxy href", async () => {
    const { view } = mount({ access: "edit", info: info() });
    fireEvent.click(screen.getAllByRole("button", { name: /^Open web preview/ })[0]);
    await waitFor(() => expect(view.container.querySelector("iframe")).not.toBeNull());
    expect(view.container.querySelector("iframe")?.getAttribute("src")).toBe("/pv/ref1/");
    const link = screen.getByRole("link", { name: /open in new tab/i });
    expect(link.getAttribute("href")).toBe("/pv/ref1/");
  });

  it("the panel closes again", async () => {
    const { view } = mount({ access: "edit", info: info() });
    fireEvent.click(screen.getAllByRole("button", { name: /^Open web preview/ })[0]);
    await waitFor(() => expect(view.container.querySelector("iframe")).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: /close/i }));
    expect(view.container.querySelector("iframe")).toBeNull();
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
    const { view } = mount({ info: info(), controller: { watching: true }, isPhone: false });
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

describe("Watch verbs drive both halves through the controller", () => {
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

  it("while watching, the control stops the watch", async () => {
    let stopped = 0;
    mount({ info: info(), controller: { watching: true, stopWatch: async () => void stopped++ } });
    fireEvent.click(screen.getByRole("button", { name: /stop/i }));
    await waitFor(() => expect(stopped).toBe(1));
  });
});

describe("the screen row", () => {
  it("a live screen shows its display and the Screen action for edit (Task 13's enabled contract; the viewer itself is screen-viewer.test)", () => {
    mount({ access: "edit", info: info({ ports: [], cdpPort: null, screen: { display: ":90", rfbPort: 5901 } }) });
    // One render contract (round-14 MINOR): the row always carries the button;
    // edit clears its reason, and no hint text replaces it.
    expect(screen.getByText("Virtual display :90")).toBeTruthy();
    const button = screen.getByRole("button", { name: "View screen" });
    expect(button.matches(":disabled, [aria-disabled=true]")).toBe(false);
  });

  it("screenLost reads as the loss line, with no Screen control", () => {
    mount({ info: info({ ports: [], cdpPort: null, screenLost: "x11vnc" }) });
    expect(screen.getByText("Display stopped: x11vnc exited")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "View screen" })).toBeNull();
  });
});

describe("phone layouts trade the panel, never Watch", () => {
  it("Screen renders present but disabled on a phone, with the layout as the reason", () => {
    // The ruling after Task 14's mobile walk-through: an enabled Screen press
    // on a phone opened a real lane no panel would ever host, and the press
    // read as a failure. The affordance stays, the reason names the layout,
    // and Watch - the verb a phone CAN serve - stays enabled beside it.
    mount({
      access: "edit",
      info: info({ screen: { display: ":90", rfbPort: 5900 } }),
      isPhone: true,
    });
    const showScreen = screen.getByRole("button", { name: "View screen" });
    expect(showScreen.matches(":disabled, [aria-disabled=true]")).toBe(true);
    expect(showScreen.getAttribute("aria-description")).toBe(SCREEN_PHONE_REASON);
    const watch = screen.getByRole("button", { name: "Watch browser" });
    expect(watch.matches(":disabled, [aria-disabled=true]")).toBe(false);
  });

  it("prepares a real link on phones so a slow request cannot become a blocked popup", async () => {
    const { view } = mount({ access: "edit", info: info(), isPhone: true });
    fireEvent.click(screen.getAllByRole("button", { name: /^Open web preview/ })[0]);
    const link = await screen.findByRole("link", { name: "Open port 3000 in new tab" });
    expect(link.getAttribute("href")).toBe("/pv/ref1/");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(view.container.querySelector("iframe")).toBeNull();
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
    render(<PreviewSection paneId="pane1" access="owner" subshell={shared} preview={controller({ info: info() })} />);
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
      fill
      initialView={{ kind: "app", port: 3000 }}
      isPhone={false}
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
      fill
      initialView={{ kind: "app", port: 3000 }}
      isPhone={false}
    />,
  );
  expect(opened).toEqual([3000]);
});

it("replaces an app view when the browser watch is selected", async () => {
  let starts = 0;
  mount({
    info: info(),
    isPhone: false,
    controller: {
      startWatch: async () => {
        starts += 1;
      },
    },
  });
  fireEvent.click(screen.getAllByRole("button", { name: /^Open web preview/ })[0]);
  await screen.findByText("Web preview");
  fireEvent.click(screen.getByRole("button", { name: "Watch browser" }));
  expect(starts).toBe(1);
  expect(screen.queryByText("Web preview") === null).toBe(true);
});

it("keeps the chooser free of a toolbar and shows it only after opening a view", async () => {
  const c = controller({ info: info() });
  render(<PreviewSection paneId="pane1" access="owner" preview={c} fill isPhone={false} />);
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
  render(<PreviewSection paneId="pane1" access="owner" preview={c} fill isPhone={false} />);
  fireEvent.click(screen.getAllByRole("button", { name: /^Open web preview/ })[0]);
  const first = await screen.findByTitle("Preview of port 3000");
  fireEvent.load(first);
  expect(screen.getByRole("button", { name: "Web preview loaded" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Refresh view" }));
  expect(screen.getByTitle("Preview of port 3000").isSameNode(first)).toBe(false);
  expect(opened).toBe(1);
});
