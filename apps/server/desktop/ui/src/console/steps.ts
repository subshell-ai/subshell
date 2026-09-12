/**
 * Overview's step: the single next thing this machine needs, and the buttons
 * that do it.
 *
 * The table below is one entry per `ProbeStep` the Rust side can emit. What
 * left it when the sidebar arrived is `configure` — a step the USER chose
 * rather than one the machine implied, held in an `override` beside
 * `probe.next` and rendered by replacing this card in place. It is the
 * Addresses section now (`addresses.ts`), which is why no step lists
 * "Change addresses…" any more: the sidebar is the way there, from every
 * section, and Cancel is no longer the only way back.
 *
 * The CLI owns every operator-facing message — the `loginctl enable-linger`
 * hint, the tmux refusal, the live-pane warning — so its stdout and stderr are
 * shown VERBATIM and never re-worded here. Two surfaces that phrase the same
 * refusal differently are two surfaces that drift.
 */
import { ask as askDialog, open as openDialog } from "@tauri-apps/plugin-dialog";
import { configPayload } from "../lib/config-form";
import { tmuxInstallPlan } from "../lib/installers";
import type { ActionResult, ProbeStep } from "../lib/ipc";
import * as ipc from "../lib/ipc";
import { buildForm } from "./config-form-view";
import { type ConsoleHost, el, SETTLE_ATTEMPTS, SETTLE_DELAY_MS, sleep, state } from "./state";
import { buildTmuxWarning, type TmuxWarning } from "./tmux-warning";

/** One entry of the actions row: label, handler, and the two rendering flags. */
type StepAction = [label: string, handler: () => unknown, primary?: boolean, needsTmux?: boolean];

/** One entry of the STEPS table. */
interface Step {
  body: string;
  hint?: string;
  /** Whether the init form is part of this step. */
  form?: boolean;
  actions: () => StepAction[];
}

export interface StepsSection {
  render(): void;
  /** The boot probe, and the Retry button's handler. */
  retry(): Promise<void>;
}

