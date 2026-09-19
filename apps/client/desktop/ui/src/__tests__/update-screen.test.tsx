/**
 * The one update act, on screen (spec 2026-09-18 §§ 4.2, 7.1, 7.4).
 *
 * `update-act.test.ts` pins the decisions; these are the things only a rendered
 * page can answer — that the status screen's button is a door rather than an
 * install, that a marker left by a previous BUILD finishes the act by itself,
 * that when it does the screen says the daemon is still on the old agent and
 * offers the restart the CLI will not do unasked, and that the table is a
 * SELECTION whose checkboxes move what the press says it will do (§ 13).
 */
import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { App } from "@/app";
import { type FakeIpc, installFakeIpc, makeProbe, renderApp } from "./harness";

let ipc: FakeIpc | undefined;

afterEach(() => {
  cleanup();
  ipc?.restore();
  ipc = undefined;
});

const button = (name: string | RegExp) => screen.getByRole("button", { name }) as HTMLButtonElement;
const buttonOrNull = (name: string | RegExp) => screen.queryByRole("button", { name }) as HTMLButtonElement | null;

/** An app already at the newest release, so only the agent half can be behind. */
const APP_CURRENT = { current: "0.6.1", latest: null, notes: null, reason: null };

async function boot(init: Parameters<typeof installFakeIpc>[0] = {}) {
  ipc = installFakeIpc(init);
  renderApp(<App />);
  await waitFor(() => expect(ipc?.callsTo("node_probe").length).toBeGreaterThan(0));
  return ipc;
}

/** The agent this app ships is newer than the one installed. */
const BEHIND = makeProbe({
  agentChoice: "upgrade-available",
  bundledVersion: "1.10.0",
  agent: { argv: ["/home/u/.local/bin/subshell"], source: "local-bin", version: "1.9.0" },
});

