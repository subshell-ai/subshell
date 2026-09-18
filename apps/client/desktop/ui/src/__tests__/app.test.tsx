/**
 * The behaviour that must survive the assistant rewrite.
 *
 * Every case here corresponds to a rule the page carried before it became one
 * screen at a time, and several of those rules exist because they were bugs
 * first — most notably case 1, the re-probe that used to clobber an action's
 * own failure message.
 *
 * What the assistant CHANGED, and why these cases now drive different screens:
 * a healthy node's screen offers one decision (open the control plane), so the
 * service verbs are reached from the screen the machine's own state implies.
 * Restart is the answer to "not responding", Start to "stopped". Stop and
 * Uninstall left the app entirely (spec 2026-09-12 § 6.4): restarting a node is
 * now also a control-plane action (§ 6.3), and removing the service is what
 * Reset does.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { App } from "@/app";
import { SETTLE_ATTEMPTS, SETTLE_DELAY_MS } from "@/hooks/use-action-runner";
import { PROBE_POLL_MS } from "@/hooks/use-node-state";
import { deferred, type FakeIpc, installFakeIpc, makeProbe, makeSettings, renderApp } from "./harness";

const GOOD_KEY = "nsk_0123456789012345678901234567890a";

const JOURNALCTL = "the agent logs to the systemd journal on Linux — run `journalctl --user -u subshell.service -f`";

/** A registered machine whose service is installed but not running. */
const STOPPED = makeProbe({
  step: "stopped",
  status: {
    nodeId: "11111111-2222-3333-4444-555555555555",
    serverUrl: "https://subshell.example.com",
    online: false,
    agentVersion: "1.9.0",
  },
  service: {
    installed: true,
    definitionPath: "/home/u/.config/systemd/user/subshell.service",
    state: "stopped",
    pid: null,
    enabled: true,
    paneSafety: "keeps",
    detail: "",
  },
});

/** A machine with no agent at all — nothing to stop, overwrite or downgrade. */
const FRESH = makeProbe({ step: "no-agent", agent: null, status: null, service: null });

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
 * Scoped queries still matter even though the assistant's own buttons got
 * shorter: the panel's accept button often carries the words of the action it
 * is about ("Uninstall the service", "Rewrite the definition"), and a test has
 * to be able to tell the panel's copy from the screen's.
 */
const confirmPanel = () => within(screen.getByRole("region"));
const confirmPanelOrNull = () => screen.queryByRole("region");

const typeInto = (label: string, value: string) => {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
};

// ---------------------------------------------------------------------------
// 0. The frame: one screen at a time, each asking one question
// ---------------------------------------------------------------------------

describe("the assistant frame", () => {
  it("asks for a server first, ahead of anything the probe says", async () => {
    // Without an address this app has nothing to show in its other window, and
    // "enroll this machine" is a question about a server nobody has named.
    await boot({ settings: makeSettings({ planeUrl: null }) });
    expect(screen.getByRole("heading", { name: "Connect to a Server" })).toBeTruthy();
    expect(buttonOrNull("Open")).not.toBeNull();
  });

  it("shows a working machine one decision, and the rest under More…", async () => {
    await boot();
    expect(screen.getByRole("heading", { name: "This Machine Is a Node" })).toBeTruthy();
    expect(buttonOrNull("Open Subshell Client")).not.toBeNull();
    expect(screen.getByText("More…")).toBeTruthy();
    expect(buttonOrNull("Re-enroll…")).not.toBeNull();
  });

  it("names which service failure it is looking at", async () => {
    await boot({ probe: STOPPED });
    expect(screen.getByRole("heading", { name: "The Node Service Is Stopped" })).toBeTruthy();
    expect(buttonOrNull("Start")).not.toBeNull();
    cleanup();
    ipc?.restore();

    await boot({ probe: makeProbe({ step: "offline", status: { ...STOPPED.status, online: false } }) });
    expect(screen.getByRole("heading", { name: "The Node Service Isn't Responding" })).toBeTruthy();
    expect(buttonOrNull("Restart")).not.toBeNull();
  });
});

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
      probe: STOPPED,
      handlers: {
        node_open_path: () => {
          throw JOURNALCTL;
        },
      },
    });
    const probesBefore = fake.callsTo("node_probe").length;

    fireEvent.click(button("Open the agent log"));

    // Scoped to the FAILURE LINE (a <p>), not the page: the same sentence is
    // also the `logs` fact's value, and a duplicate would make a bare
    // getByText ambiguous — and ambiguity is how this regression could hide.
    const problemShown = () => screen.getAllByText(JOURNALCTL).some((el) => el.tagName === "P");
    await waitFor(() => expect(problemShown()).toBe(true));
    expect(fake.callsTo("node_probe").length).toBeGreaterThan(probesBefore);
    expect(problemShown()).toBe(true);
  });

  it("shows a probe's own error when no action has anything to say", async () => {
    await boot({ probe: makeProbe({ error: "`status --json` failed: exit 2" }) });
    await waitFor(() => expect(screen.getByText(/`status --json` failed: exit 2/)).toBeTruthy());
  });

  // The action's own refusal answers what was clicked; a probe error is
  // background weather.
  it("prefers the action's failure over a probe error", async () => {
    const fake = await boot({
      probe: makeProbe({ ...STOPPED, error: "background weather" }),
      handlers: {
        node_open_path: () => {
          throw "that path does not exist yet";
        },
      },
    });
    fireEvent.click(button("Open the agent log"));
    await waitFor(() => expect(screen.getByText("that path does not exist yet")).toBeTruthy());
    expect(screen.queryByText(/background weather/)).toBeNull();
    expect(fake.callsTo("node_probe").length).toBeGreaterThan(1);
  });

  it("says something when an action reports ok:false with output", async () => {
    await boot({
      probe: STOPPED,
      handlers: {
        node_service: () => ({ ok: false, stdout: "", stderr: "Failed to start subshell.service" }),
      },
    });
    fireEvent.click(button("Start"));
    await waitFor(() => expect(screen.getByText(/That did not work/)).toBeTruthy());
  });
});

