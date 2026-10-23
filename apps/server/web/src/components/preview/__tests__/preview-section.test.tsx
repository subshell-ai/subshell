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
const SCREEN_VIEW_REASON = "Screen preview needs edit access to this subshell.";
const SWITCH_OFF_REASON = "Preview is switched off on this node. Its owner can turn it on in node settings.";

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
    const open = screen.getAllByRole("button", { name: "Open" })[0];
    expect(open.matches(":disabled, [aria-disabled=true]")).toBe(true);
    expect(open.getAttribute("aria-description")).toBe(VIEW_REASON);
    const watch = screen.getByRole("button", { name: "Watch" });
    expect(watch.matches(":disabled, [aria-disabled=true]")).toBe(false);
    const showScreen = screen.getByRole("button", { name: "Screen" });
    expect(showScreen.matches(":disabled, [aria-disabled=true]")).toBe(true);
    expect(showScreen.getAttribute("aria-description")).toBe(SCREEN_VIEW_REASON);
  });

  it("a node with the switch off answers with the switch's remedy, not a silent empty list", () => {
    mount({ info: info({ ports: [], cdpPort: null, nodeEnabled: false, reason: "preview-disabled" }) });
    expect(screen.getByText(SWITCH_OFF_REASON)).toBeTruthy();
  });
});

describe("Open (edit unlocks it)", () => {
  it("edit opens the panel hosting the proxy iframe and a new-tab link with the proxy href", async () => {
    const { view } = mount({ access: "edit", info: info() });
    fireEvent.click(screen.getAllByRole("button", { name: "Open" })[0]);
    await waitFor(() => expect(view.container.querySelector("iframe")).not.toBeNull());
    expect(view.container.querySelector("iframe")?.getAttribute("src")).toBe("/pv/ref1/");
    const link = screen.getByRole("link", { name: /open in new tab/i });
    expect(link.getAttribute("href")).toBe("/pv/ref1/");
  });

  it("the panel closes again", async () => {
    const { view } = mount({ access: "edit", info: info() });
    fireEvent.click(screen.getAllByRole("button", { name: "Open" })[0]);
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
    const frozen = badge()?.textContent;
    expect(frozen).toContain("fps");
    expect(frozen).toContain("ago");
    fake = 105_001;
    await waitFor(() => expect(screen.getByText(/still there\?/i).textContent).toMatch(/still there\?/i), {
      timeout: 2000,
    });
    // Frozen while stale: the clock line holds its last live reading (the
    // first text node; the stale span appended beside it is the notice, not
    // the clock).
    expect(badge()?.firstChild?.textContent).toBe(frozen);
    // The canvas itself stays: a stale page, not a vanished one.
    expect(canvas(view.container)?.getAttribute("data-seq")).toBe("1");
  });

  it("cdpPort vanishing mid-watch says the browser is gone beside the stale canvas", () => {
    const { view } = mount({
      access: "view",
      info: info({ ports: [], cdpPort: null }),
      controller: { watching: true },
    });
    expect(screen.getByText(/browser .*gone/i)).toBeTruthy();
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
    fireEvent.click(screen.getByRole("button", { name: "Watch" }));
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
  it("a live screen shows the launch hint with its DISPLAY for edit, and no dead Screen control", () => {
    mount({ access: "edit", info: info({ ports: [], cdpPort: null, screen: { display: ":90", rfbPort: 5901 } }) });
    expect(screen.getByText(/DISPLAY=:/).textContent).toContain(":90");
    expect(screen.queryByRole("button", { name: "Screen" })).toBeNull();
  });

  it("screenLost reads as the loss line, with no Screen control", () => {
    mount({ info: info({ ports: [], cdpPort: null, screenLost: "x11vnc" }) });
    expect(screen.getByText("Display stopped: x11vnc exited")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Screen" })).toBeNull();
  });
});

describe("phone layouts trade the panel, never Watch", () => {
  it("Open on a phone never renders the panel; it hands the proxy to a new tab. Watch still paints", async () => {
    const opened: string[] = [];
    const originalOpen = window.open;
    window.open = ((url?: string) => {
      if (url) opened.push(url);
      return null;
    }) as typeof window.open;
    try {
      const { view } = mount({
        access: "edit",
        info: info(),
        controller: { watching: true },
        isPhone: true,
      });
      fireEvent.click(screen.getAllByRole("button", { name: "Open" })[0]);
      await waitFor(() => expect(opened).toEqual(["/pv/ref1/"]));
      expect(view.container.querySelector("iframe")).toBeNull();
      expect(view.container.querySelector("[data-preview-canvas]")).not.toBeNull();
    } finally {
      window.open = originalOpen;
    }
  });
});

describe("the shared-pane banner variant", () => {
  it("raises once per device on first Preview open, and stays down after", async () => {
    const shared = row({ shareCount: 2, sharedWithEveryone: false });
    const { view } = mount({ info: info(), subshell: shared, bannerVisibleMs: 30 });
    // The PREVIEW variant's own copy: it says this surface shows more than the terminal.
    expect(screen.getByText(/live view/i)).toBeTruthy();
    // Retire it (auto-fade + mark-seen runs at visibleMs + the fade).
    await waitFor(() => expect(screen.queryByText(/shared this subshell with 2 other people/i)).toBeNull(), {
      timeout: 2000,
    });
    view.unmount();
    render(<PreviewSection paneId="pane1" access="owner" subshell={shared} preview={controller({ info: info() })} />);
    expect(screen.queryByText(/shared this subshell with 2 other people/i)).toBeNull();
  });

  it("says nothing when the pane is private", () => {
    mount({ info: info(), subshell: row({ shareCount: 0 }) });
    expect(screen.queryByText(/shared/i)).toBeNull();
  });
});
