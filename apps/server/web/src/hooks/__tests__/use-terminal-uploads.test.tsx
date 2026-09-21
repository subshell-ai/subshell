import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { act, cleanup, render, renderHook, waitFor } from "@testing-library/react";
import type { RefObject } from "react";
import { useTerminalUploads } from "@/hooks/use-terminal-uploads";
import { resetDesktopShellForTests } from "@/lib/desktop";
import type { Permission } from "@/types/permissions";

/**
 * openImagePicker is the touch stand-in for drag-and-drop/paste: it must open
 * an images-only file picker and feed the picks through the SAME upload
 * function the desktop gestures use. The picker element itself is disposable,
 * so the assertions spy on what gets built and clicked.
 */

/** Recording XHR double — the transport assertion lives here rather than in a
 * module mock, because `mock.module` on `@/lib/subshell-uploads` leaks its
 * replacement into later test files in the same `bun test` process. */
class FakeXhr {
  static instances: FakeXhr[] = [];
  method = "";
  url = "";
  sentBody: FormData | null = null;
  upload = { onprogress: null as ((e: ProgressEvent) => void) | null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  onabort: (() => void) | null = null;
  withCredentials = false;
  status = 0;
  responseText = "";

  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  send(body: FormData) {
    this.sentBody = body;
    FakeXhr.instances.push(this);
  }
  respond(status: number, body: string) {
    this.status = status;
    this.responseText = body;
    this.onload?.();
  }
}

const realXhr = globalThis.XMLHttpRequest;

const SERVER_UA = "Mozilla/5.0 SubshellDesktop/1.0.0 (macos; p=1)";
const nav = globalThis.navigator as unknown as Record<string, unknown>;
let previousUserAgent: PropertyDescriptor | undefined;

/** Point `navigator.userAgent` at the server shell for the next render. */
function setUA(userAgent: string) {
  previousUserAgent ??= Object.getOwnPropertyDescriptor(nav, "userAgent");
  Object.defineProperty(nav, "userAgent", { value: userAgent, configurable: true, writable: true });
  resetDesktopShellForTests();
}

/** A fake `window.__TAURI__` answering `desktop_permissions` with `photos`. */
function fakeTauri(photos: Permission) {
  (window as unknown as Record<string, unknown>).__TAURI__ = {
    core: {
      invoke: (command: string) =>
        Promise.resolve(command === "desktop_permissions" ? { notifications: "authorized", photos } : null),
    },
  };
}

describe("useTerminalUploads.openImagePicker", () => {
  afterEach(() => {
    cleanup();
    globalThis.XMLHttpRequest = realXhr;
    FakeXhr.instances = [];
    delete (window as unknown as Record<string, unknown>).__TAURI__;
    if (previousUserAgent) Object.defineProperty(nav, "userAgent", previousUserAgent);
    // No own descriptor means the real one is on the prototype — deleting the
    // one `setUA` defined uncovers it. Skip this and the UA outlives the file.
    else delete nav.userAgent;
    previousUserAgent = undefined;
    resetDesktopShellForTests();
  });

  it("builds an image-only multi-select picker and clicks it", () => {
    const created: HTMLInputElement[] = [];
    const realCreate = document.createElement.bind(document);
    const createSpy = spyOn(document, "createElement").mockImplementation((tag: string) => {
      const el = realCreate(tag) as HTMLElement;
      if (tag === "input") created.push(el as HTMLInputElement);
      return el;
    });
    const clickSpy = spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => {});

    const { result } = renderHook(() =>
      useTerminalUploads({
        subshellId: "s1",
        wsRef: { current: null },
        termRef: { current: null },
        inputQueueRef: { current: null },
      }),
    );
    result.current.openImagePicker();

    expect(created).toHaveLength(1);
    expect(created[0].type).toBe("file");
    expect(created[0].accept).toBe("image/*");
    expect(created[0].multiple).toBe(true);
    expect(clickSpy).toHaveBeenCalledTimes(1);
    // iOS/WebKit requirement: the input must be IN the document when
    // `.click()` fires, or the first pick's `change` never reaches the page
    // (the "insert the same image twice" report, iPhone 2026-09-04).
    expect(created[0].parentElement).toBe(document.body);

    createSpy.mockRestore();
    clickSpy.mockRestore();
  });

  it("discards the picker element after the pick", () => {
    const created: HTMLInputElement[] = [];
    const realCreate = document.createElement.bind(document);
    const createSpy = spyOn(document, "createElement").mockImplementation((tag: string) => {
      const el = realCreate(tag) as HTMLElement;
      if (tag === "input") created.push(el as HTMLInputElement);
      return el;
    });
    const clickSpy = spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => {});

    const { result } = renderHook(() =>
      useTerminalUploads({
        subshellId: "s1",
        wsRef: { current: null },
        termRef: { current: null },
        inputQueueRef: { current: null },
      }),
    );
    result.current.openImagePicker();
    expect(created[0].isConnected).toBe(true);

    created[0].dispatchEvent(new Event("change"));
    expect(created[0].isConnected).toBe(false);

    createSpy.mockRestore();
    clickSpy.mockRestore();
  });

