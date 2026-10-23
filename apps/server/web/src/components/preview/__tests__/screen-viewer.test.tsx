import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { PREVIEW_CLOSE_REASONS } from "@internal/subshell-protocol";
import * as novncReal from "@novnc/novnc";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { nodeReasonLine, SCREEN_VIEW_REASON } from "@/components/preview/port-list";
import { PreviewSection } from "@/components/preview/preview-section";
import { SCREEN_CLOSE_LINES, ScreenViewer } from "@/components/preview/screen-viewer";
import type { PreviewInfo, UseSubshellPreview } from "@/hooks/use-subshell-preview";

/**
 * The Screen viewer and its control (spec §6, §7; Task 13).
 *
 * The RFB class is mocked at the module: what this surface owns is the
 * WEBSOCKET (its URL, its lifecycle, its close event), and the point of the
 * hand-the-socket construction is exactly that the wire's reason word reaches
 * OUR listener. So the mock records what it was handed and stays out of the
 * way. The module mock is restored per test so a serial run's later files get
 * the real class back (the enroll-route.test.ts snapshot pattern).
 *
 * Each disconnect word is fed the way it ACTUALLY arrives (Task 10's wire
 * shape): every word rides pv-ws's close event (code 1011, the word verbatim
 * in `reason`), while `viewer-left` never rides a close. It is what our own
 * disconnect causes: the socket ends with nothing on it, and the component
 * says so. `revoked` gets its own named line, not a generic loss.
 */

// Eager static copies taken before any mocking: the restore re-arms the real
// module, and a swapped-out global WebSocket never outlives this file.
const novncSnapshot = { ...novncReal };
const realWebSocket = globalThis.WebSocket;

class MockRFB {
  static builds: MockRFB[] = [];
  scaleViewport = false;
  focusOnClick = false;
  clipViewport = false;
  disconnects = 0;

  constructor(
    readonly target: HTMLElement,
    readonly channel: unknown,
  ) {
    MockRFB.builds.push(this);
  }

  disconnect(): void {
    this.disconnects++;
  }
}

class MockSocket {
  static made: MockSocket[] = [];
  closed = 0;
  readyState = 1;
  private readonly listeners: { type: string; cb: (ev: unknown) => void }[] = [];

  constructor(readonly url: string) {
    MockSocket.made.push(this);
  }

  addEventListener(type: string, cb: (ev: unknown) => void): void {
    this.listeners.push({ type, cb });
  }

  removeEventListener(type: string, cb: (ev: unknown) => void): void {
    const i = this.listeners.findIndex((l) => l.type === type && l.cb === cb);
    if (i >= 0) this.listeners.splice(i, 1);
  }

  /** The browser's own close: the socket ends and the close carries no reason word. */
  close(): void {
    this.closed++;
    this.dispatchClose(1005, "");
  }

  dispatchClose(code: number, reason: string): void {
    for (const l of [...this.listeners]) if (l.type === "close") l.cb({ code, reason });
  }
}

beforeEach(() => {
  MockRFB.builds = [];
  MockSocket.made = [];
  mock.module("@novnc/novnc", () => ({ default: MockRFB }));
  globalThis.WebSocket = MockSocket as unknown as typeof WebSocket;
});

afterEach(() => {
  cleanup();
  mock.module("@novnc/novnc", () => novncSnapshot);
  globalThis.WebSocket = realWebSocket;
});

/** The tunnel root pv-ws serves: the same formula the component must use. */
function tunnelUrl(proxyBase: string): string {
  const wsProto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${wsProto}//${window.location.host}${proxyBase}`;
}

function info(over: Partial<PreviewInfo> = {}): PreviewInfo {
  return {
    ports: [],
    cdpPort: null,
    screen: { display: ":90", rfbPort: 5901 },
    nodeEnabled: true,
    ...over,
  };
}