// ---------------------------------------------------------------------------
// 2. CLI output is verbatim
// ---------------------------------------------------------------------------

describe("the CLI's own words", () => {
  it("renders stdout and stderr verbatim, in a monospace block", async () => {
    const stdout = "Installed subshell 1.9.0.";
    const stderr = "warning: this unit does not spare live panes — mint a new key if enroll fails";
    await boot({ probe: FRESH, handlers: { node_install_agent: () => ({ ok: true, stdout, stderr }) } });

    fireEvent.click(button("Install"));

    await waitFor(() => expect(screen.getByText(/Installed subshell 1\.9\.0\./)).toBeTruthy());
    const block = screen.getByText(/Installed subshell 1\.9\.0\./);
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
    const fake = await boot({ probe: FRESH, handlers: { node_install_agent: () => gate.promise } });

    fireEvent.click(button("Install"));
    await waitFor(() => expect(button("Install").disabled).toBe(true));

    // Both the guard and the disabled attribute; a click dispatched anyway
    // (a stale reference, a synthetic event) must still not reach the CLI.
    fireEvent.click(button("Install"));
    fireEvent.click(button("Choose an existing agent…"));
    expect(fake.callsTo("node_install_agent").length).toBe(1);
    expect(button("Choose an existing agent…").disabled).toBe(true);

    gate.resolve({ ok: true, stdout: "Installed subshell.", stderr: "" });
    await waitFor(() => expect(button("Install").disabled).toBe(false));
  });

  it("keeps the UI disabled until the re-probe has landed", async () => {
    const gate = deferred<{ ok: boolean; stdout: string; stderr: string }>();
    const fake = await boot({ probe: FRESH, handlers: { node_install_agent: () => gate.promise } });
    const probesBefore = fake.callsTo("node_probe").length;

    fireEvent.click(button("Install"));
    gate.resolve({ ok: true, stdout: "Installed subshell.", stderr: "" });

    // A button that came back alive before the re-probe would be a button
    // acting on a machine that has moved on.
    await waitFor(() => expect(button("Install").disabled).toBe(false));
    expect(fake.callsTo("node_probe").length).toBeGreaterThan(probesBefore);
  });
});