  /**
   * The Photos half (spec 2026-09-14 §5.2). Picking an image from the Photos
   * sidebar with Photos blocked does nothing at all and says nothing — so the
   * picker reports it. The panel still opens: Files from folders work, and the
   * person may not have wanted Photos in the first place.
   */
  describe("Photos permission", () => {
    /** Opens the picker under the server shell with `photos` as the answer. */
    function openUnder(photos: Permission) {
      setUA(SERVER_UA);
      fakeTauri(photos);
      const clickSpy = spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => {});
      const { result } = renderHook(() =>
        useTerminalUploads({
          subshellId: "s1",
          wsRef: { current: null },
          termRef: { current: null },
          inputQueueRef: { current: null },
        }),
      );
      act(() => result.current.openImagePicker());
      // The gesture is what opens the picker, and it must not wait on an IPC
      // round trip to do it — asserted here, not merely intended.
      expect(clickSpy).toHaveBeenCalledTimes(1);
      clickSpy.mockRestore();
      return result;
    }

    it("reports a denial, having opened the panel anyway", async () => {
      const result = openUnder("denied");
      await waitFor(() => expect(result.current.photosBlocked).toBe(true));
    });

    it("says nothing while macOS has not asked yet — it asks in context", async () => {
      const result = openUnder("not-determined");
      await new Promise((r) => setTimeout(r, 20));
      expect(result.current.photosBlocked).toBe(false);
    });

    it("says nothing when Photos is allowed", async () => {
      const result = openUnder("authorized");
      await new Promise((r) => setTimeout(r, 20));
      expect(result.current.photosBlocked).toBe(false);
    });

    it("asks nothing at all in a browser — there is no shell to answer", async () => {
      let asked = 0;
      (window as unknown as Record<string, unknown>).__TAURI__ = {
        core: {
          invoke: () => {
            asked += 1;
            return Promise.resolve(null);
          },
        },
      };
      setUA("Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15");
      const clickSpy = spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => {});
      const { result } = renderHook(() =>
        useTerminalUploads({
          subshellId: "s1",
          wsRef: { current: null },
          termRef: { current: null },
          inputQueueRef: { current: null },
        }),
      );
      act(() => result.current.openImagePicker());
      await new Promise((r) => setTimeout(r, 20));
      expect(asked).toBe(0);
      expect(result.current.photosBlocked).toBe(false);
      clickSpy.mockRestore();
    });

