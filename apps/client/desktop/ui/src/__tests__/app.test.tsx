/**
 * The behaviour that must survive the rewrite.
 *
 * Every case here corresponds to a rule the vanilla page carried, and several
 * of those rules exist because they were bugs first — most notably case 1, the
 * re-probe that used to clobber an action's own failure message.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { App } from "@/app";
import { TRAY_NOT_DETECTED } from "@/components/prefs-card";
import { SETTLE_ATTEMPTS, SETTLE_DELAY_MS } from "@/hooks/use-action-runner";
import { PROBE_POLL_MS } from "@/hooks/use-node-state";
import { deferred, type FakeIpc, installFakeIpc, makeProbe, makeSettings, renderApp } from "./harness";

const GOOD_KEY = "nsk_0123456789012345678901234567890a";

const JOURNALCTL = "the agent logs to the systemd journal on Linux — run `journalctl --user -u subshell.service -f`";

let ipc: FakeIpc | undefined;

afterEach(() => {
  cleanup();
  ipc?.restore();
  ipc = undefined;
});

/** Render App against a fake IPC and wait for the first probe to land. */
async function boot(init: Parameters<typeof installFakeIpc>[0] = {}) {
  ipc = installFakeIpc(init);
  renderApp(<App />);
  await waitFor(() => expect(ipc?.callsTo("node_probe").length).toBeGreaterThan(0));
  return ipc;
}

const button = (name: string) => screen.getByRole("button", { name }) as HTMLButtonElement;
const buttonOrNull = (name: string) => screen.queryByRole("button", { name }) as HTMLButtonElement | null;

/**
 * The confirmation panel, which is a labelled region.
 *
 * Its accept button deliberately carries the same words as the button that
 * raised it — "Enroll this machine" asks, then "Enroll this machine" does it —
 * so a query has to be scoped to tell the two apart.
 */
const confirmPanel = () => within(screen.getByRole("region"));
const confirmPanelOrNull = () => screen.queryByRole("region");

const typeInto = (label: string, value: string) => {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
};

// ---------------------------------------------------------------------------
// 1. A failure message always reaches the screen
// ---------------------------------------------------------------------------

describe("a failure message always reaches the screen", () => {
  // THE regression. `node_probe` cannot reject; every other command can, and
  // its rejection is a plain string. The old code re-probed after an action and
  // overwrote the message the action had set — so `node_open_path`'s rejection,
  // which on Linux IS the journalctl command to run and is the only place a
  // user learns it, rendered as nothing at all.
  it("survives the re-probe that follows the action", async () => {
    const fake = await boot({
      handlers: {
        node_open_path: () => {
          throw JOURNALCTL;
        },
      },
    });
    const probesBefore = fake.callsTo("node_probe").length;

    fireEvent.click(button("Open the agent log"));

    // Scoped to the FAILURE LINE (a <p>), not the page: the same sentence is
    // also the `logs` fact's value now, and a duplicate would make a bare
    // getByText ambiguous — and ambiguity is how this regression could hide.
    const problemShown = () => screen.getAllByText(JOURNALCTL).some((el) => el.tagName === "P");
    await waitFor(() => expect(problemShown()).toBe(true));
    // The re-probe definitely happened, and the message is still on screen.
    expect(fake.callsTo("node_probe").length).toBeGreaterThan(probesBefore);
    expect(problemShown()).toBe(true);
  });

  it("shows a probe's own error when no action has anything to say", async () => {
    await boot({ probe: makeProbe({ error: "`status --json` failed: exit 2" }) });
    await waitFor(() => expect(screen.getByText("`status --json` failed: exit 2")).toBeTruthy());
  });

  // The action's own refusal answers what was clicked; a probe error is
  // background weather.
  it("prefers the action's failure over a probe error", async () => {
    const fake = await boot({
      probe: makeProbe({ error: "background weather" }),
      handlers: {
        node_open_path: () => {
          throw "that path does not exist yet";
        },
      },
    });
    fireEvent.click(button("Open the agent log"));
    await waitFor(() => expect(screen.getByText("that path does not exist yet")).toBeTruthy());
    expect(screen.queryByText("background weather")).toBeNull();
    expect(fake.callsTo("node_probe").length).toBeGreaterThan(1);
  });

  it("says something when an action reports ok:false with output", async () => {
    await boot({
      handlers: {
        node_service: () => ({ ok: false, stdout: "", stderr: "Failed to stop subshell.service" }),
      },
    });
    fireEvent.click(button("Stop"));
    await waitFor(() => expect(screen.getByText(/That did not work/)).toBeTruthy());
  });
});

