import { afterEach, describe, expect, it } from "bun:test";
import { act, cleanup, render, screen } from "@testing-library/react";
import { deploymentView, stubAutostart, stubSupervision } from "@/components/__tests__/helpers/deployment-view";
import { currentMode, loginDisabledReason, SupervisionCard } from "@/components/service/supervision-card";
import { resetDesktopShellForTests } from "@/lib/desktop";

/**
 * Bun runs every test FILE in one process, so a UA left overwritten here is
 * the UA the next file's components read — the trap `about-dialog.test.tsx`
 * documents, and which this file hit for real: `setup.test.tsx` started
 * rendering desktop chrome under a browser UA.
 *
 * Capturing the old descriptor is NOT enough, and that is why it leaked.
 * `userAgent` lives on the `Navigator` PROTOTYPE, so
 * `getOwnPropertyDescriptor` answers `undefined` on the first call, the
 * restore is skipped as falsy, and the override survives the file. Deleting
 * the own property is what actually puts the real value back.
 */
let overrode = false;

function asShell(userAgent: string): void {
  const nav = globalThis.navigator as unknown as Record<string, unknown>;
  Object.defineProperty(nav, "userAgent", { value: userAgent, configurable: true, writable: true });
  overrode = true;
  resetDesktopShellForTests();
}

function restoreUserAgent(): void {
  if (!overrode) return;
  delete (globalThis.navigator as unknown as Record<string, unknown>).userAgent;
  overrode = false;
}

const DESKTOP = "SubshellDesktop/0.2.0 (macos; p=1)";
const BROWSER = "Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 Safari/605.1.15";

afterEach(() => {
  cleanup();
  restoreUserAgent();
  resetDesktopShellForTests();
});

const modes = () => screen.getAllByRole("radio") as HTMLInputElement[];
const door = () => screen.queryByRole("button", { name: /Switch to/ });
const loginSwitch = () => screen.getByRole("switch", { name: "Start at login" });
const switchDisabled = () => loginSwitch().getAttribute("data-disabled") !== null;

describe("currentMode", () => {
  it("reads app mode from the manager, and an installed definition as background", () => {
    const app = deploymentView();
    app.service.manager = "app";
    expect(currentMode(app)).toBe("app");
    for (const manager of ["launchd", "systemd", null] as const) {
      const view = deploymentView();
      view.service.manager = manager;
      // `installed` is true in the fixture, and that is what "in the
      // background" means — it stays the answer while the service is merely
      // stopped, when no running supervisor exists to name.
      expect(currentMode(view)).toBe("service");
    }
  });

  it("answers NEITHER for a server started by hand", () => {
    const bare = deploymentView();
    bare.service.manager = null;
    bare.service.installed = false;
    bare.service.supervised = false;
    // This used to answer "service", so the radio read "A launchd agent keeps
    // it running" directly under the Service card's "Running, not supervised".
    // Both were on screen, and one was false. It is also the ordinary state of
    // every non-desktop deployment — the audience this card was widened for.
    expect(currentMode(bare)).toBe(null);
  });
});

describe("loginDisabledReason", () => {
  it("mirrors the route's three refusals, so the UI never offers what the server refuses", () => {
    const app = deploymentView();
    app.service.manager = "app";
    // Not a refusal — the question is real in app mode too, and the reason
    // names the thing that WOULD answer it, which the person can go and do.
    expect(loginDisabledReason(app)).toContain("open Subshell Server at login");

    const bare = deploymentView();
    bare.service.installed = false;
    expect(loginDisabledReason(bare)).toContain("No service is installed");

    const mute = deploymentView();
    mute.service.enabled = null;
    expect(loginDisabledReason(mute)).toContain("did not say");

    expect(loginDisabledReason(deploymentView())).toBe(null);
  });
});