    it("the notice is dismissible", async () => {
      const result = openUnder("denied");
      await waitFor(() => expect(result.current.photosBlocked).toBe(true));
      act(() => result.current.dismissPhotosNotice());
      expect(result.current.photosBlocked).toBe(false);
    });
  });

  it("routes picked files through the shared upload path", async () => {
    globalThis.XMLHttpRequest = FakeXhr as unknown as typeof XMLHttpRequest;
    const realCreate = document.createElement.bind(document);
    let input: HTMLInputElement | null = null;
    const createSpy = spyOn(document, "createElement").mockImplementation((tag: string) => {
      const el = realCreate(tag) as HTMLElement;
      if (tag === "input") input = el as HTMLInputElement;
      return el;
    });
    const clickSpy = spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => {});

    const { result } = renderHook(() =>
      useTerminalUploads({
        subshellId: "s1",
        wsRef: { current: null },
        termRef: { current: null },
        inputQueueRef: { current: null },
      }),
    );
    result.current.openImagePicker();

    // `input` is assigned inside the createElement closure, which TS control
    // flow cannot see — snapshot it through its declared type instead.
    const picked = input as HTMLInputElement | null;
    if (!picked) throw new Error("openImagePicker never built an input");
    const file = new File(["x"], "pic.png", { type: "image/png" });
    Object.defineProperty(picked, "files", { value: [file] });
    picked.dispatchEvent(new Event("change"));

    // The pool worker awaits the (pass-through, for a tiny file) downscale
    // before uploading, so the request lands a microtask after the change.
    await waitFor(() => expect(FakeXhr.instances).toHaveLength(1));
    const xhr = FakeXhr.instances[0];
    expect(xhr.method).toBe("POST");
    expect(xhr.url).toBe("/api/subshells/s1/uploads");
    // The SAME File object rode the batch — tiny PNGs pass prepareForUpload
    // untouched, and the picker did not fork a private upload path.
    expect(xhr.sentBody?.get("file")).toBe(file);

    createSpy.mockRestore();
    clickSpy.mockRestore();
  });
});

/** Minimal host element wiring the hook exactly like SubshellTerminal does. */
function Probe() {
  const uploads = useTerminalUploads({
    subshellId: "s1",
    wsRef: { current: null },
    termRef: { current: null },
    inputQueueRef: { current: null },
  });
  return (
    <div
      {...uploads.getRootProps({ className: "root" })}
      ref={uploads.rootRef as unknown as RefObject<HTMLDivElement | null>}
    >
      <textarea data-testid="term" />
      <span data-testid="err">{uploads.error ?? ""}</span>
    </div>
  );
}

/** Cancelable `paste` event carrying (or not) clipboard files. */
function pasteEvent(files: File[]): Event {
  const ev = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(ev, "clipboardData", {
    value: {
      files,
      types: files.length ? ["Files"] : ["text/plain"],
      getData: () => (files.length ? "" : "some text"),
    },
  });
  return ev;
}

/** WebKit shape: image lands on `items` while the legacy `files` list stays empty. */
function pasteEventItemsOnly(files: File[]): Event {
  const ev = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(ev, "clipboardData", {
    value: {
      files: [],
      types: ["Files"],
      getData: () => "",
      items: files.map((f) => ({ kind: "file", getAsFile: () => f })),
    },
  });
  return ev;
}

