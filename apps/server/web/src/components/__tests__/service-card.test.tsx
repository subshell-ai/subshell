import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { deploymentView, idleRestart } from "@/components/__tests__/helpers/deployment-view";
import { ServiceCard } from "@/components/service/service-card";

afterEach(cleanup);

const restartButton = () => screen.getByRole("button", { name: "Restart server" }) as HTMLButtonElement;

describe("ServiceCard", () => {
  it("says who supervises the process and offers Restart", () => {
    render(<ServiceCard view={deploymentView()} restart={idleRestart} />);
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
    render(<ServiceCard view={view} restart={idleRestart} />);
    expect(restartButton().disabled).toBe(true);
    expect(screen.getByText(/not running under a service manager/)).toBeTruthy();
  });

  it("warns when the definition kills panes", () => {
    const view = deploymentView();
    view.service.paneSafety = "kills";
    render(<ServiceCard view={view} restart={idleRestart} />);
    expect(screen.getByText(/close every running subshell/)).toBeTruthy();
  });

  /**
   * A restart speaks through the supervision line, not beside it.
   *
   * The two sentences cannot both be true: "Running under launchd as pid 1"
   * while the process it names is being taken down is the page failing to
   * notice its own button. And there is no "Back." banner, because the line
   * reverting — to a NEW pid and start time — is the confirmation.
   */
  it("replaces the supervision line while restarting, and says nothing extra", () => {
    render(<ServiceCard view={deploymentView()} restart={{ ...idleRestart, outcome: "waiting" }} />);
    expect(screen.getByText(/Restarting… waiting for the server to come back/)).toBeTruthy();
    // The claim it contradicts is GONE, not merely styled differently.
    expect(screen.queryByText(/Running under launchd/)).toBeNull();
    expect(restartButton().disabled).toBe(true);
  });

  it("confirms a finished restart with the line itself, not a banner", () => {
    const view = deploymentView();
    view.service.pid = 4242;
    render(
      <ServiceCard view={view} restart={{ ...idleRestart, outcome: "back" }} bootedAt="2026-09-12T10:42:00.000Z" />,
    );
    // The new pid and start time ARE the news; nothing to read or dismiss.
    expect(screen.getByText(/Running under launchd as pid 4242/)).toBeTruthy();
    expect(screen.queryByText("Back.")).toBeNull();
    expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
    expect(restartButton().disabled).toBe(false);
  });

  it("still says so when the restart failed or never landed", () => {
    const { unmount } = render(
      <ServiceCard view={deploymentView()} restart={{ ...idleRestart, error: "The restart could not be requested" }} />,
    );
    expect(screen.getByText(/could not be requested/)).toBeTruthy();
    unmount();
    render(<ServiceCard view={deploymentView()} restart={{ ...idleRestart, outcome: "timeout" }} />);
    expect(screen.getByText(/has not come back/)).toBeTruthy();
  });

  it("names the boot time only when the caller has one", () => {
    const { unmount } = render(<ServiceCard view={deploymentView()} restart={idleRestart} />);
    expect(screen.queryByText(/ since /)).toBeNull();
    unmount();
    render(<ServiceCard view={deploymentView()} restart={idleRestart} bootedAt="2026-09-12T10:42:00.000Z" />);
    expect(screen.getByText(/ since /)).toBeTruthy();
  });
});

/**
 * The supervision line says WHO and SINCE WHEN, and stops there.
 *
 * "starts at login" and "stops when the app quits" moved to
 * `SupervisionCard`, where each sits under the option that owns it. This
 * pins the absence because the duplicate came back once already: a botched
 * splice left two copies of this function, `bun run lint --write --unsafe`
 * renamed the dead one to `_supervisionLine` rather than failing, and the
 * copy left live was the one still carrying the tail — so the card shipped
 * saying a thing the new card had just taken over.
 */
describe("ServiceCard — the supervision line's scope", () => {
  it("names the manager, the pid and the boot time, and no login fact", () => {
    const view = deploymentView();
    view.service.enabled = true;
    render(<ServiceCard view={view} restart={idleRestart} bootedAt="2026-09-12T10:42:00.000Z" />);
    expect(screen.getByText(/Running under launchd as pid 1 since /)).toBeTruthy();
    expect(screen.queryByText(/starts at login/)).toBeNull();
  });

  it("says nothing about quitting the app either, on a machine the app runs", () => {
    const view = deploymentView();
    view.service.manager = "app";
    render(<ServiceCard view={view} restart={idleRestart} />);
    expect(screen.getByText(/Running under Subshell Server/)).toBeTruthy();
    expect(screen.queryByText(/stops when the app quits/)).toBeNull();
  });
});