describe("SupervisionCard", () => {
  it("shows BOTH modes with the machine's own marked", () => {
    asShell(DESKTOP);
    render(<SupervisionCard view={deploymentView()} autostart={stubAutostart()} supervision={stubSupervision()} />);
    const [background, app] = modes();
    expect(background?.checked).toBe(true);
    expect(app?.checked).toBe(false);
    // The alternative is named, not hidden behind a verb — which is what the
    // bare "Run with the app instead…" button failed to do.
    expect(screen.getByText(/With the Subshell Server app/)).toBeTruthy();
  });

  it("marks the app option on a machine the app runs", () => {
    asShell(DESKTOP);
    const view = deploymentView();
    view.service.manager = "app";
    render(<SupervisionCard view={view} autostart={stubAutostart()} supervision={stubSupervision()} />);
    expect(modes()[1]?.checked).toBe(true);
  });

  it("opens the confirmation dialog on THIS page, and invokes nothing until it is confirmed", async () => {
    asShell(DESKTOP);
    const supervision = stubSupervision();
    render(<SupervisionCard view={deploymentView()} autostart={stubAutostart()} supervision={supervision} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    act(() => modes()[1]?.click());
    // A dialog here, not a window from the desktop app: the window read as a
    // bug rather than a safeguard, and the consent is the person's, not the
    // page's (docs/security.md).
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByText(/Run the server with the app\?/)).toBeTruthy();
    expect(supervision.calls).toEqual([]);
    await act(async () => {
      screen.getByRole("button", { name: "Run with the app" }).click();
      await Promise.resolve();
    });
    expect(supervision.calls).toEqual([{ mode: "app", autostart: true, force: false }]);
  });

  it("keeps the dialog open with the reason when the switch is refused", () => {
    asShell(DESKTOP);
    const supervision = stubSupervision({ result: false, error: "no subshell-server found" });
    render(<SupervisionCard view={deploymentView()} autostart={stubAutostart()} supervision={supervision} />);
    act(() => modes()[1]?.click());
    act(() => screen.getByRole("button", { name: "Run with the app" }).click());
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByText("no subshell-server found")).toBeTruthy();
  });

  it("keeps showing the MACHINE's mode when you pick the other one", () => {
    asShell(DESKTOP);
    render(<SupervisionCard view={deploymentView()} autostart={stubAutostart()} supervision={stubSupervision()} />);
    act(() => modes()[1]?.click());
    // The selection follows the machine, not the press — so dismissing the
    // dialog cannot leave this card claiming a mode that never took effect.
    // It moves when the next poll reports the change. `hidden: true` because
    // the dialog is modal and Base UI marks the card behind it aria-hidden;
    // the state under test IS the hidden one.
    const behind = screen.getAllByRole("radio", { hidden: true }) as HTMLInputElement[];
    expect(behind[0]?.checked).toBe(true);
    expect(behind[1]?.checked).toBe(false);
  });

  it("is read-only in a browser, and says where to change it", () => {
    asShell(BROWSER);
    render(<SupervisionCard view={deploymentView()} autostart={stubAutostart()} supervision={stubSupervision()} />);
    // Every viewer learns the mode — that is the point of showing both — but
    // only the machine's own app can change it, and a control that moves and
    // can never be applied is a worse lie than one that does not move.
    for (const radio of modes()) expect(radio.disabled).toBe(true);
    expect(door()).toBeNull();
    expect(screen.getByText(/Subshell Server app on that machine/)).toBeTruthy();
  });

  it("puts the login switch BELOW both modes, not between them", () => {
    asShell(DESKTOP);
    render(<SupervisionCard view={deploymentView()} autostart={stubAutostart()} supervision={stubSupervision()} />);
    // Nesting it under the first radio wedged a control between the two
    // choices, so they stopped reading as a pair. The dependency on the mode
    // is expressed by the disabled reason below, not by indentation — so in
    // document order both radios come first and the switch comes last.
    const radios = modes();
    const switchEl = loginSwitch();
    for (const radio of radios) {
      expect(radio.compareDocumentPosition(switchEl) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });

  it("reflects the service's login answer and presses through to the caller", () => {
    asShell(DESKTOP);
    const view = deploymentView();
    view.service.enabled = true;
    const autostart = stubAutostart();
    render(<SupervisionCard view={view} autostart={autostart} supervision={stubSupervision()} />);
    expect(loginSwitch().getAttribute("aria-checked")).toBe("true");
    expect(switchDisabled()).toBe(false);
    loginSwitch().click();
    expect(autostart.pressed).toEqual([false]);
  });

  it("disables the login switch in app mode, naming what would answer instead", () => {
    asShell(DESKTOP);
    const view = deploymentView();
    view.service.manager = "app";
    view.service.installed = false;
    render(<SupervisionCard view={view} autostart={stubAutostart()} supervision={stubSupervision()} />);
    expect(switchDisabled()).toBe(true);
    expect(screen.getByText(/open Subshell Server at login/)).toBeTruthy();
  });

  it("checks NEITHER radio on a hand-started server, and says why", () => {
    asShell(DESKTOP);
    const bare = deploymentView();
    bare.service.manager = null;
    bare.service.installed = false;
    bare.service.supervised = false;
    render(<SupervisionCard view={bare} autostart={stubAutostart()} supervision={stubSupervision()} />);
    for (const radio of modes()) expect(radio.checked).toBe(false);
    expect(screen.getByText(/started by hand/)).toBeTruthy();
  });

  it("names the radios as one group, so they are not announced as two unrelated controls", () => {
    asShell(DESKTOP);
    render(<SupervisionCard view={deploymentView()} autostart={stubAutostart()} supervision={stubSupervision()} />);
    expect(screen.getByRole("radiogroup", { name: "How this server runs" })).toBeTruthy();
  });

  it("forgets the previous attempt's failure when a new dialog opens", () => {
    asShell(DESKTOP);
    const supervision = stubSupervision({ result: false, error: "no subshell-server found" });
    render(<SupervisionCard view={deploymentView()} autostart={stubAutostart()} supervision={supervision} />);
    act(() => modes()[1]?.click());
    // Otherwise the failure from the "app" attempt greets the next dialog,
    // describing something the person is no longer doing.
    expect(supervision.resets).toBe(1);
  });

  it("closes the dialog when the switch succeeds", async () => {
    asShell(DESKTOP);
    render(<SupervisionCard view={deploymentView()} autostart={stubAutostart()} supervision={stubSupervision()} />);
    act(() => modes()[1]?.click());
    // The close lands in the `.then` of `set()`, a microtask after the click —
    // so the click and the flush have to be inside the SAME act.
    await act(async () => {
      screen.getByRole("button", { name: "Run with the app" }).click();
      await Promise.resolve();
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("stays dismissible while the switch is in flight", () => {
    asShell(DESKTOP);
    render(
      <SupervisionCard
        view={deploymentView()}
        autostart={stubAutostart()}
        supervision={stubSupervision({ pending: true })}
      />,
    );
    act(() => modes()[1]?.click());
    // The chain runs in the desktop app whether this dialog is open or not,
    // and the switch deliberately takes the server away — so a modal that
    // refuses to close is a page with no way back to itself.
    act(() => screen.getByRole("button", { name: "Continue in the background" }).click());
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("surfaces a failed login change", () => {
    asShell(DESKTOP);
    render(
      <SupervisionCard
        view={deploymentView()}
        autostart={stubAutostart({ error: "unit is masked" })}
        supervision={stubSupervision()}
      />,
    );
    expect(screen.getByText("unit is masked")).toBeTruthy();
  });
});
