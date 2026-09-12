import { afterEach, describe, expect, it } from "bun:test";
import { act, cleanup, render, screen } from "@testing-library/react";
import { deploymentView, stubAutostart } from "@/components/__tests__/helpers/deployment-view";
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
  it("reads app mode from the manager, and treats everything else as background", () => {
    const app = deploymentView();
    app.service.manager = "app";
    expect(currentMode(app)).toBe("app");
    for (const manager of ["launchd", "systemd", null] as const) {
      const view = deploymentView();
      view.service.manager = manager;
      // A machine with no manager at all is still the background answer:
      // that is what an operator would install if they installed anything.
      expect(currentMode(view)).toBe("service");
    }
  });
});

describe("loginDisabledReason", () => {
  it("mirrors the route's three refusals, so the UI never offers what the server refuses", () => {
    const app = deploymentView();
    app.service.manager = "app";
    expect(loginDisabledReason(app)).toContain("app itself");

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
    render(<SupervisionCard view={deploymentView()} autostart={stubAutostart()} />);
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
    render(<SupervisionCard view={view} autostart={stubAutostart()} />);
    expect(modes()[1]?.checked).toBe(true);
  });

  it("offers no door until a different mode is picked", () => {
    asShell(DESKTOP);
    render(<SupervisionCard view={deploymentView()} autostart={stubAutostart()} />);
    // A standing verb is what made the old button read as an afterthought.
    expect(door()).toBeNull();
    act(() => modes()[1]?.click());
    expect(door()?.textContent).toContain("Switch to the app");
  });

  it("names the other direction from app mode", () => {
    asShell(DESKTOP);
    const view = deploymentView();
    view.service.manager = "app";
    render(<SupervisionCard view={view} autostart={stubAutostart()} />);
    act(() => modes()[0]?.click());
    expect(door()?.textContent).toContain("background service");
  });

  it("is read-only in a browser, and says where to change it", () => {
    asShell(BROWSER);
    render(<SupervisionCard view={deploymentView()} autostart={stubAutostart()} />);
    // Every viewer learns the mode — that is the point of showing both — but
    // only the machine's own app can change it, and a control that moves and
    // can never be applied is a worse lie than one that does not move.
    for (const radio of modes()) expect(radio.disabled).toBe(true);
    expect(door()).toBeNull();
    expect(screen.getByText(/Subshell Server app on that machine/)).toBeTruthy();
  });

  it("nests the login switch under the background option and honours its reasons", () => {
    asShell(DESKTOP);
    const view = deploymentView();
    view.service.enabled = true;
    const autostart = stubAutostart();
    render(<SupervisionCard view={view} autostart={autostart} />);
    expect(loginSwitch().getAttribute("aria-checked")).toBe("true");
    expect(switchDisabled()).toBe(false);
    loginSwitch().click();
    expect(autostart.pressed).toEqual([false]);
  });

  it("disables the login switch under the app, naming what would have to start at login", () => {
    asShell(DESKTOP);
    const view = deploymentView();
    view.service.manager = "app";
    view.service.installed = false;
    render(<SupervisionCard view={view} autostart={stubAutostart()} />);
    expect(switchDisabled()).toBe(true);
    expect(screen.getByText(/app itself would need to start at login/)).toBeTruthy();
  });

  it("surfaces a failed login change", () => {
    asShell(DESKTOP);
    render(<SupervisionCard view={deploymentView()} autostart={stubAutostart({ error: "unit is masked" })} />);
    expect(screen.getByText("unit is masked")).toBeTruthy();
  });
});
