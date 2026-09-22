/**
 * The Control Plane section, as component tests — the plane address's home.
 * ONE address now (operator ruling 2026-09-22, final addendum): the control
 * plane URL IS what the node reports to, the second block and its repoint
 * form are gone, and Re-enroll… presses the card's own address through
 * `node_configure`. What the tests cover: the one value and its fallback, the
 * divergence line and the Re-enroll door it opens, the loopback notice, and
 * the address form's shape. The repoint command's flow is pinned at the app
 * level (`repoint.test.tsx`), where the whole page is under test.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, screen } from "@testing-library/react";
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
    openPath: rec("openPath"),
    openPlane: rec("openPlane"),
    openPlaneUrl: rec("openPlaneUrl"),
    installTmux: rec("installTmux"),
    connectOnly: rec("connectOnly"),
    register: rec("register"),
  };
}

const shell = { title: "Control Plane", subtitle: "The address this app and this node talk to.", problem: "" };

function mount(init: { probe?: ReturnType<typeof makeProbe>; settings?: ReturnType<typeof makeSettings> } = {}) {
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

const button = (name: string | RegExp) => screen.getByRole("button", { name }) as HTMLButtonElement;

/** The two addresses the ruling collapsed into one, as states of one card. */
describe("the ONE address", () => {
  it("shows the configured address and says nothing else when the node agrees", () => {
    mount();
    expect(screen.getAllByText("https://subshell.example.com").length).toBeGreaterThan(0);
    expect(screen.queryByText(/reports to/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /re-enroll/i })).toBeNull();
  });

  it("falls back to the node's own address when the app has stored none", () => {
    // The CLI-enrolled machine: no `planeUrl` until it opens one. The one
    // address shown IS the node's, and there is nothing to repoint TO.
    mount({ settings: makeSettings({ planeUrl: null }) });
    expect(screen.getAllByText("https://subshell.example.com").length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: /re-enroll/i })).toBeNull();
  });

  it("names both addresses when they disagree, and Re-enroll points the node at the card's", () => {
    // Enrolled against one plane, with the app pointed at another (the only
    // case the button now exists for).
    const { calls } = mount({ settings: makeSettings({ planeUrl: "https://elsewhere.example" }) });
    expect(screen.getByText("Control plane URL").closest("div")?.textContent).toContain("https://elsewhere.example");
    expect(screen.getByText(/currently the node reports to/i).textContent).toContain("https://subshell.example.com");
    fireEvent.click(button(/re-enroll/i));
    expect(calls).toEqual([{ name: "repoint", args: ["https://elsewhere.example"] }]);
  });

  it("explains what the Re-enroll press does, in the card", () => {
    mount({ settings: makeSettings({ planeUrl: "https://elsewhere.example" }) });
    const help = screen.getByText(/re-enroll points the node/i);
    expect(help.textContent).toMatch(/restarts?/i);
    expect(help.textContent).toMatch(/no setup key/i);
    // The one thing this app cannot check: a repoint keeps the node key, so
    // it works only for ONE plane under two names.
    expect(help.textContent).toMatch(/different control plane/i);
  });

  it("offers no Re-enroll on a machine that is not a node — there is nothing to repoint", () => {
    mount({
      probe: makeProbe({ status: { nodeId: null, serverUrl: "https://subshell.example.com", online: false } }),
      settings: makeSettings({ planeUrl: "https://elsewhere.example" }),
    });
    expect(screen.queryByRole("button", { name: /re-enroll/i })).toBeNull();
    expect(screen.queryByText(/reports to/i)).toBeNull();
  });

  it("flags a loopback node address without refusing anything", () => {
    mount({
      probe: makeProbe({
        status: { nodeId: "abc", serverUrl: "http://localhost:3080", online: true, agentVersion: "1.9.0" },
      }),
    });
    expect(screen.getByRole("status", { name: /loopback/i }).textContent).toMatch(/this machine/i);
    expect(button(/re-enroll/i)).toBeTruthy();
  });
});

/** The ruling deleted the status screen's "This app opens <url>" narration; the value is shown labeled. */
describe("the address, as the ruling shows it", () => {
  it("shows the configured address labeled, with the acts grouped on their own row", () => {
    // Screenshot 53 (operator ruling 2026-09-22): the one-line value with its
    // buttons beside it wrapped the URL character-broken and crowded it, so
    // the layout is the addresses-card shape — labeled value row, acts row
    // below — and no narration.
    const { calls } = mount();
    // The URL block is its own bordered card (operator ruling 2026-09-22,
    // addendum 4), labeled with the operator's exact words.
    const label = screen.getByText("Control plane URL");
    expect(label.closest(".rounded-md.border.border-border")).toBeTruthy();
    expect(screen.getAllByText("https://subshell.example.com").length).toBeGreaterThan(0);
    expect(screen.queryByText(/this app opens/i)).toBeNull();
    // The two doors for the plane live under the Dashboard card (operator
    // ruling 2026-09-22, second addendum) — the only place in the app that
    // opens the plane.
    fireEvent.click(button("Open in browser"));
    expect(calls).toEqual([{ name: "openPlaneUrl", args: [] }]);
    fireEvent.click(button("Open in app"));
    expect(calls[1]).toEqual({ name: "openPlane", args: [null] });
    expect(screen.getByText("Dashboard")).toBeTruthy();
    expect(button(/change server…/i)).toBeTruthy();
  });

  it("seeds the edit form with the address the card shows", () => {
    mount();
    fireEvent.click(button(/change server…/i));
    expect((screen.getByLabelText("Control plane URL") as HTMLInputElement).value).toBe("https://subshell.example.com");
  });
});

/** Addendum 5 (operator ruling 2026-09-22): one card-title style across the section, the Dashboard rendering the reference. */
describe("the card titles, one style", () => {
  it("renders both card titles foreground strong at detail size", () => {
    mount();
    // The muted label style was the odd one out; both titles now read the
    // same: `font-strong text-detail`, foreground.
    for (const title of ["Control plane URL", "Dashboard"]) {
      const classes = screen.getByText(title).className;
      expect(classes).toContain("font-strong");
      expect(classes).toContain("text-detail");
      expect(classes).not.toContain("text-muted-foreground");
    }
  });
});