// ---------------------------------------------------------------------------
// 2. CLI output is verbatim
// ---------------------------------------------------------------------------

describe("the CLI's own words", () => {
  it("renders stdout and stderr verbatim, in a monospace block", async () => {
    const stdout = "subshell stopped.";
    const stderr = "warning: this unit does not spare live panes — mint a new key if enroll fails";
    await boot({ handlers: { node_service: () => ({ ok: true, stdout, stderr }) } });

    fireEvent.click(button("Stop"));

    await waitFor(() => expect(screen.getByText(/subshell stopped\./)).toBeTruthy());
    const block = screen.getByText(/subshell stopped\./);
    expect(block.tagName).toBe("PRE");
    expect(block.className).toContain("font-mono");
    // Verbatim, not re-worded and not normalized: the exact bytes the CLI
    // printed, in the order it printed them.
    expect(block.textContent).toBe(`${stdout}\n\n${stderr}`);
  });
});

// ---------------------------------------------------------------------------
// 3 + 4. Actions serialize, and every action re-probes
// ---------------------------------------------------------------------------

describe("actions serialize", () => {
  it("ignores a second submission while one is in flight, and disables the UI", async () => {
    const gate = deferred<{ ok: boolean; stdout: string; stderr: string }>();
    const fake = await boot({ handlers: { node_service: () => gate.promise } });

    fireEvent.click(button("Stop"));
    await waitFor(() => expect(button("Stop").disabled).toBe(true));

    // Both the guard and the disabled attribute; a click dispatched anyway
    // (a stale reference, a synthetic event) must still not reach the CLI.
    fireEvent.click(button("Stop"));
    fireEvent.click(button("Restart"));
    expect(fake.callsTo("node_service").length).toBe(1);
    expect(button("Refresh").disabled).toBe(true);

    gate.resolve({ ok: true, stdout: "subshell stopped.", stderr: "" });
    await waitFor(() => expect(button("Stop").disabled).toBe(false));
  });

  it("keeps the UI disabled until the re-probe has landed", async () => {
    const gate = deferred<{ ok: boolean; stdout: string; stderr: string }>();
    const fake = await boot({ handlers: { node_service: () => gate.promise } });
    const probesBefore = fake.callsTo("node_probe").length;

    fireEvent.click(button("Stop"));
    gate.resolve({ ok: true, stdout: "subshell stopped.", stderr: "" });

    // A button that came back alive before the re-probe would be a button
    // acting on a machine that has moved on.
    await waitFor(() => expect(button("Stop").disabled).toBe(false));
    expect(fake.callsTo("node_probe").length).toBeGreaterThan(probesBefore);
  });
});

describe("after every action, re-probe", () => {
  it("re-reads the machine after a success, a failure and a rejection", async () => {
    const fake = await boot({
      handlers: {
        node_service: () => ({ ok: false, stdout: "", stderr: "nope" }),
        node_open_path: () => {
          throw "no such file";
        },
      },
    });

    let seen = fake.callsTo("node_probe").length;
    for (const label of ["Stop", "Open the agent log", "Reveal configuration"]) {
      fireEvent.click(button(label));
      await waitFor(() => expect(fake.callsTo("node_probe").length).toBeGreaterThan(seen));
      seen = fake.callsTo("node_probe").length;
    }
  });

  // A checkbox is not worth two CLI spawns, and it changes nothing the probe
  // reports. It still serializes and still surfaces a rejection.
  it("except the tray switch, which re-reads only the settings", async () => {
    const fake = await boot({ settings: makeSettings({ traySupported: true }) });
    const probesBefore = fake.callsTo("node_probe").length;
    const settingsBefore = fake.callsTo("node_settings").length;

    fireEvent.click(screen.getByRole("switch"));

    await waitFor(() => expect(fake.callsTo("node_set_close_to_tray").length).toBe(1));
    await waitFor(() => expect(fake.callsTo("node_settings").length).toBeGreaterThan(settingsBefore));
    expect(fake.callsTo("node_probe").length).toBe(probesBefore);
    expect(fake.callsTo("node_set_close_to_tray")[0]).toEqual({ enabled: true });
  });
});

// ---------------------------------------------------------------------------
// 5 + 6. Enrolment
// ---------------------------------------------------------------------------

