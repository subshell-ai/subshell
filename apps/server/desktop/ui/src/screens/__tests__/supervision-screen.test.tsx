/**
 * The supervision screen, as component tests: the two choice rows, the login
 * box and its reasons, the unchanged gate on Apply, the CLI's words where the
 * person still is, and the launch row that saves without an Apply.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { type FakeIpc, installFakeIpc, makeProbe } from "../../__tests__/harness";
import type { ActionResult, LaunchWindow } from "../../lib/ipc";
import { SupervisionScreen } from "../supervision-screen";

/** The last fake installed, restored after every case so no global leaks. */
let fake: FakeIpc | null = null;

afterEach(() => {
  cleanup();
  fake?.restore();
  fake = null;
});

const STRINGS = { title: "How Your Server Runs", subtitle: "Change who starts it, and when.", problem: "" };

/** What a case varies: the machine, the pending draft, and the two launch reads. */
interface SupervisionCase {
  probe?: ReturnType<typeof makeProbe>;
  supervisionForm?: { background: boolean; autostart: boolean } | null;
  failure?: ActionResult | null;
  busy?: boolean;
  /** What `desktop_launch_window` answers; the stored preference, not a default. */
  launchWindow?: LaunchWindow;
  /** Make the WRITE reject, the way a settings file that will not save does. */
  saveLaunchFails?: boolean;
  /** Make the READ reject, the way a settings file that will not parse does. */
  readLaunchFails?: boolean;
  onChoice?: (next: { background: boolean; autostart: boolean }) => void;
  onApply?: (chosen: { background: boolean; autostart: boolean }) => void;
}

function renderSupervision(over: SupervisionCase = {}): FakeIpc {
  // The launch row reads through the real `lib/ipc.ts`, so the fake answers at
  // the boundary rather than the row being handed a prop the host never sends.
  fake = installFakeIpc({
    probe: over.probe,
    handlers: {
      desktop_launch_window: () => {
        if (over.readLaunchFails) throw new Error("settings.json could not be parsed");
        return over.launchWindow ?? "dashboard";
      },
      desktop_set_launch_window: () => {
        if (over.saveLaunchFails) throw new Error("could not write settings.json");
        return null;
      },
    },
  });
  render(
    <SupervisionScreen
      strings={STRINGS}
      probe={over.probe ?? makeProbe()}
      busy={over.busy ?? false}
      running={false}
      failure={over.failure ?? null}
      supervisionForm={over.supervisionForm ?? null}
      onChoice={over.onChoice ?? (() => {})}
      onApply={over.onApply ?? (() => {})}
      onClose={() => {}}
    />,
  );
  return fake;
}

/**
 * The launch row's stored value arrives on a promise, so the draw that reflects
 * it is one microtask from the render. Flushed under `act` rather than watched
 * with `waitFor`: an observer retry escapes happy-dom's queue on Linux CI, and
 * the assertion below wants the settled DOM anyway.
 */
async function settled() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

const radio = (name: RegExp) => screen.getByLabelText(name) as HTMLInputElement;

/**
 * A pick through RTL's `fireEvent` rather than the element's own `click`.
 *
 * The supervision rows above call a parent prop, so a bare click is enough for
 * them; this row holds its OWN state (the pending value it shows while the
 * write is in flight), and a setState outside `act` warns and races the
 * assertion that follows it.
 */
const pick = (name: RegExp) => fireEvent.click(radio(name));

/**
 * A pick and the write's continuation, inside ONE `act`.
 *
 * The click settles synchronously and the command does not, so splitting them
 * across two `act`s leaves the second update outside any of them: React warns,
 * and the assertion that follows races it. `before` reads the in-flight draw,
 * which is the whole point of splitting a save from a settlement.
 */
async function pressAndSettle(name: RegExp, before?: () => void) {
  await act(async () => {
    pick(name);
    before?.();
    await new Promise((r) => setTimeout(r, 0));
  });
}

