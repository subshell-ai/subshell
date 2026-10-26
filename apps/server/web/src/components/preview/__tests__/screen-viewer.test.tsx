import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { PREVIEW_CLOSE_REASONS } from "@internal/subshell-protocol";
import * as novncReal from "@novnc/novnc";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { nodeReasonLine, SCREEN_VIEW_REASON } from "@/components/preview/port-list";
import { PreviewSection } from "@/components/preview/preview-section";
import { SCREEN_CLOSE_LINES, ScreenViewer } from "@/components/preview/screen-viewer";
import type { PreviewInfo, UseSubshellPreview } from "@/hooks/use-subshell-preview";
import { installRfbBounds } from "@/lib/preview-rfb-bounds";
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
 * in `reason`), while `viewer-left` never rides a close. It is what the
 * viewer's own leaving is: the socket ends with nothing on it, and the
 * unmount that ends it has already dropped the viewer, so nothing says so.
 * `revoked` gets its own named line, not a generic loss. `over-cap`
 * too: it means the byte-limit death (the node's frame guard, or the plane's
 * oversized message), which rides the word. Only the lane-COUNT refusal is
 * wordless, answered with a 503 at the upgrade before any close exists.
 */

// Eager static copies taken before any mocking: the restore re-arms the real
// module, and a swapped-out global WebSocket never outlives this file.
const novncSnapshot = { ...novncReal };
const realWebSocket = globalThis.WebSocket;