describe("enrolment is two-phase", () => {
  const notEnrolled = makeProbe({
    step: "not-enrolled",
    status: {
      nodeId: null,
      serverUrl: null,
      online: false,
      reason: "no config at /home/u/.config/subshell/config.json",
    },
    service: { installed: false, definitionPath: null, state: "not-installed", paneSafety: null },
  });

  it("asks first, spawns nothing, and only re-sends on an explicit accept", async () => {
    const fake = await boot({
      probe: notEnrolled,
      handlers: {
        node_enroll: (args) =>
          args.confirm === true
            ? {
                ok: true,
                stdout: "enrolled",
                stderr: "",
                node: { nodeId: "abc", name: "workstation" },
                requiresConfirmation: false,
                confirmations: [],
              }
            : {
                ok: false,
                stdout: "",
                stderr: "",
                node: null,
                requiresConfirmation: true,
                confirmations: [
                  { kind: "loopback-server", message: "http://localhost:3080 is a loopback address, so this node…" },
                ],
              },
      },
    });

    typeInto("Server URL", "http://localhost:3080");
    typeInto("Setup key", GOOD_KEY);
    fireEvent.click(button("Enroll this machine"));

    // Phase one: every message rendered, and exactly ONE call so far — nothing
    // was spawned and no setup key was spent.
    await waitFor(() => expect(screen.getByText(/is a loopback address/)).toBeTruthy());
    expect(fake.callsTo("node_enroll").length).toBe(1);
    expect(fake.callsTo("node_enroll")[0]?.confirm).toBe(false);

    // Phase two: the IDENTICAL arguments plus confirm: true, from the
    // confirmation's own accept button.
    fireEvent.click(confirmPanel().getByRole("button", { name: "Enroll this machine" }));
    await waitFor(() => expect(fake.callsTo("node_enroll").length).toBe(2));
    const [first, second] = fake.callsTo("node_enroll");
    expect(second).toEqual({ ...first, confirm: true });
    // And never a third: an accepted key cannot be redeemed twice.
    expect(fake.callsTo("node_enroll").length).toBe(2);
  });

  it("never auto-retries a failed enrolment", async () => {
    const fake = await boot({
      probe: notEnrolled,
      handlers: {
        node_enroll: () => ({
          ok: false,
          stdout: "",
          stderr: "subshell: that node name is already taken on this server — mint a new key and try again",
          node: null,
          requiresConfirmation: false,
          confirmations: [],
        }),
      },
    });

    typeInto("Server URL", "https://subshell.example.com");
    typeInto("Setup key", GOOD_KEY);
    fireEvent.click(button("Enroll this machine"));

    // The CLI's own sentence, verbatim, and exactly one attempt.
    await waitFor(() => expect(screen.getByText(/mint a new key and try again/)).toBeTruthy());
    expect(fake.callsTo("node_enroll").length).toBe(1);
  });

  it("clears the spent key from the form after a success", async () => {
    await boot({
      probe: notEnrolled,
      handlers: {
        node_enroll: () => ({
          ok: true,
          stdout: "enrolled",
          stderr: "",
          node: { nodeId: "abc", name: "workstation" },
          requiresConfirmation: false,
          confirmations: [],
        }),
      },
    });

    typeInto("Server URL", "https://subshell.example.com");
    typeInto("Setup key", GOOD_KEY);
    fireEvent.click(button("Enroll this machine"));

    await waitFor(() => expect((screen.getByLabelText("Setup key") as HTMLInputElement).value).toBe(""));
    // The server URL survives: the common re-enroll is the same server.
    expect((screen.getByLabelText("Server URL") as HTMLInputElement).value).toBe("https://subshell.example.com");
  });

  it("refuses an invalid form before any spawn", async () => {
    const fake = await boot({ probe: notEnrolled });

    typeInto("Server URL", "subshell.example.com");
    typeInto("Setup key", "nsk_short");
    fireEvent.click(button("Enroll this machine"));

    await waitFor(() => expect(screen.getByText(/include the scheme/)).toBeTruthy());
    expect(screen.getByText(/partial paste/)).toBeTruthy();
    expect(fake.callsTo("node_enroll").length).toBe(0);
  });

  it("explains what a setup key is, and what a taken name costs", async () => {
    await boot({ probe: notEnrolled });
    expect(screen.getByText(/Mint a setup key in the browser first/)).toBeTruthy();
    expect(screen.getByText(/single-use and expires after 24 hours/)).toBeTruthy();
    expect(screen.getByText(/already taken on that server/)).toBeTruthy();
    expect(screen.getByText(/Leave the name blank/)).toBeTruthy();
  });

  // A warning, never a block.
  it("warns about a loopback URL without disabling anything", async () => {
    const fake = await boot({
      probe: notEnrolled,
      handlers: {
        node_enroll: () => ({
          ok: true,
          stdout: "",
          stderr: "",
          node: null,
          requiresConfirmation: false,
          confirmations: [],
        }),
      },
    });

    typeInto("Server URL", "http://127.0.0.1:3080");
    typeInto("Setup key", GOOD_KEY);

    await waitFor(() => expect(screen.getByText(/This is a loopback address/)).toBeTruthy());
    expect(button("Enroll this machine").disabled).toBe(false);
    fireEvent.click(button("Enroll this machine"));
    await waitFor(() => expect(fake.callsTo("node_enroll").length).toBe(1));
  });

  it("seeds the re-enroll form from the server this machine already answers to", async () => {
    await boot();
    fireEvent.click(button("Re-enroll this machine…"));
    await waitFor(() =>
      expect((screen.getByLabelText("Server URL") as HTMLInputElement).value).toBe("https://subshell.example.com"),
    );
    expect(screen.getByText(/registers a SECOND node on the control plane/)).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// 7. A restart refused for pane safety
// ---------------------------------------------------------------------------

describe("a restart refused for pane safety", () => {
  const REFUSAL =
    "subshell: refusing to restart — the installed unit does not set KillMode=process, so this would SIGKILL " +
    "every subshell on this machine. Rewrite the service definition with `subshell service install`, or pass " +
    "--force.";

  const risky = makeProbe({
    service: {
      installed: true,
      definitionPath: "/home/u/.config/systemd/user/subshell.service",
      state: "running",
      pid: 42,
      enabled: true,
      paneSafety: "kills",
      detail: "",
    },
  });

  it("shows the refusal verbatim and offers --force as a separate, labelled action", async () => {
    const fake = await boot({
      probe: risky,
      handlers: {
        node_service: (args) =>
          args.force === true
            ? { ok: true, stdout: "subshell restarted.", stderr: "" }
            : { ok: false, stdout: "", stderr: REFUSAL },
      },
    });

    fireEvent.click(button("Restart"));

    // Twice on screen, deliberately: quoted into the confirmation that offers
    // the override, and in the output block as the CLI printed it.
    await waitFor(() => expect(screen.getAllByText(REFUSAL).length).toBe(2));
    // One attempt, unforced, and nothing retried on its own.
    expect(fake.callsTo("node_service")).toEqual([{ verb: "restart", force: false }]);

    // The override is a named button, never a silent retry.
    const force = button("Restart anyway (--force)");
    expect(force).toBeTruthy();
    fireEvent.click(force);
    await waitFor(() => expect(fake.callsTo("node_service").length).toBe(2));
    expect(fake.callsTo("node_service")[1]).toEqual({ verb: "restart", force: true });
  });

  it("does not offer --force for a refusal --force cannot answer", async () => {
    const fake = await boot({
      probe: risky,
      handlers: {
        node_service: () => ({ ok: false, stdout: "", stderr: "Failed to restart: Unit subshell.service is masked." }),
      },
    });

    fireEvent.click(button("Restart"));

    await waitFor(() => expect(screen.getByText(/Unit subshell.service is masked/)).toBeTruthy());
    expect(buttonOrNull("Restart anyway (--force)")).toBeNull();
    expect(fake.callsTo("node_service").length).toBe(1);
  });

  it("cancelling the override leaves the refusal on screen", async () => {
    const fake = await boot({
      probe: risky,
      handlers: { node_service: () => ({ ok: false, stdout: "", stderr: REFUSAL }) },
    });

    fireEvent.click(button("Restart"));
    await waitFor(() => expect(buttonOrNull("Restart anyway (--force)")).not.toBeNull());
    fireEvent.click(button("Cancel"));

    await waitFor(() => expect(buttonOrNull("Restart anyway (--force)")).toBeNull());
    // The verbatim refusal is the most useful thing on the screen; dismissing
    // the confirmation must not take it away.
    expect(confirmPanelOrNull()).toBeNull();
    expect(screen.getByText(REFUSAL)).toBeTruthy();
    expect(fake.callsTo("node_service").length).toBe(1);
  });

  it("says the rewrite kills nothing only where that is true", async () => {
    // Linux: systemd re-reads a rewritten unit under the running daemon.
    await boot({
      probe: risky,
      handlers: { node_service: () => ({ ok: false, stdout: "", stderr: REFUSAL }) },
    });
    fireEvent.click(button("Restart"));
    await waitFor(() => expect(screen.getByText(/it fixes this for good and kills nothing/)).toBeTruthy());
    cleanup();
    ipc?.restore();

    // macOS: launchd has no reload, so the remedy costs the very sessions it
    // is protecting — once.
    await boot({
      probe: makeProbe({ service: risky.service, rewriteTearsDown: true }),
      handlers: { node_service: () => ({ ok: false, stdout: "", stderr: REFUSAL }) },
    });
    fireEvent.click(button("Restart"));
    await waitFor(() => expect(screen.getByText(/launchd has no reload/)).toBeTruthy());
    expect(screen.queryByText(/kills nothing/)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 8. The rewrite action
// ---------------------------------------------------------------------------

describe("rewriting the service definition", () => {
  const riskyService = {
    installed: true,
    definitionPath: "/Users/u/Library/LaunchAgents/dev.subshell.client.plist",
    state: "running" as const,
    pid: 42,
    enabled: true,
    paneSafety: "kills" as const,
    detail: "",
  };

  it("is offered only when the installed definition would kill panes", async () => {
    await boot();
    expect(buttonOrNull("Rewrite the service definition")).toBeNull();
    cleanup();
    ipc?.restore();

    await boot({ probe: makeProbe({ service: riskyService }) });
    expect(buttonOrNull("Rewrite the service definition")).not.toBeNull();
  });

  it("runs straight through where the rewrite is free", async () => {
    const fake = await boot({
      probe: makeProbe({ service: riskyService, rewriteTearsDown: false }),
      handlers: { node_service: () => ({ ok: true, stdout: "wrote the unit", stderr: "" }) },
    });
    fireEvent.click(button("Rewrite the service definition"));
    await waitFor(() => expect(fake.callsTo("node_service").length).toBe(1));
    expect(fake.callsTo("node_service")[0]).toEqual({ verb: "install", force: false });
  });

  it("asks first where the rewrite itself costs the panes it is repairing", async () => {
    const fake = await boot({
      probe: makeProbe({ service: riskyService, rewriteTearsDown: true }),
      handlers: { node_service: () => ({ ok: true, stdout: "wrote the plist", stderr: "" }) },
    });

    fireEvent.click(button("Rewrite the service definition"));

    await waitFor(() => expect(screen.getByText(/Rewriting the definition restarts the agent/)).toBeTruthy());
    expect(fake.callsTo("node_service").length).toBe(0);
    expect(screen.getByText(/It is the last time that happens/)).toBeTruthy();

    fireEvent.click(button("Rewrite the definition"));
    await waitFor(() => expect(fake.callsTo("node_service").length).toBe(1));
  });
});

describe("teardown confirmations", () => {
  it("names the pane cost when uninstalling a definition that does not spare them", async () => {
    const fake = await boot({
      probe: makeProbe({
        service: {
          installed: true,
          definitionPath: "/home/u/.config/systemd/user/subshell.service",
          state: "running",
          pid: 42,
          enabled: true,
          paneSafety: "kills",
          detail: "",
        },
      }),
      handlers: { node_service: () => ({ ok: true, stdout: "removed", stderr: "" }) },
    });

    fireEvent.click(button("Uninstall the service"));

    await waitFor(() => expect(confirmPanelOrNull()).not.toBeNull());
    expect(confirmPanel().getByText(/Uninstall the background service/)).toBeTruthy();
    expect(confirmPanel().getByText(/kills every subshell running on this machine/)).toBeTruthy();
    expect(fake.callsTo("node_service").length).toBe(0);

    fireEvent.click(confirmPanel().getByRole("button", { name: "Uninstall the service" }));
    await waitFor(() => expect(fake.callsTo("node_service").length).toBe(1));
    expect(fake.callsTo("node_service")[0]).toEqual({ verb: "uninstall", force: false });
  });

  it("confirms replacing the installed agent, and never applies it unasked", async () => {
    const fake = await boot({
      probe: makeProbe({ agentChoice: "upgrade-available", bundledVersion: "1.10.0" }),
      handlers: { node_install_agent: () => ({ ok: true, stdout: "Installed subshell", stderr: "" }) },
    });

    fireEvent.click(button("Update the agent to 1.10.0"));

    await waitFor(() => expect(confirmPanelOrNull()).not.toBeNull());
    expect(fake.callsTo("node_install_agent").length).toBe(0);
    expect(confirmPanel().getByText(/Nothing is downloaded/)).toBeTruthy();
    expect(confirmPanel().getByText(/is NOT started again/)).toBeTruthy();

    fireEvent.click(button("Update the agent"));
    await waitFor(() => expect(fake.callsTo("node_install_agent").length).toBe(1));
  });

  it("does not put the upgrade offer on the re-enroll screen", async () => {
    await boot({ probe: makeProbe({ agentChoice: "upgrade-available", bundledVersion: "1.10.0" }) });
    expect(buttonOrNull("Update the agent to 1.10.0")).not.toBeNull();
    fireEvent.click(button("Re-enroll this machine…"));
    // That row already ends in a destructive button; an unrelated one first is
    // how the wrong one gets clicked.
    await waitFor(() => expect(buttonOrNull("Update the agent to 1.10.0")).toBeNull());
  });
});

// ---------------------------------------------------------------------------
// 9. The tray switch
// ---------------------------------------------------------------------------

describe("the close-to-tray switch", () => {
  // No tray on this platform at all: nothing to offer and nothing to explain.
  it("is absent where the platform has no tray", async () => {
    await boot({ settings: makeSettings({ traySupported: false, trayStatus: "unsupported" }) });
    expect(screen.queryByRole("switch")).toBeNull();
  });

  it("renders, and reflects what the app will ACT on", async () => {
    await boot({ settings: makeSettings({ traySupported: true, closeToTray: true }) });
    const toggle = screen.getByRole("switch");
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    // Live: nothing to explain, so no reason and no re-check.
    expect(screen.queryByText(TRAY_NOT_DETECTED)).toBeNull();
    expect(buttonOrNull("Check again")).toBeNull();
  });

  // The case the platform check used to swallow: a Linux desktop where no
  // StatusNotifier host answered. Hiding the control would leave a GNOME user
  // with no way to learn that an AppIndicator extension is all this needs.
  it("is offered DISABLED, with the reason, where no host was detected", async () => {
    const fake = await boot({ settings: makeSettings({ traySupported: false, trayStatus: "not-detected" }) });
    const toggle = screen.getByRole("switch");
    expect(toggle.getAttribute("data-disabled")).not.toBeNull();
    expect(screen.getByText(TRAY_NOT_DETECTED)).not.toBeNull();

    // And it cannot be turned on from there. One tick, so a command that was
    // going to fire has fired.
    fireEvent.click(toggle);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fake.callsTo("node_set_close_to_tray").length).toBe(0);
  });

  // The reason has to stay true for a user looking at their own tray icon:
  // the probe is a false negative on the older XEmbed tray.
  it("never claims the tray does not exist, only that none was detected", async () => {
    await boot({ settings: makeSettings({ traySupported: false, trayStatus: "not-detected" }) });
    expect(screen.getByText(TRAY_NOT_DETECTED).textContent).toContain("detected");
    expect(screen.getByText(TRAY_NOT_DETECTED).textContent).toContain("AppIndicator");
  });

  // Installing the extension flips the answer with the app already running,
  // and the Rust side holds no cached answer — so a re-read is the re-check.
  it("re-reads the machine when asked to check again", async () => {
    const fake = await boot({ settings: makeSettings({ traySupported: false, trayStatus: "not-detected" }) });
    const before = fake.callsTo("node_settings").length;
    fireEvent.click(button("Check again"));
    await waitFor(() => expect(fake.callsTo("node_settings").length).toBeGreaterThan(before));
    // Only the settings: the tray says nothing about the machine's state, and
    // a re-check is not worth two CLI spawns.
    expect(fake.callsTo("node_probe").length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 10 + 12. The invocations that must not exist, and the pacing
// ---------------------------------------------------------------------------

describe("what the page never asks for", () => {
  it("drives no command outside the eight it declares", async () => {
    const fake = await boot({
      settings: makeSettings({ traySupported: true }),
      handlers: {
        node_service: () => ({ ok: true, stdout: "", stderr: "" }),
        node_set_close_to_tray: () => null,
      },
    });

    fireEvent.click(button("Stop"));
    await waitFor(() => expect(fake.callsTo("node_service").length).toBe(1));
    fireEvent.click(screen.getByRole("switch"));
    await waitFor(() => expect(fake.callsTo("node_set_close_to_tray").length).toBe(1));

    const allowed = new Set([
      "node_probe",
      "node_settings",
      "node_service",
      "node_install_agent",
      "node_enroll",
      "node_set_agent_bin",
      "node_open_path",
      "node_set_close_to_tray",
    ]);
    for (const call of fake.calls) expect(allowed.has(call.cmd)).toBe(true);
    // No `service run` — it never resolves and flaps against the service.
    for (const args of fake.callsTo("node_service")) expect(args.verb).not.toBe("run");
  });
});

describe("pacing", () => {
  // `node_probe` is two CLI spawns plus the ladder probes. Nothing here may
  // poll on a sub-second timer.
  it("never polls or settles faster than seconds", () => {
    expect(PROBE_POLL_MS).toBeGreaterThanOrEqual(1_000);
    expect(SETTLE_DELAY_MS).toBeGreaterThanOrEqual(1_000);
    // A settle, never a poll: bounded to a couple of extra probes.
    expect(SETTLE_ATTEMPTS).toBeLessThanOrEqual(3);
  });

  it("does not poll while an action is in flight", async () => {
    const gate = deferred<{ ok: boolean; stdout: string; stderr: string }>();
    const fake = await boot({ handlers: { node_service: () => gate.promise } });

    fireEvent.click(button("Stop"));
    await waitFor(() => expect(button("Stop").disabled).toBe(true));
    const during = fake.callsTo("node_probe").length;
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(fake.callsTo("node_probe").length).toBe(during);

    gate.resolve({ ok: true, stdout: "", stderr: "" });
    await waitFor(() => expect(button("Stop").disabled).toBe(false));
  });
});

// ---------------------------------------------------------------------------
// The steps a machine walks
// ---------------------------------------------------------------------------

describe("the step screens", () => {
  it("offers the install only when nothing answered at all", async () => {
    await boot({ probe: makeProbe({ step: "no-agent", agent: null, status: null, service: null }) });
    expect(buttonOrNull("Install the agent")).not.toBeNull();
    expect(screen.getByText("No subshell agent was found on this machine.")).toBeTruthy();
    cleanup();
    ipc?.restore();

    // An agent that answered `version` but not `status --json`: enrolling here
    // would overwrite a live config and discard its node key.
    await boot({ probe: makeProbe({ step: "no-agent", status: null }) });
    expect(buttonOrNull("Install the agent")).toBeNull();
    expect(buttonOrNull("Enroll this machine")).toBeNull();
    expect(screen.getByText(/could not report its status/)).toBeTruthy();
  });

  it("settles after a start rather than reporting Offline", async () => {
    const fake = await boot({
      probe: makeProbe({
        step: "stopped",
        status: { nodeId: "abc", serverUrl: "https://x.example", online: false },
        service: {
          installed: true,
          definitionPath: "/home/u/.config/systemd/user/subshell.service",
          state: "stopped",
          pid: null,
          enabled: true,
          paneSafety: "keeps",
          detail: "",
        },
      }),
      handlers: { node_service: () => ({ ok: true, stdout: "subshell started.", stderr: "" }) },
    });

    // The daemon takes the lock a beat after the manager returns.
    fake.setProbe(makeProbe());
    fireEvent.click(button("Start"));

    await waitFor(() => expect(screen.getByText("Online")).toBeTruthy(), {
      timeout: SETTLE_DELAY_MS * (SETTLE_ATTEMPTS + 1),
    });
    expect(fake.callsTo("node_service")).toEqual([{ verb: "start", force: false }]);
  });

  it("says it does not recognise a step this build predates", async () => {
    await boot({ probe: makeProbe({ step: "quantum-superposition" as never }) });
    expect(screen.getByText(/does not know what to do about "quantum-superposition"/)).toBeTruthy();
    expect(screen.getByText(/older than the agent it is managing/)).toBeTruthy();
    expect(buttonOrNull("Retry")).not.toBeNull();
  });

  it("does not strand the window when the probe itself cannot be read", async () => {
    ipc = installFakeIpc({
      handlers: {
        node_probe: () => {
          throw "the app is not allowed to call node_probe";
        },
      },
    });
    renderApp(<App />);
    await waitFor(() => expect(screen.getByText(/Could not read this machine's state/)).toBeTruthy());
    expect(buttonOrNull("Retry")).not.toBeNull();
  });
});

describe("the facts", () => {
  it("names the config file, the control plane and tmux", async () => {
    await boot();
    expect(screen.getByText("/home/u/.config/subshell/config.json")).toBeTruthy();
    expect(screen.getByText("https://subshell.example.com")).toBeTruthy();
    expect(screen.getByText("/usr/bin/tmux")).toBeTruthy();
    expect(screen.getByText(/online — last heartbeat 4s ago/)).toBeTruthy();
  });

  it("shouts when tmux is missing, because a node without it refuses every launch", async () => {
    await boot({ probe: makeProbe({ tmux: null }) });
    expect(screen.getByText(/NOT FOUND — enroll refuses/)).toBeTruthy();
  });

  it("shows the node name only when this session chose it", async () => {
    await boot({
      probe: makeProbe({ step: "not-enrolled", status: { nodeId: null, online: false, reason: "no config" } }),
      handlers: {
        node_enroll: () => ({
          ok: true,
          stdout: "enrolled",
          stderr: "",
          node: { nodeId: "11111111-2222-3333-4444-555555555555", name: "workstation" },
          requiresConfirmation: false,
          confirmations: [],
        }),
      },
    });
    // Before: `status --json` carries no name, so none is shown.
    expect(screen.queryByText(/"workstation"/)).toBeNull();

    typeInto("Server URL", "https://subshell.example.com");
    typeInto("Setup key", GOOD_KEY);
    ipc?.setProbe(makeProbe());
    fireEvent.click(button("Enroll this machine"));

    await waitFor(() => expect(screen.getByText(/11111111-2222-3333-4444-555555555555 "workstation"/)).toBeTruthy());
  });
});

// ---------------------------------------------------------------------------
// The tmux hard stop, and the plane's second door
// ---------------------------------------------------------------------------

describe("tmux is a hard stop, not a hint", () => {
  // Ported from the server console: the CLI refuses (or degrades far from the
  // cause), and a live button that only produces that outcome trains the user
  // to click through warnings. The buttons that DO work without tmux — Stop,
  // Uninstall, the reveals — must stay live; disabling those strands the box.
  it("disables what cannot work without tmux, and nothing else", async () => {
    await boot({ probe: makeProbe({ tmux: null, step: "stopped" }) });
    expect(button("Start").disabled).toBe(true);
    expect(button("Uninstall the service").disabled).toBe(false);
    expect(button("Open the agent log").disabled).toBe(false);
    // The hint names the install command, so the refusal is one step from action.
    expect(screen.getByText(/brew install tmux|sudo apt-get install tmux/)).toBeTruthy();
  });

  it("re-enables on the probe that finds tmux — the gate is not remembered", async () => {
    const fake = await boot({ probe: makeProbe({ tmux: null, step: "stopped" }) });
    expect(button("Start").disabled).toBe(true);
    fake.setProbe(makeProbe({ step: "stopped" }));
    fireEvent.click(button("Refresh"));
    await waitFor(() => expect(button("Start").disabled).toBe(false));
  });

  it("gates the online Restart too — a tmux-less node 409s every launch", async () => {
    await boot({ probe: makeProbe({ tmux: null }) });
    expect(button("Restart").disabled).toBe(true);
    expect(button("Stop").disabled).toBe(false);
  });

  it("the install button says it also starts, because the CLI's install does", async () => {
    await boot({ probe: makeProbe({ step: "no-service" }) });
    expect(button("Install and start the background service")).toBeTruthy();
  });
});

describe("the plane's second door", () => {
  // The in-app window stays primary; this opens the SAME settled address in
  // the system browser, and the command takes no URL argument by design.
  it("opens the settled plane URL in the system browser", async () => {
    const fake = await boot({
      settings: makeSettings({ planeUrl: "https://plane.example" }),
      handlers: { node_open_plane_url: () => null },
    });
    fireEvent.click(button("In browser"));
    await waitFor(() => expect(fake.callsTo("node_open_plane_url")).toEqual([{}]));
    // And it asked for NOTHING but the intent — no URL crossed the boundary.
    expect(fake.callsTo("node_open_plane_url")[0]).toEqual({});
  });

  it("rejection reaches the problem line, like every command", async () => {
    await boot({
      settings: makeSettings({ planeUrl: "https://plane.example" }),
      handlers: {
        node_open_plane_url: () => {
          throw "no control plane yet — enter its URL, or enrol this machine first";
        },
      },
    });
    fireEvent.click(button("In browser"));
    await waitFor(() =>
      expect(screen.getByText("no control plane yet — enter its URL, or enrol this machine first")).toBeTruthy(),
    );
  });
});