function controller(over: Partial<UseSubshellPreview> = {}): UseSubshellPreview {
  return {
    info: info(),
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

describe("the viewer owns the socket", () => {
  it("mounts one WebSocket at the session's tunnel root and hands the SOCKET to RFB", () => {
    render(<ScreenViewer display=":90" proxyBase="/pv/ref1/" onClose={() => {}} />);
    expect(MockSocket.made).toHaveLength(1);
    expect(MockSocket.made[0].url).toBe(tunnelUrl("/pv/ref1/"));
    expect(MockRFB.builds).toHaveLength(1);
    const rfb = MockRFB.builds[0];
    // Not a URL string: the component keeps the socket, which is what puts
    // pv-ws's 1011 + reason word within reach of its own listener.
    expect(rfb.channel).toBe(MockSocket.made[0]);
    expect(rfb.scaleViewport).toBe(true);
    expect(rfb.focusOnClick).toBe(true);
    expect(rfb.clipViewport).toBe(false);
  });

  it("unmounting disconnects: RFB let go and the socket closed, which is how the lane reads viewer-left", () => {
    const view = render(<ScreenViewer display=":90" proxyBase="/pv/ref1/" onClose={() => {}} />);
    const [ws] = MockSocket.made;
    const [rfb] = MockRFB.builds;
    view.unmount();
    expect(rfb.disconnects).toBe(1);
    expect(ws.closed).toBe(1);
  });
});

describe("disconnect causes render by name", () => {
  for (const word of ["slow-link", "revoked", "target-gone"] as const) {
    it(`a ${word} close, fed as pv-ws sends it (1011 + the word), renders its own line`, () => {
      render(<ScreenViewer display=":90" proxyBase="/pv/ref1/" onClose={() => {}} />);
      act(() => {
        MockSocket.made[0].dispatchClose(1011, word);
      });
      expect(screen.getByText(SCREEN_CLOSE_LINES[word])).toBeTruthy();
    });
  }

  it("revoked names the access change, not a generic loss", () => {
    expect(SCREEN_CLOSE_LINES.revoked).toMatch(/access/i);
    expect(SCREEN_CLOSE_LINES.revoked).not.toMatch(/connection lost/i);
  });

  it("every protocol close word owns its own line", () => {
    for (const reason of PREVIEW_CLOSE_REASONS) {
      expect(SCREEN_CLOSE_LINES[reason].length).toBeGreaterThan(0);
    }
    const lines = PREVIEW_CLOSE_REASONS.map((reason) => SCREEN_CLOSE_LINES[reason]);
    expect(new Set(lines).size).toBe(lines.length);
  });

  it("the component's own disconnect renders the viewer-left line through the close it causes", () => {
    render(<ScreenViewer display=":90" proxyBase="/pv/ref1/" onClose={() => {}} />);
    const [ws] = MockSocket.made;
    // The path pv-ws reserves for the viewer's own leaving: our close, and a
    // close event with nothing on it. Not a hand-built reason prop.
    fireEvent.click(screen.getByRole("button", { name: /disconnect/i }));
    expect(ws.closed).toBe(1);
    expect(screen.getByText(/you closed this preview/i)).toBeTruthy();
  });

  it("a wordless close we did not start reads as a lost link, never as the user's own leave", () => {
    render(<ScreenViewer display=":90" proxyBase="/pv/ref1/" onClose={() => {}} />);
    act(() => {
      MockSocket.made[0].dispatchClose(1006, "");
    });
    expect(screen.getByText(/closed before/i)).toBeTruthy();
    expect(screen.queryByText(/you closed this preview/i)).toBeNull();
  });
});

describe("the Screen control", () => {
  it("its presence follows info.screen", () => {
    render(
      <PreviewSection
        paneId="pane1"
        access="edit"
        preview={controller({ info: info({ screen: null }) })}
        isPhone={false}
      />,
    );
    expect(screen.queryByRole("button", { name: "Screen" })).toBeNull();
    cleanup();
    render(<PreviewSection paneId="pane1" access="edit" preview={controller()} isPhone={false} />);
    expect(screen.getByRole("button", { name: "Screen" })).toBeTruthy();
  });

  it("enabled-ness follows edit", () => {
    render(<PreviewSection paneId="pane1" access="edit" preview={controller()} isPhone={false} />);
    expect(screen.getByRole("button", { name: "Screen" }).matches(":disabled, [aria-disabled=true]")).toBe(false);
    cleanup();
    render(<PreviewSection paneId="pane1" access="view" preview={controller()} isPhone={false} />);
    const gated = screen.getByRole("button", { name: "Screen" });
    expect(gated.matches(":disabled, [aria-disabled=true]")).toBe(true);
    expect(gated.getAttribute("aria-description")).toBe(SCREEN_VIEW_REASON);
  });

  it("a node with the switch off keeps edit's control present and explains the switch", () => {
    render(
      <PreviewSection
        paneId="pane1"
        access="edit"
        preview={controller({ info: info({ nodeEnabled: false, reason: "preview-disabled" }) })}
        isPhone={false}
      />,
    );
    const screenButton = screen.getByRole("button", { name: "Screen" });
    expect(screenButton.matches(":disabled, [aria-disabled=true]")).toBe(true);
    expect(screenButton.getAttribute("aria-description")).toBe(nodeReasonLine("preview-disabled"));
  });

  it("pressing the enabled control drives exactly one open against rfbPort, mounts the viewer on the answer, and refreshes the poll", async () => {
    const opens: number[] = [];
    let refreshes = 0;
    const preview = controller({
      openPort: async (port) => {
        opens.push(port);
        return { proxyBase: "/pv/screen-ref/" };
      },
      refresh: () => {
        refreshes++;
      },
    });
    render(<PreviewSection paneId="pane1" access="edit" preview={preview} isPhone={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Screen" }));
    await waitFor(() => expect(opens).toEqual([5901]));
    expect(opens).toHaveLength(1);
    // The answer's proxyBase is the tunnel root the viewer dials, and the
    // post-launch info refresh is what makes the fresh session's state land.
    await waitFor(() => expect(MockSocket.made[0]?.url).toBe(tunnelUrl("/pv/screen-ref/")));
    expect(MockRFB.builds).toHaveLength(1);
    expect(refreshes).toBe(1);
  });
});