export function createSteps(host: ConsoleHost): StepsSection {
  // -------------------------------------------------------------------------
  // The actions. Each is `host.guard`ed, which owns busy/problem/re-probe and
  // records the press for the result strip.
  // -------------------------------------------------------------------------

  const retry = host.guard("Retry", async (): Promise<ActionResult | null> => null);
  const service = (label: string, verb: ipc.ServiceVerb, settle = false) =>
    host.guard(label, () => ipc.service(verb, false), settle);

  /**
   * First-run configure: write config.env, then install and start the service.
   *
   * One button rather than two steps. Configuring and then being asked to
   * install a service is a distinction that serves our state machine, not the
   * person setting this up: there is no reason to write a configuration on this
   * machine and NOT run the server it configures. The `install-service` step is
   * still reachable for the case that genuinely means something, a config that
   * already exists with no service installed.
   *
   * Same shape as the Addresses section's save: if the write fails, stop and
   * report it rather than acting on a configuration that is not there.
   */
  const doInit = host.guard(
    "Save and start",
    async () => {
      const written = await ipc.init(configPayload(state.form, state.explicit));
      if (!written.ok) return written;
      const installed = await ipc.service("install", false);
      return installed.ok ? installed : { ...installed, stdout: `${written.stdout}\n${installed.stdout}` };
    },
    true,
  );

  const openMain = host.guard("Open Dashboard", () => ipc.openMain().then(() => null));

  /**
   * The whole first-run chain, one press.
   *
   * Disclosed rather than silent: installing a binary and registering a
   * background service is not something to do unasked, so this is one INFORMED
   * click instead of four uninformed ones. The step's hint is the disclosure,
   * and it is what makes collapsing the four steps honest.
   *
   * Opening the dashboard is part of the press, but the press waits for the
   * server to ANSWER before pointing a window at it: the `ready` button and the
   * tray item have always opened it against a running server, and `service
   * start` returns when the manager has spawned the process, not when the port
   * is bound. So the settle runs here, before the open, rather than only after
   * the return. A chain that installed everything and never settles stays on
   * screen as the step that names the remainder, with the CLI's own words in
   * the log section below; a window pointed at a dead port is the one outcome
   * this press exists to remove.
   */
  const doSetup = host.guard(
    "Set up and start",
    async () => {
      const result = await ipc.setup();
      if (!result.ok) return result;
      for (let i = 0; i < SETTLE_ATTEMPTS && state.probe?.next !== "ready"; i += 1) {
        await sleep(SETTLE_DELAY_MS);
        await host.refresh();
      }
      if (state.probe?.next === "ready") {
        await ipc.openMain();
        return result;
      }
      // The settle ran out, not the setup: the chain installed and started a
      // server that has not bound its port yet (a first boot runs migrations; a
      // launchd job mid-throttle reports its wait verbatim). Say the press ended
      // without its last act, rather than letting the hint's promise of an
      // opened dashboard read as a silent lie. The background poll keeps
      // checking, and "Open Dashboard" appears on its own the moment READY lands.
      return {
        ...result,
        stdout:
          `${result.stdout}\nThe server is set up and still starting. The console keeps checking, and the ` +
          '"Open Dashboard" button appears the moment it answers.\n',
      };
    },
    true,
  );

  /**
   * Run the platform's own tmux installer. No settle: tmux appearing changes
   * nothing about the server — the guard's ordinary re-probe lifts the warning,
   * enables every gated button, and the package manager's own output goes to
   * the log section verbatim. The user then presses what they were going to
   * press.
   */
  const doInstallTmux = host.guard("Install tmux", () => ipc.installTmux());

  /**
   * Replacing the installed server stops it first, which ends every running
   * subshell whose definition does not spare them. That is not something to do
   * on a single click.
   */
  const doUpdateServer = host.guard(
    "Update server",
    async () => {
      const kills = state.probe?.service?.paneSafety !== "keeps" && state.probe?.service?.installed;
      const warning = kills
        ? "\n\nThe installed service definition does not spare live panes, so every running subshell will be killed."
        : "";
      const proceed = await askDialog(
        `Replace the installed server with ${state.probe?.bundledVersion}? The service will be stopped and restarted.${warning}`,
        { title: "Update the server", kind: kills ? "warning" : "info", okLabel: "Update" },
      );
      return proceed ? await ipc.installServer() : null;
    },
    true,
  );

  /**
   * Restart is refused outright when the installed definition would kill live
   * panes. The decision is taken from `paneSafety`, which is structured — the
   * prose check is only a fallback for a probe that has gone stale between the
   * render and the click.
   */
  const doRestart = host.guard(
    "Restart",
    async () => {
      const first = await ipc.service("restart", false);
      // The CLI's refusal is the only thing that means "refused". Treating any
      // failure on a `kills` host as the pane refusal offered "restart anyway" for
      // a masked unit, a dead D-Bus, or a permission error — none of which --force
      // can help, and all of which then failed a second time.
      const refused = !first.ok && first.stderr.includes("refusing to restart");
      if (first.ok || !refused) return first;
      const proceed = await askDialog(`${first.stderr.trim()}\n\nRestart anyway and lose those sessions?`, {
        title: "This will kill running subshells",
        kind: "warning",
        okLabel: "Restart anyway",
      });
      return proceed ? await ipc.service("restart", true) : first;
    },
    true,
  );

  /** Stop warns rather than refusing, so the warning is the thing to surface. */
  const doStop = host.guard("Stop", () => ipc.service("stop", false));

  /** The Rust side validates the chosen file and returns an Err for anything that is not a server. */
  const pickBinary = host.guard("Choose a server", async () => {
    const chosen = await openDialog({ multiple: false, directory: false, title: "Choose subshell-server" });
    // Falsy, not "not a string": an empty string reaching `setServerBin` would
    // CLEAR the configured choice (Rust maps it to None) — silence where a
    // cancel is the only reading that fits.
    if (!chosen) return null;
    await ipc.setServerBin(chosen);
    return { ok: true, stdout: `Using ${chosen}`, stderr: "" };
  });

  // -------------------------------------------------------------------------
  // The table
  // -------------------------------------------------------------------------

  /**
   * One entry per `ProbeStep` the Rust side can emit.
   *
   * `Object.create(null)` so a step named `constructor` or `toString` cannot
   * resolve to something inherited and crash the render loop.
   */
  const STEPS: Partial<Record<ProbeStep, Step>> = Object.assign(Object.create(null), {
    "no-server": {
      body: "No subshell-server was found, and this build does not ship one.",
      hint: "Point the app at a server binary you already have.",
      actions: () => [["Choose subshell-server…", pickBinary, true]],
    },
    setup: {
      body: "Set up Subshell on this machine.",
      hint:
        "Installs the bundled server to ~/.local/bin, writes ~/.config/subshell-server/config.env (port 3080, all " +
        "interfaces), registers it to start at login, starts it, and opens the dashboard. Nothing is downloaded.",
      actions: () => [
        // tmux-gated like every step that advances setup: the chain ends in
        // `init` and `service install`, both of which refuse without tmux (every
        // local pane launches through it), so an enabled button here would just
        // walk the press into that wall.
        ["Set up and start", doSetup, true, true],
        // No address editing offered from here: this screen exists exactly
        // where no server resolves, and a save IS `subshell-server init` — it
        // could only answer "no subshell-server found", and the next press
        // would then overwrite the edit without a word. The hint discloses the
        // defaults the press writes. The Addresses section refuses on this
        // step for the same reason and says so in its own words
        // (`addressesAvailability`). (Pinned by test.)
        ["Choose an existing server…", pickBinary],
      ],
    },
    unreachable: {
      body: "A subshell-server was found, but it did not answer.",
      hint: "Nothing has been changed. Retry, or choose a different binary; this app will not rewrite a configuration it cannot read. If the answer you expect is a different port or address, edit it under Addresses.",
      actions: () => [
        ["Retry", retry, true],
        ["Choose a different one…", pickBinary],
      ],
    },
    init: {
      body: "The server has no config.env yet. Choose the port and the addresses it will answer to.",
      // Forward tense: this sits under the form, BEFORE the button is pressed.
      // "Written to …" read as a report of a write that had already happened.
      // And the secret is generated exactly ONCE, since a value already in the
      // file wins and an environment one is adopted, so "a fresh auth secret"
      // was wrong on both of those paths (`commands/init.ts`).
      hint:
        "Creates ~/.config/subshell-server/config.env (0600), and an auth secret if there is not one already, then " +
        "installs the background service and starts it.",
      form: true,
      actions: () => [["Save and start", doInit, true, true]],
    },
    "install-service": {
      body: "Configured, but not installed as a background service.",
      hint: "A systemd user unit on Linux, a launchd agent on macOS. Installing also starts it, and it starts at login from then on.",
      actions: () => [
        ["Install and start as a service", service("Install and start as a service", "install", true), true, true],
      ],
    },
    start: {
      body: "The service is installed but not running.",
      actions: () => [
        ["Start", service("Start", "start", true), true, true],
        ["Uninstall service", service("Uninstall service", "uninstall")],
      ],
    },
    ready: {
      // Rendered as an empty body on purpose: the hero directly above has just
      // said "Running", and a sentence repeating it is the clutter this page
      // was reorganized to remove. Every other step keeps its body, because
      // there the sentence IS the instruction.
      body: "",
      actions: () => [
        // The tray's item for this same window says "Open Dashboard".
        //
        // There is deliberately no agent-install button beside it. Installing an
        // agent CLI moved to the control plane (spec 2026-09-11 § 7), so this app
        // has nothing left to run - and a second button whose only job is to open
        // the dashboard is the button immediately to its left.
        ["Open Dashboard", openMain, true],
        ["Restart", doRestart, false, true],
        ["Stop", doStop],
      ],
    },
  } satisfies Partial<Record<ProbeStep, Step>>);

  /** What to show before the first probe lands, or for a step this build predates. */
  function fallbackStep(): Step {
    return state.probe === null
      ? { body: "Checking this machine…", actions: () => [] }
      : {
          body: `This app does not know what to do about "${state.probe.next}".`,
          hint: "That usually means the app is older than the server it is managing.",
          actions: () => [["Retry", retry, true]],
        };
  }

  function button(label: string, handler: () => unknown, primary?: boolean, needsTmux?: boolean): HTMLButtonElement {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    if (primary) b.className = "primary";
    // The CLI refuses init/configure/service-install without tmux; a button
    // that only produces the refusal is a button that teaches the user to
    // ignore it. Flagged on the element, applied every render (see render).
    if (needsTmux) b.dataset.tmux = "1";
    b.addEventListener("click", handler);
    return b;
  }

  const tmuxWarn: TmuxWarning = buildTmuxWarning(host, doInstallTmux);

  /** Which step the action area currently shows, so focus survives a re-render. */
  let renderedStep: string | null = null;

  function render(): void {
    const key = state.probe?.next ?? null;
    const step = (key !== null && STEPS[key]) || fallbackStep();
    const actions = el("step-actions");

    // Rebuild only when the STEP changes. Rebuilding on every render — and every
    // guarded action ends in one — destroyed keyboard focus mid-interaction and
    // threw away the init form's inputs.
    if (renderedStep !== key) {
      renderedStep = key;
      el("step-body").textContent = step.body;
      el("step-body").hidden = step.body === "";
      el("step-hint").textContent = step.hint ?? "";
      actions.textContent = "";

      // A newer bundled server is OFFERED alongside the current step — never
      // applied unasked. The reverse (a newer server already installed) is
      // adopted silently and is not a choice: server boot runs forward-only
      // migrations, so an older binary against a migrated database is data loss.
      if (state.probe?.serverChoice === "upgrade-available") {
        actions.append(button(`Update server to ${state.probe.bundledVersion}`, doUpdateServer, false));
      }
      if (step.form) actions.append(buildForm());
      for (const [label, handler, primary, needsTmux] of step.actions()) {
        actions.append(button(label, handler, primary, needsTmux));
      }
      // Appended last and RE-CHECKED every render, not rebuilt with the step.
      // Installing tmux does not change which step you are on, so a warning (or
      // a disabled button) rebuilt only on a step change would survive its own
      // fix — worse than never having one. With the background poll this is what
      // makes the fix land on its own: tmux appears, the next tick re-checks,
      // and the buttons enable without the user doing anything.
      actions.append(tmuxWarn);
    }
    const tmuxMissing = state.probe !== null && !state.probe.tmux;
    tmuxWarn.hidden = !tmuxMissing;
    // Re-read every render, not rebuilt with the step: installing tmux or brew
    // does not change which step you are on, and a plan decided once would
    // outlive its own premise. `platform` comes from the probe (a Rust fact)
    // rather than the UA string this used to sniff. (The `probe !== null` test
    // is the same fact `tmuxMissing` encodes — restated because TS cannot see
    // through the boolean to narrow `state.probe`.)
    if (state.probe !== null && tmuxMissing) {
      tmuxWarn.applyPlan(tmuxInstallPlan(state.probe.platform, state.probe.hasBrew));
    }
    for (const b of actions.querySelectorAll("button")) {
      if (b.dataset.always === "1") continue;
      b.disabled = state.busy || (tmuxMissing && b.dataset.tmux === "1");
    }
    for (const i of actions.querySelectorAll("input")) i.disabled = state.busy;
  }

  return { render, retry };
}
