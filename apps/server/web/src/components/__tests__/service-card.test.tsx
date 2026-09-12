import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { deploymentView, idleRestart, stubAutostart } from "@/components/__tests__/helpers/deployment-view";
import { ServiceCard } from "@/components/service/service-card";
import { resetDesktopShellForTests } from "@/lib/desktop";

afterEach(cleanup);

const restartButton = () => screen.getByRole("button", { name: "Restart server" }) as HTMLButtonElement;

describe("ServiceCard", () => {
  it("says who supervises the process and offers Restart", () => {
    render(<ServiceCard view={deploymentView()} restart={idleRestart} autostart={stubAutostart()} />);
    expect(screen.getByText(/Running under launchd as pid 1/)).toBeTruthy();
    expect(restartButton().disabled).toBe(false);
  });

  it("disables Restart with the reason when not supervised", () => {
    const view = deploymentView();
    view.service.supervised = false;
    view.restart = {
      available: false,
      reason: "This server is not running under a service manager; restart it where you started it.",
    };
    render(<ServiceCard view={view} restart={idleRestart} autostart={stubAutostart()} />);
    expect(restartButton().disabled).toBe(true);
    expect(screen.getByText(/not running under a service manager/)).toBeTruthy();
  });

  it("warns when the definition kills panes", () => {
    const view = deploymentView();
    view.service.paneSafety = "kills";
    render(<ServiceCard view={view} restart={idleRestart} autostart={stubAutostart()} />);
    expect(screen.getByText(/close every running subshell/)).toBeTruthy();
  });

  it("names the boot time only when the caller has one", () => {
    const { unmount } = render(
      <ServiceCard view={deploymentView()} restart={idleRestart} autostart={stubAutostart()} />,
    );
    expect(screen.queryByText(/ since /)).toBeNull();
    unmount();
    render(
      <ServiceCard
        view={deploymentView()}
        restart={idleRestart}
        autostart={stubAutostart()}
        bootedAt="2026-09-12T10:42:00.000Z"
      />,
    );
    expect(screen.getByText(/ since /)).toBeTruthy();
  });
});

/**
 * Start at login (spec 2026-09-12 server-supervision § 3.7).
 *
 * The switch's whole job is to be honest about a machine where the question
 * has no answer, so most of these cases are about NOT offering it — and about
 * saying why, since a disabled control with no reason reads as a broken one.
 */
const loginSwitch = () => screen.getByRole("switch", { name: "Start at login" }) as HTMLElement;
const switchDisabled = () => loginSwitch().getAttribute("data-disabled") !== null;

describe("ServiceCard — start at login", () => {
  it("reflects the service's own answer and presses through to the caller", () => {
    const autostart = stubAutostart();
    const view = deploymentView();
    view.service.enabled = true;
    render(<ServiceCard view={view} restart={idleRestart} autostart={autostart} />);
    expect(loginSwitch().getAttribute("aria-checked")).toBe("true");
    expect(switchDisabled()).toBe(false);
    loginSwitch().click();
    expect(autostart.pressed).toEqual([false]);
  });

  it("is off, and enabled, when the service does not start at login", () => {
    const view = deploymentView();
    view.service.enabled = false;
    render(<ServiceCard view={view} restart={idleRestart} autostart={stubAutostart()} />);
    expect(loginSwitch().getAttribute("aria-checked")).toBe("false");
    expect(switchDisabled()).toBe(false);
  });

  it("is disabled with nothing installed, and says so", () => {
    const view = deploymentView();
    view.service.installed = false;
    view.service.enabled = null;
    render(<ServiceCard view={view} restart={idleRestart} autostart={stubAutostart()} />);
    expect(switchDisabled()).toBe(true);
    expect(screen.getByText("No service is installed on this machine.")).toBeTruthy();
  });

  it("is disabled under the app, and names what to do instead", () => {
    const view = deploymentView();
    view.service.manager = "app";
    view.service.installed = false;
    view.service.enabled = false;
    render(<ServiceCard view={view} restart={idleRestart} autostart={stubAutostart()} />);
    expect(switchDisabled()).toBe(true);
    // The remedy, not just the refusal: under the app it is the APP that
    // should start at login, which is a thing the person can actually do.
    expect(screen.getByText(/start the app at login instead/)).toBeTruthy();
  });

  it("is disabled when the manager would not say", () => {
    const view = deploymentView();
    view.service.enabled = null;
    render(<ServiceCard view={view} restart={idleRestart} autostart={stubAutostart()} />);
    expect(switchDisabled()).toBe(true);
    expect(screen.getByText(/did not say whether/)).toBeTruthy();
  });

  it("is disabled while a change is in flight, and shows a failure", () => {
    const { unmount } = render(
      <ServiceCard view={deploymentView()} restart={idleRestart} autostart={stubAutostart({ pending: true })} />,
    );
    expect(switchDisabled()).toBe(true);
    unmount();
    render(
      <ServiceCard
        view={deploymentView()}
        restart={idleRestart}
        autostart={stubAutostart({ error: "unit is masked" })}
      />,
    );
    expect(screen.getByText("unit is masked")).toBeTruthy();
  });

  it("says the app runs this server, and that quitting stops it", () => {
    const view = deploymentView();
    view.service.manager = "app";
    render(<ServiceCard view={view} restart={idleRestart} autostart={stubAutostart()} />);
    // "app" is an id, not a name — a person reads the product's name here.
    expect(screen.getByText(/Running under Subshell Server/)).toBeTruthy();
    expect(screen.getByText(/stops when the app quits/)).toBeTruthy();
  });
});

/**
 * The door to "How Your Server Runs" (spec 2026-09-12 § 6.4).
 *
 * It is a door rather than a control on purpose: installing or uninstalling
 * a service leaves the server unreachable for a moment, which is the standing
 * reason those verbs have no route at all. The card names a SCREEN.
 */
describe("ServiceCard — the supervision door", () => {
  /**
   * Bun runs every test FILE in one process, so a UA left overwritten here is
   * the UA the next file's components read — the trap `about-dialog.test.tsx`
   * documents. Restored after each case.
   */
  let previousUserAgent: PropertyDescriptor | undefined;

  function asShell(userAgent: string): void {
    const nav = globalThis.navigator as unknown as Record<string, unknown>;
    previousUserAgent ??= Object.getOwnPropertyDescriptor(nav, "userAgent");
    Object.defineProperty(nav, "userAgent", { value: userAgent, configurable: true, writable: true });
    resetDesktopShellForTests();
  }

  afterEach(() => {
    if (previousUserAgent) {
      Object.defineProperty(globalThis.navigator, "userAgent", previousUserAgent);
      previousUserAgent = undefined;
    }
    resetDesktopShellForTests();
  });

  const door = () => screen.queryByRole("button", { name: /Run (with the app|as a background service)/ });

  it("is absent in a browser, where there is no assistant to raise", () => {
    asShell("Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 Safari/605.1.15");
    render(<ServiceCard view={deploymentView()} restart={idleRestart} autostart={stubAutostart()} />);
    expect(door()).toBeNull();
  });

  it("offers the other mode, whichever this machine is in", () => {
    asShell("SubshellDesktop/0.2.0 (macos; p=1)");
    const { unmount } = render(
      <ServiceCard view={deploymentView()} restart={idleRestart} autostart={stubAutostart()} />,
    );
    expect(door()?.textContent).toContain("Run with the app instead");
    unmount();

    const app = deploymentView();
    app.service.manager = "app";
    render(<ServiceCard view={app} restart={idleRestart} autostart={stubAutostart()} />);
    expect(door()?.textContent).toContain("Run as a background service");
  });
});