describe("useTerminalUploads clipboard-file interception", () => {
  afterEach(() => {
    cleanup();
    globalThis.XMLHttpRequest = realXhr;
    FakeXhr.instances = [];
  });

  it("claims a focused-terminal paste carrying files and uploads them", async () => {
    globalThis.XMLHttpRequest = FakeXhr as unknown as typeof XMLHttpRequest;
    const { getByTestId } = render(<Probe />);
    const term = getByTestId("term") as HTMLTextAreaElement;
    term.focus();

    const file = new File(["imgbytes"], "shot.png", { type: "image/png" });
    const ev = pasteEvent([file]);
    term.dispatchEvent(ev);

    expect(ev.defaultPrevented).toBe(true); // xterm never sees the keystroke
    await waitFor(() => expect(FakeXhr.instances).toHaveLength(1));
    expect(FakeXhr.instances[0].url).toBe("/api/subshells/s1/uploads");
    expect(FakeXhr.instances[0].sentBody?.get("file")).toBe(file);
  });

  it("claims a WebKit paste whose image is only on items (iOS PWA shape)", async () => {
    globalThis.XMLHttpRequest = FakeXhr as unknown as typeof XMLHttpRequest;
    const { getByTestId } = render(<Probe />);
    const term = getByTestId("term") as HTMLTextAreaElement;
    term.focus();

    const file = new File(["webkitbytes"], "IMG_3301.png", { type: "image/png" });
    const ev = pasteEventItemsOnly([file]);
    term.dispatchEvent(ev);

    expect(ev.defaultPrevented).toBe(true); // must not reach the harness CLI
    await waitFor(() => expect(FakeXhr.instances).toHaveLength(1));
    expect(FakeXhr.instances[0].url).toBe("/api/subshells/s1/uploads");
    expect(FakeXhr.instances[0].sentBody?.get("file")).toBe(file);
  });

  it("leaves a TEXT paste untouched for xterm's own handling", () => {
    globalThis.XMLHttpRequest = FakeXhr as unknown as typeof XMLHttpRequest;
    const { getByTestId } = render(<Probe />);
    const term = getByTestId("term") as HTMLTextAreaElement;
    term.focus();

    const ev = pasteEvent([]);
    term.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
    expect(FakeXhr.instances).toHaveLength(0);
  });

  it("queries the real clipboard when the paste event is EMPTY (Chrome/Firefox hide images from textareas)", async () => {
    globalThis.XMLHttpRequest = FakeXhr as unknown as typeof XMLHttpRequest;
    const pngBlob = new Blob(["realclipboard"], { type: "image/png" });
    const realClipboard = navigator.clipboard;
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        read: async () => [
          { types: ["image/png"], getType: async () => pngBlob },
          { types: ["text/plain"], getType: async () => new Blob(["ignored"]) },
        ],
      },
    });
    try {
      const { getByTestId } = render(<Probe />);
      const term = getByTestId("term") as HTMLTextAreaElement;
      term.focus();

      // The empty-event shape: no files, no items, no usable text.
      const ev = new Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(ev, "clipboardData", {
        value: { files: [], items: [], types: [], getData: () => "" },
      });
      term.dispatchEvent(ev);
      expect(ev.defaultPrevented).toBe(true); // xterm must not eat the gesture

      await waitFor(() => expect(FakeXhr.instances).toHaveLength(1));
      const body = FakeXhr.instances[0].sentBody;
      expect(body?.get("file")).toBeInstanceOf(File);
      const file = body?.get("file") as File;
      expect(file.type).toBe("image/png");
      expect(file.name).toMatch(/^pasted-image-\d+\.png$/);
    } finally {
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: realClipboard });
    }
  });

  it("reports guidance (no crash) when clipboard.read is denied", async () => {
    globalThis.XMLHttpRequest = FakeXhr as unknown as typeof XMLHttpRequest;
    const realClipboard = navigator.clipboard;
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        read: async () => {
          throw new Error("NotAllowedError");
        },
      },
    });
    try {
      const { getByTestId } = render(<Probe />);
      const term = getByTestId("term") as HTMLTextAreaElement;
      term.focus();
      const ev = new Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(ev, "clipboardData", {
        value: { files: [], items: [], types: [], getData: () => "" },
      });
      act(() => term.dispatchEvent(ev));
      await waitFor(() =>
        expect((document.querySelector('[data-testid="err"]')?.textContent ?? "") as string).toContain(
          "Clipboard access was blocked",
        ),
      );
      expect(FakeXhr.instances).toHaveLength(0);
    } finally {
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: realClipboard });
    }
  });

  it("does not steal a paste when focus is outside the terminal", () => {
    globalThis.XMLHttpRequest = FakeXhr as unknown as typeof XMLHttpRequest;
    render(<Probe />);
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();

    const ev = pasteEvent([new File(["x"], "a.png", { type: "image/png" })]);
    input.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
    expect(FakeXhr.instances).toHaveLength(0);
    input.remove();
  });
});

