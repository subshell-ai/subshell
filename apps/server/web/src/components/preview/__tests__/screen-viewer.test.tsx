import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { PREVIEW_CLOSE_REASONS } from "@internal/subshell-protocol";
import * as novncReal from "@novnc/novnc";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { nodeReasonLine, SCREEN_VIEW_REASON } from "@/components/preview/port-list";
import { PreviewSection } from "@/components/preview/preview-section";
import { SCREEN_CLOSE_LINES, ScreenViewer } from "@/components/preview/screen-viewer";
import type { PreviewInfo, UseSubshellPreview } from "@/hooks/use-subshell-preview";
import { setConsoleErrorObserver } from "@/test-setup";

/**
 * The Screen viewer and its control (spec §6, §7; Task 13).
 *
 * The RFB class is mocked at the module: what this surface owns is the
 * WEBSOCKET (its URL, its lifecycle, its close event), and the point of the
 * hand-the-socket construction is exactly that the wire's reason word reaches
 * OUR listener. So the mock records what it was handed and stays out of the
 * way. The module mock is restored per test so a serial run's later files get
 * the real class back (the enroll-route.test.ts snapshot pattern). The file's
 * last describe is the one exception: it pins the bun patch on the REAL class,
 * and the eager `novncReal` import is how it reaches it untouched by the mock.
 *
 * Each disconnect word is fed the way it ACTUALLY arrives (Task 10's wire
 * shape): every word rides pv-ws's close event (code 1011, the word verbatim
 * in `reason`), while `viewer-left` never rides a close. It is what our own
 * disconnect causes: the socket ends with nothing on it, and the component
 * says so. `revoked` gets its own named line, not a generic loss. `over-cap`
 * too: it means the byte-limit death (the node's frame guard, or the plane's
 * oversized message), which rides the word. Only the lane-COUNT refusal is
 * wordless, answered with a 503 at the upgrade before any close exists.
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

/**
 * A raw channel shaped exactly as noVNC's Websock wants it: the property list
 * `core/websock.js` checks on attach, parked at CONNECTING (0) so the real
 * RFB constructor reaches the code under test and stops there, no handshake,
 * no pump, no timers. It doubles as the `WebSocket` the URL form opens for
 * itself. Only the patch-pin describe uses it.
 */
class PatchProbeChannel {
  binaryType = "";
  onerror: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: unknown) => void) | null = null;
  onopen: (() => void) | null = null;
  protocol = "";
  readyState = 0;
  send(): void {}
  close(): void {}
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
  // Every protocol word is dispatch-rendered, not just map-tested: the
  // listener's lookup path is half of the contract. `over-cap` earns its row
  // here the same way as the rest, because its byte-limit deaths (the node's
  // frame guard, the plane's oversized message) ride the wire word.
  for (const word of Object.keys(SCREEN_CLOSE_LINES) as (keyof typeof SCREEN_CLOSE_LINES)[]) {
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
    expect(new Set(Object.keys(SCREEN_CLOSE_LINES))).toEqual(new Set(PREVIEW_CLOSE_REASONS));
    const lines = PREVIEW_CLOSE_REASONS.map((reason) => SCREEN_CLOSE_LINES[reason]);
    for (const line of lines) expect(line.length).toBeGreaterThan(0);
    expect(new Set(lines).size).toBe(lines.length);
  });

  it("a close carrying a word the protocol never defines reads as a lost link, not a named cause", () => {
    render(<ScreenViewer display=":90" proxyBase="/pv/ref1/" onClose={() => {}} />);
    act(() => {
      MockSocket.made[0].dispatchClose(1011, "not-a-reason-of-ours");
    });
    expect(screen.getByText(/closed before/i)).toBeTruthy();
    expect(screen.queryByText(SCREEN_CLOSE_LINES["over-cap"])).toBeNull();
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
    expect(screen.queryByRole("button", { name: "View screen" })).toBeNull();
    cleanup();
    render(<PreviewSection paneId="pane1" access="edit" preview={controller()} isPhone={false} />);
    expect(screen.getByRole("button", { name: "View screen" })).toBeTruthy();
  });

  it("enabled-ness follows edit", () => {
    render(<PreviewSection paneId="pane1" access="edit" preview={controller()} isPhone={false} />);
    expect(screen.getByRole("button", { name: "View screen" }).matches(":disabled, [aria-disabled=true]")).toBe(false);
    cleanup();
    render(<PreviewSection paneId="pane1" access="view" preview={controller()} isPhone={false} />);
    const gated = screen.getByRole("button", { name: "View screen" });
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
    const screenButton = screen.getByRole("button", { name: "View screen" });
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
    fireEvent.click(screen.getByRole("button", { name: "View screen" }));
    await waitFor(() => expect(opens).toEqual([5901]));
    expect(opens).toHaveLength(1);
    // The answer's proxyBase is the tunnel root the viewer dials, and the
    // post-launch info refresh is what makes the fresh session's state land.
    await waitFor(() => expect(MockSocket.made[0]?.url).toBe(tunnelUrl("/pv/screen-ref/")));
    expect(MockRFB.builds).toHaveLength(1);
    expect(refreshes).toBe(1);
  });
});

