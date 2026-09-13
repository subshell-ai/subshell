import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { deploymentView } from "@/components/__tests__/helpers/deployment-view";
import { RestartDialog } from "@/components/service/restart-dialog";
import type { ServerDeployment } from "@/types/server-deployment";

afterEach(cleanup);

/** The dialog open, with the pane-safety facts under test. */
function open(over: Partial<ServerDeployment["service"]>, onConfirm = (_force: boolean) => {}) {
  const view = deploymentView();
  Object.assign(view.service, over);
  return render(<RestartDialog open onOpenChange={() => {}} view={view} onConfirm={onConfirm} />);
}

/**
 * `kills` is not cosmetic: it is passed straight to `onConfirm`, which sends
 * `force: true` to the restart route. So this predicate is the difference
 * between a restart that respects the server's pane-safety refusal and one
 * that overrides it — and it had no test at all.
 */
describe("RestartDialog pane safety", () => {
  it("says nothing alarming, and does not force, when no definition is installed", () => {
    // `paneSafety` is "unknown" when there is nothing to read, and "unknown"
    // is not "keeps" — so this warned about a definition that does not exist
    // and offered to override a refusal nobody had made.
    const forced: boolean[] = [];
    open({ installed: false, paneSafety: "unknown" }, (f) => forced.push(f));
    expect(screen.getByText(/Running subshells keep running/)).toBeTruthy();
    screen.getByRole("button", { name: "Restart server" }).click();
    expect(forced).toEqual([false]);
  });

  it("warns and forces when the installed definition would close subshells", () => {
    const forced: boolean[] = [];
    open({ installed: true, paneSafety: "kills" }, (f) => forced.push(f));
    expect(screen.getByText(/close every running subshell/)).toBeTruthy();
    // The actionable command, not "reinstall the service definition" — which
    // is not something a person can do from here.
    expect(screen.getByText(/subshell-server service install/)).toBeTruthy();
    screen.getByRole("button", { name: /Restart anyway/ }).click();
    expect(forced).toEqual([true]);
  });

  it("treats an unreadable installed definition as unsafe", () => {
    // Absence of evidence is not evidence of safety: a definition that could
    // not be read gets the same refusal as one known to be lethal.
    open({ installed: true, paneSafety: "unknown" });
    expect(screen.getByText(/close every running subshell/)).toBeTruthy();
  });
});
