/**
 * The Control Plane LIST, as component tests (operator ruling 2026-09-22:
 * "the control plane section is for connecting to other control planes, not
 * necessarily tied with the node"). What the tests own, in order of the harm
 * each prevents:
 *
 * 1. the pinned row: the node's address FIRST, badged, NOT removable — its
 *    Remove affordance sends a detaching person to Service, because the
 *    binding acts are not this section's;
 * 2. the stored rows' ACTION MENU: open in dashboard, open in browser,
 *    remove — one at a time, class-positioned so the CSP cannot touch it,
 *    and dismissible the way every other menu in the world is;
 * 3. the row itself opens the dashboard (the ruling's "clicking on the line
 *    item directly");
 * 4. the add form SAVES only, and closes on submit whatever Rust answers.
 *
 * The list's storage rules (canonicalize, dedupe, refuse the node's own
 * address) are Rust's, pinned in `control.rs`; the app-level flows are in
 * `app.test.tsx` and `repoint.test.tsx`.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { PlaneScreen } from "@/components/assistant/plane-screen";
import type { NodeCommands } from "@/hooks/use-node-commands";
import type { ActionResult } from "@/lib/ipc";
import { makeProbe, makeSettings, renderApp } from "./harness";

afterEach(cleanup);

interface Call {
  name: string;
  args: unknown[];
}

function makeCommands(calls: Call[]): NodeCommands {
  const rec =
    (name: string) =>
    (...args: unknown[]) => {
      const kept = args.filter(
        (a) => a === null || typeof a !== "object" || Object.getPrototypeOf(a) === Object.prototype,
      );
      calls.push({ name, args: kept });
    };
  return {
    refresh: rec("refresh"),
    installNode: rec("installNode"),
    updateNode: rec("updateNode"),
    service: rec("service"),
    restart: rec("restart"),
    uninstall: rec("uninstall"),
    autostart: rec("autostart"),
    rewrite: rec("rewrite"),
    repoint: rec("repoint"),
    unenroll: rec("unenroll"),
    openPath: rec("openPath"),
    openPlane: rec("openPlane"),
    openPlaneUrl: rec("openPlaneUrl"),
    installTmux: rec("installTmux"),
    addPlane: rec("addPlane"),
    removePlane: rec("removePlane"),
    register: rec("register"),
  };
}

const shell = { title: "Control Plane", subtitle: "Planes this app can connect to.", problem: "" };

function mount(init: { probe?: ReturnType<typeof makeProbe>; settings?: ReturnType<typeof makeSettings> } = {}): {
  calls: Call[];
} {
  const calls: Call[] = [];
  renderApp(
    <PlaneScreen
      shell={shell}
      probe={init.probe ?? makeProbe()}
      settings={init.settings ?? makeSettings()}
      commands={makeCommands(calls)}
      busy={false}
      output={null as ActionResult | null}
    />,
  );
  return { calls };
}

/** Install a clipboard the tests can watch; `ok: false` plays the refusal. */
function stubClipboard(ok = true): string[] {
  const writes: string[] = [];
  Object.defineProperty(window.navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: async (text: string) => {
        if (!ok) throw new Error("denied");
        writes.push(text);
      },
    },
  });
  return writes;
}

const button = (name: string | RegExp) => screen.getByRole("button", { name }) as HTMLButtonElement;
const _buttonOrNull = (name: string | RegExp) => screen.queryByRole("button", { name }) as HTMLButtonElement | null;
const menuItem = (scope: HTMLElement, name: string) => within(scope).getByRole("menuitem", { name }) as HTMLElement;

/** Open one row's `⋮` disclosure and return the group that holds its actions. */
function openMenu(url: string): HTMLElement {
  const row = screen.getByRole("button", { name: url }).closest(".border-b") as HTMLElement;
  fireEvent.click(within(row).getByRole("button", { name: `Actions for ${url}` }));
  return row;
}