class MockRFB {
  _FBU = { width: 0, height: 0, encoding: 0 };
  _resize() {}
  _handleRect() {
    return true;
  }
  _fail() {
    this.disconnect();
    return false;
  }
  _display = { _renderQ: [], imageRect() {} };
  static builds: MockRFB[] = [];
  scaleViewport = false;
  focusOnClick = false;
  clipViewport = false;
  disconnects = 0;
  onConnect: (() => void) | undefined;
  addEventListener(type: string, listener: () => void) {
    if (type === "connect") this.onConnect = listener;
  }

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
    screen: { display: ":90", viewer: { protocol: "vnc", port: 5901 } },
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
    render(<ScreenViewer protocol="vnc" proxyBase="/pv/ref1/" />);
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
    const view = render(<ScreenViewer protocol="vnc" proxyBase="/pv/ref1/" />);
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
      render(<ScreenViewer protocol="vnc" proxyBase="/pv/ref1/" />);
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
    render(<ScreenViewer protocol="vnc" proxyBase="/pv/ref1/" />);
    act(() => {
      MockSocket.made[0].dispatchClose(1011, "not-a-reason-of-ours");
    });
    expect(screen.getByText(/closed before/i)).toBeTruthy();
    expect(screen.queryByText(SCREEN_CLOSE_LINES["over-cap"])).toBeNull();
  });

  // There is no in-viewer Disconnect control any more: leaving a preview is
  // closing its tab, which unmounts the viewer (pinned by the unmount test
  // above). The viewer-left LINE stays as the protocol word's mapping: a close
  // that reaches a mounted viewer names its cause, and the wordless test below
  // pins that an empty word is read as a lost link, not as a self-inflicted one.
  it("a wordless close we did not start reads as a lost link, never as the user's own leave", () => {
    render(<ScreenViewer protocol="vnc" proxyBase="/pv/ref1/" />);
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
        onClose={() => {}}
      />,
    );
    expect(screen.queryByRole("button", { name: "View screen" })).toBeNull();
    cleanup();
    render(<PreviewSection paneId="pane1" access="edit" preview={controller()} onClose={() => {}} />);
    expect(screen.getByRole("button", { name: "View screen" })).toBeTruthy();
  });

  it("enabled-ness follows edit", () => {
    render(<PreviewSection paneId="pane1" access="edit" preview={controller()} onClose={() => {}} />);
    expect(screen.getByRole("button", { name: "View screen" }).matches(":disabled, [aria-disabled=true]")).toBe(false);
    cleanup();
    render(<PreviewSection paneId="pane1" access="view" preview={controller()} onClose={() => {}} />);
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
        onClose={() => {}}
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
    render(<PreviewSection paneId="pane1" access="edit" preview={preview} onClose={() => {}} />);
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
  /**
   * The live viewer's handle: the socket it dials. The viewer in the tab
   * carries no Disconnect control (leaving is closing the tab, which the
   * toolbar owns), so liveness is read off the wire: the last socket made,
   * still unclosed.
   */
  function viewerAlive(): boolean {
    const last = MockSocket.made.at(-1);
    return last !== undefined && last.closed === 0;
  }

  it("StrictMode's simulated cleanup burns no close line into the viewer that survives it", () => {
    // main.tsx wraps the whole app in StrictMode, and dev React double-invokes
    // the effect on the SAME instance. The cleanup's own socket close must not
    // be read as a cause: the viewer never died, and a line burned here poisons
    // every later genuine close (the close arrives under the discarded run's own
    // disposal flag, so it is dropped rather than reported).
    render(
      <StrictMode>
        <ScreenViewer protocol="vnc" proxyBase="/pv/ref1/" />
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
    // The tab holds no key on the Section: repointing changes `paneId` on the
    // SAME instance. Carrying pane A's state into B would render A's live VNC
    // under B's name forever, and RFB's pump keeps pv-ws from ever idling the
    // lane, pinning the slot. One committed viewer at a time is the tab
    // shape, so the two drops are walked in sequence: screen, then app.
    const preview = controller({
      info: info({ ports: [{ proto: "tcp", port: 8080, pid: 4242 }] }),
      openPort: async (port) => ({ proxyBase: port === 5901 ? "/pv/screen-ref/" : "/pv/port-ref/" }),
    });
    const view = render(<PreviewSection paneId="paneA" access="edit" preview={preview} onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "View screen" }));
    await waitFor(() => expect(viewerAlive()).toBe(true));
    view.rerender(<PreviewSection paneId="paneB" access="edit" preview={preview} onClose={() => {}} />);
    expect(viewerAlive()).toBe(false);
    // The list returns with the reset, so the app half can be committed and
    // dropped the same way on the fresh pane.
    fireEvent.click(screen.getByRole("button", { name: "Open web preview on port 8080" }));
    await waitFor(() => expect(view.container.querySelector("iframe")).not.toBeNull());
    view.rerender(<PreviewSection paneId="paneA" access="edit" preview={preview} onClose={() => {}} />);
    expect(view.container.querySelector("iframe")).toBeNull();
  });

  // One choice at a time is the compact list's own rule: while an open is in
  // flight its siblings answer "Opening the selected view…", so the two
  // kinds of late answer are walked as two presses, each alone in flight.
  it("a screen open that answers after a repoint never dials on the new pane", async () => {
    const resolvers: ((v: { proxyBase: string }) => void)[] = [];
    const preview = controller({
      openPort: () => new Promise((resolve) => void resolvers.push(resolve)),
    });
    const view = render(<PreviewSection paneId="paneA" access="edit" preview={preview} onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "View screen" }));
    expect(resolvers).toHaveLength(1);
    view.rerender(<PreviewSection paneId="paneB" access="edit" preview={preview} onClose={() => {}} />);
    await act(async () => {
      resolvers[0]?.({ proxyBase: "/pv/late-screen/" });
    });
    // The answer belongs to the pane the user left: no viewer mounts on B, so
    // no socket is ever dialed and no session is left to close.
    expect(MockSocket.made).toHaveLength(0);
    expect(viewerAlive()).toBe(false);
  });

  it("an app open that answers after a repoint never renders in the new pane", async () => {
    const resolvers: ((v: { proxyBase: string }) => void)[] = [];
    const preview = controller({
      info: info({ ports: [{ proto: "tcp", port: 8080, pid: 4242 }] }),
      openPort: () => new Promise((resolve) => void resolvers.push(resolve)),
    });
    const view = render(<PreviewSection paneId="paneA" access="edit" preview={preview} onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Open web preview on port 8080" }));
    expect(resolvers).toHaveLength(1);
    view.rerender(<PreviewSection paneId="paneB" access="edit" preview={preview} onClose={() => {}} />);
    await act(async () => {
      resolvers[0]?.({ proxyBase: "/pv/late-port/" });
    });
    expect(view.container.querySelector("iframe")).toBeNull();
    // And B is not left stuck on the old pane's open: its own choices are live.
    expect(screen.getByRole("button", { name: "Open web preview on port 8080" }).matches(":disabled")).toBe(false);
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

it("opens a cached screen shortcut once under StrictMode", async () => {
  const ports: number[] = [];
  const c = controller({
    info: info({ screen: { display: ":90", viewer: { protocol: "vnc", port: 5910 } } }),
    openPort: async (port) => {
      ports.push(port);
      return { proxyBase: "/pv/shortcut/" };
    },
  });
  render(
    <StrictMode>
      <PreviewSection paneId="pane1" access="owner" preview={c} initialView={{ kind: "screen" }} onClose={() => {}} />
    </StrictMode>,
  );
  await waitFor(() => expect(MockSocket.made.filter((socket) => socket.closed === 0)).toHaveLength(1));
  expect(screen.queryByText("Virtual display") === null).toBe(true);
  expect(ports).toEqual([5910]);
  expect(MockSocket.made.filter((socket) => socket.closed === 0)).toHaveLength(1);
});

it("reports the RFB connection state instead of treating an allocated lane as connected", () => {
  const states: string[] = [];
  render(<ScreenViewer protocol="vnc" proxyBase="/pv/state/" onConnectionChange={(state) => states.push(state)} />);
  expect(states).toEqual(["connecting"]);
  act(() => MockRFB.builds[0].onConnect?.());
  expect(states.at(-1)).toBe("connected");
  act(() => MockSocket.made[0].dispatchClose(1006, ""));
  expect(states.at(-1)).toBe("disconnected");
});

describe("real noVNC allocation guards", () => {
  function bounded() {
    const instance = new novncSnapshot.default(
      document.createElement("div"),
      new PatchProbeChannel() as unknown as WebSocket,
    );
    const rfb = instance as unknown as {
      _FBU: { width: number; height: number; encoding: number };
      _resize(w: number, h: number): void;
      _handleRect(): boolean;
      _fbWidth: number;
      _fail(message: string): false;
      _handleServerCutText(): boolean;
      _sock: { rQwait(...args: unknown[]): boolean; rQskipBytes(n: number): void; rQshift32(): number };
      _display: {
        _renderQ: { width: number; height: number }[];
        _drawCtx: { getImageData?: () => unknown; putImageData?: () => void };
        _targetCtx: { drawImage?: () => void };
        imageRect(x: number, y: number, w: number, h: number, mime: string, bytes: Uint8Array): void;
      };
    };
    rfb._display._drawCtx.getImageData = () => null;
    rfb._display._drawCtx.putImageData = () => {};
    rfb._display._targetCtx.drawImage = () => {};
    const failures: string[] = [];
    rfb._fail = (message) => {
      failures.push(message);
      return false;
    };
    installRfbBounds(instance);
    return { rfb, failures };
  }
  it("keeps ordinary resizing and rejects an oversized framebuffer before canvas allocation", () => {
    const { rfb, failures } = bounded();
    rfb._resize(1280, 800);
    expect(rfb._fbWidth).toBe(1280);
    rfb._resize(65535, 65535);
    expect(rfb._fbWidth).toBe(1280);
    expect(failures).toHaveLength(1);
  });
  it("rejects cursor/data allocations and unsupported video, while allowing empty pseudo rectangles", () => {
    for (const encoding of [-239, 7, 50]) {
      const { rfb, failures } = bounded();
      rfb._FBU = { width: 65535, height: 65535, encoding };
      expect(rfb._handleRect()).toBe(false);
      expect(failures).toHaveLength(1);
    }
    const { rfb, failures } = bounded();
    rfb._FBU = { width: 0, height: 0, encoding: -224 };
    expect(rfb._handleRect()).toBe(true);
    expect(failures).toHaveLength(0);
  });
  it("bounds a single update's render queue before another rectangle decodes", () => {
    const { rfb, failures } = bounded();
    rfb._display._renderQ.push({ width: 8192, height: 4096 });
    rfb._FBU = { width: 1, height: 1, encoding: 7 };
    expect(rfb._handleRect()).toBe(false);
    expect(failures).toHaveLength(1);
  });
  it("skips clipboard bytes without reaching extended-clipboard decompression", () => {
    const { rfb, failures } = bounded();
    const skips: number[] = [];
    rfb._sock.rQwait = () => false;
    rfb._sock.rQshift32 = () => 0xfffffff0;
    rfb._sock.rQskipBytes = (n) => {
      skips.push(n);
    };
    expect(rfb._handleServerCutText()).toBe(true);
    expect(skips).toEqual([3, 16]);
    rfb._sock.rQshift32 = () => 0x7fffffff;
    expect(rfb._handleServerCutText()).toBe(false);
    expect(failures).toHaveLength(1);
  });
  it("checks encoded image dimensions even when the rectangle claims to be small", () => {
    const { rfb, failures } = bounded();
    const oversizedJpeg = new Uint8Array([255, 216, 255, 192, 0, 11, 8, 255, 255, 255, 255, 1, 1, 17, 0, 255, 217]);
    rfb._display.imageRect(0, 0, 10, 10, "image/jpeg", oversizedJpeg);
    expect(failures).toHaveLength(1);
  });
});
