/**
 * Every action this app can take on the machine, and the confirmation each one
 * asks for first.
 *
 * Two rules carry most of the weight, and they are the same two the vanilla
 * page was built around:
 *
 * 1. **The CLI owns every operator-facing message.** `apps/node/agent` phrases the
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
import type { RegisterPhase, RegisterRow } from "@/lib/client-flow";
import {
  type EnrolledNodeBody,
  type EnrollOutcome,
  nodeConfigure,
  nodeEnroll,
  nodeInstallAgent,
  nodeInstallTmux,
  nodeOpenPath,
  nodeOpenPlane,
  nodeOpenPlaneUrl,
  nodeProbe,
  nodeService,
  nodeSetPlane,
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
  /** Repoint this machine's node at another control plane. Non-destructive, so one click. */
  repoint: (server: string) => void;
  /** Reveal one of the app's own directories or files. */
  openPath: (target: OpenTarget) => void;
  /** Show a control plane's UI. `null` opens the address already settled. */
  openPlane: (url: string | null) => void;
  /** Open the settled control-plane address in the SYSTEM browser. */
  openPlaneUrl: () => void;
  /**
   * Install tmux on this machine.
   *
   * Registration is GATED on tmux rather than merely warned about it: every
   * subshell runs in a tmux pane, and `enroll` preflights it before its
   * network call precisely so an unenrollable machine does not burn a
   * one-time setup key.
   */
  installTmux: () => void;
  /**
   * Remember a control plane WITHOUT opening its window.
   *
   * {@link NodeCommands.openPlane} persists AND opens, which is right for a
   * button labelled "open the dashboard" and wrong for the first run: the
   * whole point of the new flow is that the dashboard does not appear until
   * the machine is set up and someone asks for it.
   */
  connectOnly: (url: string) => void;
  /**
   * The first run's one press: install the agent if there is none, enroll this
   * machine, then install and start its service.
   *
   * Reports progress through {@link RegisterOptions.onPhase} so the Setting
   * Up… checklist can say which act is running — a chain of three spawns
   * behind one disabled button reads exactly like a hang, which is the defect
   * the reset screen's own step rows were added to close.
   */
  register: (opts: RegisterOptions) => void;
}

/** What {@link NodeCommands.register} needs from the page driving it. */
export interface RegisterOptions {
  /**
   * Whether the node's service is armed for login, answered on the start-up
   * screen BEFORE this runs — it parameterizes the chain's last act, so it
   * cannot be asked afterwards without installing twice.
   */
  startAtLogin: boolean;
  /** Which act is running now. */
  onPhase: (phase: RegisterPhase) => void;
  /** The act that failed, or `null` at the start of a run. */
  onFailed: (act: RegisterRow["id"] | null) => void;
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
            "The service is stopped first so the file can be replaced, and is NOT started again. Start it from " +
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
                  "fixes this for good, but launchd has no reload, so it boots the stale job out to load the new " +
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
          "The agent stops and will not come back at login. This machine stays registered, with its " +
            "configuration and node key untouched, so running it in the background again brings it back.",
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

    /**
     * Repointing is the ONE address change that costs nothing, and that is why
     * it is a single click where {@link NodeCommands.enroll} is two.
     * `configure` spends no setup key, mints no second node row and keeps the
     * node key — so there is nothing here to confirm, and asking would teach
     * the user that this is as dangerous as re-enrolling, which is the
     * confusion the separate command exists to remove.
     *
     * It DOES re-probe: `serverUrl` is a probe fact, and the divergence notice
     * is computed from it.
     */
    repoint: (server) => runner.run(async () => finished(await nodeConfigure({ server }))),

    openPath: (target) =>
      runner.run(async () => {
        // Rejects with the actionable sentence on Linux (the `journalctl`
        // line), which the runner surfaces as the failure message.
        await nodeOpenPath({ target });
        return finished(null);
      }),

    /**
     * Opening a plane changes nothing about THIS MACHINE, so it is the one
     * action that does not re-probe. It still goes through the runner, so it
     * serializes with everything else and an unusable URL comes back as a
     * rejection on the same message line.
     */
    openPlane: (url) =>
      runner.run(
        async () => {
          const opened = await nodeOpenPlane({ url });
          return finished({ ok: true, stdout: `Opened ${opened}`, stderr: "" });
        },
        { reprobe: false },
      ),

    /**
     * Install tmux — and ASK THE MACHINE FIRST (operator's request,
     * 2026-09-18: "retry would also check for the presence of the install").
     *
     * Someone who has gone off to a terminal, installed tmux by hand and come
     * back is pressing this to say "look again", not to run brew a second
     * time — and the probe poll is PAUSED while this screen's own last action
     * was in flight, so it cannot have noticed for them. A tmux found here
     * returns without spawning anything: the runner re-probes on the way out,
     * the router stops routing to the tmux screen, and there is no result left
     * behind for {@link tmuxInstallFailure} to report a failure from.
     */
    installTmux: () =>
      runner.run(async () => {
        // Swallowed rather than surfaced: a probe that could not run is not a
        // reason to refuse the install the person actually asked for, and the
        // install's own result is about to say something more useful.
        const fresh = await nodeProbe().catch(() => null);
        if (fresh?.tmux) return finished(null);
        return finished(await nodeInstallTmux());
      }),

    /**
     * Persist only. The runner still re-probes, because nothing about this
     * machine changed but the screen it should be on has.
     */
    connectOnly: (url) =>
      runner.run(async () => {
        const opened = await nodeSetPlane({ url });
        return finished({ ok: true, stdout: `Using ${opened}`, stderr: "" });
      }),

