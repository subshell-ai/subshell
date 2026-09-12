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
