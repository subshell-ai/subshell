/**
 * The one update act, on screen (spec 2026-09-18 §§ 4.2, 7.1, 7.4).
 *
 * `update-act.test.ts` pins the decisions; these are the three things only a
 * rendered page can answer — that the status screen's button is a door rather
 * than an install, that a marker left by a previous BUILD finishes the act by
 * itself, and that when it does, the screen says the daemon is still on the
 * old agent and offers the restart the CLI will not do unasked.
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

    fireEvent.click(button("Update the agent to 1.10.0"));

    await waitFor(() => expect(screen.getByText("Update Subshell Client")).toBeTruthy());
    // Nothing was installed by walking through the door — the act asks first.
    expect(fake.callsTo("node_install_agent").length).toBe(0);
    // Both halves are named, and the half that is behind carries its numbers.
    expect(screen.getByText("Node agent")).toBeTruthy();
    expect(screen.getByText(/1\.9\.0 →/)).toBeTruthy();
  });

  it("leaves by its own Back, because an override is a screen and not a verdict", async () => {
    await boot({ probe: BEHIND, handlers: { node_check_app_update: () => APP_CURRENT } });
    fireEvent.click(button("Update the agent to 1.10.0"));
    await waitFor(() => expect(screen.getByText("Update Subshell Client")).toBeTruthy());
    fireEvent.click(button("Back"));
    await waitFor(() => expect(buttonOrNull("Update the agent to 1.10.0")).not.toBeNull());
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
        pendingUpdate: { fromAppVersion: "0.6.0", attempts: 0, exhausted: false },
      }),
      handlers: {
        node_check_app_update: () => APP_CURRENT,
        node_install_agent: () => ({ ok: true, stdout: "Installed subshell 1.10.0", stderr: "" }),
      },
    });

    await waitFor(() => expect(fake.callsTo("node_install_agent").length).toBe(1));
    // And it raised the screen to say so, rather than doing it behind the
    // landing the person was looking at.
    expect(screen.getByText("Update Subshell Client")).toBeTruthy();
    // No confirmation: phase 1's press was the consent for both halves.
    expect(screen.queryByRole("region")).toBeNull();
  });

  /**
   * Bounded at the marker's attempt limit, which Rust reports as `exhausted`.
   * An install that fails on every boot would otherwise take this window to a
   * failure screen on every launch, forever.
   */
  it("stops firing and offers Retry once it has failed too often", async () => {
    const fake = await boot({
      probe: makeProbe({
        ...BEHIND,
        pendingUpdate: { fromAppVersion: "0.6.0", attempts: 2, exhausted: true },
      }),
      handlers: {
        node_check_app_update: () => APP_CURRENT,
        node_install_agent: () => ({ ok: true, stdout: "Installed subshell 1.10.0", stderr: "" }),
      },
    });

    await waitFor(() => expect(buttonOrNull("Retry")).not.toBeNull());
    expect(fake.callsTo("node_install_agent").length).toBe(0);

    fireEvent.click(button("Retry"));
    await waitFor(() => expect(fake.callsTo("node_install_agent").length).toBe(1));
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
        pendingUpdate: { fromAppVersion: "0.6.0", attempts: 0, exhausted: false },
      }),
      handlers: {
        node_check_app_update: () => APP_CURRENT,
        node_install_agent: () => {
          // The install cleared the marker and moved the machine on, which is
          // exactly what the next probe reports.
          fake.setProbe(done);
          return { ok: true, stdout: "Installed subshell 1.10.0", stderr: "" };
        },
        node_service: () => ({ ok: true, stdout: "restarted", stderr: "" }),
      },
    });

    await waitFor(() => expect(screen.getByText(/still running the previous version/)).toBeTruthy());
    expect(screen.getByText(/The agent was replaced/)).toBeTruthy();

    fireEvent.click(button("Restart the agent"));
    await waitFor(() => expect(fake.callsTo("node_service").length).toBe(1));
    // Through the existing command, which is what surfaces the CLI's own
    // refusal and offers `--force` behind it. Never a forced restart here.
    expect(fake.callsTo("node_service")[0]).toEqual({ verb: "restart", force: false });

    // And the offer goes once it has been taken.
    await waitFor(() => expect(buttonOrNull("Restart the agent")).toBeNull());
  });

  /**
   * The pane-safety sentence belongs to the RESTART, not to the install: the
   * swap is a rename a running daemon never notices, so nothing about
   * installing an agent can close a subshell.
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
        pendingUpdate: { fromAppVersion: "0.6.0", attempts: 0, exhausted: false },
      }),
      handlers: {
        node_check_app_update: () => APP_CURRENT,
        node_install_agent: () => {
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
        pendingUpdate: { fromAppVersion: "0.6.0", attempts: 0, exhausted: false },
      }),
      handlers: {
        node_check_app_update: () => APP_CURRENT,
        node_install_agent: () => {
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

    await waitFor(() => expect(buttonOrNull("Restart the agent")).not.toBeNull());
    fireEvent.click(button("Restart the agent"));

    // The refusal, verbatim, with the override behind it — the existing
    // command's work, not this screen's.
    await waitFor(() => expect(screen.queryByRole("region")).not.toBeNull());
    expect(within(screen.getByRole("region")).getByText(/refusing to restart/)).toBeTruthy();
    // And the offer is still there to take once that conversation is over.
    expect(buttonOrNull("Restart the agent")).not.toBeNull();
  });
});
