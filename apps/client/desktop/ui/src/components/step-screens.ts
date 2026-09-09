/**
 * One entry per `ProbeStep` the Rust side can emit, plus `enroll` — the one
 * step the USER chooses rather than the machine implying it.
 *
 * The page never invents state: the keys are the same serde values
 * `src-tauri/src/control.rs` emits, and every action ends by re-probing (the
 * runner does that), so the screen showing is always the screen the machine's
 * current facts imply.
 *
 * These are definitions rather than components on purpose — a screen is a
 * sentence, some notes, and a labelled list of things to do, and keeping that
 * as data makes it testable without a webview and keeps `step-card.tsx` about
 * layout.
 */
import type { NodeCommands } from "@/hooks/use-node-commands";
import { ENROLL_NOTES, tmuxHint } from "@/lib/copy";
import type { NodeSettings, Probe } from "@/lib/ipc";
import { paneRisk, type StepKey } from "@/lib/steps";

/** One button in a step's action row. */
export interface StepAction {
  label: string;
  onClick: () => void;
  /** The one obvious next thing on this screen. At most one per row. */
  primary?: boolean;
  /** Spends a credential, or ends sessions. */
  danger?: boolean;
  /**
   * Pointless without tmux, so DISABLED while the probe cannot find it (the
   * step card applies the gate; the copy explains it). `enroll` refuses
   * outright on a missing tmux, and a node whose service starts without one
   * comes up online with an empty harness inventory and 409s every launch —
   * the exact failure nobody attributes to tmux. A button that only produces
   * a refusal teaches the user to click through warnings.
   */
  needsTmux?: boolean;
}

/** What a step puts on the screen. */
export interface StepScreen {
  /** The one sentence naming what has to be true next. */
  body: string;
  /** Explanatory prose: what a setup key is, what a re-enroll costs. */
  notes?: readonly string[];
  /** A quieter closing line — usually the tmux warning or the log hint. */
  hint?: string;
  /** Whether the enrollment form belongs on this screen. */
  form?: boolean;
  actions: StepAction[];
}

/** Everything a screen reads. */
export interface StepContext {
  probe: Probe | undefined;
  settings: NodeSettings | undefined;
  commands: NodeCommands;
  /** True once the first probe has been attempted and did not produce facts. */
  probeFailed: boolean;
  onShowEnroll: () => void;
  onCancelEnroll: () => void;
}

/** Reveal buttons every registered screen carries. */
function pathActions({ commands }: StepContext): StepAction[] {
  return [
    { label: "Reveal configuration", onClick: () => commands.openPath("config-dir") },
    // Offered on every platform even though Linux has no log FILE: the Rust
    // side rejects with the `journalctl` command to run instead, which is the
    // actionable answer and the only place a user would find it.
    { label: "Open the agent log", onClick: () => commands.openPath("agent-log") },
  ];
}

/** The remedy for a definition that would kill live panes. */
function rewriteAction({ probe, commands }: StepContext): StepAction[] {
  return paneRisk(probe) ? [{ label: "Rewrite the service definition", onClick: commands.rewrite }] : [];
}

function reenrollAction(ctx: StepContext): StepAction[] {
  return [{ label: "Re-enroll this machine…", onClick: ctx.onShowEnroll }];
}