describe("the choice rows", () => {
  it("opens on the machine's own answer", () => {
    // service mode, armed for login: the machine's real state, not a default.
    renderSupervision({
      probe: makeProbe({
        supervision: "service",
        service: {
          installed: true,
          definitionPath: "/p",
          state: "running",
          pid: 1,
          enabled: true,
          paneSafety: "keeps",
          detail: "",
        },
      }),
    });
    expect((screen.getByLabelText(/^In the background/) as HTMLInputElement).checked).toBe(true);
    // The kit Switch renders the labelled control as a hidden native input,
    // so the test reads it by id — getByLabelText would match both it and the
    // role=switch span Base UI names through the same label.
    expect((document.getElementById("sup-login") as HTMLInputElement).checked).toBe(true);
    expect(
      screen.getByText(
        "Currently the Subshell Server Service runs in the background, and starts automatically on startup.",
      ),
    ).toBeDefined();
  });

  /**
   * The operator ruling of 2026-09-22, second pass: "Currently" is the
   * machine's word, not the draft's. Flipping the switch without pressing
   * Apply must not make the screen say the service starts at login — the
   * state line reads the probe; only the switch follows the pending choice.
   */
  it("never says Currently about an unapplied choice", () => {
    renderSupervision({
      // Live: service mode, NOT armed. Draft: armed, unapplied.
      probe: makeProbe({
        supervision: "service",
        service: {
          installed: true,
          definitionPath: "/p",
          state: "running",
          pid: 1,
          enabled: false,
          paneSafety: "keeps",
          detail: "",
        },
      }),
      supervisionForm: { background: true, autostart: true },
    });
    expect(
      screen.getByText(
        "Currently the Subshell Server Service runs in the background, but does not automatically start on startup.",
      ),
    ).toBeDefined();
    expect(
      screen.queryByText(
        "Currently the Subshell Server Service runs in the background, and starts automatically on startup.",
      ),
    ).toBeNull();
    // And the draft still rides the switch: this is a pending choice, not a
    // disabled readout.
    expect((document.getElementById("sup-login") as HTMLInputElement).checked).toBe(true);
  });

  it("says so plainly when the machine runs with the app", () => {
    renderSupervision({ probe: makeProbe({ supervision: "app", service: null }) });
    expect(screen.getByText("Currently the Subshell Server Service runs with this app.")).toBeDefined();
  });

  it("picks the app mode through the model's dependency rule", () => {
    const onChoice = vi.fn();
    renderSupervision({ probe: makeProbe({ supervision: "service", service: null }), onChoice });
    screen.getByLabelText(/^With this app/).click();
    // Going app takes the login box with it — arming login means nothing
    // without a service.
    expect(onChoice).toHaveBeenCalledWith({ background: false, autostart: false });
  });

  it("re-arms login at the default when a service is picked back", () => {
    const onChoice = vi.fn();
    // A half-choice left over from a visit would otherwise undo itself: the
    // pending choice rides the host state, and the model restores the default.
    renderSupervision({ probe: makeProbe(), onChoice, supervisionForm: { background: false, autostart: false } });
    screen.getByLabelText(/^In the background/).click();
    expect(onChoice).toHaveBeenCalledWith({ background: true, autostart: true });
  });

  it("disables the login box in app mode, and explains an old server", () => {
    renderSupervision({
      probe: makeProbe({
        supervision: "app",
        service: null,
        server: { argv: ["/usr/bin/subshell-server"], source: "local-bin", version: "0.8.0" },
      }),
    });
    const login = document.getElementById("sup-login") as HTMLInputElement;
    expect(login.disabled).toBe(true);
    expect(screen.getByText("Update your server to 0.9.0 to control this.")).toBeDefined();
  });
});

