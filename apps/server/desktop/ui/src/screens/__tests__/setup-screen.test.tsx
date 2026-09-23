/**
 * The Set Up screen, as component tests: the zero-touch auto-fire's decision
 * inputs, the form's controls and gate, and the progress and failure
 * variants.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { makeProbe } from "../../__tests__/harness";
import type { ActionResult } from "../../lib/ipc";
import { DEFAULT_SUPERVISION } from "../../lib/wizard-state";
import { SetupScreen } from "../setup-screen";

afterEach(cleanup);

const STRINGS = {
  title: "Set Up Subshell Server",
  subtitle: "Choose how the server runs on this machine.",
  problem: "",
};

/** A fresh machine whose tmux is present: the setup screen's ordinary subject. */
const INIT = makeProbe({ next: "init", onboarded: false, tmux: "/usr/bin/tmux", platform: "darwin" });

function renderSetup(over: {
  probe?: typeof INIT;
  busy?: boolean;
  running?: boolean;
  failure?: ActionResult | null;
  autoFired?: boolean;
  portCheck?: { port: string; inUse: boolean } | null;
  customizeOpen?: boolean;
  seeded?: boolean;
  onAutoFire?: () => void;
  onStartSetup?: () => void;
}) {
  return render(
    <SetupScreen
      strings={over.probe ? { title: "Set Up Subshell Server", subtitle: "", problem: "" } : STRINGS}
      probe={over.probe ?? INIT}
      busy={over.busy ?? false}
      running={over.running ?? false}
      failure={over.failure ?? null}
      autoFired={over.autoFired ?? false}
      onAutoFire={over.onAutoFire ?? (() => {})}
      portCheck={over.portCheck ?? null}
      onCheckPort={() => {}}
      form={{ port: "", host: "", baseUrl: "", trustedOrigins: "" }}
      explicit={{}}
      supervision={DEFAULT_SUPERVISION}
      onSupervision={() => {}}
      customizeOpen={over.customizeOpen ?? false}
      onCustomizeToggle={() => {}}
      seeded={over.seeded ?? false}
      onFormEdit={() => {}}
      onStartSetup={over.onStartSetup ?? (() => {})}
      onPickBinary={() => {}}
      settings={undefined}
      detailsOpen={false}
      onDetailsOpenChange={() => {}}
    />,
  );
}

describe("the auto-fire", () => {
  it("fires when the port answer is in and the decision says fire", () => {
    const onAutoFire = vi.fn();
    renderSetup({ portCheck: { port: "3080", inUse: false }, onAutoFire });
    expect(onAutoFire).toHaveBeenCalledTimes(1);
  });

  it("waits for the port answer before it fires", () => {
    const onAutoFire = vi.fn();
    // The round trip is still outstanding: unknown must arrive as absent,
    // never as a conflict — a fire on an unmeasured port would send a machine
    // whose port is busy into a failed chain.
    renderSetup({ portCheck: null, onAutoFire });
    expect(onAutoFire).not.toHaveBeenCalled();
  });

  it("does not fire on a measured conflict — that is the form's job", () => {
    const onAutoFire = vi.fn();
    renderSetup({ portCheck: { port: "3080", inUse: true }, onAutoFire });
    expect(onAutoFire).not.toHaveBeenCalled();
    // The warning above the question, with the two remedies in its own words.
    expect(screen.getByText("Something is already answering on port 3080.")).toBeDefined();
    expect(screen.getByText(/choose a different port under “Customize port and addresses…”\./)).toBeDefined();
  });

  it("fires once per load, however many probes land after", () => {
    const onAutoFire = vi.fn();
    const first = renderSetup({ portCheck: { port: "3080", inUse: false }, onAutoFire });
    expect(onAutoFire).toHaveBeenCalledTimes(1);
    // A new probe identity (the poll's next answer) must not re-fire.
    first.rerender(
      <SetupScreen
        strings={STRINGS}
        probe={makeProbe({ next: "init", onboarded: false, tmux: "/usr/bin/tmux" })}
        busy={false}
        running={false}
        failure={null}
        autoFired
        onAutoFire={onAutoFire}
        portCheck={{ port: "3080", inUse: false }}
        onCheckPort={() => {}}
        form={{ port: "", host: "", baseUrl: "", trustedOrigins: "" }}
        explicit={{}}
        supervision={DEFAULT_SUPERVISION}
        onSupervision={() => {}}
        customizeOpen={false}
        onCustomizeToggle={() => {}}
        seeded={false}
        onFormEdit={() => {}}
        onStartSetup={() => {}}
        onPickBinary={() => {}}
        settings={undefined}
        detailsOpen={false}
        onDetailsOpenChange={() => {}}
      />,
    );
    expect(onAutoFire).toHaveBeenCalledTimes(1);
  });
});

