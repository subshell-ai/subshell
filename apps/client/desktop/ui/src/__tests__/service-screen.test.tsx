/**
 * The Service section, as component tests — the node's own machinery, moved
 * out of the status screen by operator ruling 2026-09-22 (the rail's Service
 * section). What the tests cover: the contextual service verb on the thing
 * that is wrong, the pane-safety rewrite door the CLI's refusal names by
 * label, and the reveals. The install/no-node split and the unrecognised
 * step are pinned at the app level, where the whole page is under test.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { ServiceScreen } from "@/components/assistant/service-screen";
import type { NodeCommands } from "@/hooks/use-node-commands";
import type { ActionResult } from "@/lib/ipc";
import { makeProbe, makeSettings, renderApp } from "./harness";

afterEach(cleanup);

/** One recorded command call, values kept the way the status screen's does. */
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

const shell = { title: "Service", subtitle: "The node is the small program.", problem: "" };

function mount(init: { probe?: ReturnType<typeof makeProbe>; busy?: boolean } = {}) {
  const calls: Call[] = [];
  const pressed: string[] = [];
  renderApp(
    <ServiceScreen
      shell={shell}
      probe={init.probe ?? makeProbe()}
      commands={makeCommands(calls)}
      busy={init.busy ?? false}
      onRegister={() => pressed.push("register")}
      output={null as ActionResult | null}
    />,
  );
  return { calls, pressed };
}

const button = (name: string | RegExp) => screen.getByRole("button", { name }) as HTMLButtonElement;

describe("a node whose agent is not running", () => {
  const stopped = makeProbe({ step: "stopped", service: { ...makeProbe().service, state: "stopped", pid: null } });

  it("offers Start, and says what is wrong", () => {
    const { calls } = mount({ probe: stopped });
    expect(screen.getByText(/the node is not running/i)).toBeTruthy();
    fireEvent.click(button(/^start$/i));
    expect(calls).toEqual([{ name: "service", args: ["start", { settle: true }] }]);
  });

  /** Restart is the two-phase command: its refusal is read before `--force`. */
  it("offers Restart for an offline node, through the confirming path", () => {
    const { calls } = mount({ probe: makeProbe({ step: "offline" }) });
    fireEvent.click(button(/^restart$/i));
    expect(calls).toEqual([{ name: "restart", args: [] }]);
  });

  it("offers Install and Start when nothing keeps the agent running", () => {
    mount({ probe: makeProbe({ step: "no-service", service: { installed: false } }) });
    expect(button(/^install and start$/i)).toBeTruthy();
  });

  /**
   * tmux is a gate, not a caption: a node that starts without it comes up
   * online with no harnesses and refuses every launch.
   */
  it("disables the service action while tmux is missing, and says why", () => {
    mount({ probe: makeProbe({ step: "stopped", tmux: null }) });
    expect(button(/^start$/i).disabled).toBe(true);
    expect(screen.getByText(/tmux was not found/i)).toBeTruthy();
  });
});

/** The remedy the restart refusal names BY LABEL, so the label is pinned. */
describe("the pane-safety rewrite", () => {
  it("offers the definition rewrite when a teardown would kill live panes", () => {
    const { calls } = mount({
      probe: makeProbe({ service: { ...makeProbe().service, paneSafety: "kills" } }),
    });
    fireEvent.click(button(/rewrite the service definition/i));
    expect(calls).toEqual([{ name: "rewrite", args: [] }]);
  });
});

/** The two reveals follow the node rather than the screen: a machine with no node has neither. */
describe("the reveals", () => {
  it("offers them only where there is a node to reveal", () => {
    const { calls } = mount({ probe: makeProbe({ step: "stopped" }) });
    expect(button(/reveal configuration/i)).toBeTruthy();
    fireEvent.click(button(/reveal configuration/i));
    expect(calls).toEqual([{ name: "openPath", args: ["config-dir"] }]);
    fireEvent.click(button(/open the node log/i));
    expect(calls).toEqual([
      { name: "openPath", args: ["config-dir"] },
      { name: "openPath", args: ["node-log"] },
    ]);
    cleanup();

    // No node, nothing to reveal.
    mount({ probe: makeProbe({ step: "no-node", nodeBinary: null, status: null, service: null }) });
    expect(buttonOrNull_(/reveal configuration/i)).toBeNull();
  });

  it("titles the install card 'Register as a node', with the button below it", () => {
    // Operator ruling 2026-09-22, addendum 3: the card's title is the
    // operator's exact words, and the explainer is gone (the button speaks
    // for itself).
    mount({ probe: makeProbe({ step: "no-node", nodeBinary: null, status: null, service: null }) });
    expect(screen.getByText("Register as a node")).toBeTruthy();
    expect(button(/install the subshell node cli/i)).toBeTruthy();
    cleanup();
  });

  it("keeps the title on the no-bundled case, where only the sentence shows", () => {
    mount({
      probe: makeProbe({ step: "no-node", nodeBinary: null, status: null, service: null, bundledVersion: null }),
    });
    expect(screen.getByText("Register as a node")).toBeTruthy();
    expect(buttonOrNull_(/install the subshell node cli/i)).toBeNull();
    expect(screen.getByText(/ships no node CLI/)).toBeTruthy();
    cleanup();
  });
});

function buttonOrNull_(name: string | RegExp) {
  return screen.queryByRole("button", { name });
}

/** makeSettings is imported for the mount parity with the other screen tests. */
void makeSettings;