describe("the pinned row", () => {
  it("puts the node's address first, badged, above the stored list", () => {
    mount({ settings: makeSettings({ planes: ["https://work.example", "https://home.example"] }) });
    const rows = screen.getAllByRole("button", { name: /^https:\/\// }).map((b) => b.textContent);
    expect(rows).toEqual(["https://subshell.example.com", "https://work.example", "https://home.example"]);
    expect(screen.getByText("this node")).toBeTruthy();
  });

  it("renders the node's address exactly once, even if a stored row spells it", () => {
    mount({ settings: makeSettings({ planes: ["https://subshell.example.com", "https://other.example"] }) });
    expect(screen.getAllByRole("button", { name: "https://subshell.example.com" }).length).toBe(1);
  });

  it("its menu offers the two opens and no Remove, and says nothing", () => {
    // Operator rulings 2026-09-22, in order: "what about open in browser?"
    // gave the pinned row its opens; the note that explained the missing
    // Remove was deleted once Un-enroll… stood up on Service. Absence is the
    // whole message — the detaching act has its own door, and a sentence in
    // a connect-menu pointing at it is the pane-in-the-panel this wave is
    // systematically deleting.
    const { calls } = mount();
    const scope = openMenu("https://subshell.example.com");
    fireEvent.click(menuItem(scope, "Open in dashboard"));
    expect(calls).toEqual([{ name: "openPlane", args: ["https://subshell.example.com"] }]);
    const scope2 = openMenu("https://subshell.example.com");
    fireEvent.click(menuItem(scope2, "Open in browser"));
    expect(calls[1]).toEqual({ name: "openPlaneUrl", args: ["https://subshell.example.com"] });
    const scope3 = openMenu("https://subshell.example.com");
    expect(within(scope3).queryByRole("menuitem", { name: "Remove" })).toBeNull();
    expect(within(scope3).queryByText(/detach|reports to|go to service/i)).toBeNull();
  });

  it("disappears with the node — a watcher's list has no pinned row", () => {
    mount({
      probe: makeProbe({ status: { nodeId: null, serverUrl: null, online: false, agentVersion: "1.9.0" } }),
      settings: makeSettings({ planes: ["https://watched.example"] }),
    });
    expect(screen.queryByText("this node")).toBeNull();
    expect(screen.getAllByRole("button", { name: /^https:\/\// }).length).toBe(1);
  });
});

describe("a stored row's menu", () => {
  it("opens the dashboard from the row itself", () => {
    const { calls } = mount({ settings: makeSettings({ planes: ["https://work.example"] }) });
    fireEvent.click(button("https://work.example"));
    expect(calls).toEqual([{ name: "openPlane", args: ["https://work.example"] }]);
  });

  it("copies the row's address and closes the menu", async () => {
    const writes = stubClipboard();
    mount({ settings: makeSettings({ planes: ["https://work.example"] }) });
    const scope = openMenu("https://work.example");
    fireEvent.click(menuItem(scope, "Copy URL"));
    await waitFor(() => expect(writes).toEqual(["https://work.example"]));
    // The dismiss IS the success flash.
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("keeps the menu open and renames the item when the clipboard refuses", async () => {
    stubClipboard(false);
    mount({ settings: makeSettings({ planes: ["https://work.example"] }) });
    const scope = openMenu("https://work.example");
    fireEvent.click(menuItem(scope, "Copy URL"));
    await waitFor(() => expect(menuItem(scope, "Couldn't copy, try again")).toBeTruthy());
    // Reopening resets the honest label to the plain one.
    fireEvent.click(button("Actions for https://work.example"));
    fireEvent.click(button("Actions for https://work.example"));
    expect(menuItem(scope, "Copy URL")).toBeTruthy();
  });

  it("offers dashboard, browser, copy and remove, each aimed at the row's own address", () => {
    const { calls } = mount({ settings: makeSettings({ planes: ["https://work.example"] }) });
    const scope = openMenu("https://work.example");
    fireEvent.click(menuItem(scope, "Open in browser"));
    expect(calls).toEqual([{ name: "openPlaneUrl", args: ["https://work.example"] }]);
    const scopeC = openMenu("https://work.example");
    expect(menuItem(scopeC, "Copy URL")).toBeTruthy();
    fireEvent.click(menuItem(scopeC, "Open in dashboard"));
    expect(calls[1]).toEqual({ name: "openPlane", args: ["https://work.example"] });
    const scope3 = openMenu("https://work.example");
    fireEvent.click(menuItem(scope3, "Remove"));
    expect(calls[2]).toEqual({ name: "removePlane", args: ["https://work.example"] });
  });

  it("holds one open menu at a time, and dismisses on Escape and outside press", () => {
    mount({ settings: makeSettings({ planes: ["https://one.example", "https://two.example"] }) });
    const one = button("Actions for https://one.example");
    expect(one.getAttribute("aria-haspopup")).toBe("menu");
    fireEvent.click(one);
    expect(one.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("menu", { name: "Actions for https://one.example" })).toBeTruthy();
    fireEvent.click(button("Actions for https://two.example"));
    // The first row's menu closed when the second opened: the items are
    // asked for GLOBALLY here, and exactly one set exists.
    expect(screen.getAllByRole("menuitem", { name: "Open in browser" }).length).toBe(1);

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.click(button("Actions for https://two.example"));
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("menu")).toBeNull();
  });
});

describe("the list and its add form", () => {
  it("says so when there is nothing to open yet", () => {
    mount({
      probe: makeProbe({ status: { nodeId: null, serverUrl: null, online: false, agentVersion: "1.9.0" } }),
      settings: makeSettings({ planes: [] }),
    });
    expect(screen.getByText(/No control planes yet/)).toBeTruthy();
  });

  it("adds through the save command and closes the form on submit", () => {
    const { calls } = mount({ settings: makeSettings({ planes: [] }) });
    fireEvent.click(button("Add a control plane…"));
    const field = screen.getByLabelText("Control plane URL") as HTMLInputElement;
    fireEvent.change(field, { target: { value: "https://new.example" } });
    fireEvent.click(button("Add"));
    expect(calls).toEqual([{ name: "addPlane", args: ["https://new.example"] }]);
    // Closed unconditionally: the refetched list is the feedback, including
    // for the refusals, which arrive as the runner's message.
    expect(screen.queryByLabelText("Control plane URL")).toBeNull();
  });

  it("keeps the empty field unpressable", () => {
    mount({ settings: makeSettings({ planes: [] }) });
    fireEvent.click(button("Add a control plane…"));
    expect(button("Add").disabled).toBe(true);
  });
});

/**
 * The footer ruling (operator, 2026-09-22, an hour after the list shipped):
 * not a card, a table, and the add on the frame's bottom bar right. The bar's
 * own grammar then does the rest: open, the primary becomes the form's Add
 * and Cancel sits ghost-left.
 */
describe("the table and its footer", () => {
  it("is a bare table with the add on the frame's bottom bar", () => {
    mount();
    expect(screen.queryByText("Control planes")).toBeNull();
    expect(button("Add a control plane…").closest('[class*="border-t"]')).not.toBeNull();
  });

  it("opens the add as a dialog, and a submit closes it", () => {
    // (ruling 2026-09-22, the dialog audit's last inline pane; and the
    // close-on-submit grammar the re-enroll dialog learned from the live
    // window the same hour).
    const { calls } = mount({ settings: makeSettings({ planes: [] }) });
    fireEvent.click(button("Add a control plane…"));
    expect(screen.getByRole("dialog", { name: "Add a control plane" })).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Control plane URL"), { target: { value: "https://new.example" } });
    fireEvent.click(button("Add"));
    expect(calls).toEqual([{ name: "addPlane", args: ["https://new.example"] }]);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
