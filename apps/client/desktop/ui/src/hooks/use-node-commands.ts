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
import { asks, errorText, finished } from "@/lib/actions";
import type { RegisterPhase, RegisterRow } from "@/lib/client-flow";
import {
  type ActionResult,
  type EnrolledNodeBody,
  type EnrollOutcome,
  nodeConfigure,
  nodeEnroll,
  nodeInstallCli,
  nodeInstallTmux,
  nodeOpenPath,
  nodeOpenPlane,
  nodeOpenPlaneUrl,
  nodePlaneAdd,
  nodePlaneRemove,
  nodeProbe,
  nodeService,
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
  /** Install the bundled node CLI with no confirmation — only ever offered where nothing exists to overwrite. */
  installNode: () => void;
  /** Replace the INSTALLED node CLI with the bundled one. Always confirmed. */
  updateNode: () => void;
  /** One `service` verb, straight through. Never `restart` — that goes through {@link restart}. */
  service: (verb: ServiceVerb, opts?: { settle?: boolean }) => void;
  /** Restart, offering `--force` only behind the verbatim refusal `--force` answers. */
  restart: () => void;
  /**
   * Uninstall the background service. Always confirmed.
   *
   * Offered on the Service section since the rails addendum (2026-09-22) put
   * the full lifecycle verbs there for server parity — "uninstall the service
   * while keeping the node" is the act review M6 said was a ruling away, and
   * that is the ruling.
   */
  uninstall: () => void;
  /**
   * Arm or disarm login start for the installed service — the run-at-login
   * switch, and the day-2 form of what the first run's start-up screen asks
   * once.
   *
   * The CLI's `service autostart on|off` changes the NEXT login and nothing
   * running: no restart, no stop. That is what lets it be a switch rather
   * than a confirmed act — reversing it reverses everything.
   */
  autostart: (on: boolean) => void;
  /** Rewrite the service definition, confirmed where the rewrite itself costs panes. */
  rewrite: () => void;
  /** Repoint this machine's node at another control plane. Non-destructive, so one click. */
  repoint: (server: string) => void;
  /** Reveal one of the app's own directories or files (the Status fact rows). */
  openPath: (target: OpenTarget) => void;
  /** Show one control plane's UI, at the row's address. Opens are one-off. */
  openPlane: (url: string) => void;
  /** Open one saved address in the SYSTEM browser, same one-off rule. */
  openPlaneUrl: (url: string) => void;
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
   * Storing and opening are fully separate since the plane list (operator
   * ruling 2026-09-22): this writes the app's saved list and opens nothing,
   * so the first run can record the address it just learned about without
   * the dashboard appearing over the questions it is still asking.
   */
  addPlane: (url: string) => void;
  /**
   * Forget one saved control plane, behind a confirmation. The app's own
   * bookmarks are the whole reach of this: no node, no key, no service and
   * nothing on the control plane is touched — those acts live on Service.
   */
  removePlane: (url: string) => void;
  /**
   * The first run's one press: install the node if there is none, enroll this
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
  /**
   * What the tmux install itself answered — `null` at the press, the result on
   * the way out.
   *
   * The tmux screen's failure card CANNOT read `runner.output`, which is the
   * last of ANY action and outlives the screen it was produced on: the runner
   * lives in `App`, so a failed `service` verb or node CLI install on the status
   * screen would render under "The tmux install didn't finish." the next time
   * anyone walked to the tmux screen. That is the defect the server app's own
   * `tmuxResult` slot exists to prevent (`wizard.ts`), and this is its twin —
   * a page-state slot only this command writes.
   */
  onTmuxInstall: (result: ActionResult | null) => void;
}): NodeCommands {
  const { runner, probe, form, onEnrolled, onTmuxInstall } = args;

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

    installNode: () => runner.run(async () => finished(await nodeInstallCli())),

    /**
     * Replacing the installed node CLI is worth a confirmation even though it
     * interrupts nothing: it overwrites the binary this machine runs, from a
     * copy that ships inside this app, and the daemon goes on running the
     * previous version afterwards. That last fact is the one a single click
     * would hide — see the messages below, which state it rather than the
     * stop-and-start this path has not done since spec 2026-09-15 § 7.1.
     */
    updateNode: () =>
      runner.run(async () => {
        const messages = [
          `Install the Subshell Node CLI that ships inside this app (${probe?.bundledVersion ?? "unknown version"}) over ` +
            "~/.local/bin/subshell. Nothing is downloaded.",
        ];
        if (probe?.managed === true) {
          // What this actually does, measured rather than remembered. It said
          // "The service is stopped first so the file can be replaced, and is
          // NOT started again. Start it from here afterwards." — false twice
          // over (operator's question, 2026-09-18):
          //
          // - Nothing is stopped. `install_node_now` passes a no-op closure
          //   where the stop callback used to be, and the managed path goes
          //   through the CLI's `update --from`, whose swap is a `rename(2)`
          //   a running daemon never notices.
          // - So it was never stopped, and "start it" names the wrong verb:
          //   the daemon is UP, on the old binary, because rename leaves a
          //   running process on its original inode.
          //
          // The pane-safety line is gone from HERE and belongs to the restart,
          // which is the act that costs panes. An install that interrupts
          // nothing cannot kill a subshell.
          messages.push(
            "The running daemon is not interrupted (the swap is a rename it never notices), so it keeps running " +
              "the previous version until you restart it.",
          );
        }
        return asks({
          title: "Update the node",
          messages,
          acceptLabel: "Update the node",
          run: async () => finished(await nodeInstallCli()),
        });
      }),

    service: (verb, opts) => runner.run(async () => finished(await runService(verb, opts))),

    /**
     * The run-at-login switch's press. No confirmation and no settle: the CLI
     * arms or disarms the NEXT login and interrupts nothing, so there is
     * nothing to wait for. The re-probe the runner already does is what moves
     * the switch when the fact comes back different, and the CLI's line
     * ("subshell will start at login.") is the receipt.
     */
    autostart: (on) =>
      runner.run(async () => finished(await nodeService({ verb: "autostart", force: false, autostart: on }))),

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
                ? "Rewriting the definition fixes this permanently, but it restarts the service once, so " +
                  "sessions end either way. Forcing the restart ends them without fixing anything."
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
          "The node stops and will not come back at login. This machine stays registered, with its " +
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
          title: "Rewriting the definition restarts the Subshell Node Service",
          messages: [
            "All running subshells on this machine will stop while it restarts.",
            "It is the last time that happens. The definition this writes spares panes, so every stop, restart " +
              "and uninstall after it is free.",
          ],
          acceptLabel: "Rewrite the definition",
          run: async () => finished(await runService("install", { settle: true })),
        });
      }),

    /**
     * Repointing is the ONE address change that costs nothing: `configure`
     * spends no setup key, mints no second node row and keeps the node key,
     * so there is nothing to confirm. Since the Control Plane collapse
     * (operator ruling 2026-09-22) it is also what the plane card's Re-enroll…
     * press IS: one address, and repointing the node to it.
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
          await nodeOpenPlane({ url });
          // An OPEN needs no receipt (operator ruling 2026-09-22): the
          // window or browser opening IS the feedback, so the runner
          // records nothing and no other section inherits an "Opened
          // <url>" line that is not its business.
          return finished(null);
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
        // Cleared at the press rather than on the way out: a card from the
        // last attempt sitting under a fresh spinner is a previous run's
        // verdict.
        onTmuxInstall(null);
        // Swallowed rather than surfaced: a probe that could not run is not a
        // reason to refuse the install the person actually asked for, and the
        // install's own result is about to say something more useful.
        const fresh = await nodeProbe().catch(() => null);
        if (fresh?.tmux) return finished(null);
        try {
          const result = await nodeInstallTmux();
          onTmuxInstall(result);
          return finished(result);
        } catch (err) {
          // A rejection is a failure of THIS install and belongs on its card,
          // not only on the shared message line — `NO_MANAGER` is the one that
          // reaches here, on a platform with nothing to drive.
          onTmuxInstall({ ok: false, stdout: "", stderr: errorText(err) });
          throw err;
        }
      }),

    /**
     * Save only. The runner still re-probes and refetches settings, because
     * nothing about this machine changed but the screen it should be on has
     * (the walk's `configured` watch reads the list). A rejection — a
     * non-http(s) URL, or the node's own address, which is always the pinned
     * row — comes back on the message line with Rust's canonicalization
     * refusing on the page's behalf.
     */
    addPlane: (url) =>
      runner.run(async () => {
        await nodePlaneAdd({ url });
        // An instantaneous save records nothing (operator ruling 2026-09-22):
        // the runner's settings refetch is what moves the address on screen,
        // and a receipt line for a save nobody watched is the same
        // foreign-output defect the opens had.
        return finished(null);
      }),

    /**
     * Remove behind a confirmed press — deleting a row someone might mean is
     * never a single click — and the confirmation says the whole reach of
     * the act: the list is this app's bookmarks, and detaching the MACHINE is
     * Service's business.
     */
    removePlane: (url) =>
      runner.run(async () =>
        asks({
          title: "Remove this control plane?",
          messages: ["This removes the address from this app's list only. Nothing on the control plane changes."],
          acceptLabel: "Remove",
          run: async () => {
            await nodePlaneRemove({ url });
            // No receipt: the row vanishing through the settings refetch IS
            // the feedback, one press one visible result.
            return finished(null);
          },
        }),
      ),

    /**
     * Three acts, one press, no confirmation.
     *
     * The press IS the consent: a person typed a single-use key into a field
     * labelled as one and pressed Register, so `confirm: true` goes straight
     * out. It is the ONLY key-spending path since the destructive re-enrol
     * screen retired (operator ruling 2026-09-22); its chain still runs the
     * two-call `confirm: false` first, because Rust's already-enrolled guard
     * can still fire on a machine that holds a config the probe cannot see,
     * and the panel it raises is the honest answer.
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

        // A no-op where a node CLI is already installed, which is what makes a
        // resumed run converge rather than refuse.
        if (probe?.step === "no-node") {
          onPhase("installing");
          const installed = await nodeInstallCli();
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
        // live config: `no-node` is reported for a missing binary AND for one
        // that cannot answer `status --json`, so a machine whose node CLI was
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
    openPlaneUrl: (url) =>
      runner.run(
        async () => {
          await nodeOpenPlaneUrl({ url });
          return finished(null);
        },
        { reprobe: false },
      ),
  };
}
