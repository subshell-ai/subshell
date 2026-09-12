/**
 * The Addresses section: the configuration form, on its own page.
 *
 * It used to be a step the user chose — `override = "configure"` — which
 * replaced the one card on the page in place, so the way back was a Cancel
 * button and the way IN was a button that four different steps had to
 * remember to list. Neither is true now: the sidebar reaches it from
 * anywhere, and whether a save can work is one function
 * (`addressesAvailability`) rather than a fact spread across a table.
 *
 * A section that cannot help still opens, and says why. A dimmed sidebar item
 * with the reason in a tooltip would fail this console's rule that no refused
 * control lacks its reason beside it — on every platform where hover is not a
 * thing a person does.
 */
import { configPayload, effectiveForm, explicitFields } from "../lib/config-form";
import { addressesAvailability } from "../lib/console-nav";
import { tmuxInstallPlan } from "../lib/installers";
import * as ipc from "../lib/ipc";
import { buildForm } from "./config-form-view";
import { type ConsoleHost, el, state } from "./state";
import { buildTmuxWarning, type TmuxWarning } from "./tmux-warning";

export interface AddressesSection {
  render(): void;
  /** Reseed from the stored configuration and rebuild the inputs. */
  enter(): void;
}

export function createAddresses(host: ConsoleHost): AddressesSection {
  /**
   * Rewrite config.env, then restart so the change takes effect.
   *
   * `configure` only writes the file — `constants.ts` reads every value once at
   * import, so a running server keeps its old settings until it is restarted.
   * Doing both here is what makes the button mean what it says.
   */
  const doConfigure = host.guard(
    "Save and restart",
    async () => {
      const written = await ipc.init(configPayload(state.form, state.explicit));
      if (!written.ok) return written;
      // Back to Overview on success: the hero is where "did it come back up?"
      // is answered, and the result strip follows the person there. A failure
      // stays HERE, beside the fields that caused it.
      state.section = "overview";
      // No service yet: the file IS the whole action, and there is nothing to
      // restart — the reachable-from-`install-service` case must not answer a
      // save with a restart failure.
      if (!state.probe?.service?.installed) {
        return {
          ...written,
          stdout: `${written.stdout}\nSaved. It takes effect when the service is installed and started.`,
        };
      }
      const restarted = await ipc.service("restart", false);
      return restarted.ok ? restarted : { ...restarted, stdout: `${written.stdout}\n${restarted.stdout}` };
    },
    true,
  );

  const doInstallTmux = host.guard("Install tmux", () => ipc.installTmux());
  const tmuxWarn: TmuxWarning = buildTmuxWarning(host, doInstallTmux);

  /** Whether the inputs are currently built, so a poll's re-render does not rebuild them. */
  let formBuilt = false;

  /**
   * Reseed and rebuild.
   *
   * An edit starts from the STORED configuration, not from whatever a previous
   * visit left behind — including a visit the user cancelled. `explicit` is
   * seeded from `explicitFields` rather than from editing alone, because
   * `trusted_origins` is emptyable: keyed on editing, opening this section and
   * saving without touching that field sends an empty value, which means "no
   * extra addresses" and wipes a stored list.
   */
  function enter(): void {
    state.form = effectiveForm(state.probe?.status?.settings);
    state.explicit = explicitFields(state.probe?.status?.settings);
    formBuilt = false;
  }

  function render(): void {
    const verdict = addressesAvailability(state.probe);
    el("addresses-blocked").hidden = verdict.ok;
    el("addresses-live").hidden = !verdict.ok;
    if (!verdict.ok) {
      el("addresses-reason").textContent = verdict.reason;
      // A section that went from usable to not (the server stopped answering
      // mid-edit) must not keep stale inputs behind the refusal.
      formBuilt = false;
      return;
    }

    const actions = el("addresses-actions");
    // Rebuild only on entry, never on a poll tick: every render rebuilding the
    // inputs destroys keyboard focus mid-typing and throws away what was typed.
    if (!formBuilt) {
      formBuilt = true;
      el("addresses-form").textContent = "";
      el("addresses-form").append(buildForm());
      actions.textContent = "";
      const save = document.createElement("button");
      save.type = "button";
      save.className = "primary";
      save.textContent = "Save and restart";
      // The CLI refuses `configure` without tmux, so the button carries the
      // gate and the warning below carries its reason. A button that only
      // produces the refusal is a button that teaches the user to ignore it.
      save.dataset.tmux = "1";
      save.addEventListener("click", doConfigure);
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "ghost";
      cancel.textContent = "Cancel";
      cancel.addEventListener("click", () => {
        // Discard: the next entry reseeds from the stored configuration.
        enter();
        host.goTo("overview");
      });
      actions.append(save, cancel);
      actions.append(tmuxWarn);
    }

    const tmuxMissing = state.probe !== null && !state.probe.tmux;
    tmuxWarn.hidden = !tmuxMissing;
    if (state.probe !== null && tmuxMissing) {
      tmuxWarn.applyPlan(tmuxInstallPlan(state.probe.platform, state.probe.hasBrew));
    }
    for (const b of actions.querySelectorAll("button")) {
      if (b.dataset.always === "1") continue;
      b.disabled = state.busy || (tmuxMissing && b.dataset.tmux === "1");
    }
    for (const i of el("addresses-form").querySelectorAll("input")) i.disabled = state.busy;
  }

  return { render, enter };
}
