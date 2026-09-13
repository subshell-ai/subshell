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
    expect(linux).toContain("Does not start it at login");
    expect(consequences("service", "linux", true)).toContain("Starts it again at every login");
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
        onConfirm={(a) => got.push(a)}
      />,
    );
    expect(screen.queryByRole("switch", { name: "Start it at every login" })).toBeNull();
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
        onConfirm={(a) => got.push(a)}
      />,
    );
    const login = screen.getByRole("switch", { name: "Start it at every login" });
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
        onConfirm={noop}
      />,
    );
    const go = screen.getByRole("button", { name: "Switching…" }) as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows the refusal where the person is", () => {
    render(
      <SupervisionDialog
        target="app"
        onOpenChange={noop}
        view={deploymentView()}
        pending={false}
        error="no subshell-server found"
        onConfirm={noop}
      />,
    );
    expect(screen.getByText("no subshell-server found")).toBeTruthy();
  });
});
