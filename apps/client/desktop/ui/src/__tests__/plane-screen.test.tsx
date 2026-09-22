/**
 * The Control Plane section, as component tests — the plane address's home,
 * moved out of the status screen by operator ruling 2026-09-22. What the
 * tests cover: the two addresses and their coherence (the app's stored
 * `planeUrl` against the node's own `serverUrl`), the loopback notice, and
 * the repoint form's shape. The repoint command's flow is pinned at the app
 * level (`repoint.test.tsx`), where the whole page is under test.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
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
    rewrite: rec("rewrite"),
    enroll: rec("enroll"),
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
  const pressed: string[] = [];
  renderApp(
    <PlaneScreen
      shell={shell}
      probe={init.probe ?? makeProbe()}
      settings={init.settings ?? makeSettings()}
      commands={makeCommands(calls)}
      busy={false}
      onReenroll={() => pressed.push("reenroll")}
      output={null as ActionResult | null}
    />,
  );
  return { calls, pressed };
}

const button = (name: string | RegExp) => screen.getByRole("button", { name }) as HTMLButtonElement;

describe("the two control-plane addresses", () => {
  /** Enrolled against one plane, with the app pointed at another. */
  const diverged = { probe: makeProbe(), settings: makeSettings({ planeUrl: "https://elsewhere.example" }) };

  it("names both when they disagree, and offers the reconciliation", () => {
    const { calls } = mount(diverged);
    const notice = screen.getByRole("status", { name: /mismatch/i });
    expect(notice.textContent).toContain("https://elsewhere.example");
    expect(notice.textContent).toContain("https://subshell.example.com");
    fireEvent.click(within(notice).getByRole("button", { name: /use https:\/\/elsewhere\.example/i }));
    expect(calls).toEqual([{ name: "repoint", args: ["https://elsewhere.example"] }]);
  });

  it("says nothing when the two agree", () => {
    mount();
    expect(screen.queryByRole("status", { name: /mismatch/i })).toBeNull();
  });

  it("flags a loopback node address without refusing anything", () => {
    mount({
      probe: makeProbe({
        status: { nodeId: "abc", serverUrl: "http://localhost:3080", online: true, agentVersion: "1.9.0" },
      }),
    });
    expect(screen.getByRole("status", { name: /loopback/i }).textContent).toMatch(/this machine/i);
    expect(button(/repoint this node/i)).toBeTruthy();
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
    expect(screen.getByText(/this app's control plane/i)).toBeTruthy();
    expect(screen.getAllByText("https://subshell.example.com").length).toBeGreaterThan(0);
    expect(screen.queryByText(/this app opens/i)).toBeNull();
    // The two doors for the plane itself, both on the acts row.
    fireEvent.click(button("Open in browser"));
    expect(calls).toEqual([{ name: "openPlaneUrl", args: [] }]);
    fireEvent.click(button("Open the control plane"));
    expect(calls[1]).toEqual({ name: "openPlane", args: [null] });
    expect(button(/change server…/i)).toBeTruthy();
  });
});

/** Re-enroll… moved here from the status screen (operator ruling 2026-09-22): the act is on this machine's relationship to the plane. */
describe("re-enroll, beside the plane address acts", () => {
  it("is offered on a machine that is a node, and opens the enroll flow", () => {
    const { pressed } = mount();
    expect(button(/re-enroll/i)).toBeTruthy();
    fireEvent.click(button(/re-enroll/i));
    expect(pressed).toEqual(["reenroll"]);
  });

  it("is not offered on a machine that is not a node — that act is Register", () => {
    const { pressed } = mount({
      probe: makeProbe({ status: { nodeId: null, online: false, reason: "no config" } }),
    });
    expect(screen.queryByRole("button", { name: /re-enroll/i })).toBeNull();
    expect(pressed).toEqual([]);
  });
});