describe("teardown on the paths that keep the instance alive", () => {
  /** The live viewer's handle: its Disconnect button, which only the mounted viewer has. */
  function viewerAlive(): boolean {
    return screen.queryByRole("button", { name: /disconnect/i }) !== null;
  }

  it("StrictMode's simulated cleanup burns no close line into the viewer that survives it", () => {
    // main.tsx wraps the whole app in StrictMode, and dev React double-invokes
    // the effect on the SAME instance. The cleanup's own socket close must not
    // be read as a cause: the viewer never died, and a line burned here poisons
    // every later genuine close (leftRef is a ref, so it survives the swap).
    render(
      <StrictMode>
        <ScreenViewer display=":90" proxyBase="/pv/ref1/" onClose={() => {}} />
      </StrictMode>,
    );
    // The double-invoke really happened: the discarded first socket, then the live one.
    expect(MockSocket.made).toHaveLength(2);
    expect(screen.queryByText(/closed/i)).toBeNull();
    expect(viewerAlive()).toBe(true);
    // And the live socket's own wordless close still reads as what it is.
    act(() => {
      MockSocket.made[1].dispatchClose(1006, "");
    });
    expect(screen.getByText(/closed before/i)).toBeTruthy();
    expect(screen.queryByText(/you closed this preview/i)).toBeNull();
  });

  it("repointing the pane in place drops the screen session and the open panel with it", async () => {
    // The mount site (subshells_.$id.tsx) holds no key on the Section: swipe
    // navigation changes `paneId` on the SAME instance. Carrying pane A's
    // state into B would render A's live VNC under B's name forever, and
    // RFB's pump keeps pv-ws from ever idling the lane, pinning the slot.
    const preview = controller({
      info: info({ ports: [{ proto: "tcp", port: 8080, pid: 4242 }] }),
      openPort: async (port) => ({ proxyBase: port === 5901 ? "/pv/screen-ref/" : "/pv/port-ref/" }),
    });
    const view = render(<PreviewSection paneId="paneA" access="edit" preview={preview} isPhone={false} />);
    fireEvent.click(screen.getByRole("button", { name: "View screen" }));
    await waitFor(() => expect(viewerAlive()).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Open app" }));
    await waitFor(() => expect(screen.getByText("Port 8080")).toBeTruthy());
    view.rerender(<PreviewSection paneId="paneB" access="edit" preview={preview} isPhone={false} />);
    expect(viewerAlive()).toBe(false);
    expect(screen.queryByText("Port 8080")).toBeNull();
  });

  it("an open whose pane changes mid-POST cannot repopulate the new pane", async () => {
    // Both presses are in flight when the page repoints; the answers belong
    // to the pane the user left, not the one now on screen.
    const resolvers: ((v: { proxyBase: string }) => void)[] = [];
    const preview = controller({
      info: info({ ports: [{ proto: "tcp", port: 8080, pid: 4242 }] }),
      openPort: () => new Promise((resolve) => void resolvers.push(resolve)),
    });
    const view = render(<PreviewSection paneId="paneA" access="edit" preview={preview} isPhone={false} />);
    fireEvent.click(screen.getByRole("button", { name: "View screen" }));
    fireEvent.click(screen.getByRole("button", { name: "Open app" }));
    expect(resolvers).toHaveLength(2);
    view.rerender(<PreviewSection paneId="paneB" access="edit" preview={preview} isPhone={false} />);
    await act(async () => {
      resolvers[0]?.({ proxyBase: "/pv/late-screen/" });
      resolvers[1]?.({ proxyBase: "/pv/late-port/" });
    });
    expect(viewerAlive()).toBe(false);
    expect(MockSocket.made).toHaveLength(0);
    expect(screen.queryByText("Port 8080")).toBeNull();
  });
});

/**
 * The pin on `patches/@novnc%2Fnovnc@1.7.0.patch` (operator ruling 2026-10-23,
 * from the feature's leg log): on a plain-http LAN origin the Screen session
 * works fine, so noVNC must not print "noVNC requires a secure context (TLS).
 * Expect crashes!" for OUR construction. The patch narrows that warning to
 * URL mode, where noVNC opens its own socket and will later reach for crypto
 * and clipboard APIs the insecure context genuinely withholds.
 *
 * These two tests run the REAL class (the eager `novncReal` import, not the
 * module mock) through the console observer the preload installs, because
 * noVNC binds `console.error` at its own import and a spy attached afterward
 * could never see the line. The URL-mode row is the permanent positive
 * control: if a future `bun install` silently drops patches/ the socket row
 * fails; if the capture itself ever dies, this row fails. Neither assertion
 * can pass vacuously.
 */
describe("the secure-context warning speaks only in URL mode", () => {
  const RealRFB = novncReal.default;

  /** The plain-http shape: a page whose origin is not a secure context. */
  function withPlainHttpPage<T>(run: () => T): T {
    const holder = window as unknown as { isSecureContext?: unknown };
    const previous = Object.getOwnPropertyDescriptor(window, "isSecureContext");
    Object.defineProperty(window, "isSecureContext", { value: false, configurable: true, writable: true });
    try {
      return run();
    } finally {
      if (previous) Object.defineProperty(window, "isSecureContext", previous);
      else delete holder.isSecureContext;
    }
  }

  /** Everything `console.error` carried while `run` went through, one line per call. */
  function errorLinesFrom(run: () => void): string[] {
    const lines: string[] = [];
    setConsoleErrorObserver((args) => lines.push(args.map(String).join(" ")));
    try {
      run();
    } finally {
      setConsoleErrorObserver(null);
    }
    return lines;
  }

  it("the hand-the-socket form, the one Screen uses, logs nothing about the context", () => {
    const lines = errorLinesFrom(() =>
      withPlainHttpPage(() => {
        void new RealRFB(document.createElement("div"), new PatchProbeChannel() as unknown as WebSocket);
      }),
    );
    expect(lines.some((line) => line.includes("secure context") || line.includes("Expect crashes"))).toBe(false);
  });

  it("URL mode still carries the warning, which keeps this capture honest about it", () => {
    const previousWebSocket = globalThis.WebSocket;
    // URL mode opens its own socket; the probe channel answers for that too.
    globalThis.WebSocket = PatchProbeChannel as unknown as typeof WebSocket;
    try {
      const lines = errorLinesFrom(() =>
        withPlainHttpPage(() => {
          void new RealRFB(document.createElement("div"), "ws://plane.invalid/pv/probe/" as unknown as WebSocket);
        }),
      );
      expect(lines.some((line) => line.includes("Expect crashes"))).toBe(true);
    } finally {
      globalThis.WebSocket = previousWebSocket;
    }
  });
});

it("opens a cached screen shortcut once under StrictMode, including in a phone workspace tab", async () => {
  const ports: number[] = [];
  const c = controller({
    info: info({ screen: { display: ":90", rfbPort: 5910 } }),
    openPort: async (port) => {
      ports.push(port);
      return { proxyBase: "/pv/shortcut/" };
    },
  });
  render(
    <StrictMode>
      <PreviewSection paneId="pane1" access="owner" preview={c} initialView={{ kind: "screen" }} isPhone fill />
    </StrictMode>,
  );
  await screen.findByText("Screen preview");
  expect(ports).toEqual([5910]);
  expect(MockSocket.made.filter((socket) => socket.closed === 0)).toHaveLength(1);
});
