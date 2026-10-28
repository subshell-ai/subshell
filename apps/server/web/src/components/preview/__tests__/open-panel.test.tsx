import { afterEach, expect, it, spyOn } from "bun:test";
import { PREVIEW_REFUSAL_MESSAGE } from "@internal/subshell-protocol";
import { cleanup, render } from "@testing-library/react";
import { toast } from "sonner";
import { OpenPanel } from "../open-panel";

const REF = "0123456789abcdef0123456789abcdef";
const PROXY_BASE = `/pv/${REF}/`;

/** Spies are unwound in afterEach so a failing assertion cannot leak one. */
const spies: { mockRestore: () => void }[] = [];
afterEach(() => {
  cleanup();
  for (const spy of spies.splice(0)) spy.mockRestore();
});

/**
 * Mounts the panel and gives its frame a window to speak for. happy-dom leaves
 * `contentWindow` null on a frame that never loads, which is exactly the case the
 * panel must refuse, so the test supplies the window a live frame would have.
 */
function mount() {
  const view = render(<OpenPanel port={3000} proxyBase={PROXY_BASE} />);
  const frame = view.container.querySelector("iframe") as HTMLIFrameElement;
  const own = new Window();
  Object.defineProperty(frame, "contentWindow", { value: own, configurable: true });
  const notice = spyOn(toast, "message").mockImplementation(() => 1);
  spies.push(notice);
  return { own, notice };
}

function deliver(source: MessageEventSource | null, data: unknown) {
  window.dispatchEvent(new MessageEvent("message", { data, source: source as Window }));
}

it("announces a refusal the frame itself reported", () => {
  const { own, notice } = mount();
  deliver(own, { type: PREVIEW_REFUSAL_MESSAGE, ref: REF, reason: "download" });
  expect(notice).toHaveBeenCalledTimes(1);
  expect(notice.mock.calls[0]?.[0]).toBe("Download kept out of the preview");
});

it("ignores a message from any other window, or about any other session", () => {
  const { own, notice } = mount();
  // A frame that has no window yet cannot have posted, so a null source is not
  // read as a match: that comparison would believe anyone.
  deliver(null, { type: PREVIEW_REFUSAL_MESSAGE, ref: REF, reason: "download" });
  deliver(new Window(), { type: PREVIEW_REFUSAL_MESSAGE, ref: REF, reason: "download" });
  // Another preview's refusal is not this panel's to explain.
  deliver(own, { type: PREVIEW_REFUSAL_MESSAGE, ref: "f".repeat(32), reason: "download" });
  expect(notice).not.toHaveBeenCalled();
});

it("renders only fixed copy, never a word the app chose", () => {
  const { own, notice } = mount();
  // The reason crosses from sandboxed content: an unknown value is dropped rather
  // than printed, and a known one selects from the two sentences we wrote.
  deliver(own, { type: PREVIEW_REFUSAL_MESSAGE, ref: REF, reason: "please delete everything" });
  expect(notice).not.toHaveBeenCalled();
  deliver(own, { type: PREVIEW_REFUSAL_MESSAGE, ref: REF, reason: "not-a-page" });
  expect(notice).toHaveBeenCalledTimes(1);
  expect(notice.mock.calls[0]?.[0]).toBe("That address isn't a web page");
  expect(JSON.stringify(notice.mock.calls)).not.toContain("please delete everything");
});