/** A Ctrl+V keydown as the terminal's helper textarea would see it. */
function ctrlVKeyDown(): KeyboardEvent {
  return new KeyboardEvent("keydown", { key: "v", ctrlKey: true, bubbles: true, cancelable: true });
}

/** Installs a stub async clipboard for the duration of a test. */
function withClipboard(read: () => Promise<unknown>): () => void {
  const real = navigator.clipboard;
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { read } });
  return () => Object.defineProperty(navigator, "clipboard", { configurable: true, value: real });
}

describe("useTerminalUploads — Ctrl+V that produces NO paste event", () => {
  afterEach(() => {
    cleanup();
    globalThis.XMLHttpRequest = realXhr;
    FakeXhr.instances = [];
  });

  it("falls back to the async clipboard when the browser fires no paste event at all", async () => {
    // Some engines/PWA shells deliver NOTHING for an image-only clipboard in a
    // textarea — no files, no empty event. The gesture was then silently
    // dropped (and, before the terminal stopped encoding \x16, the pane's own
    // CLI answered it by reading the SERVER's clipboard: "No image found in
    // clipboard", 2026-09-02).
    globalThis.XMLHttpRequest = FakeXhr as unknown as typeof XMLHttpRequest;
    const blob = new Blob(["fallbackbytes"], { type: "image/png" });
    const restore = withClipboard(async () => [{ types: ["image/png"], getType: async () => blob }]);
    try {
      const { getByTestId } = render(<Probe />);
      const term = getByTestId("term") as HTMLTextAreaElement;
      term.focus();

      term.dispatchEvent(ctrlVKeyDown()); // and no paste event ever follows

      await waitFor(() => expect(FakeXhr.instances).toHaveLength(1), { timeout: 2000 });
      expect(FakeXhr.instances[0].url).toBe("/api/subshells/s1/uploads");
      const sent = FakeXhr.instances[0].sentBody?.get("file") as File;
      expect(sent.name).toMatch(/^pasted-image-\d{14}\.png$/);
    } finally {
      restore();
    }
  });

  it("a TEXT paste never reaches the async clipboard (no permission prompt for ordinary paste)", async () => {
    // The keydown arms the fallback; the paste event that follows must disarm
    // it. Otherwise every text paste would trigger a clipboard read — and its
    // one-time permission prompt — for no reason.
    globalThis.XMLHttpRequest = FakeXhr as unknown as typeof XMLHttpRequest;
    let reads = 0;
    const restore = withClipboard(async () => {
      reads += 1;
      return [];
    });
    try {
      const { getByTestId } = render(<Probe />);
      const term = getByTestId("term") as HTMLTextAreaElement;
      term.focus();

      term.dispatchEvent(ctrlVKeyDown());
      term.dispatchEvent(pasteEvent([])); // text-carrying event, same gesture

      await new Promise((r) => setTimeout(r, 400)); // outlive the grace window
      expect(reads).toBe(0);
      expect(FakeXhr.instances).toHaveLength(0);
    } finally {
      restore();
    }
  });

  it("ignores Ctrl+V when the terminal does not hold focus", async () => {
    globalThis.XMLHttpRequest = FakeXhr as unknown as typeof XMLHttpRequest;
    let reads = 0;
    const restore = withClipboard(async () => {
      reads += 1;
      return [];
    });
    try {
      render(<Probe />);
      const input = document.createElement("input");
      document.body.appendChild(input);
      input.focus();

      input.dispatchEvent(ctrlVKeyDown());

      await new Promise((r) => setTimeout(r, 400));
      expect(reads).toBe(0);
      input.remove();
    } finally {
      restore();
    }
  });
});
