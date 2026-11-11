import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { deploymentView, idleRestart } from "@/components/__tests__/helpers/deployment-view";
import { PluginRestartOffer } from "@/components/plugins/plugin-restart-offer";
import type { ServerRestart } from "@/hooks/use-server-restart";

/**
 * The offer that closes the plugin-update loop: replacing bytes in the store
 * does not replace code this process imported at boot, so an updated row
 * reports `restartRequired` until the server has restarted.
 *
 * The dialog is `RestartDialog`, not a copy of it — its pane-safety warning
 * and the `force` it forwards are the difference between a restart that
 * respects the server's refusal and one that ploughs through it, and both
 * paths are asserted here rather than trusted to the dialog's own suite.
 */

const base = deploymentView();
/** The definition that would take every running pane down with the process. */
const killsView = { ...base, service: { ...base.service, paneSafety: "kills" as const } };

/** A restart handle that records the body it was called with. */
function stubRestart(bodies: { force?: boolean }[], over: Partial<ServerRestart> = {}): ServerRestart {
  return {
    ...idleRestart,
    restart: async (body) => {
      bodies.push(body);
    },
    ...over,
  };
}

afterEach(cleanup);

describe("PluginRestartOffer", () => {
  it("offers the restart while a plugin reports restartRequired", () => {
    render(<PluginRestartOffer restartRequired deployment={base} restart={idleRestart} />);
    expect(screen.getByText("Updated plugins take effect after the server restarts.")).toBeDefined();
    expect(screen.getByRole("button", { name: "Restart server" })).toBeDefined();
  });

  it("renders nothing once no plugin needs a restart", () => {
    render(<PluginRestartOffer restartRequired={false} deployment={base} restart={idleRestart} />);
    expect(screen.queryByRole("button", { name: "Restart server" })).toBeNull();
    expect(screen.queryByText(/take effect after the server restarts/)).toBeNull();
  });

  it("keeps the pane-safety warning and passes force", () => {
    const forced: { force?: boolean }[] = [];
    render(<PluginRestartOffer restartRequired deployment={killsView} restart={stubRestart(forced)} />);
    fireEvent.click(screen.getByRole("button", { name: "Restart server" }));
    expect(screen.getByText(/close every running subshell/)).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Restart anyway" }));
    expect(forced).toEqual([{ force: true }]);
  });

  it("does not force a definition that keeps the panes", () => {
    const called: { force?: boolean }[] = [];
    render(<PluginRestartOffer restartRequired deployment={base} restart={stubRestart(called)} />);
    fireEvent.click(screen.getByRole("button", { name: "Restart server" }));
    // The dialog's confirm is the second "Restart server": the offer's own
    // press only opened the question.
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Restart server" }));
    expect(called).toEqual([{}]);
  });

  it("renders nothing while the deployment view is still loading", () => {
    const { container } = render(<PluginRestartOffer restartRequired restart={idleRestart} />);
    // The update result is already visible in the rows; a sentence guessing at
    // the machine's restart answer would be a claim nobody has made yet.
    expect(container.textContent).toBe("");
  });

  it("shows the waiting state while the server is away", () => {
    render(<PluginRestartOffer restartRequired deployment={base} restart={{ ...idleRestart, outcome: "waiting" }} />);
    const status = screen.getByRole("status");
    expect(status.textContent).toContain("Restarting… waiting for the server to come back.");
    expect(screen.queryByRole("button", { name: "Restart server" })).toBeNull();
  });

  it("keeps the retry beside a failed request, and the retry reaches the wait", async () => {
    // A failed POST used to replace the offer with a red sentence and no way
    // back: the only remedy was a page reload. The press is repeatable, and
    // `restart()` clears the error, so the button stays.
    const attempts: { force?: boolean }[] = [];
    function Harness() {
      const [state, setState] = useState<{ outcome: ServerRestart["outcome"]; error: string | null }>({
        outcome: "idle",
        error: null,
      });
      const restart: ServerRestart = {
        ...state,
        async restart() {
          attempts.push({});
          if (attempts.length === 1) {
            setState({ outcome: "idle", error: "The restart could not be requested" });
            return;
          }
          setState({ outcome: "waiting", error: null });
        },
      };
      return <PluginRestartOffer restartRequired deployment={base} restart={restart} />;
    }
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Restart server" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Restart server" }));
    expect(await screen.findByText("The restart could not be requested")).toBeDefined();
    // The offer is still there to press again, and the second press works.
    fireEvent.click(screen.getByRole("button", { name: "Restart server" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Restart server" }));
    expect(await screen.findByText(/waiting for the server to come back/)).toBeDefined();
    expect(attempts).toHaveLength(2);
  });

  it("tells the reader where to look when the restart never landed", () => {
    render(<PluginRestartOffer restartRequired deployment={base} restart={{ ...idleRestart, outcome: "timeout" }} />);
    expect(screen.getByText(/The server has not come back/i)).toBeDefined();
    expect(screen.getByText(/check the service/i)).toBeDefined();
    expect(screen.queryByRole("button", { name: "Restart server" })).toBeNull();
  });

  it("says no Back. — the reappearing rows are the confirmation", () => {
    render(<PluginRestartOffer restartRequired deployment={base} restart={{ ...idleRestart, outcome: "back" }} />);
    expect(screen.getByRole("button", { name: "Restart server" })).toBeDefined();
    expect(screen.queryByText(/^Back\.?$/)).toBeNull();
  });
});
