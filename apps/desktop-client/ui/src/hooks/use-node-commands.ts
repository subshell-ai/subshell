/**
 * Every action this app can take on the machine, and the confirmation each one
 * asks for first.
 *
 * Two rules carry most of the weight, and they are the same two the vanilla
 * page was built around:
 *
 * 1. **The CLI owns every operator-facing message.** `apps/client` phrases the
 *    tmux refusal, the `loginctl enable-linger` hint, the live-pane refusal and
 *    every enrollment failure, and its strings are pinned by its own tests. So
 *    `stdout`/`stderr` reach the screen VERBATIM and are never re-worded here.
 *    Decisions key off exit status and structured fields, never off prose —
 *    with one deliberate exception, documented at {@link NodeCommands.restart}.
 * 2. **Nothing destructive happens on one click.** A setup key is single-use
 *    and 24-hour, `enroll` has no already-enrolled guard, and a restart on a
 *    stale service definition SIGKILLs every subshell on this machine. Each of
 *    those raises a confirmation that names the cost in the Rust side's words
 *    (or the CLI's) before the button that pays it.
 */
import { asks, finished } from "@/lib/actions";
import { pickAgentBinaryPath } from "@/lib/dialog";
import {
  type EnrolledNodeBody,
  nodeEnroll,
  nodeInstallAgent,
  nodeOpenPath,
  nodeService,
  nodeSetAgentBin,
  nodeSetCloseToTray,
  type OpenTarget,
  type Probe,
  type ServiceVerb,
} from "@/lib/ipc";
import { paneRisk, rewriteKillsPanes } from "@/lib/steps";
import type { ActionRunner } from "./use-action-runner";
import type { EnrollForm } from "./use-enroll-form";

export interface NodeCommands {
  /** Re-read the machine. No CLI action of its own; the runner's re-probe IS the work. */
  refresh: () => void;
  /** Install the bundled agent with no confirmation — only ever offered where nothing exists to overwrite. */
  installAgent: () => void;
  /** Replace the INSTALLED agent with the bundled one. Always confirmed. */
  updateAgent: () => void;
  /** One `service` verb, straight through. Never `restart` — that goes through {@link restart}. */
  service: (verb: ServiceVerb, opts?: { settle?: boolean }) => void;
  /** Restart, offering `--force` only behind the verbatim refusal `--force` answers. */
  restart: () => void;
  /** Uninstall the background service. Always confirmed. */
  uninstall: () => void;
  /** Rewrite the service definition, confirmed where the rewrite itself costs panes. */
  rewrite: () => void;
  /** Register this machine. Two-phase, always. */
  enroll: () => void;
  /** Reveal one of the app's own directories or files. */
  openPath: (target: OpenTarget) => void;
  /** Choose an agent binary by hand. */
  pickBinary: () => void;
  /** Forget the hand-chosen binary. */
  clearBinary: () => void;
  /** The close-to-tray preference. */
  setCloseToTray: (enabled: boolean) => void;
}

