import { afterEach, describe, expect, it } from "bun:test";
import { act, cleanup, render, screen } from "@testing-library/react";
import { deploymentView } from "@/components/__tests__/helpers/deployment-view";
import { consequences, SupervisionDialog } from "@/components/service/supervision-dialog";

afterEach(cleanup);

const noop = () => {};

describe("consequences", () => {
  it("names the platform's own agent and ends on the fact people are actually asking about", () => {
    const mac = consequences("app", "darwin", true);
    expect(mac[0]).toBe("Removes the launchd agent");
    expect(mac.at(-1)).toBe("Running subshells keep running");
    const linux = consequences("service", "linux", false);
    expect(linux[1]).toBe("Installs a systemd user service and starts it");
    expect(linux).toContain("Does not come back after you log out — you would start it yourself");
    expect(consequences("service", "linux", true)).toContain("Starts it again the next time you log in");
  });
});

describe("SupervisionDialog", () => {
  it("is closed with no target", () => {
    render(
      <SupervisionDialog
        target={null}
        onOpenChange={noop}
        view={deploymentView()}
        pending={false}
        error={null}
        details={null}
        onConfirm={noop}
      />,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("confirms TO the app with the login answer absent — there is nothing to arm", () => {
    const got: boolean[] = [];
    render(
      <SupervisionDialog
        target="app"
        onOpenChange={noop}
        view={deploymentView()}
        pending={false}
        error={null}
        details={null}
        onConfirm={(a) => got.push(a)}
      />,
    );
    expect(screen.queryByRole("switch", { name: "Start it again at every login" })).toBeNull();
    act(() => screen.getByRole("button", { name: "Run with the app" }).click());
    expect(got).toEqual([true]);
  });

  it("offers the login box only when going TO a service, defaulting on", () => {
    const got: boolean[] = [];
    render(
      <SupervisionDialog
        target="service"
        onOpenChange={noop}
        view={deploymentView()}
        pending={false}
        error={null}
        details={null}
        onConfirm={(a) => got.push(a)}
      />,
    );
    const login = screen.getByRole("switch", { name: "Start it again at every login" });
    expect(login.getAttribute("aria-checked")).toBe("true");
    act(() => login.click());
    act(() => screen.getByRole("button", { name: "Run in the background" }).click());
    expect(got).toEqual([false]);
  });

  it("says it is working, and refuses a second press, while the chain runs", () => {
    render(
      <SupervisionDialog
        target="app"
        onOpenChange={noop}
        view={deploymentView()}
        pending
        error={null}
        details={null}
        onConfirm={noop}
      />,
    );
    const go = screen.getByRole("button", { name: "Switching…" }) as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    // The dismiss button stays LIVE, and says "Close" rather than "Cancel"
    // because it does not cancel anything — the chain runs in the desktop app
    // either way. It was disabled, and that turned the one surface able to
    // explain a failed switch into a modal saying "Switching…" forever on a
    // page whose server was gone.
    const close = screen.getByRole("button", { name: "Continue in the background" }) as HTMLButtonElement;
    expect(close.disabled).toBe(false);
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
  });

  it("renders the chain log behind a failure, collapsed", () => {
    render(
      <SupervisionDialog
        target="service"
        onOpenChange={noop}
        view={deploymentView()}
        pending={false}
        error="install failed"
        details={"Stopped the server this app was running.\ninstall failed"}
        onConfirm={noop}
      />,
    );
    // The steps are destructive in order, so the log is the only record of how
    // far the machine moved — "the server is now stopped" is not in the one
    // stderr line the dialog leads with.
    expect(screen.getByText("What ran before it stopped")).toBeTruthy();
    expect(screen.getByText(/Stopped the server this app was running/)).toBeTruthy();
  });

  it("shows the refusal where the person is", () => {
    render(
      <SupervisionDialog
        target="app"
        onOpenChange={noop}
        view={deploymentView()}
        pending={false}
        error="no subshell-server found"
        details={null}
        onConfirm={noop}
      />,
    );
    expect(screen.getByText("no subshell-server found")).toBeTruthy();
  });
});