const SCREENS: Record<StepKey, (ctx: StepContext) => StepScreen> = {
  "no-agent": (ctx) => {
    const { probe, settings, commands } = ctx;
    // Two very different situations share this step, on purpose: a binary that
    // answered `version` but not `status --json` must NOT route to enroll,
    // because a transient read failure would then overwrite a live config.
    const answered = Boolean(probe?.agent);
    const actions: StepAction[] = [];
    // The unconfirmed install is for a machine with NO agent: nothing to stop,
    // nothing to overwrite, nothing to downgrade. When an agent WAS resolved,
    // the same command stops the service and replaces the binary it runs, which
    // is what `updateAgent` exists to ask about first. So no install is offered
    // here; a newer bundled agent is still offered by `step-card.tsx`, with its
    // confirmation.
    if (probe?.bundledVersion && !answered) {
      actions.push({ label: "Install the agent", onClick: commands.installAgent, primary: true });
    }
    if (answered) actions.push({ label: "Retry", onClick: commands.refresh, primary: true });
    actions.push({ label: "Choose an existing agent…", onClick: commands.pickBinary });
    if (settings?.agentBinPath) actions.push({ label: "Forget the chosen binary", onClick: commands.clearBinary });

    return {
      body: answered
        ? "An agent was found on this machine, but it could not report its status."
        : "No subshell agent was found on this machine.",
      notes: answered
        ? [
            "Nothing has been changed. This app will not offer to register a machine whose agent cannot say whether " +
              "it is already a node: enrolling overwrites the existing configuration and discards its node key.",
          ]
        : [
            "The agent is the small program that holds this machine's connection to the control plane and starts " +
              "the sessions launched here. Installing it copies the copy that ships inside this app to " +
              "~/.local/bin/subshell, and nothing is downloaded.",
          ],
      hint: probe?.bundledVersion ? "" : "This build ships no agent, so an existing one has to be pointed at.",
      actions,
    };
  },

  "not-enrolled": (ctx) => ({
    body: "This machine has an agent but is not registered with a control plane yet.",
    notes: ENROLL_NOTES,
    form: true,
    actions: [{ label: "Enroll this machine", onClick: ctx.commands.enroll, primary: true, needsTmux: true }],
    hint: tmuxHint(ctx.probe, "enroll"),
  }),

  // Reached from a registered step, never from the probe: re-enrolling is
  // something a user asks for, not something the machine's state implies.
  enroll: (ctx) => {
    const current = ctx.probe?.status?.nodeId;
    const where = ctx.probe?.status?.serverUrl;
    const lead = current
      ? `This machine is already enrolled as node ${current}${where ? ` on ${where}` : ""}. Enrolling again ` +
        "overwrites that configuration, registers a SECOND node on the control plane, and discards the current " +
        "node key, whose only copy is that file. The old node row stays behind and has to be deleted by hand."
      : "This machine already has a node configuration. Enrolling again replaces it.";
    return {
      body: "Register this machine again, with a different control plane or as a new node.",
      notes: [lead, ...ENROLL_NOTES],
      form: true,
      actions: [
        { label: "Enroll this machine", onClick: ctx.commands.enroll, danger: true, needsTmux: true },
        { label: "Cancel", onClick: ctx.onCancelEnroll },
      ],
      hint: tmuxHint(ctx.probe, "enroll"),
    };
  },

  "no-service": (ctx) => ({
    body: "This machine is registered, but nothing keeps its agent running.",
    notes: [
      "Running it in the background writes a user-level service definition (a systemd user unit on Linux, a " +
        "launchd agent on macOS) that starts the agent at login and brings it back if it exits.",
    ],
    actions: [
      {
        // Says both halves because the CLI's `install` does both — enable AND
        // start. A button that named only the backgrounding would leave the
        // user reaching for a Start that the next probe already answers.
        label: "Install and start the background service",
        onClick: () => ctx.commands.service("install", { settle: true }),
        primary: true,
        needsTmux: true,
      },
      ...pathActions(ctx),
      ...reenrollAction(ctx),
    ],
    hint: tmuxHint(ctx.probe, "service"),
  }),

  stopped: (ctx) => ({
    body: "The background service is installed, but the agent is not running.",
    actions: [
      {
        label: "Start",
        onClick: () => ctx.commands.service("start", { settle: true }),
        primary: true,
        needsTmux: true,
      },
      { label: "Uninstall the service", onClick: ctx.commands.uninstall },
      ...rewriteAction(ctx),
      ...pathActions(ctx),
      ...reenrollAction(ctx),
    ],
    hint: tmuxHint(ctx.probe, "service"),
  }),

  offline: (ctx) => ({
    body: "The service manager reports the agent as running, but no local daemon is heartbeating.",
    notes: [
      "An agent that starts, fails and is restarted on a timer looks exactly like this. Its own log says why: a " +
        "missing tmux, an unreachable control plane, or a node key the server no longer recognises.",
    ],
    actions: [
      { label: "Restart", onClick: ctx.commands.restart, primary: true, needsTmux: true },
      { label: "Stop", onClick: () => ctx.commands.service("stop") },
      // Reachable from here too: a crash-looping agent is exactly the case
      // where someone wants the supervision off while they investigate.
      { label: "Uninstall the service", onClick: ctx.commands.uninstall },
      ...rewriteAction(ctx),
      ...pathActions(ctx),
      ...reenrollAction(ctx),
    ],
    hint: ctx.probe?.paths?.agentLogHint ?? "",
  }),

  online: (ctx) => ({
    body: "This machine is registered and its agent is online. Sessions can be launched here from the browser.",
    actions: [
      { label: "Restart", onClick: ctx.commands.restart, needsTmux: true },
      { label: "Stop", onClick: () => ctx.commands.service("stop") },
      { label: "Uninstall the service", onClick: ctx.commands.uninstall },
      ...rewriteAction(ctx),
      ...pathActions(ctx),
      ...reenrollAction(ctx),
    ],
    hint: tmuxHint(ctx.probe, "service"),
  }),
};

/** What to show before the first probe lands, for a failed one, or for a step this build predates. */
function fallbackScreen(step: StepKey | null, ctx: StepContext): StepScreen {
  if (ctx.probe === undefined) {
    return ctx.probeFailed
      ? {
          body: "This machine's state could not be read.",
          actions: [{ label: "Retry", onClick: ctx.commands.refresh, primary: true }],
        }
      : { body: "Checking this machine…", actions: [] };
  }
  return {
    body: `This app does not know what to do about "${step}".`,
    hint: "That usually means the app is older than the agent it is managing.",
    actions: [{ label: "Retry", onClick: ctx.commands.refresh, primary: true }],
  };
}

/**
 * The screen for the step showing, or a fallback.
 *
 * A lookup rather than a `switch` so the table above is one flat list of
 * screens — and indexed off a typed key, so a step added to `ProbeStep`
 * without a screen here is a compile error rather than a blank panel.
 */
export function stepScreen(step: StepKey | null, ctx: StepContext): StepScreen {
  const build = step === null ? undefined : SCREENS[step];
  return build === undefined ? fallbackScreen(step, ctx) : build(ctx);
}