describe("the Apply gate", () => {
  it("is dead while the choice is the machine's own", () => {
    renderSupervision({});
    expect((screen.getByRole("button", { name: "Apply" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("fires the chosen answer once it differs, and the leave label says where back is", () => {
    const onApply = vi.fn();
    renderSupervision({ supervisionForm: { background: false, autostart: false }, onApply });
    const apply = screen.getByRole("button", { name: "Apply" }) as HTMLButtonElement;
    expect(apply.disabled).toBe(false);
    apply.click();
    expect(onApply).toHaveBeenCalledWith({ background: false, autostart: false });
    // A ready machine has the handoff behind it: the leave is Close, not Back.
    expect(screen.getByRole("button", { name: "Close" })).toBeDefined();
  });
});

describe("the CLI's own words", () => {
  it("renders where the person still is, styled as a failure", () => {
    renderSupervision({ failure: { ok: false, stdout: "", stderr: "launchctl: bootstrap failed: 5" } });
    const out = document.querySelector("pre.output");
    expect(out?.textContent).toBe("launchctl: bootstrap failed: 5");
    expect(out?.className).toContain("output-bad");
  });
});

/**
 * The launch preference (operator ruling 2026-09-23): which window a launch
 * opens once the server answers. Two named states, read from the settings file
 * and written on the press — nothing on this row waits for Apply.
 */
describe("the launch row", () => {
  it("offers both windows by name, under its own heading", () => {
    const ipc = renderSupervision();
    expect(screen.getByText("Open on launch")).toBeDefined();
    expect(radio(/^The control plane/).checked).toBe(true);
    expect(radio(/^The assistant/).checked).toBe(false);
    // A separate radio group: a pick here must not move the supervision modes,
    // whose choice is still a draft until Apply.
    expect(radio(/^The control plane/).name).toBe("launch-window");
    expect(radio(/^In the background/).name).toBe("supervision-mode");
    expect(ipc.callsTo("desktop_set_launch_window")).toEqual([]);
  });

  it("draws what the app has stored, not its own default", async () => {
    renderSupervision({ launchWindow: "assistant" });
    await settled();
    expect(radio(/^The assistant/).checked).toBe(true);
    expect(radio(/^The control plane/).checked).toBe(false);
  });

  it("saves the moment the other window is picked, with no Apply", async () => {
    const ipc = renderSupervision();
    await pressAndSettle(/^The assistant/);
    expect(ipc.callsTo("desktop_set_launch_window")).toEqual([{ window: "assistant" }]);
    // Reading a preference is not writing one: the modes' chain was never asked.
    expect(ipc.callsTo("desktop_set_supervision")).toEqual([]);
    // And the pick survives the opening read landing afterwards, which it does
    // inside this same flush: a stored answer applied late would undo a choice
    // the person can see they just made.
    expect(radio(/^The assistant/).checked).toBe(true);
  });

  it("goes back to what the file still says when the write fails, and says so", async () => {
    const ipc = renderSupervision({ saveLaunchFails: true });
    await pressAndSettle(/^The assistant/, () => {
      // The row moves at once, while the write is in flight.
      expect(radio(/^The assistant/).checked).toBe(true);
    });
    expect(ipc.callsTo("desktop_set_launch_window")).toEqual([{ window: "assistant" }]);
    // And it comes back when the write says it did not land.
    expect(radio(/^The assistant/).checked).toBe(false);
    expect(radio(/^The control plane/).checked).toBe(true);
    expect(
      screen.getByText("That choice could not be saved. The next launch opens what was saved before."),
    ).toBeTruthy();
  });

  it("shows the dashboard with a word when the stored choice cannot be read", async () => {
    // The failure must not read as a choice the person made: the row draws the
    // behavior the machine actually has, and says which of the two it is.
    renderSupervision({ readLaunchFails: true });
    await settled();
    expect(radio(/^The control plane/).checked).toBe(true);
    expect(screen.getByText("This app could not read the saved choice. The row shows the control plane.")).toBeTruthy();
  });
});