describe("after every action, re-probe", () => {
  it("re-reads the machine after a success, a failure and a rejection", async () => {
    const fake = await boot({
      probe: STOPPED,
      handlers: {
        node_service: () => ({ ok: false, stdout: "", stderr: "nope" }),
        node_open_path: () => {
          throw "no such file";
        },
      },
    });

    let seen = fake.callsTo("node_probe").length;
    for (const label of ["Start", "Open the agent log", "Reveal configuration"]) {
      fireEvent.click(button(label));
      await waitFor(() => expect(fake.callsTo("node_probe").length).toBeGreaterThan(seen));
      seen = fake.callsTo("node_probe").length;
    }
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
    typeInto("Node name", "workstation");
    fireEvent.click(button("Enroll"));

    // Phase one: every message rendered, and exactly ONE call so far — nothing
    // was spawned and no setup key was spent.
    await waitFor(() => expect(screen.getByText(/is a loopback address, so this node…/)).toBeTruthy());
    expect(fake.callsTo("node_enroll").length).toBe(1);
    expect(fake.callsTo("node_enroll")[0]?.confirm).toBe(false);

    // Phase two: the IDENTICAL arguments plus confirm: true, from the
    // confirmation's own accept button.
    fireEvent.click(confirmPanel().getByRole("button", { name: "Enroll this machine" }));
    await waitFor(() => expect(fake.callsTo("node_enroll").length).toBe(2));
    const [first, second] = fake.callsTo("node_enroll");
    expect(second).toEqual({ ...first, confirm: true });
    // Named, in the payload — not defaulted by the CLI behind the form's back.
    // (The line above already pins that phase two carries the SAME name: the form
    // is not re-read between the confirm and the spawn.)
    expect(first).toMatchObject({ server: "http://localhost:3080", key: GOOD_KEY, name: "workstation" });
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
    typeInto("Node name", "workstation");
    fireEvent.click(button("Enroll"));

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
    typeInto("Node name", "workstation");
    fireEvent.click(button("Enroll"));

    await waitFor(() => expect((screen.getByLabelText("Setup key") as HTMLInputElement).value).toBe(""));
    // The server URL survives: the common re-enroll is the same server.
    expect((screen.getByLabelText("Server URL") as HTMLInputElement).value).toBe("https://subshell.example.com");
    // And so does the NAME, which the operator typed rather than pasted. It is
    // required now, and a retry costs a fresh key rather than a retyped machine
    // name — the field that failed is the one that clears.
    expect((screen.getByLabelText("Node name") as HTMLInputElement).value).toBe("workstation");
  });

  it("refuses an invalid form before any spawn", async () => {
    const fake = await boot({ probe: notEnrolled });

    typeInto("Server URL", "subshell.example.com");
    typeInto("Setup key", "nsk_short");
    fireEvent.click(button("Enroll"));

    await waitFor(() => expect(screen.getByText(/Include the scheme/)).toBeTruthy());
    expect(screen.getByText(/partial paste/)).toBeTruthy();
    // The third refusal is the field that became required: nothing is spawned
    // with a nameless `enroll`, because the CLI would refuse the argv anyway.
    expect(screen.getByText(/the Nodes page lists it by this name/)).toBeTruthy();
    expect(fake.callsTo("node_enroll").length).toBe(0);
  });

  it("explains what a setup key is, and what a taken name costs", async () => {
    await boot({ probe: notEnrolled });
    expect(screen.getByText(/Mint a setup key in the browser first/)).toBeTruthy();
    expect(screen.getByText(/single-use and expires after 24 hours/)).toBeTruthy();
    expect(screen.getByText(/already taken on that server/)).toBeTruthy();
    // The third note is the naming one, and it says WHY the field is here rather
    // than being an optional courtesy: the control plane's guess went away.
    expect(screen.getByText(/the row on the Nodes page/)).toBeTruthy();
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
    typeInto("Node name", "workstation");

    await waitFor(() => expect(screen.getByText(/This is a loopback address/)).toBeTruthy());
    expect(button("Enroll").disabled).toBe(false);
    fireEvent.click(button("Enroll"));
    await waitFor(() => expect(fake.callsTo("node_enroll").length).toBe(1));
  });

  it("seeds the re-enroll form from the server this machine already answers to", async () => {
    await boot();
    fireEvent.click(button("Re-enroll…"));
    await waitFor(() =>
      expect((screen.getByLabelText("Server URL") as HTMLInputElement).value).toBe("https://subshell.example.com"),
    );
    expect(screen.getByText(/registers a SECOND node on the control plane/)).toBeTruthy();
    // Asked for, so it can be taken back — and the machine's own screen is
    // what it goes back to.
    fireEvent.click(button("Cancel"));
    await waitFor(() => expect(screen.getByRole("heading", { name: "This Machine Is a Node" })).toBeTruthy());
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

  /** Not responding, on a definition that would take live panes down. */
  const risky = makeProbe({
    step: "offline",
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
    fireEvent.click(confirmPanel().getByRole("button", { name: "Cancel" }));

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
      probe: makeProbe({ ...risky, rewriteTearsDown: true }),
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
    await boot({ probe: STOPPED });
    expect(buttonOrNull("Rewrite the service definition")).toBeNull();
    cleanup();
    ipc?.restore();

    await boot({ probe: makeProbe({ ...STOPPED, service: riskyService }) });
    expect(buttonOrNull("Rewrite the service definition")).not.toBeNull();
    // And the reason it is offered is said out loud, not left to the facts.
    expect(screen.getByText(/does not spare live panes/)).toBeTruthy();
  });

  it("runs straight through where the rewrite is free", async () => {
    const fake = await boot({
      probe: makeProbe({ ...STOPPED, service: riskyService, rewriteTearsDown: false }),
      handlers: { node_service: () => ({ ok: true, stdout: "wrote the unit", stderr: "" }) },
    });
    fireEvent.click(button("Rewrite the service definition"));
    await waitFor(() => expect(fake.callsTo("node_service").length).toBe(1));
    expect(fake.callsTo("node_service")[0]).toEqual({ verb: "install", force: false });
  });

  it("asks first where the rewrite itself costs the panes it is repairing", async () => {
    const fake = await boot({
      probe: makeProbe({ ...STOPPED, service: riskyService, rewriteTearsDown: true }),
      handlers: { node_service: () => ({ ok: true, stdout: "wrote the plist", stderr: "" }) },
    });

    fireEvent.click(button("Rewrite the service definition"));

    await waitFor(() => expect(screen.getByText(/Rewriting the definition restarts the agent/)).toBeTruthy());
    expect(fake.callsTo("node_service").length).toBe(0);
    expect(screen.getByText(/It is the last time that happens/)).toBeTruthy();

    fireEvent.click(confirmPanel().getByRole("button", { name: "Rewrite the definition" }));
    await waitFor(() => expect(fake.callsTo("node_service").length).toBe(1));
  });
});

describe("replacing the installed agent", () => {
  it("confirms first, and never applies it unasked", async () => {
    const fake = await boot({
      probe: makeProbe({ agentChoice: "upgrade-available", bundledVersion: "1.10.0" }),
      handlers: { node_install_agent: () => ({ ok: true, stdout: "Installed subshell", stderr: "" }) },
    });

    fireEvent.click(button("Update the agent to 1.10.0"));

    await waitFor(() => expect(confirmPanelOrNull()).not.toBeNull());
    expect(fake.callsTo("node_install_agent").length).toBe(0);
    expect(confirmPanel().getByText(/Nothing is downloaded/)).toBeTruthy();
    expect(confirmPanel().getByText(/is NOT started again/)).toBeTruthy();

    fireEvent.click(confirmPanel().getByRole("button", { name: "Update the agent" }));
    await waitFor(() => expect(fake.callsTo("node_install_agent").length).toBe(1));
  });

  it("does not put the upgrade offer on the re-enroll screen", async () => {
    await boot({ probe: makeProbe({ agentChoice: "upgrade-available", bundledVersion: "1.10.0" }) });
    expect(buttonOrNull("Update the agent to 1.10.0")).not.toBeNull();
    fireEvent.click(button("Re-enroll…"));
    // That screen ends in a destructive button; an unrelated one beside it is
    // how the wrong one gets clicked.
    await waitFor(() => expect(buttonOrNull("Update the agent to 1.10.0")).toBeNull());
  });
});

// ---------------------------------------------------------------------------
// 9. What the page never asks for
// ---------------------------------------------------------------------------

describe("what the page never asks for", () => {
  it("drives no command outside the set it declares", async () => {
    const fake = await boot({
      probe: STOPPED,
      handlers: { node_service: () => ({ ok: true, stdout: "", stderr: "" }) },
    });

    fireEvent.click(button("Start"));
    await waitFor(() => expect(fake.callsTo("node_service").length).toBe(1));

    const allowed = new Set([
      "node_probe",
      "node_settings",
      "node_service",
      "node_install_agent",
      "node_enroll",
      "node_set_agent_bin",
      "node_open_path",
      // The tray's screen request, ASKED for on mount — a window the tray just
      // created has no listener yet, so the event alone would be lost.
      "node_pending_screen",
      // Tauri's own event plumbing, not a command this app defines: the page
      // subscribes for the tray's screen requests on mount. `node_about` is
      // NOT here any more — it is read by the About screen, which a person has
      // to ask for, and no rendered screen invokes it.
      "plugin:event|listen",
      "plugin:event|unlisten",
    ]);
    for (const call of fake.calls) expect(allowed.has(call.cmd)).toBe(true);
    // No `service run` — it never resolves and flaps against the service.
    for (const args of fake.callsTo("node_service")) expect(args.verb).not.toBe("run");
  });

  // The tray preference is no longer a control on this page at all: it is a
  // check item in the tray menu, so nothing here can invoke it.
  it("never touches the tray preference", async () => {
    const fake = await boot();
    expect(screen.queryByRole("switch")).toBeNull();
    expect(fake.callsTo("node_set_close_to_tray").length).toBe(0);
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
    const fake = await boot({ probe: FRESH, handlers: { node_install_agent: () => gate.promise } });

    fireEvent.click(button("Install"));
    await waitFor(() => expect(button("Install").disabled).toBe(true));
    const during = fake.callsTo("node_probe").length;
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(fake.callsTo("node_probe").length).toBe(during);

    gate.resolve({ ok: true, stdout: "", stderr: "" });
    await waitFor(() => expect(button("Install").disabled).toBe(false));
  });
});

// ---------------------------------------------------------------------------
// The screens a machine walks
// ---------------------------------------------------------------------------

describe("the screens", () => {
  it("offers the install only when nothing answered at all", async () => {
    await boot({ probe: makeProbe({ step: "no-agent", agent: null, status: null, service: null }) });
    expect(screen.getByRole("heading", { name: "Install the Agent" })).toBeTruthy();
    expect(buttonOrNull("Install")).not.toBeNull();
    expect(screen.getByText(/No subshell agent was found/)).toBeTruthy();
    cleanup();
    ipc?.restore();

    // An agent that answered `version` but not `status --json`: enrolling here
    // would overwrite a live config and discard its node key.
    await boot({ probe: makeProbe({ step: "no-agent", status: null }) });
    expect(buttonOrNull("Install")).toBeNull();
    expect(buttonOrNull("Enroll")).toBeNull();
    expect(buttonOrNull("Retry")).not.toBeNull();
    expect(screen.getByText(/could not report its status/)).toBeTruthy();
  });

  it("settles after a start rather than reporting the service still stopped", async () => {
    const fake = await boot({
      probe: STOPPED,
      handlers: { node_service: () => ({ ok: true, stdout: "subshell started.", stderr: "" }) },
    });

    // The daemon takes the lock a beat after the manager returns.
    fake.setProbe(makeProbe());
    fireEvent.click(button("Start"));

    await waitFor(() => expect(screen.getByRole("heading", { name: "This Machine Is a Node" })).toBeTruthy(), {
      timeout: SETTLE_DELAY_MS * (SETTLE_ATTEMPTS + 1),
    });
    expect(fake.callsTo("node_service")).toEqual([{ verb: "start", force: false }]);
  });

  // A step this build predates lands on the screen that shows the facts and
  // the last output, which are what make an unrecognised state diagnosable.
  it("says it does not recognise a step this build predates", async () => {
    await boot({ probe: makeProbe({ step: "quantum-superposition" as never }) });
    expect(screen.getByText(/does not recognise the state "quantum-superposition"/)).toBeTruthy();
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
  // Behind Show Details now, rather than a permanent card: a person opens this
  // window to DO something. Nothing was dropped in the move.
  it("names the config file, the control plane and tmux", async () => {
    await boot();
    expect(screen.getByText("/home/u/.config/subshell/config.json")).toBeTruthy();
    expect(screen.getAllByText(/https:\/\/subshell\.example\.com/).length).toBeGreaterThan(0);
    expect(screen.getByText("/usr/bin/tmux")).toBeTruthy();
    expect(screen.getByText(/online \(last heartbeat 4s ago\)/)).toBeTruthy();
  });

  it("shouts when tmux is missing, because a node without it refuses every launch", async () => {
    await boot({ probe: makeProbe({ tmux: null }) });
    expect(screen.getByText(/NOT FOUND: enroll refuses/)).toBeTruthy();
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
    // Before: a machine whose name this session did not choose says nothing
    // about one, rather than guessing it from the hostname.
    expect(screen.queryByText(/workstation/)).toBeNull();

    typeInto("Server URL", "https://subshell.example.com");
    typeInto("Setup key", GOOD_KEY);
    typeInto("Node name", "workstation");
    ipc?.setProbe(makeProbe());
    fireEvent.click(button("Enroll"));

    // Twice over, and both are the same fact: the connected screen greets the
    // machine by name, and the facts list carries it beside the node id.
    await waitFor(() => expect(screen.getAllByText(/workstation/).length).toBeGreaterThan(0));
    expect(screen.getByText(/Enrolled as/)).toBeTruthy();
  });
});

describe("tmux is a hard stop, not a hint", () => {
  // The CLI refuses (or degrades far from the cause), and a live button that
  // only produces that outcome trains the user to click through warnings. The
  // buttons that DO work without tmux — the reveals, the re-read — must stay
  // live; disabling those strands the box.
  it("disables what cannot work without tmux, and nothing else", async () => {
    await boot({ probe: makeProbe({ ...STOPPED, tmux: null }) });
    expect(button("Start").disabled).toBe(true);
    expect(button("Refresh").disabled).toBe(false);
    expect(button("Open the agent log").disabled).toBe(false);
    expect(button("Reveal configuration").disabled).toBe(false);
    // The hint names the install command, so the refusal is one step from action.
    expect(screen.getByText(/brew install tmux|sudo apt-get install tmux/)).toBeTruthy();
  });

  it("re-enables on the probe that finds tmux — the gate is not remembered", async () => {
    const fake = await boot({ probe: makeProbe({ ...STOPPED, tmux: null }) });
    expect(button("Start").disabled).toBe(true);
    fake.setProbe(STOPPED);
    fireEvent.click(button("Refresh"));
    await waitFor(() => expect(button("Start").disabled).toBe(false));
  });

  it("gates enrolment too — enroll preflights tmux before spending the key", async () => {
    await boot({
      probe: makeProbe({
        step: "not-enrolled",
        tmux: null,
        status: { nodeId: null, online: false, reason: "no config" },
      }),
    });
    expect(button("Enroll").disabled).toBe(true);
    expect(screen.getByText(/so enrolling is disabled/)).toBeTruthy();
  });

  it("the install button says it also starts, because the CLI's install does", async () => {
    await boot({ probe: makeProbe({ ...STOPPED, step: "no-service" }) });
    expect(button("Install and Start")).toBeTruthy();
  });
});

describe("the plane's two doors", () => {
  // The in-app window stays primary; this opens the SAME settled address in
  // the system browser, and the command takes no URL argument by design.
  it("opens the settled plane URL in the system browser", async () => {
    const fake = await boot({ handlers: { node_open_plane_url: () => null } });
    fireEvent.click(button("Open in browser instead"));
    await waitFor(() => expect(fake.callsTo("node_open_plane_url")).toEqual([{}]));
    // And it asked for NOTHING but the intent — no URL crossed the boundary.
    expect(fake.callsTo("node_open_plane_url")[0]).toEqual({});
  });

  it("rejection reaches the problem line, like every command", async () => {
    await boot({
      handlers: {
        node_open_plane_url: () => {
          throw "no control plane yet — enter its URL, or enrol this machine first";
        },
      },
    });
    fireEvent.click(button("Open in browser instead"));
    await waitFor(() =>
      expect(screen.getByText("no control plane yet — enter its URL, or enrol this machine first")).toBeTruthy(),
    );
  });

  it("opens the app window at the address the connect screen was given", async () => {
    const fake = await boot({
      settings: makeSettings({ planeUrl: null }),
      handlers: { node_open_plane: (args) => String(args.url) },
    });
    typeInto("Server URL", "https://plane.example");
    fireEvent.click(button("Open"));
    await waitFor(() => expect(fake.callsTo("node_open_plane")).toEqual([{ url: "https://plane.example" }]));
  });

  // `node_open_plane_url` re-reads the settled address rather than taking one
  // from the page, so an address that has never been saved has to be persisted
  // before the browser can be sent to it — and the runner serializes, so the
  // two cannot be fired together.
  it("persists the typed address before opening a browser on it", async () => {
    const fake = await boot({
      settings: makeSettings({ planeUrl: null }),
      handlers: { node_open_plane: (args) => String(args.url), node_open_plane_url: () => null },
    });
    typeInto("Server URL", "https://plane.example");
    fireEvent.click(button("Open in browser instead"));
    await waitFor(() => expect(fake.callsTo("node_open_plane_url").length).toBe(1));
    expect(fake.callsTo("node_open_plane")).toEqual([{ url: "https://plane.example" }]);
    // Order matters: saving comes first, or the browser opens on nothing.
    const order = fake.calls.filter((c) => c.cmd.startsWith("node_open_plane")).map((c) => c.cmd);
    expect(order).toEqual(["node_open_plane", "node_open_plane_url"]);
  });
});
