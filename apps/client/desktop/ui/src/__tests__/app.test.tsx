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
 *
 * **What the FIRST RUN changed** (spec 2026-09-18), because it is why so many
 * cases below reach their subject by a different route than they used to. The
 * probe no longer picks a landing: `clientScreen` asks what a person came to
 * do, and every CONFIGURED client lands on one screen, `status`. So the
 * `connected`, `service` and `install-agent` screens are gone, and what each
 * of them offered is a card or a bar button there. Three properties moved
 * rather than merely relocating:
 *
 * - **An address no longer comes first.** An enrolled machine with no stored
 *   `planeUrl` is configured, because the walk ends at Register and Register
 *   on a node mints a second node row.
 * - **Two-phase enrolment is the RE-enrolment's property.** The first run's
 *   Register press IS the consent (§ 6.2), so it sends `confirm: true`; the
 *   confirmation survives on the act that overwrites a live `config.json`.
 * - **The connect screen persists without opening.** Its button used to open
 *   the server's dashboard over the setup still running behind it, which is
 *   the defect the whole flow exists to remove.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { App } from "@/app";
import { SETTLE_ATTEMPTS, SETTLE_DELAY_MS } from "@/hooks/use-action-runner";
import { PROBE_KEY, PROBE_POLL_MS } from "@/hooks/use-node-state";
import { deferred, type FakeIpc, installFakeIpc, makeProbe, makeSettings, renderApp } from "./harness";

// Unmount after each test. Testing Library appends every `render` to
// `document.body`, and there is ONE document per bun test process — so a file
// that renders without unmounting leaves its DOM for whatever file bun shards
// into that process next, and a test asking a GLOBAL question
// (`getAllByRole("button")`) reads the leftovers as its own. That is exactly
// how the Welcome screen's "Continue is the only control" case passed on a Mac
// and failed on CI, counting four About-screen buttons as its own (2026-09-18).
afterEach(cleanup);

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

/** A machine with no node CLI at all — nothing to stop, overwrite or downgrade. */
const FRESH = makeProbe({ step: "no-node", nodeBinary: null, status: null, service: null });

let ipc: FakeIpc | undefined;

afterEach(() => {
  cleanup();
  ipc?.restore();
  ipc = undefined;
});

/** Render App against a fake IPC and wait for the first probe to land. */
async function boot(init: Parameters<typeof installFakeIpc>[0] = {}) {
  ipc = installFakeIpc(init);
  const view = renderApp(<App />);
  await waitFor(() => expect(ipc?.callsTo("node_probe").length).toBeGreaterThan(0));
  // A plain FakeIpc copy with the query client along for the tests that need
  // to drive a re-probe without a Refresh button (the poll is the refresh,
  // operator ruling 2026-09-22). The module-level `ipc` still holds the
  // original for `restore()`.
  return Object.assign({}, ipc, { client: view.client });
}

/**
 * A button by its accessible name. A RegExp is accepted for the two-line
 * choices on the first-run Choice screen, whose accessible name is the label
 * AND its detail sentence — matching the whole of that is asserting the copy
 * twice, in the place least likely to be updated with it.
 */
const button = (name: string | RegExp) => screen.getByRole("button", { name }) as HTMLButtonElement;
const buttonOrNull = (name: string | RegExp) => screen.queryByRole("button", { name }) as HTMLButtonElement | null;

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

/**
 * Open the enrol form the way a person reaches it: **Re-enroll…**, on the
 * Control Plane section of a machine that already IS a node (operator ruling
 * 2026-09-22 — the act moved there from the status screen, which keeps
 * machine state only).
 *
 * The probe-derived `enroll` landing is gone (spec 2026-09-18 § 5.4). An
 * unconfigured machine walks to **Register**, whose press is the consent and
 * which therefore does not confirm; the two-phase flow every case in that
 * block is about belongs to re-enrolment — the act that overwrites a working
 * `config.json`, mints a SECOND node row and discards the only copy of a live
 * node key. Same screen, same form, same commands; a different door.
 */
async function openReenroll(init: Parameters<typeof installFakeIpc>[0] = {}) {
  const fake = await boot(init);
  await openSection("Control Plane");
  fireEvent.click(button("Re-enroll…"));
  await screen.findByRole("heading", { name: "Enroll This Machine" });
  return fake;
}

// ---------------------------------------------------------------------------
// 0. The frame: one screen at a time, each asking one question
// ---------------------------------------------------------------------------

/**
 * The rail select IS the navigation now (operator ruling 2026-09-22): open a
 * section and wait for its screen's heading.
 */
async function openSection(name: "Status" | "Service" | "Control Plane" | "Update"): Promise<void> {
  fireEvent.click(button(name));
  await waitFor(() =>
    expect(
      {
        Status: "Subshell Client",
        Service: "Service",
        "Control Plane": "Control Plane",
        Update: "Update Subshell Client",
      }[name],
    ).toBe(screen.getByRole("heading", { level: 1 }).textContent),
  );
}