    /**
     * Three acts, one press, no confirmation.
     *
     * The press IS the consent: a person typed a single-use key into a field
     * labelled as one and pressed Register, so `confirm: true` goes straight
     * out rather than raising the panel {@link NodeCommands.enroll} raises.
     * That is scoped to the FIRST run — re-enrolling from the status screen
     * still asks, because there it overwrites a working `config.json`, mints a
     * second node row and discards the only copy of a live node key.
     */
    register: ({ startAtLogin, onPhase, onFailed }) =>
      runner.run(async () => {
        onFailed(null);

        /** Install and start the service — the chain's last act. */
        const startService = async () => {
          onPhase("starting");
          const started = await nodeService({ verb: "install", force: false, autostart: startAtLogin });
          if (!started.ok) {
            onFailed("start");
            return finished(started);
          }
          // `service install` returns when the manager has spawned the process,
          // not when the daemon has taken its lock — without this the run ends
          // on "offline", which reads as a failure of the thing that just worked.
          await runner.settle();
          onPhase("done");
          return finished(started);
        };

        /** Everything after a decided enrolment: the key, the row, the service. */
        const afterEnroll = async (enrolled: EnrollOutcome) => {
          // Spent whatever happened — a consumed credential has no business
          // sitting in a field the next click could re-send. The NAME survives:
          // a taken name is the common retry and is what gets retyped anyway.
          form.clearSpentKey();
          if (!enrolled.ok) {
            onFailed("enroll");
            return finished(enrolled);
          }
          onEnrolled(enrolled.node);
          return startService();
        };

        // A RETRY after the SERVICE act failed arrives here with this machine
        // already registered. Enrolling again would mint a second node row and
        // discard the node key the previous attempt just stored — so the act
        // is skipped rather than repeated, which is what makes the chain
        // resumable instead of destructive on its second press.
        //
        // It is answered FIRST, ahead of the form, and that order is the whole
        // of it: `afterEnroll` clears the spent key, so on this very press
        // `form.validate()` refuses an empty one — and refusing for an act
        // that is not going to run is how a Retry becomes a button that does
        // nothing at all, which is the dead end the checklist exists to avoid.
        // Nothing below this line is needed to start a service.
        if (probe?.status?.nodeId) return startService();

        // BEFORE any spawn: the Register button stays live for a malformed
        // field on purpose, so this press is where `validateEnroll`'s per-field
        // refusals are rendered. Refused here means nothing ran and no key was
        // spent. (The Register screen validates too, so on a first run these
        // have already been seen; this is the guard for every other caller.)
        const args = form.validate();
        if (args === null) return finished(null);

        // A no-op where an agent is already installed, which is what makes a
        // resumed run converge rather than refuse.
        if (probe?.step === "no-agent") {
          onPhase("installing");
          const installed = await nodeInstallAgent();
          if (!installed.ok) {
            onFailed("install");
            return finished(installed);
          }
        }

        onPhase("enrolling");
        // `confirm: false` FIRST, always.
        //
        // The press IS the consent for a FIRST RUN, and on a machine with no
        // `config.json` Rust raises nothing, so this still enrolls in one call
        // and the person sees no panel. What a blanket `confirm: true` would
        // ALSO do is skip Rust's already-enrolled guard, which reads
        // `config.json` directly — and a machine can reach this chain with a
        // live config: `no-agent` is reported for a missing binary AND for one
        // that cannot answer `status --json`, so a machine whose agent was
        // deleted still has its config, its node id and the only copy of its
        // node key. Enrolling over that mints a SECOND node row and discards
        // the key. The probe's own comment says a transient failure must never
        // route to the destructive step; this is that rule, on this path.
        const first = await nodeEnroll({ ...args, confirm: false });
        if (!first.requiresConfirmation) return afterEnroll(first);

        // Nothing ran and no key was spent. Loopback alone is ADVISORY — the
        // enrol fields already carry that sentence under the URL, so stopping
        // the press to say it a second time would be the nag this flow removed.
        //
        // Written as "every one of them is the advisory kind", NOT as "none of
        // them is the destructive kind we know about". The two agree today,
        // because `ConfirmKind` has exactly two members — but this is the one
        // path that spends a setup key with no panel in front of it, so a third
        // kind added on the Rust side must land in the PANEL by default rather
        // than being waved through by a predicate that was only ever
        // enumerating today's dangers. Fail closed on the unknown.
        const advisoryOnly = first.confirmations.every((c) => c.kind === "loopback-server");
        if (advisoryOnly) return afterEnroll(await nodeEnroll({ ...args, confirm: true }));

        // Destructive, and the one thing this chain will not do silently.
        //
        // The row is deliberately left ACTIVE rather than marked failed: the
        // act has not failed, it is waiting on a person, and a checklist that
        // says "Failed" under a panel asking a question describes neither.
        // What the page does on a CANCEL is mark it — see `app.tsx`, which is
        // where that press is known.
        return asks(
          {
            title: "This machine is already registered",
            messages: first.confirmations.map((c) => c.message),
            acceptLabel: "Register anyway",
            run: async () => {
              onFailed(null);
              onPhase("enrolling");
              return afterEnroll(await nodeEnroll({ ...args, confirm: true }));
            },
          },
          first,
        );
      }),

    /** As {@link openPlane}: the browser is not this machine's state either. */
    openPlaneUrl: () =>
      runner.run(
        async () => {
          await nodeOpenPlaneUrl();
          return finished(null);
        },
        { reprobe: false },
      ),
  };
}