export function useNodeCommands(args: {
  runner: ActionRunner;
  probe: Probe | undefined;
  form: EnrollForm;
  /** Called with the `enroll --json` body after a successful enrollment. */
  onEnrolled: (node: EnrolledNodeBody | null) => void;
}): NodeCommands {
  const { runner, probe, form, onEnrolled } = args;

  /**
   * One `service` verb. `force` is never passed here — the CLI accepts it only
   * on `restart`, and that one path goes through {@link restart} so its refusal
   * is read out loud before the override is offered.
   */
  async function runService(verb: ServiceVerb, opts?: { settle?: boolean }) {
    const result = await nodeService({ verb, force: false });
    if (result.ok && opts?.settle) await runner.settle();
    return result;
  }

  return {
    refresh: () => runner.run(async () => finished(null)),

    installAgent: () => runner.run(async () => finished(await nodeInstallAgent())),

    /**
     * Replacing the installed agent stops the service that runs it — and does
     * not start it again. On a stale definition, stopping is also what ends
     * every live subshell. Neither is something to do on a single click.
     */
    updateAgent: () =>
      runner.run(async () => {
        const messages = [
          `Install the agent that ships inside this app (${probe?.bundledVersion ?? "unknown version"}) over ` +
            "~/.local/bin/subshell. Nothing is downloaded.",
        ];
        if (probe?.managed === true) {
          messages.push(
            "The service is stopped first so the file can be replaced, and is NOT started again — start it from " +
              "here afterwards.",
          );
          if (paneRisk(probe)) {
            messages.push(
              "The installed definition does not spare live panes, so stopping it kills every subshell running on " +
                "this machine.",
            );
          }
        }
        return asks({
          title: "Update the agent",
          messages,
          acceptLabel: "Update the agent",
          run: async () => finished(await nodeInstallAgent()),
        });
      }),

    service: (verb, opts) => runner.run(async () => finished(await runService(verb, opts))),

    /**
     * The one place this file reads the CLI's prose, and the reason is that
     * nothing structured says "refused": the pane guard's refusal and a masked
     * unit, a dead D-Bus or a permission error all arrive as the same non-zero
     * exit. Deciding from `paneSafety` instead would offer "restart anyway" for
     * all four — and `--force` helps only the first, so the other three would
     * then fail a second time. The override is a separate, named button behind
     * the verbatim refusal, never a silent retry.
     */
    restart: () =>
      runner.run(async () => {
        const first = await nodeService({ verb: "restart", force: false });
        if (first.ok) {
          await runner.settle();
          return finished(first);
        }
        if (!first.stderr.includes("refusing to restart")) return finished(first);
        return asks(
          {
            title: "This restart would kill every subshell running on this machine",
            messages: [
              first.stderr.trim(),
              rewriteKillsPanes(probe)
                ? 'The button labelled "Rewrite the service definition" is the CLI\'s own first suggestion and it ' +
                  "fixes this for good — but launchd has no reload, so it boots the stale job out to load the new " +
                  "one and costs the same sessions this restart would, once. Forcing the restart loses them and " +
                  "repairs nothing."
                : 'The button labelled "Rewrite the service definition" is the CLI\'s own first suggestion: it ' +
                  "fixes this for good and kills nothing. Forcing the restart loses every session running on this " +
                  "machine right now.",
            ],
            acceptLabel: "Restart anyway (--force)",
            run: async () => {
              const forced = await nodeService({ verb: "restart", force: true });
              if (forced.ok) await runner.settle();
              return finished(forced);
            },
          },
          first,
        );
      }),

    /**
     * Uninstalling gates on nothing in the CLI — deliberately, so a stranded
     * unit can always come down. That makes this the one place the consequence
     * gets said out loud.
     */
    uninstall: () =>
      runner.run(async () => {
        const messages = [
          "The agent stops and will not come back at login. This machine stays registered — its configuration and " +
            "node key are untouched — so running it in the background again is all it takes to bring it back.",
        ];
        if (paneRisk(probe)) {
          messages.push(
            "The installed definition does not spare live panes, so this kills every subshell running on this " +
              "machine.",
          );
        }
        return asks({
          title: "Uninstall the background service",
          messages,
          acceptLabel: "Uninstall the service",
          run: async () => finished(await nodeService({ verb: "uninstall", force: false })),
        });
      }),

    /**
     * The remedy for a definition that would SIGKILL every subshell on a
     * teardown, and on Linux it is free — which is why the restart refusal
     * points at it. On macOS the same `service install` is bootout +
     * bootstrap, so it pays the exact price it is buying off, once. "Kills
     * nothing" is not said on the platform where it does.
     */
    rewrite: () =>
      runner.run(async () => {
        if (!rewriteKillsPanes(probe)) return finished(await runService("install", { settle: true }));
        return asks({
          title: "Rewriting the definition restarts the agent",
          messages: [
            "A launchd job cannot be reloaded in place: the loaded one is booted out and the new definition is " +
              "bootstrapped. The definition currently loaded does not spare live panes, so booting it out kills " +
              "every subshell running on this machine.",
            "It is the last time that happens. The definition this writes spares panes, so every stop, restart " +
              "and uninstall after it is free.",
          ],
          acceptLabel: "Rewrite the definition",
          run: async () => finished(await runService("install", { settle: true })),
        });
      }),

    /**
     * The two-call flow the Rust side defines: `confirm: false` first, and when
     * it comes back asking, NOTHING was spawned and no key was spent — so the
     * reasons are shown and the IDENTICAL arguments are re-sent only on an
     * explicit acceptance. There is no auto-retry anywhere in here: once the
     * control plane has accepted a key, a second attempt with it cannot
     * succeed, and the CLI's own stderr already says to mint a new one where
     * that is the answer.
     */
    enroll: () =>
      runner.run(async () => {
        const enrollArgs = form.validate();
        // Refused here means refused BEFORE a spawn: nothing ran, no key spent.
        if (enrollArgs === null) return finished(null);
        const outcome = await nodeEnroll({ ...enrollArgs, confirm: false });
        if (!outcome.requiresConfirmation) {
          if (outcome.ok) {
            onEnrolled(outcome.node);
            form.clearSpentKey();
          }
          return finished(outcome);
        }
        return asks({
          title: "Confirm before this setup key is spent",
          messages: outcome.confirmations.map((c) => c.message),
          acceptLabel: "Enroll this machine",
          run: async () => {
            const confirmed = await nodeEnroll({ ...enrollArgs, confirm: true });
            if (confirmed.ok) {
              onEnrolled(confirmed.node);
              form.clearSpentKey();
            }
            return finished(confirmed);
          },
        });
      }),

    openPath: (target) =>
      runner.run(async () => {
        // Rejects with the actionable sentence on Linux (the `journalctl`
        // line), which the runner surfaces as the failure message.
        await nodeOpenPath({ target });
        return finished(null);
      }),

    /** The Rust side validates the chosen file and rejects anything that is not an agent. */
    pickBinary: () =>
      runner.run(async () => {
        const chosen = await pickAgentBinaryPath();
        if (chosen === null) return finished(null);
        await nodeSetAgentBin({ path: chosen });
        return finished({ ok: true, stdout: `Using ${chosen}`, stderr: "" });
      }),

    clearBinary: () =>
      runner.run(async () => {
        await nodeSetAgentBin({ path: null });
        return finished({
          ok: true,
          stdout: "Cleared. The app will resolve an agent again from the service definition, PATH, or its own install.",
          stderr: "",
        });
      }),

    /**
     * Not worth two CLI spawns, so this is the one action that does not
     * re-probe — it changes nothing the probe reports. It still goes through
     * the runner, so it serializes with everything else and its rejection
     * reaches the same message line.
     */
    setCloseToTray: (enabled) =>
      runner.run(
        async () => {
          await nodeSetCloseToTray({ enabled });
          return finished(null);
        },
        { reprobe: false },
      ),
  };
}