describe("the assistant frame", () => {
  // Was "asks for a server first, ahead of anything the probe says", and the
  // rule is deliberately reversed (spec 2026-09-18 §§ 1-2). Asking for an
  // address first meant the front door of a fresh install was a field whose
  // button opened somebody else's dashboard. The address is still asked for —
  // on the watch path, as one of two answers to a question that is now put
  // first.
  it("asks what you came to do before it asks for anything else", async () => {
    await boot({ settings: makeSettings({ planeUrl: null }), probe: FRESH });
    expect(screen.getByRole("heading", { name: "Welcome to Subshell Client" })).toBeTruthy();
    // Nothing on it but a step forward: no field, and no command.
    expect(ipc?.callsTo("node_set_plane").length).toBe(0);

    fireEvent.click(button("Continue"));
    await waitFor(() => expect(screen.getByRole("heading", { name: "What Would You Like to Do?" })).toBeTruthy());

    fireEvent.click(button(/^connect to a server/i));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Connect to a Server" })).toBeTruthy());
    expect(screen.getByLabelText("Server URL")).toBeTruthy();
    expect(buttonOrNull("Connect")).not.toBeNull();
  });

  // The other half of that reversal, and the reason `configured` counts a node
  // rather than only a stored address: this machine has no `planeUrl`, so the
  // old router showed it Connect — but it IS a node, and the walk that screen
  // starts ends at Register, which mints a SECOND node row on the control
  // plane and discards the node key whose only copy is `config.json`.
  it("never walks an enrolled machine through a first run, address or no address", async () => {
    await boot({ settings: makeSettings({ planeUrl: null }) });
    // The landing is Control Plane now (operator ruling 2026-09-22, second
    // addendum), and it is a standing screen, never a walk.
    expect(screen.getByRole("heading", { name: "Control Plane" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Welcome to Subshell Client" })).toBeNull();
    expect(buttonOrNull("Register")).toBeNull();
  });

  it("shows a working machine its state, and the rail the rest", async () => {
    // The status screen keeps machine state only, after the wave-3 follow-ups
    // (operator rulings, 2026-09-22): the node's machinery lives on Service,
    // the plane addresses on Control Plane, and the rail is the navigation —
    // so "More…" is gone rather than moved.
    await boot();
    // The landing is Control Plane (operator ruling 2026-09-22, second
    // addendum); the rail reads Control Plane first, and it is active.
    expect(screen.getByRole("heading", { name: "Control Plane" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Control Plane" }).getAttribute("aria-current")).toBe("true");
    await openSection("Status");
    // No doors on the status screen (the second addendum superseded the same
    // day's browser ghost): the Dashboard card is the only place that opens
    // the plane.
    expect(buttonOrNull("Open Dashboard")).toBeNull();
    expect(buttonOrNull("Open in browser")).toBeNull();
    expect(buttonOrNull("Open in app")).toBeNull();
    // Re-enroll… is NOT on the status screen any more (operator ruling
    // 2026-09-22): the act is on the machine's relationship to the plane, so
    // the Control Plane section carries it.
    expect(buttonOrNull("Re-enroll…")).toBeNull();
    expect(screen.queryByText("More…")).toBeNull();
    const rail = screen.getByRole("navigation", { name: "Main" });
    expect([...rail.querySelectorAll("button")].map((b) => b.textContent)).toEqual([
      "Control Plane",
      "Status",
      "Service",
      "Update",
      "About",
      "Reset",
    ]);
    // Back to the landing section, where the relationship act lives.
    await openSection("Control Plane");
    expect(buttonOrNull("Re-enroll…")).not.toBeNull();
  });

  // Each used to be its own screen with its own heading. They land on `status`
  // now, so what names the failure is the badge and the sentence beside the
  // verb rather than a title that changed under the person reading it — and
  // the verb is still the step's own.
  it("names which service failure it is looking at", async () => {
    await boot({ probe: STOPPED });
    // The verb and its diagnosis are the Service section's now.
    await openSection("Service");
    expect(screen.getByText("Service stopped")).toBeTruthy();
    expect(screen.getByText(/the node is not running/)).toBeTruthy();
    expect(buttonOrNull("Start")).not.toBeNull();
    cleanup();
    ipc?.restore();

    await boot({ probe: makeProbe({ step: "offline", status: { ...STOPPED.status, online: false } }) });
    await openSection("Service");
    expect(screen.getByText("Offline")).toBeTruthy();
    expect(screen.getByText(/no local daemon is heartbeating/)).toBeTruthy();
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

    await openSection("Service");
    fireEvent.click(button("Start"));

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
        node_service: () => {
          throw "the service manager would not answer";
        },
      },
    });
    await openSection("Service");
    fireEvent.click(button("Start"));
    await waitFor(() => expect(screen.getByText("the service manager would not answer")).toBeTruthy());
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
    // The service verb is the Service section's now.
    await openSection("Service");
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
    await boot({ probe: FRESH, handlers: { node_install_cli: () => ({ ok: true, stdout, stderr }) } });

    // The install screen's one button is the status screen's no-node card
    // now. Same command, same unconfirmed offer, same reason it is safe: on a
    // machine where nothing answered there is nothing to stop, overwrite or
    // downgrade.
    // The install offer is the Service section's now (operator ruling 2026-09-22).
    await openSection("Service");
    fireEvent.click(button("Install the Subshell Node CLI"));

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
    const fake = await boot({ probe: FRESH, handlers: { node_install_cli: () => gate.promise } });

    // The install offer is the Service section's now (operator ruling 2026-09-22).
    await openSection("Service");
    fireEvent.click(button("Install the Subshell Node CLI"));
    await waitFor(() => expect(button("Install the Subshell Node CLI").disabled).toBe(true));

    // Both the guard and the disabled attribute; a click dispatched anyway
    // (a stale reference, a synthetic event) must still not reach the CLI.
    fireEvent.click(button("Install the Subshell Node CLI"));
    expect(fake.callsTo("node_install_cli").length).toBe(1);
    expect(button("Install the Subshell Node CLI").disabled).toBe(true);

    gate.resolve({ ok: true, stdout: "Installed subshell.", stderr: "" });
    await waitFor(() => expect(button("Install the Subshell Node CLI").disabled).toBe(false));
  });

  it("keeps the UI disabled until the re-probe has landed", async () => {
    const gate = deferred<{ ok: boolean; stdout: string; stderr: string }>();
    const fake = await boot({ probe: FRESH, handlers: { node_install_cli: () => gate.promise } });
    const probesBefore = fake.callsTo("node_probe").length;

    // The install offer is the Service section's now (operator ruling 2026-09-22).
    await openSection("Service");
    fireEvent.click(button("Install the Subshell Node CLI"));
    gate.resolve({ ok: true, stdout: "Installed subshell.", stderr: "" });

    // A button that came back alive before the re-probe would be a button
    // acting on a machine that has moved on.
    await waitFor(() => expect(button("Install the Subshell Node CLI").disabled).toBe(false));
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

    // All three are the Service section's controls now.
    await openSection("Service");
    let seen = fake.callsTo("node_probe").length;
    for (const label of ["Start", "Open the node log", "Reveal configuration"]) {
      fireEvent.click(button(label));
      await waitFor(() => expect(fake.callsTo("node_probe").length).toBeGreaterThan(seen));
      seen = fake.callsTo("node_probe").length;
    }
  });
});

// ---------------------------------------------------------------------------
// 5 + 6. Enrolment
// ---------------------------------------------------------------------------

/**
 * Two-phase enrolment, which is now RE-enrolment's property.
 *
 * Every case here is unchanged in what it asserts; what changed is the door.
 * `openReenroll` reaches the same screen, the same form and the same
 * `node_enroll` two-call flow from a machine that already is a node — which
 * is the act the confirmation was always FOR (it overwrites `config.json`,
 * mints a second node row and discards the only copy of a live node key). The
 * first run's Register press is the consent for the OTHER case and skips the
 * panel by design (§ 6.2); that path has its own block below, which pins that
 * it sends `confirm: true` and raises nothing.
 */
describe("enrolment is two-phase", () => {
  it("asks first, spawns nothing, and only re-sends on an explicit accept", async () => {
    const fake = await openReenroll({
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

  it("sends the NORMALIZED name, never the text that was typed", async () => {
    // The gap this closes is one the test above cannot see: it types "workstation",
    // and for a clean name the raw field and `normalizeNodeName`'s output are the SAME
    // string, so asserting on either passes. The claim the whole revamp rests on — one
    // rule, applied once, so a name cannot be clean here and collapsed later — is only
    // pinned by a name that NEEDS normalizing: this asserts the argv Rust receives, and
    // therefore the POST body and the row on the Nodes page, is the normalized value.
    const fake = await openReenroll({
      handlers: {
        node_enroll: () => ({
          ok: true,
          stdout: "enrolled",
          stderr: "",
          node: { nodeId: "abc", name: "mac mini two" },
          requiresConfirmation: false,
          confirmations: [],
        }),
      },
    });

    typeInto("Server URL", "https://subshell.example.com");
    typeInto("Setup key", GOOD_KEY);
    typeInto("Node name", "  mac\u000emini\ttwo  ");
    // The guard against a vacuous pass: if the DOM had swallowed the control character
    // on the way in, the assertion below would only prove that a clean name round-trips.
    // So first prove the FIELD holds the dirty value, and only then that the WIRE does not.
    expect((screen.getByLabelText("Node name") as HTMLInputElement).value).toContain("\u000e");
    fireEvent.click(button("Enroll"));

    await waitFor(() => expect(fake.callsTo("node_enroll").length).toBe(1));
    const sent = fake.callsTo("node_enroll")[0];
    expect(sent).toMatchObject({ name: "mac mini two" });
    // Pinned the other way too: had the raw field been sent, the control character and
    // the tab would still be in it, and this is the assertion that says so.
    expect(sent.name).not.toInclude("\u000e");
    expect(sent.name).not.toContain("\t");
  });

  it("never auto-retries a failed enrolment", async () => {
    const fake = await openReenroll({
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
    const fake = await openReenroll({
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

    // A successful enrolment closes the screen it was asked for, so the form
    // is re-opened to read it. That is not a workaround: the values live in
    // the page rather than in the DOM, which is the whole reason they survive
    // a screen change at all.
    await waitFor(() => expect(fake.callsTo("node_enroll").length).toBe(1));
    await openSection("Control Plane");
    await waitFor(() => expect(buttonOrNull("Re-enroll…")).not.toBeNull());
    fireEvent.click(button("Re-enroll…"));
    await screen.findByRole("heading", { name: "Enroll This Machine" });

    expect((screen.getByLabelText("Setup key") as HTMLInputElement).value).toBe("");
    // The server URL survives: the common re-enroll is the same server.
    expect((screen.getByLabelText("Server URL") as HTMLInputElement).value).toBe("https://subshell.example.com");
    // And so does the NAME, which the operator typed rather than pasted. It is
    // required now, and a retry costs a fresh key rather than a retyped machine
    // name — the field that failed is the one that clears.
    expect((screen.getByLabelText("Node name") as HTMLInputElement).value).toBe("workstation");
  });

  it("refuses an invalid form before any spawn", async () => {
    const fake = await openReenroll();

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
    await openReenroll();
    expect(screen.getByText(/Mint a setup key in the browser first/)).toBeTruthy();
    expect(screen.getByText(/single-use and expires after 24 hours/)).toBeTruthy();
    expect(screen.getByText(/fails after the control plane has accepted it/)).toBeTruthy();
    // The third note is the naming one, and it says WHY the field is here rather
    // than being an optional courtesy: the control plane's guess went away.
    expect(screen.getByText(/the row on the Nodes page/)).toBeTruthy();
  });

  // A warning, never a block.
  it("warns about a loopback URL without disabling anything", async () => {
    const fake = await openReenroll({
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
    await openSection("Control Plane");
    fireEvent.click(button("Re-enroll…"));
    await waitFor(() =>
      expect((screen.getByLabelText("Server URL") as HTMLInputElement).value).toBe("https://subshell.example.com"),
    );
    expect(screen.getByText(/registers a SECOND node on the control plane/)).toBeTruthy();
    // Asked for, so it can be taken back — and the machine's own screen is
    // what it goes back to.
    fireEvent.click(button("Cancel"));
    // The machine's own screen is the landing, Control Plane now.
    await waitFor(() => expect(screen.getByRole("heading", { name: "Control Plane" })).toBeTruthy());
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

    await openSection("Service");
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

    await openSection("Service");
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

    await openSection("Service");
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
    await openSection("Service");
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
    await openSection("Service");
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
    // The rewrite is the Service section's control now.
    await boot({ probe: STOPPED });
    await openSection("Service");
    expect(buttonOrNull("Rewrite the service definition")).toBeNull();
    cleanup();
    ipc?.restore();

    await boot({ probe: makeProbe({ ...STOPPED, service: riskyService }) });
    await openSection("Service");
    expect(buttonOrNull("Rewrite the service definition")).not.toBeNull();
    // And the reason it is offered is said out loud, not left to the facts.
    expect(screen.getByText(/does not spare live panes/)).toBeTruthy();
  });

  it("runs straight through where the rewrite is free", async () => {
    const fake = await boot({
      probe: makeProbe({ ...STOPPED, service: riskyService, rewriteTearsDown: false }),
      handlers: { node_service: () => ({ ok: true, stdout: "wrote the unit", stderr: "" }) },
    });
    await openSection("Service");
    fireEvent.click(button("Rewrite the service definition"));
    await waitFor(() => expect(fake.callsTo("node_service").length).toBe(1));
    expect(fake.callsTo("node_service")[0]).toEqual({ verb: "install", force: false });
  });

  it("asks first where the rewrite itself costs the panes it is repairing", async () => {
    const fake = await boot({
      probe: makeProbe({ ...STOPPED, service: riskyService, rewriteTearsDown: true }),
      handlers: { node_service: () => ({ ok: true, stdout: "wrote the plist", stderr: "" }) },
    });

    await openSection("Service");
    fireEvent.click(button("Rewrite the service definition"));

    await waitFor(() => expect(screen.getByText(/Rewriting the definition restarts the node/)).toBeTruthy());
    expect(fake.callsTo("node_service").length).toBe(0);
    expect(screen.getByText(/It is the last time that happens/)).toBeTruthy();

    fireEvent.click(confirmPanel().getByRole("button", { name: "Rewrite the definition" }));
    await waitFor(() => expect(fake.callsTo("node_service").length).toBe(1));
  });
});

describe("replacing the installed node CLI", () => {
  /**
   * The status screen's button is a DOOR now (spec 2026-09-18 § 7.4), so the
   * confirmation it used to raise directly is raised one screen further in —
   * by the one update act, which is where both halves of an update live. What
   * the test still pins is that nothing is installed before someone accepts.
   */
  it("confirms first, and never applies it unasked", async () => {
    const fake = await boot({
      probe: makeProbe({ nodeChoice: "upgrade-available", bundledVersion: "1.10.0" }),
      handlers: {
        node_install_cli: () => ({ ok: true, stdout: "Installed subshell", stderr: "" }),
        node_check_app_update: () => ({ current: "0.6.1", latest: null, notes: null, reason: null }),
      },
    });

    // The door is the rail's Update section now (operator ruling 2026-09-22);
    // the doors the status screen carried are gone.
    await openSection("Update");
    await waitFor(() => expect(buttonOrNull("Install the Subshell Node CLI (1.10.0)")).not.toBeNull());
    fireEvent.click(button("Install the Subshell Node CLI (1.10.0)"));

    await waitFor(() => expect(confirmPanelOrNull()).not.toBeNull());
    expect(fake.callsTo("node_install_cli").length).toBe(0);
    expect(confirmPanel().getByText(/Nothing is downloaded/)).toBeTruthy();
    // NOT "the service is stopped first" and NOT "start it afterwards": the
    // managed path swaps through the CLI's `update --from`, whose rename(2)
    // the running daemon never notices, so nothing is stopped and the daemon
    // is still up — on the OLD binary. Both halves of the old sentence were
    // false, and the second one named the wrong verb (2026-09-18).
    expect(confirmPanel().queryByText(/stopped first/i)).toBeNull();
    expect(confirmPanel().queryByText(/is NOT started again/)).toBeNull();
    expect(confirmPanel().getByText(/keeps running the previous version until you restart it/)).toBeTruthy();

    fireEvent.click(confirmPanel().getByRole("button", { name: "Update the node" }));
    await waitFor(() => expect(fake.callsTo("node_install_cli").length).toBe(1));
  });

  it("does not put the upgrade offer on the re-enroll screen", async () => {
    // The node-behind door the status screen carried is GONE (operator
    // ruling 2026-09-22): the Update section is the door, and the update
    // screen's own table is where the node row's numbers live.
    await boot({ probe: makeProbe({ nodeChoice: "upgrade-available", bundledVersion: "1.10.0" }) });
    expect(buttonOrNull("Update the node to 1.10.0")).toBeNull();
    await openSection("Control Plane");
    fireEvent.click(button("Re-enroll…"));
    // That screen ends in a destructive button; an unrelated one beside it is
    // how the wrong one gets clicked.
    await waitFor(() => expect(buttonOrNull("Update the node to 1.10.0")).toBeNull());
    expect(buttonOrNull("Install the Subshell Node CLI (1.10.0)")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 9. What the page never asks for
// ---------------------------------------------------------------------------

describe("what the page never asks for", () => {
  // THE pin (review I1, 2026-09-22): every screen the app ships must be WALKED
  // here, pressing what it offers, or the declared set proves nothing — a
  // screen nobody visits can drive any command it likes. The standing
  // sections are walked below; the FTE walk's screens have their own test,
  // because their machine state is a different boot.
  it("drives no command outside the set it declares", async () => {
    const fake = await boot({
      probe: STOPPED,
      handlers: {
        node_service: () => ({ ok: true, stdout: "", stderr: "" }),
        node_open_plane: (args) => String(args.url),
        node_open_plane_url: () => null,
        node_configure: () => ({ ok: true, stdout: "node repointed", stderr: "" }),
        node_check_app_update: () => ({ current: "0.6.1", latest: null, notes: null, reason: null }),
      },
    });

    // Service: the contextual verb.
    await openSection("Service");
    fireEvent.click(button("Start"));
    await waitFor(() => expect(fake.callsTo("node_service").length).toBe(1));

    // Control Plane: both doors, and the repoint form. Each act waits out the
    // runner (Start's settle included) before the next press, because a press
    // refused on `busy` is a silent no-op and this pin must not pass by luck.
    await openSection("Control Plane");
    await waitFor(() => expect(button("Open in app").disabled).toBe(false), {
      timeout: SETTLE_DELAY_MS * (SETTLE_ATTEMPTS + 2),
    });
    fireEvent.click(button("Open in app"));
    await waitFor(() => expect(fake.callsTo("node_open_plane").length).toBe(1));
    await waitFor(() => expect(button("Open in browser").disabled).toBe(false));
    fireEvent.click(button("Open in browser"));
    await waitFor(() => expect(fake.callsTo("node_open_plane_url").length).toBe(1));
    await waitFor(() => expect(button("Repoint this node…").disabled).toBe(false));
    fireEvent.click(button("Repoint this node…"));
    const field = await screen.findByLabelText("Control plane this node reports to");
    fireEvent.change(field, { target: { value: "https://elsewhere.example" } });
    fireEvent.click(button("Repoint"));
    await waitFor(() => expect(fake.callsTo("node_configure").length).toBe(1));

    // Update: the check runs on mount, and Check Again re-asks it.
    await openSection("Update");
    await waitFor(() => expect(fake.callsTo("node_check_app_update").length).toBe(1));
    fireEvent.click(button("Check Again"));
    await waitFor(() => expect(fake.callsTo("node_check_app_update").length).toBe(2));

    const allowed = new Set([
      "node_probe",
      "node_settings",
      // The standing sections' commands: the service verb, the plane doors,
      // the repoint, the app-update check.
      "node_service",
      "node_open_plane",
      "node_open_plane_url",
      "node_configure",
      "node_check_app_update",
      // The FTE walk's screens (pinned in the test below): the connect
      // screen's persist, the tmux gate's install.
      "node_set_plane",
      "node_install_tmux",
      // The enroll flow's commands, reached from the rail.
      "node_install_cli",
      "node_enroll",
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

  // The FTE walk's screens, walked the same way the standing sections are
  // (review I1, 2026-09-22): Connect presses `node_set_plane`, the tmux gate
  // presses `node_install_tmux`. Anything else either screen drives is this
  // test's failure.
  it("drives no command outside the set on the first-run walk", async () => {
    const fake = await boot({
      settings: makeSettings({ planeUrl: null }),
      probe: FRESH,
      handlers: {
        node_set_plane: (args) => String(args.url),
        node_install_tmux: () => ({ ok: true, stdout: "installed tmux", stderr: "" }),
      },
    });

    // The watch path: Connect persists the address, and opens nothing.
    fireEvent.click(button("Continue"));
    fireEvent.click(button(/^connect to a server/i));
    await screen.findByRole("heading", { name: "Connect to a Server" });
    typeInto("Server URL", "https://plane.example");
    fireEvent.click(button("Connect"));
    await waitFor(() => expect(fake.callsTo("node_set_plane").length).toBe(1));

    cleanup();
    ipc?.restore();

    // The node path on a machine without tmux: the gate installs it.
    const gate = await boot({
      settings: makeSettings({ planeUrl: null }),
      probe: makeProbe({ tmux: null, status: null, service: null }),
      handlers: {
        node_set_plane: (args) => String(args.url),
        node_install_tmux: () => ({ ok: true, stdout: "installed tmux", stderr: "" }),
      },
    });
    fireEvent.click(button("Continue"));
    fireEvent.click(button(/^run subshells on this machine/i));
    await screen.findByRole("heading", { name: "Install tmux" });
    fireEvent.click(button("Install tmux"));
    await waitFor(() => expect(gate.callsTo("node_install_tmux").length).toBe(1));

    const allowed = new Set([
      "node_probe",
      "node_settings",
      "node_set_plane",
      "node_install_tmux",
      "node_pending_screen",
      "plugin:event|listen",
      "plugin:event|unlisten",
    ]);
    for (const call of gate.calls) expect(allowed.has(call.cmd)).toBe(true);
    for (const call of fake.calls) expect(allowed.has(call.cmd)).toBe(true);
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
    // The exact cadence is the freshness guarantee (operator ruling
    // 2026-09-22) and is pinned to the constant in `use-node-state.test.tsx`;
    // this is the coarser guard beside it.
    expect(PROBE_POLL_MS).toBeGreaterThanOrEqual(1_000);
    expect(SETTLE_DELAY_MS).toBeGreaterThanOrEqual(1_000);
    // A settle, never a poll: bounded to a couple of extra probes.
    expect(SETTLE_ATTEMPTS).toBeLessThanOrEqual(3);
  });

  it("does not poll while an action is in flight", async () => {
    const gate = deferred<{ ok: boolean; stdout: string; stderr: string }>();
    const fake = await boot({ probe: FRESH, handlers: { node_install_cli: () => gate.promise } });

    // The install offer is the Service section's now (operator ruling 2026-09-22).
    await openSection("Service");
    fireEvent.click(button("Install the Subshell Node CLI"));
    await waitFor(() => expect(button("Install the Subshell Node CLI").disabled).toBe(true));
    const during = fake.callsTo("node_probe").length;
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(fake.callsTo("node_probe").length).toBe(during);

    gate.resolve({ ok: true, stdout: "", stderr: "" });
    await waitFor(() => expect(button("Install the Subshell Node CLI").disabled).toBe(false));
  });
});

// ---------------------------------------------------------------------------
// The first run (spec 2026-09-18 § 9)
// ---------------------------------------------------------------------------

describe("the first run", () => {
  /** Untouched: nothing stored, no node, no node config. */
  const untouched = (over: Partial<ReturnType<typeof makeProbe>> = {}) =>
    makeProbe({ step: "no-node", nodeBinary: null, status: null, service: null, ...over });

  /**
   * A CONFIGURED client that is not a node: it has an address it watches and
   * no `config.json`. The status screen offers it "Register this machine",
   * which is the door the one-way-door case below is about.
   */
  const watcher = () =>
    makeProbe({
      step: "not-enrolled",
      status: { nodeId: null, serverUrl: null, online: false, agentVersion: "1.9.0" },
      service: { installed: false, definitionPath: null, state: "not-installed", paneSafety: null },
    });

  /** Walk Welcome -> Choice -> "Run subshells on this machine". */
  const chooseNode = () => {
    fireEvent.click(button("Continue"));
    fireEvent.click(button(/^run subshells on this machine/i));
  };

  // tmux is a hard gate rather than a caption: every subshell runs in a tmux
  // pane, `subshell enroll` preflights it BEFORE its network call precisely so
  // an unenrollable box does not burn a one-time setup key, and the screen has
  // no way past it — it leaves on its own when the probe finds one.
  it("routes the node path to tmux, with no way past it, until tmux exists", async () => {
    const fake = await boot({
      settings: makeSettings({ planeUrl: null }),
      probe: untouched({ tmux: null }),
      handlers: { node_install_tmux: () => ({ ok: true, stdout: "installed tmux", stderr: "" }) },
    });
    chooseNode();
    await waitFor(() => expect(screen.getByRole("heading", { name: "Install tmux" })).toBeTruthy());
    // Neither press exists here — not the one that leaves the details screen,
    // not the one that spends the key, and no skip either.
    expect(buttonOrNull("Register")).toBeNull();
    expect(buttonOrNull("Continue")).toBeNull();
    // The command a person can paste instead, because a package manager may
    // ask for a password this app has no terminal to answer.
    expect(screen.getByText(/brew install tmux|sudo apt-get install tmux/)).toBeTruthy();

    fake.setProbe(untouched());
    fireEvent.click(button("Install tmux"));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Register This Machine" })).toBeTruthy());
  });

  /** The node the control plane hands back, matching the probe's own id. */
  const ENROLLED_NODE = { nodeId: "11111111-2222-3333-4444-555555555555", name: "workstation" };
  const enrolledOk = {
    ok: true,
    stdout: "enrolled",
    stderr: "",
    node: ENROLLED_NODE,
    requiresConfirmation: false,
    confirmations: [],
  };

  /**
   * Walk to Register, fill it, and press through the start-up question.
   *
   * The two labels are the way round they are on purpose (2026-09-18): the
   * details screen COLLECTS and spends nothing, so it says **Continue**; the
   * start-up screen is where the press ACTS — install, enrol, service — so it
   * says **Register**. A button is named for what pressing it does.
   */
  const registerAs = async (server: string) => {
    chooseNode();
    await screen.findByRole("heading", { name: "Register This Machine" });
    typeInto("Server URL", server);
    typeInto("Setup key", GOOD_KEY);
    typeInto("Node name", "workstation");
    fireEvent.click(button("Continue"));
    await screen.findByRole("heading", { name: "How This Node Runs" });
    fireEvent.click(button("Register"));
    await screen.findByRole("heading", { name: "Setting Up…" });
  };

  const CHAIN = ["node_install_cli", "node_enroll", "node_service"];
  const chainOrder = (fake: FakeIpc) => fake.calls.filter((c) => CHAIN.includes(c.cmd)).map((c) => c.cmd);

  // Spec § 6: one press, three acts, in order — and § 6.2: the press IS the
  // consent, so no confirmation panel stands between it and the spent key.
  //
  // Modelled as the Rust side really behaves on an untouched machine:
  // `confirmations_for` raises NOTHING without a `config.json`, so the
  // unconfirmed call enrols on the spot. That is what makes one press honest
  // here — not a `confirm: true` that would also skip the guard below.
  it("registers in one press: install, enrol, then the service", async () => {
    const fake = await boot({
      settings: makeSettings({ planeUrl: null }),
      probe: untouched(),
      handlers: {
        node_install_cli: () => ({ ok: true, stdout: "Installed subshell 1.9.0.", stderr: "" }),
        node_enroll: () => enrolledOk,
        node_service: () => ({ ok: true, stdout: "installed the service", stderr: "" }),
      },
    });

    await registerAs("https://subshell.example.com");
    await waitFor(() => expect(fake.callsTo("node_service").length).toBe(1), { timeout: 5_000 });
    // The daemon takes its lock a beat after the manager returns; the chain
    // settles for it, which is why the checklist can end on "done".
    fake.setProbe(makeProbe());

    expect(chainOrder(fake)).toEqual(CHAIN);
    // ONE call, and it is the unconfirmed one: nothing asked, so nothing to
    // ask the person about, and the key was spent on that same call.
    expect(fake.callsTo("node_enroll")).toEqual([
      { server: "https://subshell.example.com", key: GOOD_KEY, name: "workstation", confirm: false },
    ]);
    expect(confirmPanelOrNull()).toBeNull();
    // And the answer the previous screen collected rode the act it belongs to.
    expect(fake.callsTo("node_service")[0]).toEqual({ verb: "install", force: false, autostart: true });

    // The completed checklist HOLDS, unlike the sibling app's zero-touch
    // auto-open: a chain a person just started is owed the beat that answers
    // "what did that just do".
    await waitFor(
      () => {
        expect(buttonOrNull("Continue")?.disabled).toBe(false);
      },
      { timeout: 8_000 },
    );
    expect(screen.getByRole("heading", { name: "Setting Up…" })).toBeTruthy();
    fireEvent.click(button("Continue"));
    // The walk ends on the landing, Control Plane now.
    await waitFor(() => expect(screen.getByRole("heading", { name: "Control Plane" })).toBeTruthy());
  });

  // THE safety property of this chain, and what it costs to lose.
  //
  // A machine reaches Register with a live `config.json` more easily than it
  // looks: `no-node` is the probe's answer for a missing binary AND for one
  // that cannot answer `status --json`, so a machine whose agent was deleted
  // still has its node id, its `serverUrl` and the ONLY copy of its node key
  // in that file. Enrolling over it mints a SECOND node row on the control
  // plane and discards that key — the old row stays behind, permanently
  // offline, to be deleted by hand.
  //
  // Rust raises `already-enrolled` for exactly that machine (it reads
  // `config.json` directly, not the agent), and a blanket `confirm: true`
  // would skip the guard. So the chain STOPS here and asks.
  it("stops the chain rather than enrol over a machine that is already registered", async () => {
    const ALREADY = "This machine is already enrolled as node node-abc on https://old.example.";
    const fake = await boot({
      settings: makeSettings({ planeUrl: null }),
      probe: untouched(),
      handlers: {
        node_install_cli: () => ({ ok: true, stdout: "Installed subshell 1.9.0.", stderr: "" }),
        node_enroll: (args) =>
          args.confirm === true
            ? enrolledOk
            : {
                ok: false,
                stdout: "",
                stderr: "",
                node: null,
                requiresConfirmation: true,
                confirmations: [{ kind: "already-enrolled", message: ALREADY }],
              },
        node_service: () => ({ ok: true, stdout: "installed the service", stderr: "" }),
      },
    });

    await registerAs("https://subshell.example.com");

    // Phase one: the reason on screen, and the chain halted BEFORE the act
    // that cannot be undone. Nothing was spawned and no key was spent — the
    // one call that went out is the unconfirmed one.
    await waitFor(() => expect(confirmPanelOrNull()).not.toBeNull());
    expect(confirmPanel().getByText(ALREADY)).toBeTruthy();
    expect(fake.callsTo("node_enroll")).toEqual([
      { server: "https://subshell.example.com", key: GOOD_KEY, name: "workstation", confirm: false },
    ]);
    expect(fake.callsTo("node_service")).toEqual([]);
    // The checklist says WHERE it stopped, rather than looking like a hang.
    expect(screen.getByRole("heading", { name: "Setting Up…" })).toBeTruthy();

    // Phase two: an explicit acceptance, and only then the identical
    // arguments plus `confirm: true` — the chain picks up where it stopped.
    fireEvent.click(confirmPanel().getByRole("button", { name: "Register anyway" }));
    await waitFor(() => expect(fake.callsTo("node_enroll").length).toBe(2), { timeout: 5_000 });
    const [first, second] = fake.callsTo("node_enroll");
    expect(second).toEqual({ ...first, confirm: true });
    await waitFor(() => expect(fake.callsTo("node_service").length).toBe(1), { timeout: 5_000 });
    fake.setProbe(makeProbe());
    expect(fake.callsTo("node_service")[0]).toEqual({ verb: "install", force: false, autostart: true });
  });

  // The deliberate asymmetry beside it. A loopback server is ADVISORY — the
  // node will look for a control plane on its own machine, which is right
  // whenever the plane runs here — and `EnrollFields` already prints that
  // sentence live under the URL as it is typed. Stopping the press to say it
  // a second time is the nag this flow set out to remove, so the chain
  // proceeds. It is `already-enrolled` that is destructive, not every
  // confirmation.
  it("does not stop for a loopback address, which the field already warned about", async () => {
    const fake = await boot({
      settings: makeSettings({ planeUrl: null }),
      probe: untouched(),
      handlers: {
        node_install_cli: () => ({ ok: true, stdout: "Installed subshell 1.9.0.", stderr: "" }),
        node_enroll: (args) =>
          args.confirm === true
            ? enrolledOk
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
        node_service: () => ({ ok: true, stdout: "installed the service", stderr: "" }),
      },
    });

    await registerAs("http://localhost:3080");
    await waitFor(() => expect(fake.callsTo("node_service").length).toBe(1), { timeout: 5_000 });
    fake.setProbe(makeProbe());

    expect(confirmPanelOrNull()).toBeNull();
    // The same three acts in the same order, with enrol taking TWO calls —
    // the unconfirmed one that surfaces the advisory, then the confirmed one
    // the chain proceeds with on its own. That second call is the difference
    // from the `already-enrolled` case above, where it waits for a press.
    expect(chainOrder(fake)).toEqual(["node_install_cli", "node_enroll", "node_enroll", "node_service"]);
    expect(fake.callsTo("node_enroll").map((a) => a.confirm)).toEqual([false, true]);
  });

  // 1. The press that goes nowhere, and why it was worse than a refusal.
  //
  // The Register button is gated only on the three fields being NON-EMPTY, so
  // `https//typo` and a truncated key both reach the press — but
  // `validateEnroll` wants a parseable http(s) URL with a host and `nsk_` plus
  // 32 characters. The chain used to be the only validator, which meant the
  // page had already stepped to start-up and then to the checklist by the time
  // the refusals were written to the form: the per-field errors rendered on a
  // screen nobody was looking at, and what the person saw was a checklist with
  // no row moving and NO button at all, since `barRight` appears only on
  // `failed` or `done`. The screen that owns the fields validates them.
  it("refuses a malformed URL or key on the screen that owns the fields", async () => {
    const fake = await boot({ settings: makeSettings({ planeUrl: null }), probe: untouched() });
    chooseNode();
    await screen.findByRole("heading", { name: "Register This Machine" });
    typeInto("Server URL", "https//typo");
    typeInto("Setup key", "nsk_short");
    typeInto("Node name", "workstation");
    fireEvent.click(button("Continue"));

    // Still here, with the refusals beside the fields they are about.
    expect(screen.getByRole("heading", { name: "Register This Machine" })).toBeTruthy();
    expect(screen.getByText(/Include the scheme/)).toBeTruthy();
    expect(screen.getByText(/partial paste/)).toBeTruthy();
    // Not one screen further on, which is where those sentences used to land.
    expect(screen.queryByRole("heading", { name: "How This Node Runs" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Setting Up…" })).toBeNull();
    // And nothing ran: no agent installed, no key spent, no service written.
    expect(fake.callsTo("node_install_cli")).toEqual([]);
    expect(fake.callsTo("node_enroll")).toEqual([]);
    expect(fake.callsTo("node_service")).toEqual([]);
  });

  // 2. The way back, and the reason Retry alone could never be it.
  //
  // An enrolment that reached the control plane spends the setup key WHATEVER
  // it answered, so `clearSpentKey` empties that field — and a Retry with an
  // empty key is refused by `validateEnroll` before it spawns anything. Retry
  // was therefore a button that could not converge: press it forever and the
  // checklist never moves. Editing the details is the only remedy, which is
  // what the operator asked for.
  it("offers a way back to the details after a failed enrolment, key cleared", async () => {
    const TAKEN = "subshell: that node name is already taken on this server — mint a new key and try again";
    await boot({
      settings: makeSettings({ planeUrl: null }),
      probe: untouched(),
      handlers: {
        node_install_cli: () => ({ ok: true, stdout: "Installed subshell 1.9.0.", stderr: "" }),
        node_enroll: () => ({
          ok: false,
          stdout: "",
          stderr: TAKEN,
          node: null,
          requiresConfirmation: false,
          confirmations: [],
        }),
      },
    });

    await registerAs("https://subshell.example.com");
    await waitFor(() => expect(buttonOrNull("Edit details")).not.toBeNull());
    // Beside Retry, not instead of it: a fresh key in the same fields is the
    // other half of the answer, and the CLI's own words say which it is.
    expect(buttonOrNull("Retry")).not.toBeNull();
    expect(screen.getByText(TAKEN)).toBeTruthy();

    fireEvent.click(button("Edit details"));
    await screen.findByRole("heading", { name: "Register This Machine" });
    // What the operator typed survives; only the credential that was spent is
    // gone, because that is the one field a retry has to change.
    expect((screen.getByLabelText("Server URL") as HTMLInputElement).value).toBe("https://subshell.example.com");
    expect((screen.getByLabelText("Node name") as HTMLInputElement).value).toBe("workstation");
    expect((screen.getByLabelText("Setup key") as HTMLInputElement).value).toBe("");
  });

  // 3. …and the way back is WITHHELD once the machine is a node.
  //
  // Only the service act can fail after enrolment landed, and the details are
  // spent by then: going back to them would invite a second enrolment, which
  // mints another node row and discards the key this run just stored. Retry is
  // the whole remedy here, and it is enough — the service act is repeatable.
  it("offers no way back to the details once the enrolment has landed", async () => {
    await boot({
      settings: makeSettings({ planeUrl: null }),
      probe: untouched(),
      handlers: {
        node_install_cli: () => ({ ok: true, stdout: "Installed subshell 1.9.0.", stderr: "" }),
        node_enroll: () => enrolledOk,
        node_service: () => ({ ok: false, stdout: "", stderr: "Failed to start subshell.service" }),
      },
    });

    await registerAs("https://subshell.example.com");
    await waitFor(() => expect(buttonOrNull("Retry")).not.toBeNull());
    expect(screen.getByText(/Failed to start subshell.service/)).toBeTruthy();
    expect(buttonOrNull("Edit details")).toBeNull();
  });

  // The FIRST attempt passes through the same gate a Retry never did.
  //
  // `runRegister` fires the chain synchronously while `setStep` is still
  // queued, so at the press the screen ref the output tag reads said
  // "startup" — a chain tagged to the question the person answered one
  // render ago, which loses the gated failure sentence on the progress
  // shell exactly when there is no Retry history to fall back on. (The
  // words themselves always rendered: the checklist's failure block reads
  // the raw output. This pins the sentence, which is the gated half.)
  it("tags a first-attempt failure to the progress screen the chain runs on", async () => {
    await boot({
      settings: makeSettings({ planeUrl: null }),
      probe: untouched(),
      handlers: {
        node_install_cli: () => ({ ok: false, stdout: "", stderr: "brew refused to run" }),
      },
    });

    await registerAs("https://subshell.example.com");
    await waitFor(() => expect(screen.getByText("That did not work. See the output below.")).toBeTruthy());
    expect(screen.getByRole("heading", { name: "Setting Up…" })).toBeTruthy();
    // And beside the sentence, the raw half the gate never held: the act's
    // own last words, on the same screen.
    expect(screen.getByText("brew refused to run")).toBeTruthy();
  });

  // 4. The Retry that must not re-enrol.
  //
  // A Retry after the SERVICE act failed arrives with the machine ALREADY
  // registered — enrol succeeded, the row exists, the node key is on disk. The
  // chain used to start from the top, so that second press enrolled again:
  // another node row on the control plane, the first left behind permanently
  // offline, and the only copy of the node key this run had just stored
  // discarded. `register()` returns straight to the service act when the probe
  // reports a `nodeId`, which is what makes the chain resumable rather than
  // destructive on its second press.
  it("resumes at the service act on retry, rather than enrolling a second time", async () => {
    let fake!: FakeIpc;
    let starts = 0;
    fake = await boot({
      settings: makeSettings({ planeUrl: null }),
      probe: untouched(),
      handlers: {
        node_install_cli: () => ({ ok: true, stdout: "Installed subshell 1.9.0.", stderr: "" }),
        node_enroll: () => {
          // The machine really is a node from here on, so the probe says so —
          // which is the fact the resume reads, and the reason this is not a
          // contrivance: the run's own re-probe is what delivers it.
          fake.setProbe(makeProbe());
          return enrolledOk;
        },
        node_service: () => {
          starts += 1;
          return starts === 1
            ? { ok: false, stdout: "", stderr: "Failed to start subshell.service" }
            : { ok: true, stdout: "installed the service", stderr: "" };
        },
      },
    });

    await registerAs("https://subshell.example.com");
    await waitFor(() => expect(buttonOrNull("Retry")?.disabled).toBe(false), { timeout: 5_000 });
    expect(fake.callsTo("node_enroll").length).toBe(1);

    fireEvent.click(button("Retry"));
    await waitFor(() => expect(fake.callsTo("node_service").length).toBe(2), { timeout: 5_000 });
    // The act that spends a key and rewrites `config.json` ran ONCE across
    // both presses. Not "once more with confirm" — not at all.
    expect(fake.callsTo("node_enroll").length).toBe(1);
    // And the resumed run finishes, so the checklist reaches its handoff
    // rather than stranding a machine that is one act from working.
    await waitFor(() => expect(buttonOrNull("Continue")?.disabled).toBe(false), { timeout: 8_000 });
  });

  // The walk had no way out at all: `barLeft` existed only on the progress
  // screen, so tmux, the details form and the start-up question each had a
  // single forward press and nothing that cleared `step`. That made the Choice
  // screen's own promise false — "whichever you pick, the other is still
  // available afterwards" (subtitles.ts) — from the moment you picked.
  it("lets a fresh machine back out of the node path to the choice", async () => {
    const fake = await boot({ settings: makeSettings({ planeUrl: null }), probe: untouched() });
    chooseNode();
    await screen.findByRole("heading", { name: "Register This Machine" });

    fireEvent.click(button("Back"));
    await waitFor(() => expect(screen.getByRole("heading", { name: "What Would You Like to Do?" })).toBeTruthy());
    // Both answers offered again, which is what the promise said.
    expect(buttonOrNull(/^run subshells on this machine/i)).not.toBeNull();
    expect(buttonOrNull(/^connect to a server/i)).not.toBeNull();
    // And leaving touched nothing: no agent, no key, no service.
    expect(fake.callsTo("node_install_cli")).toEqual([]);
    expect(fake.callsTo("node_enroll")).toEqual([]);
    expect(fake.callsTo("node_service")).toEqual([]);
    expect(fake.callsTo("node_set_plane")).toEqual([]);
  });

  // THE one-way door, and the case a person actually hits.
  //
  // A configured client — someone already watching a server — presses
  // "Register this machine" on the status screen, which sets the walk's step.
  // Back has to return them to the LANDING, not to Choice: Choice is a screen
  // that person never saw, and before this the status screen's own button was
  // a door out of the dashboard for the rest of the session.
  it("returns a configured client to its landing screen, not to a choice it never saw", async () => {
    await boot({ probe: watcher() });
    // Register lives on the Service section (operator ruling 2026-09-22,
    // screenshot 60); the landing is Control Plane.
    await openSection("Service");
    expect(screen.getByRole("heading", { name: "Service" })).toBeTruthy();
    fireEvent.click(button("Register this machine"));
    await screen.findByRole("heading", { name: "Register This Machine" });

    fireEvent.click(button("Back"));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Control Plane" })).toBeTruthy());
    // The door they came for is back, which is the whole of the defect: the
    // landing, now Control Plane, whose Dashboard card carries the doors.
    expect(buttonOrNull("Open in app")).not.toBeNull();
    // And NOT the fresh machine's answer: this person never chose anything.
    expect(screen.queryByRole("heading", { name: "What Would You Like to Do?" })).toBeNull();
    // The invitation is still there to accept a second time, on the Service
    // section where it lives: a door that closes behind you is the thing
    // being fixed.
    await openSection("Service");
    expect(buttonOrNull("Register this machine")).not.toBeNull();
  });

  // The last screen before a single-use key is spent, so the way back to the
  // address that key is for matters most here.
  it("goes back from the start-up question to the details, still filled in", async () => {
    await boot({ settings: makeSettings({ planeUrl: null }), probe: untouched() });
    chooseNode();
    await screen.findByRole("heading", { name: "Register This Machine" });
    typeInto("Server URL", "https://subshell.example.com");
    typeInto("Setup key", GOOD_KEY);
    typeInto("Node name", "workstation");
    fireEvent.click(button("Continue"));
    await screen.findByRole("heading", { name: "How This Node Runs" });

    fireEvent.click(button("Back"));
    await screen.findByRole("heading", { name: "Register This Machine" });
    // The answers survive, because the form's values live in the page rather
    // than in the DOM — which is the point of going back at all: correcting
    // one character of an address, not retyping three fields.
    expect((screen.getByLabelText("Server URL") as HTMLInputElement).value).toBe("https://subshell.example.com");
    expect((screen.getByLabelText("Node name") as HTMLInputElement).value).toBe("workstation");
    expect((screen.getByLabelText("Setup key") as HTMLInputElement).value).toBe(GOOD_KEY);
  });

  // The gate needs the exit most of all: tmux is required to register, so a
  // machine where it never appears parks a person here with nothing but
  // quitting the app. Back is not a way THROUGH the gate — it answers "not
  // this machine, not now", which is a different sentence from "register me
  // without tmux" — so it leaves the walk and changes nothing.
  it("lets a fresh machine leave the tmux gate for the choice", async () => {
    const fake = await boot({ settings: makeSettings({ planeUrl: null }), probe: untouched({ tmux: null }) });
    chooseNode();
    await screen.findByRole("heading", { name: "Install tmux" });

    fireEvent.click(button("Back"));
    await waitFor(() => expect(screen.getByRole("heading", { name: "What Would You Like to Do?" })).toBeTruthy());
    expect(fake.callsTo("node_install_tmux")).toEqual([]);
    expect(fake.callsTo("node_enroll")).toEqual([]);
  });

  // Same asymmetry as the details screen's: a configured client reached the
  // gate from "Register this machine" and never saw Choice, so Back owes them
  // the landing they came from — with the dashboard button on it.
  it("returns a configured client from the tmux gate to its landing screen", async () => {
    await boot({ probe: makeProbe({ ...watcher(), tmux: null }) });
    await openSection("Service");
    fireEvent.click(button("Register this machine"));
    await screen.findByRole("heading", { name: "Install tmux" });

    fireEvent.click(button("Back"));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Control Plane" })).toBeTruthy());
    expect(buttonOrNull("Open in app")).not.toBeNull();
    expect(screen.queryByRole("heading", { name: "What Would You Like to Do?" })).toBeNull();
  });

  // The case the screen's Back exists FOR, and the one place the host can
  // quietly undo it.
  //
  // `tmux-screen.tsx` keeps this button live while the install runs — alone
  // among bottom-bar controls in this app — and says why at the point it draws
  // it: leaving changes nothing (the install runs in Rust and finishes either
  // way, and the next probe sees the tmux it produced), and a screen whose
  // whole complaint is "there is no way out of this wait" cannot take its way
  // out away for the length of it. A `brew install` is a minute or more.
  //
  // That only holds if the HOST honours the press. A live button whose handler
  // returns silently is worse than a disabled one: a disabled button says "not
  // now", and this would say nothing at all — which is the dead end the whole
  // screen was rebuilt to remove.
  it("lets a person leave while the install is still running", async () => {
    const gate = deferred<{ ok: boolean; stdout: string; stderr: string }>();
    const fake = await boot({
      settings: makeSettings({ planeUrl: null }),
      probe: untouched({ tmux: null }),
      handlers: { node_install_tmux: () => gate.promise },
    });
    chooseNode();
    await screen.findByRole("heading", { name: "Install tmux" });

    fireEvent.click(button("Install tmux"));
    await waitFor(() => expect(fake.callsTo("node_install_tmux").length).toBe(1));
    // Live, which is the component's own deliberate divergence.
    const back = button("Back");
    expect(back.disabled).toBe(false);

    fireEvent.click(back);
    await waitFor(() => expect(screen.getByRole("heading", { name: "What Would You Like to Do?" })).toBeTruthy());
    // The install was not cancelled by leaving — it is Rust's, and it finishes.
    expect(fake.callsTo("node_install_tmux").length).toBe(1);
    gate.resolve({ ok: true, stdout: "installed tmux", stderr: "" });
  });

  /**
   * The operator's own requirement, verbatim: "retry would also check for the
   * presence of the install" (2026-09-18).
   *
   * It is the line most likely to be silently reverted by a later refactor —
   * dropping the pre-probe leaves a button that still works, just wastefully
   * and against the point — and it is untestable on Subshell Server, whose
   * assistant has no DOM harness. Here it is one end-to-end press, so this is
   * the only pin the requirement gets in either app.
   *
   * It covers the screen's self-exit in the same breath: the tmux screen has
   * no Continue by design and leaves when the poll (or this probe) sees a
   * tmux, so "installed nothing" and "left anyway" are the same assertion.
   */
  it("re-reads the machine before installing, and installs nothing when tmux turned up", async () => {
    const fake = await boot({
      settings: makeSettings({ planeUrl: null }),
      probe: untouched({ tmux: null }),
    });
    chooseNode();
    await screen.findByRole("heading", { name: "Install tmux" });

    // Someone went to a terminal and installed it themselves. The poll cannot
    // have noticed — it is paused while an action is in flight and resumes
    // only after one — so the press is what asks.
    fake.setProbe(untouched({ tmux: "/opt/homebrew/bin/tmux" }));
    fireEvent.click(button("Install tmux"));

    await waitFor(() => expect(screen.queryByRole("heading", { name: "Install tmux" })).toBeNull());
    expect(fake.callsTo("node_install_tmux")).toEqual([]);
  });

  // The other answer, and the rule the whole flow exists for: the watch path
  // touches nothing on this machine and opens no dashboard.
  it("takes the watch path without installing, enrolling or opening anything", async () => {
    const fake = await boot({
      settings: makeSettings({ planeUrl: null }),
      probe: untouched(),
      handlers: { node_set_plane: (args) => String(args.url) },
    });
    fireEvent.click(button("Continue"));
    fireEvent.click(button(/^connect to a server/i));
    await screen.findByRole("heading", { name: "Connect to a Server" });
    typeInto("Server URL", "https://watch.example");
    fireEvent.click(button("Connect"));

    await waitFor(() => expect(fake.callsTo("node_set_plane")).toEqual([{ url: "https://watch.example" }]));
    // Nothing else was asked for. Every one of these is unstubbed, so a call
    // would have rejected loudly; the assertions say which absences matter.
    expect(fake.callsTo("node_install_cli")).toEqual([]);
    expect(fake.callsTo("node_enroll")).toEqual([]);
    expect(fake.callsTo("node_service")).toEqual([]);
    expect(fake.callsTo("node_open_plane")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The screens a machine walks
// ---------------------------------------------------------------------------

describe("the screens", () => {
  // The install screen's whole reason for existing, carried onto the status
  // screen as two cards: `no-node` covers two very different machines and the
  // split between them decides what may be offered at all. What the screen
  // looks like changed; the split did not.
  it("offers the install only when nothing answered at all", async () => {
    // The install offer is the Service section's now (operator ruling
    // 2026-09-22); its explainer is the trimmed one, and the "what is a node"
    // half is the section's own subtitle.
    await boot({ probe: makeProbe({ step: "no-node", nodeBinary: null, status: null, service: null }) });
    await openSection("Service");
    expect(buttonOrNull("Install the Subshell Node CLI")).not.toBeNull();
    // The explainer is deleted (operator ruling 2026-09-22, second addendum):
    // the button speaks for itself.
    expect(screen.queryByText(/This copies the node this app ships/)).toBeNull();
    // And registering is NOT offered beside it. A machine with no agent cannot
    // say whether it is already a node, and Register's chain enrols with
    // `confirm: true` — so the install comes first and the probe that follows
    // is what decides whether Register appears at all.
    expect(buttonOrNull("Register this machine")).toBeNull();
    cleanup();
    ipc?.restore();

    // An agent that answered `version` but not `status --json`: enrolling here
    // would overwrite a live config and discard its node key.
    await boot({ probe: makeProbe({ step: "no-node", status: null }) });
    await openSection("Service");
    expect(buttonOrNull("Install the Subshell Node CLI")).toBeNull();
    expect(buttonOrNull("Register this machine")).toBeNull();
    expect(buttonOrNull("Enroll")).toBeNull();
    // There is no re-read button on this state (operator ruling 2026-09-22):
    // the probe's own interval re-reads the machine, which is what makes the
    // state live. The wiring is pinned in `use-node-state.test.tsx`.
    expect(buttonOrNull("Refresh")).toBeNull();
    expect(screen.getByText(/cannot say whether it is already a node/)).toBeTruthy();
  });

  it("settles after a start rather than reporting the service still stopped", async () => {
    const fake = await boot({
      probe: STOPPED,
      handlers: { node_service: () => ({ ok: true, stdout: "subshell started.", stderr: "" }) },
    });

    // The daemon takes the lock a beat after the manager returns.
    fake.setProbe(makeProbe());
    // The service verb is the Service section's now.
    await openSection("Service");
    fireEvent.click(button("Start"));

    // The heading is the same before and after now (one landing for every
    // state), so what says the settle worked is the state itself: the badge
    // flips to Online and the verb that was offered is gone. Reporting the
    // machine as still stopped is what this guards against, and that is
    // exactly what a lingering Start would be.
    await waitFor(() => expect(screen.getByText("Online")).toBeTruthy(), {
      timeout: SETTLE_DELAY_MS * (SETTLE_ATTEMPTS + 1),
    });
    expect(buttonOrNull("Start")).toBeNull();
    expect(fake.callsTo("node_service")).toEqual([{ verb: "start", force: false }]);
  });

  // A step this build predates lands on the screen that shows the facts and
  // the last output, which are what make an unrecognised state diagnosable —
  // `status` now, where the sentence is the screen's own card rather than the
  // service screen's subtitle, and where nothing that spends anything is
  // offered over a state the app cannot read.
  it("says it does not recognise a step this build predates", async () => {
    await boot({ probe: makeProbe({ step: "quantum-superposition" as never }) });
    // The unrecognised-state card is the Service section's now.
    await openSection("Service");
    expect(screen.getByText(/does not recognise the state "quantum-superposition"/)).toBeTruthy();
    expect(screen.getByText(/older than the node CLI it is managing/)).toBeTruthy();
    expect(screen.getByText("Unknown")).toBeTruthy();
    // No refresh affordance over an unreadable state either: the poll is the
    // re-read (operator ruling 2026-09-22).
    expect(buttonOrNull("Refresh")).toBeNull();
    // And no facts list here: the facts are Status's alone (operator ruling
    // 2026-09-22, screenshot 60); the card's own sentence is the explanation.
    expect(screen.queryByText("Show Details")).toBeNull();
    expect(screen.queryByText("/usr/bin/tmux")).toBeNull();
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
    // A configured client lands on `status` whatever the probe did, and the
    // window does not strand: the probe's own interval keeps re-reading the
    // failed command (the poll is the refresh, operator ruling 2026-09-22;
    // the wiring is pinned in `use-node-state.test.tsx`). And nothing that
    // could spend a key is drawn over a machine this app failed to read at
    // all.
    expect(buttonOrNull("Refresh")).toBeNull();
    expect(buttonOrNull("Register this machine")).toBeNull();
  });
});

describe("the facts", () => {
  // INLINE on the status screen (operator ruling 2026-09-22), and the list is
  // STATUS's ALONE (same day, screenshot 60, superseding the screenshot-52
  // scoping): one list, one panel, bundled and tmux included. No other
  // screen renders it.
  it("names the machine on Status, with the full list", async () => {
    await boot();
    // The landing is Control Plane; the facts list is Status's.
    await openSection("Status");
    expect(screen.getByText("/home/u/.config/subshell/config.json")).toBeTruthy();
    expect(screen.getAllByText(/https:\/\/subshell\.example\.com/).length).toBeGreaterThan(0);
    expect(screen.getByText(/online \(last heartbeat 4s ago\)/)).toBeTruthy();
    expect(screen.getByText("/usr/bin/tmux")).toBeTruthy();
    // And nowhere else: the Service section renders no facts list.
    await openSection("Service");
    expect(screen.queryByText("/usr/bin/tmux")).toBeNull();
    expect(screen.queryByText("node binary")).toBeNull();
  });

  it("shouts when tmux is missing, because a node without it refuses every launch", async () => {
    await boot({ probe: makeProbe({ tmux: null }) });
    // The refusal sentence is the facts list's row, on Status (the landing
    // is Control Plane).
    await openSection("Status");
    expect(screen.getByText(/NOT FOUND: enroll refuses/)).toBeTruthy();
  });

  it("shows the node name only when this session chose it", async () => {
    // Reached through Re-enroll… rather than through the probe's own enroll
    // landing, which is gone. The property is untouched: the name is a fact
    // only when THIS session's `enroll --json` returned it for the node the
    // probe is reporting, because `status --json` names no node and
    // `config.json`'s name is not among the facts Rust hands out.
    const fake = await openReenroll({
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
    fireEvent.click(button("Enroll"));
    await waitFor(() => expect(fake.callsTo("node_enroll").length).toBe(1));

    // Twice over, and both are the same fact: the status screen greets the
    // machine by name, and the facts list carries it beside the node id. The
    // enroll success closes the override onto the landing, Control Plane,
    // whose facts carry no name (enrolledNode is the status screen's to
    // show), so the greeting is read on Status, raised by its own select.
    await openSection("Status");
    await waitFor(() => expect(screen.getAllByText(/workstation/).length).toBeGreaterThan(0));
    expect(screen.getByText(/Enrolled as/)).toBeTruthy();
  });
});

describe("tmux is a hard stop, not a hint", () => {
  // The CLI refuses (or degrades far from the cause), and a live button that
  // only produces that outcome trains the user to click through warnings. The
  // buttons that DO work without tmux — the reveals — must stay live;
  // disabling those strands the box.
  it("disables what cannot work without tmux, and nothing else", async () => {
    await boot({ probe: makeProbe({ ...STOPPED, tmux: null }) });
    // The verb and the reveals are the Service section's now.
    await openSection("Service");
    expect(button("Start").disabled).toBe(true);
    expect(button("Open the node log").disabled).toBe(false);
    expect(button("Reveal configuration").disabled).toBe(false);
    // The hint names the install command, so the refusal is one step from action.
    expect(screen.getByText(/brew install tmux|sudo apt-get install tmux/)).toBeTruthy();
  });

  it("re-enables on the probe that finds tmux — the gate is not remembered", async () => {
    const fake = await boot({ probe: makeProbe({ ...STOPPED, tmux: null }) });
    await openSection("Service");
    expect(button("Start").disabled).toBe(true);
    fake.setProbe(STOPPED);
    // No Refresh button drives the re-read any more (operator ruling
    // 2026-09-22); the poll is the refresh, and the test asks the cache for
    // the same re-read the interval performs rather than sleeping out the
    // cadence. The gate reads the LIVE probe, so any re-read re-decides it.
    await fake.client.refetchQueries({ queryKey: PROBE_KEY });
    await waitFor(() => expect(button("Start").disabled).toBe(false));
  });

  // There are two doors to the act that spends a key now, so the gate is
  // asserted on both. The Register screen is where a half-built machine
  // resumes (spec § 5.5) and the re-enrol screen is what a working node asks
  // for; neither may offer a live button, because `subshell enroll` refuses
  // before its network call and a button that only ever produces that refusal
  // teaches people to click through warnings. (The first-run walk never even
  // reaches Register without tmux — it routes to the tmux screen, which the
  // first-run block below pins.)
  it("gates enrolment too — enroll preflights tmux before spending the key", async () => {
    await boot({
      settings: makeSettings({ planeUrl: null }),
      probe: makeProbe({
        step: "not-enrolled",
        tmux: null,
        status: { nodeId: null, online: false, reason: "no config" },
      }),
    });
    expect(screen.getByRole("heading", { name: "Register This Machine" })).toBeTruthy();
    expect(button("Continue").disabled).toBe(true);
    expect(screen.getByText(/so enrolling is disabled/)).toBeTruthy();
    cleanup();
    ipc?.restore();

    await boot({ probe: makeProbe({ tmux: null }) });
    await openSection("Control Plane");
    fireEvent.click(button("Re-enroll…"));
    await screen.findByRole("heading", { name: "Enroll This Machine" });
    expect(button("Enroll").disabled).toBe(true);
    expect(screen.getByText(/so enrolling is disabled/)).toBeTruthy();
  });

  it("the install button says it also starts, because the CLI's install does", async () => {
    await boot({
      probe: makeProbe({ ...STOPPED, step: "no-service", service: { installed: false } }),
    });
    await openSection("Service");
    expect(button("Install and Start")).toBeTruthy();
  });
});

describe("the plane's two doors", () => {
  // Both doors for the plane live here (operator ruling 2026-09-22). The
  // in-app window was the status screen's "Open Dashboard"; the system
  // browser was "Open in browser instead". Each opens the SAME settled
  // address, and neither takes a URL argument by design.
  it("opens the settled plane URL in the system browser", async () => {
    const fake = await boot({ handlers: { node_open_plane_url: () => null } });
    await openSection("Control Plane");
    fireEvent.click(button("Open in browser"));
    await waitFor(() => expect(fake.callsTo("node_open_plane_url")).toEqual([{}]));
    // And it asked for NOTHING but the intent — no URL crossed the boundary.
    expect(fake.callsTo("node_open_plane_url")[0]).toEqual({});
    // No receipt either (operator ruling 2026-09-22): the browser opening
    // is the feedback.
    expect(screen.queryByText(/Opened\b|Using\b/)).toBeNull();
  });

  it("rejection reaches the problem line, like every command", async () => {
    await boot({
      handlers: {
        node_open_plane_url: () => {
          throw "no control plane yet — enter its URL, or enrol this machine first";
        },
      },
    });
    await openSection("Control Plane");
    fireEvent.click(button("Open in browser"));
    await waitFor(() =>
      expect(screen.getByText("no control plane yet — enter its URL, or enrol this machine first")).toBeTruthy(),
    );
  });

  it("lands the in-app door's refusal on the problem line, like the browser door", async () => {
    // Mirror of the browser door's pin below: "Open in app" with nothing
    // configured is refused BY the Rust side, and its sentence is the
    // problem line (delta review m-2).
    await boot({
      handlers: {
        node_open_plane: () => {
          throw "no control plane yet — enter its URL, or enrol this machine first";
        },
      },
    });
    await openSection("Control Plane");
    fireEvent.click(button("Open in app"));
    await waitFor(() =>
      expect(screen.getByText("no control plane yet — enter its URL, or enrol this machine first")).toBeTruthy(),
    );
  });

  it("opens the app window at the settled address, the door the Dashboard card carries", async () => {
    // The in-app window door IS `node_open_plane` with no URL: the Rust side
    // re-reads its own ladder, which is how "Open Dashboard" always worked.
    // "Open in app" is its name under the Dashboard card (operator ruling
    // 2026-09-22, second addendum).
    const fake = await boot({ handlers: { node_open_plane: (args) => String(args.url) } });
    await openSection("Control Plane");
    fireEvent.click(button("Open in app"));
    await waitFor(() => expect(fake.callsTo("node_open_plane")).toEqual([{ url: null }]));
    // An OPEN records NO receipt (operator ruling 2026-09-22): the window
    // opening is the feedback, so no "Opened <url>" line renders anywhere.
    expect(screen.queryByText(/Opened\b|Using\b/)).toBeNull();
  });

  // Was "opens the app window at the address the connect screen was given",
  // and the connect screen deliberately no longer does that (spec § 1): its
  // one button called `node_open_plane`, which persists AND opens, so pressing
  // it on a fresh install threw the server's dashboard in front of the setup
  // still running behind it. `connectOnly` is the persisting half alone.
  it("remembers the address the connect screen was given, and opens nothing", async () => {
    const fake = await boot({
      settings: makeSettings({ planeUrl: null }),
      probe: FRESH,
      handlers: { node_set_plane: (args) => String(args.url) },
    });
    fireEvent.click(button("Continue"));
    fireEvent.click(button(/^connect to a server/i));
    await screen.findByRole("heading", { name: "Connect to a Server" });
    typeInto("Server URL", "https://plane.example");
    fireEvent.click(button("Connect"));

    await waitFor(() => expect(fake.callsTo("node_set_plane")).toEqual([{ url: "https://plane.example" }]));
    // And no window opened. `node_open_plane` is deliberately unstubbed here,
    // so a call would have rejected loudly rather than passing unnoticed.
    expect(fake.callsTo("node_open_plane")).toEqual([]);
  });

  // The `openPlane` door itself survives, on the screen of a client that is
  // already set up: there, pressing it IS the request to see that dashboard.
  it("saves the address WITHOUT opening anything, under the label Change", async () => {
    // Operator ruling 2026-09-22, addendum 6: the submit persists the
    // address and opens NOTHING — the Dashboard card's two doors are the
    // explicit opens. The save rides node_set_plane (the persist-only
    // command), so the boundary sees no open call from it, and the field
    // label is the addendum-4 "Control plane URL".
    const fake = await boot({
      handlers: {
        node_set_plane: (args) => String(args.url),
        node_open_plane: (args) => String(args.url),
        node_open_plane_url: () => null,
      },
    });
    await openSection("Control Plane");
    fireEvent.click(button("Change server…"));
    typeInto("Control plane URL", "https://plane.example");
    fireEvent.click(button("Change"));
    await waitFor(() => expect(fake.callsTo("node_set_plane")).toEqual([{ url: "https://plane.example" }]));
    // The whole pin: no open crossed the boundary from the save.
    expect(fake.callsTo("node_open_plane")).toEqual([]);
    expect(fake.callsTo("node_open_plane_url")).toEqual([]);
  });

  // Was "persists the typed address before opening a browser on it". That
  // ORDER existed because the connect screen offered both doors and
  // `node_open_plane_url` re-reads the SETTLED address, so an unsaved one had
  // to be persisted first. The first run drops the browser door entirely
  // (§ 5.3, operator: "we should NOT have an 'open in browser' link"), so the
  // ordering has no path left to get wrong — what is pinned instead is that
  // the door is absent there and present where the address is already saved.
  it("keeps the browser door off the first run, and on the screen where the address is settled", async () => {
    await boot({ settings: makeSettings({ planeUrl: null }), probe: FRESH });
    fireEvent.click(button("Continue"));
    fireEvent.click(button(/^connect to a server/i));
    await screen.findByRole("heading", { name: "Connect to a Server" });
    expect(buttonOrNull("Open in browser")).toBeNull();
    cleanup();
    ipc?.restore();

    const fake = await boot({ handlers: { node_open_plane_url: () => null } });
    // The settled address's browser door is the Control Plane section's now.
    await openSection("Control Plane");
    expect(buttonOrNull("Open in browser")).not.toBeNull();
    fireEvent.click(button("Open in browser"));
    // Still no URL across the boundary: the command re-reads the ladder.
    await waitFor(() => expect(fake.callsTo("node_open_plane_url")).toEqual([{}]));
  });
});

/**
 * The rail (wave 3, the same rulings the server wave carried): present on a
 * settled machine's standing screens, absent everywhere else, the tray's
 * request selecting its section, and Reset a door to a frame-replacing room.
 */
describe("the rail", () => {
  it("shows the six sections on a settled machine, Control Plane active and first", async () => {
    // The landing is Control Plane (operator ruling 2026-09-22, second
    // addendum), and the section reads first in the rail.
    await boot();
    await waitFor(() => expect(screen.getByRole("navigation", { name: "Main" })).toBeTruthy());
    expect(screen.getByRole("button", { name: "Control Plane" }).getAttribute("aria-current")).toBe("true");
    for (const section of ["Status", "Update", "About", "Reset"]) {
      expect(screen.getByRole("button", { name: section })).toBeTruthy();
    }
  });

  it("is absent on the FTE walk, whatever step it is on", async () => {
    // An untouched machine: Welcome, then Choice after the press — both
    // full-window, no navigation.
    await boot({ probe: FRESH, settings: makeSettings({ planeUrl: null }) });
    await waitFor(() =>
      expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Welcome to Subshell Client"),
    );
    expect(screen.queryByRole("navigation", { name: "Main" })).toBeNull();
    fireEvent.click(button("Continue"));
    await waitFor(() =>
      expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("What Would You Like to Do?"),
    );
    expect(screen.queryByRole("navigation", { name: "Main" })).toBeNull();
  });

  it("selects About, and the tray's request lands on its section", async () => {
    // `node_pending_screen` is the tray's ASK — the same answer the event
    // delivers — so this pins the section-selection semantics the events
    // ride: the override state becomes the rail's active id.
    await boot({ handlers: { node_pending_screen: () => "about" } });
    await waitFor(() => expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("About Subshell Client"));
    expect(screen.getByRole("button", { name: "About" }).getAttribute("aria-current")).toBe("true");
    // The leave button is gone where the rail is; a select leaves.
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
    fireEvent.click(button("Status"));
    await waitFor(() => expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Subshell Client"));
  });

  it("carries the Reset door, and the confirmation rides the rail", async () => {
    // Operator ruling 2026-09-22, final word on the reset layout: the
    // sidebar STAYS on the confirmation (it was being lost today), reset
    // active; the room is the RUNNING chain, pinned in reset-screen.test.
    await boot();
    await waitFor(() => expect(screen.getByRole("navigation", { name: "Main" })).toBeTruthy());
    fireEvent.click(button("Reset"));
    await waitFor(() => expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Reset this client"));
    expect(screen.getByRole("navigation", { name: "Main" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reset" }).getAttribute("aria-current")).toBe("true");
  });
});

// ---------------------------------------------------------------------------
// 10. Output ownership, on the two screens the ruling first missed
// ---------------------------------------------------------------------------

/**
 * Service and Control Plane passed the RAW runner output while every other
 * screen gated it — so Service's Start answer followed a person onto the
 * plane cards, and the explaining failure line stayed honestly gated while
 * the words beneath it were not. The reset screen's own pin ("renders no
 * other action's output", reset-screen.test) covers the direction the two
 * leaked INTO; these cover the direction they now refuse: what is recorded
 * renders only on the screen the action was pressed on. That each screen
 * still shows its OWN words is pinned beside the gate — Service's by
 * reset-screen.test's setup walk, Control Plane's by repoint.test's verbatim
 * refusal — so these cases are free to assert only the absence.
 *
 * A SUCCESSFUL enroll records no receipt by ruling (its screen unmounts, the
 * status facts are the proof — precedent: opens record nothing), so no
 * handoff mechanism exists and none of these cases mints one.
 */
describe("output ownership on Service and Control Plane", () => {
  /**
   * Run a reset to completion from the landing, leaving its words on Reset.
   *
   * The reset chain is the cheap cross-screen press to borrow: one command,
   * no settle budget, and the output line is the chain's own. Waiting for
   * the words on their own screen doubles as the completion signal.
   */
  async function runOneReset() {
    const fake = await boot({
      handlers: {
        node_arm_reset: () => true,
        node_reset: () => ({ ok: true, stdout: "reset complete", stderr: "" }),
      },
    });
    fireEvent.click(button("Reset"));
    await screen.findByRole("heading", { name: "Reset this client" });
    // The label is `Type <mono>devbox</mono> to confirm`, three nodes, so it
    // is matched the way the reset file matches it: by its stem.
    fireEvent.change(screen.getByLabelText(/Type/), { target: { value: "devbox" } });
    fireEvent.click(button("Reset Everything"));
    await waitFor(() => expect(screen.getByText("reset complete")).toBeTruthy());
    return fake;
  }

  it("keeps another screen's words off Control Plane", async () => {
    const fake = await runOneReset();
    await openSection("Control Plane");
    expect(screen.queryByText("reset complete")).toBeNull();
    // Sanity: the press was the chain's own, on Reset — nothing else could
    // have produced these words to begin with.
    expect(fake.callsTo("node_reset")).toEqual([{ typed: "devbox" }]);
  });

  it("keeps another screen's words off Service", async () => {
    await runOneReset();
    await openSection("Service");
    expect(screen.queryByText("reset complete")).toBeNull();
  });
});