describe("the status screen's button is a door (§ 7.4)", () => {
  it("opens the one act instead of installing the agent on the spot", async () => {
    const fake = await boot({
      probe: BEHIND,
      handlers: { node_check_app_update: () => APP_CURRENT },
    });

    fireEvent.click(button("Update the node to 1.10.0"));

    await waitFor(() => expect(screen.getByText("Update Subshell Client")).toBeTruthy());
    // Nothing was installed by walking through the door — the act asks first.
    expect(fake.callsTo("node_install_cli").length).toBe(0);
    // The half that is behind carries its numbers and its own checkbox — the
    // app is current here, so the agent row is an act of its own (§ 13.1).
    expect(screen.getByText("Subshell Node CLI")).toBeTruthy();
    expect(screen.getByText("1.9.0")).toBeTruthy();
    expect(screen.getByText("1.10.0")).toBeTruthy();
    expect((screen.getByRole("checkbox", { name: "Update Subshell Node CLI" }) as HTMLInputElement).checked).toBe(true);
  });

  it("leaves by its own Back, because an override is a screen and not a verdict", async () => {
    await boot({ probe: BEHIND, handlers: { node_check_app_update: () => APP_CURRENT } });
    fireEvent.click(button("Update the node to 1.10.0"));
    await waitFor(() => expect(screen.getByText("Update Subshell Client")).toBeTruthy());
    fireEvent.click(button("Back"));
    await waitFor(() => expect(buttonOrNull("Update the node to 1.10.0")).not.toBeNull());
  });

  /**
   * The frame's contract is "primary right and ghost left", and every screen
   * that asks something ends on a filled button at the bottom right. This
   * screen's act is the press in the CONTENT, so the bar carries only the way
   * out — which sat in the ghost-left seat, leaving the filled one empty and
   * making the one footer button the faintest thing in the frame (operator's
   * call, 2026-09-18, on the sibling app's copy of the same screen).
   *
   * The WORD stays Back, and the case above is why: leaving returns to the
   * status screen rather than closing anything. The server app's says Close
   * because `host.close()` really does end that window.
   */
  it("ends on a filled leave at the bottom right, with Check Again beside it", async () => {
    await boot({ probe: BEHIND, handlers: { node_check_app_update: () => APP_CURRENT } });
    fireEvent.click(button("Update the node to 1.10.0"));
    await waitFor(() => expect(screen.getByText("Update Subshell Client")).toBeTruthy());

    const leave = button("Back");
    const check = button("Check Again");
    // Same bar cell, and Check Again comes FIRST — the seat Restart takes
    // beside Save on the sibling app's Server Addresses.
    expect(leave.parentElement).toBe(check.parentElement);
    expect(check.compareDocumentPosition(leave) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Nothing is left in the ghost-left cell.
    const bar = leave.parentElement?.parentElement;
    expect(
      within(bar as HTMLElement)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["Check Again", "Back"]);
    // The leave is the PRIMARY — the filled gradient the `default` variant
    // paints — and Check Again is the `outline` one beside it. Keyed on the
    // variant's own token rather than on a word like "outline", which every
    // button carries through `focus-visible:outline-none`.
    expect(leave.className).toContain("--button-primary-from");
    expect(check.className).not.toContain("--button-primary-from");
  });
});

describe("the second phase finishes an act this build did not start (§ 4.2)", () => {
  /**
   * The press happened in a process that no longer exists — `app.restart()`
   * never returns — so there is nothing left to consent to, and the new build
   * installs the agent its own bundle ships without asking again.
   */
  it("installs the bundled agent by itself when the probe reports a marker", async () => {
    const fake = await boot({
      probe: makeProbe({
        ...BEHIND,
        pendingInstall: { fromAppVersion: "0.6.0", attempts: 0, halted: false },
      }),
      handlers: {
        node_check_app_update: () => APP_CURRENT,
        node_install_cli: () => ({ ok: true, stdout: "Installed subshell 1.10.0", stderr: "" }),
      },
    });

    await waitFor(() => expect(fake.callsTo("node_install_cli").length).toBe(1));
    // And it raised the screen to say so, rather than doing it behind the
    // landing the person was looking at.
    expect(screen.getByText("Update Subshell Client")).toBeTruthy();
    // No confirmation: phase 1's press was the consent for both halves.
    expect(screen.queryByRole("region")).toBeNull();
  });

  /**
   * Bounded at the marker's attempt limit, which Rust reports as `halted`.
   * An install that fails on every boot would otherwise take this window to a
   * failure screen on every launch, forever.
   */
  it("stops firing and offers Retry once it has failed too often", async () => {
    const fake = await boot({
      probe: makeProbe({
        ...BEHIND,
        pendingInstall: { fromAppVersion: "0.6.0", attempts: 2, halted: true },
      }),
      handlers: {
        node_check_app_update: () => APP_CURRENT,
        node_install_cli: () => ({ ok: true, stdout: "Installed subshell 1.10.0", stderr: "" }),
      },
    });

    await waitFor(() => expect(buttonOrNull("Retry")).not.toBeNull());
    expect(fake.callsTo("node_install_cli").length).toBe(0);

    fireEvent.click(button("Retry"));
    await waitFor(() => expect(fake.callsTo("node_install_cli").length).toBe(1));
  });
});

describe("the restart it offers rather than performs (§ 7.1)", () => {
  /**
   * `--no-restart` stays: restarting a node agent kills every subshell on a
   * machine whose definition does not spare panes. What was missing was the
   * SENTENCE — `rename(2)` leaves the running process on its original inode,
   * so the file is new and the daemon is old, and nothing said so.
   */
  it("says the daemon is still on the previous version, and offers the restart", async () => {
    const done = makeProbe({ agentChoice: "up-to-date", bundledVersion: "1.10.0" });
    const fake = await boot({
      probe: makeProbe({
        ...BEHIND,
        pendingInstall: { fromAppVersion: "0.6.0", attempts: 0, halted: false },
      }),
      handlers: {
        node_check_app_update: () => APP_CURRENT,
        node_install_cli: () => {
          // The install cleared the marker and moved the machine on, which is
          // exactly what the next probe reports.
          fake.setProbe(done);
          return { ok: true, stdout: "Installed subshell 1.10.0", stderr: "" };
        },
        node_service: () => ({ ok: true, stdout: "restarted", stderr: "" }),
      },
    });

    await waitFor(() => expect(screen.getByText(/still running the previous version/)).toBeTruthy());
    expect(screen.getByText(/The node CLI was replaced/)).toBeTruthy();

    fireEvent.click(button("Restart the node"));
    await waitFor(() => expect(fake.callsTo("node_service").length).toBe(1));
    // Through the existing command, which is what surfaces the CLI's own
    // refusal and offers `--force` behind it. Never a forced restart here.
    expect(fake.callsTo("node_service")[0]).toEqual({ verb: "restart", force: false });

    // And the offer goes once it has been taken — replaced by the sentence
    // that says the act is over. Until 2026-09-18 nothing took its place and
    // the body rendered EMPTY: the rows are gone (nothing is behind), and
    // `upToDate` is false because this window installed something.
    await waitFor(() => expect(buttonOrNull("Restart the node")).toBeNull());
    expect(screen.getByText(/both up to date/)).toBeTruthy();
  });

  /**
   * The pane-safety sentence belongs to the RESTART, not to the install: the
   * swap is a rename a running daemon never notices, so nothing about
   * installing a node CLI can close a subshell.
   */
  it("warns about live panes on the restart, where the cost actually is", async () => {
    const risky = {
      installed: true,
      definitionPath: "/home/u/.config/systemd/user/subshell.service",
      state: "running" as const,
      pid: 42,
      enabled: true,
      paneSafety: "kills" as const,
      detail: "",
    };
    const fake = await boot({
      probe: makeProbe({
        ...BEHIND,
        service: risky,
        pendingInstall: { fromAppVersion: "0.6.0", attempts: 0, halted: false },
      }),
      handlers: {
        node_check_app_update: () => APP_CURRENT,
        node_install_cli: () => {
          fake.setProbe(makeProbe({ agentChoice: "up-to-date", bundledVersion: "1.10.0", service: risky }));
          return { ok: true, stdout: "Installed subshell 1.10.0", stderr: "" };
        },
      },
    });

    await waitFor(() => expect(screen.getByText(/closes every subshell running on this machine/)).toBeTruthy());
  });

  /**
   * A refused restart is a conversation, not an ending: the CLI's own words
   * come back with `--force` behind them, and the offer has to survive that or
   * the person is left with a daemon on the old binary and no way to say yes.
   */
  it("keeps the offer standing when the CLI refuses", async () => {
    const done = makeProbe({ agentChoice: "up-to-date", bundledVersion: "1.10.0" });
    const fake = await boot({
      probe: makeProbe({
        ...BEHIND,
        pendingInstall: { fromAppVersion: "0.6.0", attempts: 0, halted: false },
      }),
      handlers: {
        node_check_app_update: () => APP_CURRENT,
        node_install_cli: () => {
          fake.setProbe(done);
          return { ok: true, stdout: "Installed subshell 1.10.0", stderr: "" };
        },
        node_service: () => ({
          ok: false,
          stdout: "",
          stderr: "refusing to restart: 2 live panes would be killed",
        }),
      },
    });

    await waitFor(() => expect(buttonOrNull("Restart the node")).not.toBeNull());
    fireEvent.click(button("Restart the node"));

    // The refusal, verbatim, with the override behind it — the existing
    // command's work, not this screen's.
    await waitFor(() => expect(screen.queryByRole("region")).not.toBeNull());
    expect(within(screen.getByRole("region")).getByText(/refusing to restart/)).toBeTruthy();
    // And the offer is still there to take once that conversation is over.
    expect(buttonOrNull("Restart the node")).not.toBeNull();
  });
});

/**
 * The table, and the two things only a rendered page can answer about it: that
 * a row with nothing to do carries its REASON where its checkbox would be, and
 * that unticking a row changes what the press says it will do.
 *
 * Reported against Subshell Server on 2026-09-18 and structural to both apps:
 * an agent installed by hand outranks the one inside the bundle, and the
 * screen named that newer version as a target it would be replaced by.
 */
describe("the act is a selection (§ 13)", () => {
  const APP_BEHIND = { current: "0.6.1", latest: "0.7.0", notes: null, reason: null };
  /** An agent somebody installed by hand, newer than the one in this bundle. */
  const AGENT_NEWER = makeProbe({
    agentChoice: "adopt-installed",
    bundledVersion: "1.9.0",
    agent: { argv: ["/home/u/.local/bin/subshell"], source: "local-bin", version: "1.11.0" },
  });

  async function openUpdate(init: Parameters<typeof installFakeIpc>[0]) {
    const fake = await boot(init);
    fireEvent.click(button(/Update the node to|Check for updates/));
    await waitFor(() => expect(screen.getByText("Update Subshell Client")).toBeTruthy());
    return fake;
  }

  it("states a newer installed agent rather than naming it as a target", async () => {
    await openUpdate({ probe: AGENT_NEWER, handlers: { node_check_app_update: () => APP_BEHIND } });

    expect(screen.getByText("you run a newer one")).toBeTruthy();
    // Never a disabled checkbox: the reason IS the content of that cell.
    expect(screen.queryByRole("checkbox", { name: "Update Subshell Node CLI" })).toBeNull();
    // The press used to carry a paragraph promising or disclaiming the agent
    // half; it was removed on 2026-09-18, so the cell above is now the only
    // place that says so — which is why this still asserts nothing renders it.
    expect(screen.queryByText(/It finishes by installing the node agent it ships/)).toBeNull();
    expect(button(/Download and Install 0\.7\.0/).disabled).toBe(false);
  });

  it("hands the agent half its own checkbox once the app half is unticked", async () => {
    await openUpdate({ probe: BEHIND, handlers: { node_check_app_update: () => APP_BEHIND } });

    // Both behind: both are part of the act, and both are choices. The agent
    // row rides along across the relaunch — its cell says so — but it is a
    // checkbox, because clearing it writes no marker and phase 2 then never
    // runs (review, 2026-09-18).
    expect(screen.getByText("ships with the new app")).toBeTruthy();
    expect((screen.getByRole("checkbox", { name: "Update Subshell Client App" }) as HTMLInputElement).checked).toBe(
      true,
    );
    expect((screen.getByRole("checkbox", { name: "Update Subshell Node CLI" }) as HTMLInputElement).checked).toBe(true);

    fireEvent.click(screen.getByRole("checkbox", { name: "Update Subshell Client App" }));
    await waitFor(() => expect(screen.queryByRole("checkbox", { name: "Update Subshell Node CLI" })).not.toBeNull());
    expect(button(/Install the node \(1\.10\.0\)/)).toBeTruthy();

    fireEvent.click(screen.getByRole("checkbox", { name: "Update Subshell Node CLI" }));
    await waitFor(() => expect(button("Nothing selected").disabled).toBe(true));
  });

  /**
   * § 13.3: Force overrides the pane-safety refusal on a service RESTART, and
   * phase 2 here restarts nothing — it offers the restart, whose override
   * rides on the CLI's own refusal. A control governing nothing would be the
   * same false promise this amendment removes.
   */
  it("renders no Force control anywhere", async () => {
    await openUpdate({ probe: BEHIND, handlers: { node_check_app_update: () => APP_BEHIND } });
    expect(screen.queryByText(/force/i)).toBeNull();
  });
});
