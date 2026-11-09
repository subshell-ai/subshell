import { afterEach, describe, expect, it } from "bun:test";
import { wireTabFocus } from "../workspace-dock/tab-focus";

/** A dock tab wrapper shaped like dockview's: our content inside its own box. */
function mountTab(paneId: string, root = document.createElement("div")) {
  const tab = document.createElement("div");
  tab.className = "dv-tab";
  tab.setAttribute("data-tab-panel-id", paneId);
  const content = document.createElement("div");
  content.className = "dv-default-tab";
  const title = document.createElement("span");
  title.textContent = "Alpha";
  const close = document.createElement("button");
  close.className = "dv-default-tab-action";
  content.append(title, close);
  tab.append(content);
  root.append(tab);
  if (!root.isConnected) document.body.append(root);
  return { root, tab, title, close };
}

function press(target: Element, init: PointerEventInit = {}) {
  target.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse", ...init }));
}

function click(target: Element) {
  target.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 }));
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/** Mounts a tab, wires the dock root, and records the pane ids it focuses. */
function wire(paneId = "pane-1") {
  const mounted = mountTab(paneId);
  const focused: string[] = [];
  const unwire = wireTabFocus(mounted.root, (id) => focused.push(id));
  cleanups.push(unwire, () => mounted.root.remove());
  return { ...mounted, focused };
}

describe("tab focus handoff", () => {
  it("hands a mouse click on the title to the pane's terminal", () => {
    const { title, focused } = wire();
    press(title);
    click(title);
    expect(focused).toEqual(["pane-1"]);
  });

  it("treats a pen click like a mouse click", () => {
    const { title, focused } = wire();
    press(title, { pointerType: "pen" });
    click(title);
    expect(focused).toEqual(["pane-1"]);
  });

  it("covers the wrapper's padding ring, where the tab itself is the target", () => {
    const { tab, focused } = wire();
    press(tab);
    click(tab);
    expect(focused).toEqual(["pane-1"]);
  });

  it("leaves a touch tap to the pane's own keyboard gate", () => {
    const { title, focused } = wire();
    press(title, { pointerType: "touch" });
    click(title);
    expect(focused).toEqual([]);
  });

  it("asks for nothing when the click had no press on the tab", () => {
    const { title, focused } = wire();
    click(title);
    expect(focused).toEqual([]);
  });

  it("does not treat a press on the close control as a tab click", () => {
    const { title, close, focused } = wire();
    press(close);
    click(title);
    expect(focused).toEqual([]);
  });

  it("keeps focus out of a tab the press did not begin on", () => {
    const root = document.createElement("div");
    const first = mountTab("pane-1", root);
    const second = mountTab("pane-2", root);
    const focused: string[] = [];
    const unwire = wireTabFocus(root, (id) => focused.push(id));
    cleanups.push(unwire, () => root.remove());
    // A drag from pane 1's title that releases on pane 2's title.
    press(first.title);
    click(second.title);
    expect(focused).toEqual([]);
  });

  it("asks for nothing for a preview tab, which owns no terminal", () => {
    const { title, focused } = wire("preview:pane-1:app:8000");
    press(title);
    click(title);
    expect(focused).toEqual([]);
  });

  it("drops a press the browser cancelled", () => {
    const { title, root, focused } = wire();
    press(title);
    root.dispatchEvent(new PointerEvent("pointercancel", { bubbles: true }));
    click(title);
    expect(focused).toEqual([]);
  });
});
