import { afterEach, describe, expect, it } from "bun:test";
import { act, cleanup, render, screen } from "@testing-library/react";
import {
  deploymentView,
  linuxDeploymentView,
  stubAutostart,
  stubSupervision,
} from "@/components/__tests__/helpers/deployment-view";
import { SupervisionCard } from "@/components/service/supervision-card";
import { resetDesktopShellForTests } from "@/lib/desktop";
import { currentMode, loginDisabledReason } from "@/lib/supervision";

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
      // stopped, when no running supervisor exists to name. The manager name
      // does not enter into it, in EITHER direction.
      expect(currentMode(view)).toBe("service");
      view.service.installed = false;
      expect(currentMode(view)).toBe(null);
    }
  });

  it("answers NEITHER for a server started by hand", () => {
    const bare = deploymentView();
    // `manager` deliberately LEFT as the platform's name, which is what the
    // server always sends: it says which manager this host would use, never
    // that one is managing anything. Reading it here reported "In the
    // background" on every macOS and Linux machine, installed or not.
    bare.service.manager = "launchd";
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

  it("shows a spinner and the target while the switch is landing", () => {
    asShell(DESKTOP);
    render(
      <SupervisionCard
        view={deploymentView()}
        autostart={stubAutostart()}
        supervision={stubSupervision({ settling: "app" })}
      />,
    );
    // The command returning is not the switch being done: the server is
    // coming back, the card still shows the machine's OLD mode, and without
    // this the dialog closed onto a page that looked like it had done nothing.
    expect(screen.getByText(/Switching to the Subshell Server app/)).toBeTruthy();
    // And the radios are locked, because a second switch would race the first
    // for the port — `ActionGuard` would refuse it anyway.
    for (const radio of modes()) expect(radio.disabled).toBe(true);
  });

  it("says so when the server never comes back", () => {
    asShell(DESKTOP);
    render(
      <SupervisionCard
        view={deploymentView()}
        autostart={stubAutostart()}
        supervision={stubSupervision({ timedOut: true })}
      />,
    );
    expect(screen.getByText(/has not come back/)).toBeTruthy();
  });

  it("keeps the two axes distinct: who runs it, and whether it comes back", () => {
    asShell(DESKTOP);
    render(<SupervisionCard view={deploymentView()} autostart={stubAutostart()} supervision={stubSupervision()} />);
    // The mode says WHO runs the server; it must not also claim to answer
    // logins, which is what "keeps it running whether or not the app is open"
    // was read as. Both managers run inside the login session.
    expect(screen.getByText(/runs it, whether or not Subshell Server is open/)).toBeTruthy();
    expect(screen.getByText(/nothing brings it back after you log out/)).toBeTruthy();
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

/**
 * The browser half is a different card, not a disabled copy of the app's one.
 *
 * It used to render both radios disabled under "Changing this is done in the
 * Subshell Server app on that machine" — which offered a headless Linux
 * operator a mode their machine has no app for, and told them to go and use
 * it. What they get now is the one fact they came for.
 */
describe("SupervisionCard in a browser", () => {
  const browser = (view = deploymentView(), autostart = stubAutostart()) =>
    render(<SupervisionCard view={view} autostart={autostart} supervision={stubSupervision()} />);

  it("offers no choice at all — neither the modes nor the login switch", () => {
    asShell(BROWSER);
    browser();
    // Not disabled: absent. A control that can never be applied is noise, and
    // "start at login" is the desktop question this card stopped asking here.
    expect(screen.queryAllByRole("radio")).toEqual([]);
    expect(screen.queryAllByRole("switch")).toEqual([]);
  });

  it("states the app's own answer without offering the app's controls", () => {
    asShell(BROWSER);
    const view = deploymentView();
    view.service.manager = "app";
    browser(view);
    expect(screen.getByText(/quitting the app stops it/)).toBeTruthy();
    expect(screen.queryAllByRole("button", { name: "Start automatically" })).toEqual([]);
  });

  it("says a lingering systemd user survives a reboot, and offers nothing", () => {
    asShell(BROWSER);
    browser(linuxDeploymentView({ enabled: true, linger: true }));
    expect(screen.getByText(/without anyone logging in/)).toBeTruthy();
    // The fix is for the machines that need it. Offering `loginctl` to a user
    // who already lingers is an instruction to do what is already done.
    expect(screen.queryByText(/loginctl/)).toBeNull();
  });

  it("names the logout trap on a systemd user who does not linger, with the command", () => {
    asShell(BROWSER);
    browser(linuxDeploymentView({ enabled: true, linger: false }));
    // The fact that decides survival on Linux, and which no version of this
    // card showed before: an enabled --user unit lives inside its owner's
    // login session.
    expect(screen.getByText(/stops when you log out/)).toBeTruthy();
    expect(screen.getByText(/To keep it running after you log out/)).toBeTruthy();
    expect(screen.getByText("loginctl enable-linger $USER")).toBeTruthy();
  });

  it("asks rather than accuses when logind never answered, and still offers the command", () => {
    asShell(BROWSER);
    browser(linuxDeploymentView({ enabled: true, linger: null }));
    expect(screen.getByText(/needs lingering to stay up/)).toBeTruthy();
    // `null` is "we could not measure" — a container, or no loginctl on PATH —
    // so the remedy is offered as an answer to the question above rather than
    // as a fault report.
    expect(screen.getByText(/If it needs to stay up with nobody logged in:/)).toBeTruthy();
    expect(screen.queryByText(/To keep it running after you log out/)).toBeNull();
    expect(screen.getByText("loginctl enable-linger $USER")).toBeTruthy();
  });

  it("offers ONE button for a definition that will not come back, and presses through", () => {
    asShell(BROWSER);
    const autostart = stubAutostart();
    browser(linuxDeploymentView({ enabled: false }), autostart);
    expect(screen.getByText(/Will not come back after a reboot/)).toBeTruthy();
    screen.getByRole("button", { name: "Start automatically" }).click();
    // Only the arming direction exists here: nobody on a headless box disarms
    // their own server from a web page, and doing it stays a CLI act.
    expect(autostart.pressed).toEqual([true]);
  });

  it("locks that button while the change is in flight, and says why it failed", () => {
    asShell(BROWSER);
    browser(linuxDeploymentView({ enabled: false }), stubAutostart({ pending: true, error: "unit is masked" }));
    expect((screen.getByRole("button", { name: "Start automatically" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("unit is masked")).toBeTruthy();
  });

  it("offers the install command when nothing is installed", () => {
    asShell(BROWSER);
    browser(linuxDeploymentView({ installed: false, enabled: null }));
    expect(screen.getByText(/Nothing brings it back when it stops/)).toBeTruthy();
    expect(screen.getByText("subshell-server service install")).toBeTruthy();
    expect(screen.queryAllByRole("button", { name: "Start automatically" })).toEqual([]);
  });

  it("states a launchd agent's login lifetime and offers no remedy for it", () => {
    asShell(BROWSER);
    browser();
    // A LaunchAgent's lifetime IS the login session by design; there is no
    // linger equivalent to offer, and a Mac nobody logs in to runs no agents
    // either way.
    expect(screen.getByText(/Comes back when you log in to this machine/)).toBeTruthy();
    expect(screen.queryByText(/loginctl/)).toBeNull();
    expect(screen.queryAllByRole("button", { name: "Start automatically" })).toEqual([]);
  });
});