describe("the form", () => {
  it("asks the supervision question with the login box's reason", () => {
    renderSetup({});
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Set Up Subshell Server");
    expect(screen.getByRole("radiogroup", { name: "How this server runs" })).toBeDefined();
    expect(screen.getByLabelText(/In the background/)).toBeDefined();
    expect((document.getElementById("plan-autostart") as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText(/Starts the server again the next time you log in/)).toBeDefined();
  });

  it("disables Set Up with its reason while tmux is missing", () => {
    renderSetup({ probe: makeProbe({ next: "init", onboarded: false, tmux: null }) });
    const setUp = screen.getByRole("button", { name: "Set Up" }) as HTMLButtonElement;
    expect(setUp.disabled).toBe(true);
    expect(screen.getByText("Waiting for tmux")).toBeDefined();
  });

  it("keeps Set Up live when tmux is present, and fires it on the press", () => {
    const onStartSetup = vi.fn();
    // autoFired so the auto-fire effect stands down and the form stays drawn.
    renderSetup({ autoFired: true, onStartSetup });
    const setUp = screen.getByRole("button", { name: "Set Up" }) as HTMLButtonElement;
    expect(setUp.disabled).toBe(false);
    setUp.click();
    expect(onStartSetup).toHaveBeenCalledTimes(1);
  });

  it("offers the binary picker only on a machine with no bundled server", () => {
    renderSetup({ probe: makeProbe({ next: "init", onboarded: false, serverChoice: "no-bundled" }), autoFired: true });
    expect(screen.getByRole("button", { name: "Choose an existing server…" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "Customize port and addresses…" })).toBeDefined();
  });

  it("shows the four address fields when Customize is open, with the dashboard row", () => {
    renderSetup({ customizeOpen: true, seeded: true });
    expect(screen.getByText("Control plane URL")).toBeDefined();
    expect(screen.getByLabelText("Port")).toBeDefined();
    expect(screen.getByLabelText("Bind address")).toBeDefined();
    expect(screen.getByLabelText("Public base URL")).toBeDefined();
    expect(screen.getByLabelText("Other addresses browsers will use (optional)")).toBeDefined();
  });
});

describe("the progress variant", () => {
  it("holds the checklist while the chain runs", () => {
    // The strings are the host's per-variant shell; the screen's own job is
    // the branch.
    render(
      <SetupScreen
        strings={{ title: "Setting Up Subshell…", subtitle: "This takes a moment.", problem: "" }}
        probe={makeProbe({ next: "init", onboarded: false })}
        busy={false}
        running
        failure={null}
        autoFired
        onAutoFire={() => {}}
        portCheck={null}
        onCheckPort={() => {}}
        form={{ port: "", host: "", baseUrl: "", trustedOrigins: "" }}
        explicit={{}}
        supervision={DEFAULT_SUPERVISION}
        onSupervision={() => {}}
        customizeOpen={false}
        onCustomizeToggle={() => {}}
        seeded={false}
        onFormEdit={() => {}}
        onStartSetup={() => {}}
        onPickBinary={() => {}}
        settings={undefined}
        detailsOpen={false}
        onDetailsOpenChange={() => {}}
      />,
    );
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Setting Up Subshell…");
    const rows = document.querySelectorAll("ul.checklist li");
    expect(rows).toHaveLength(5);
    expect(rows[0].getAttribute("data-state")).toBe("done"); // tmux present
    expect(rows[4].getAttribute("data-state")).toBe("pending"); // running
  });

  it("shows the failed row with the CLI's own words, and Try Again in the bar", () => {
    const failure: ActionResult = { ok: false, stdout: "", stderr: "install: launchctl exited 5" };
    const onStartSetup = vi.fn();
    render(
      <SetupScreen
        strings={{ title: "Setup Couldn't Finish", subtitle: "Nothing else was changed.", problem: "" }}
        probe={INIT}
        busy={false}
        running={false}
        failure={failure}
        autoFired
        onAutoFire={() => {}}
        portCheck={null}
        onCheckPort={() => {}}
        form={{ port: "", host: "", baseUrl: "", trustedOrigins: "" }}
        explicit={{}}
        supervision={DEFAULT_SUPERVISION}
        onSupervision={() => {}}
        customizeOpen={false}
        onCustomizeToggle={() => {}}
        seeded={false}
        onFormEdit={() => {}}
        onStartSetup={onStartSetup}
        onPickBinary={() => {}}
        settings={undefined}
        detailsOpen={false}
        onDetailsOpenChange={() => {}}
      />,
    );
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Setup Couldn't Finish");
    expect(screen.getAllByText("install: launchctl exited 5").length).toBeGreaterThan(0);
    const tryAgain = screen.getByRole("button", { name: "Try Again" }) as HTMLButtonElement;
    tryAgain.click();
    expect(onStartSetup).toHaveBeenCalledTimes(1);
  });
});
