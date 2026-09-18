/**
 * One update act, pure (spec 2026-09-18 §§ 4, 6 and 7).
 *
 * **This app SHIPS the agent it drives**, so "update Subshell Client" and
 * "update the node agent" were never two independent things: each desktop
 * bundle carries the CLI it wraps (root `AGENTS.md`, "a desktop cut re-releases
 * that CLI"), and `node_install_agent` installs precisely that sidecar. Two
 * screens with two buttons made our packaging the person's problem, and
 * produced a loop that reads as a bug — update the app, and the next launch's
 * probe sees a bundled agent newer than the installed one and asks again.
 *
 * So it is ONE act in TWO PHASES, separated by the relaunch that the app
 * install ends in:
 *
 * 1. show what is behind, confirm, download and install the app bundle, write
 *    the marker, relaunch;
 * 2. the new build boots, Rust's `resume_decision` reads the marker against
 *    this machine, the probe reports it as {@link Probe.pendingInstall}, and
 *    this screen finishes the act by installing the bundled agent.
 *
 * **The order is forced, not chosen.** The new app carries a newer bundled
 * agent, so installing the agent first installs the OUTGOING bundle's copy and
 * leaves the machine behind again the moment the app lands.
 *
 * Everything here is a decision rather than a rendering, which is why it lives
 * in `lib/` and is exercised by `bun test` with no webview:
 * `components/assistant/update-screen.tsx` draws exactly what
 * {@link updateAct} returns.
 */
import type { AppUpdateCheck, PendingInstall, Probe } from "@/lib/ipc";
import { paneRisk } from "@/lib/steps";

/** Which half of the act a row is about. */
export type UpdateRowId = "app" | "agent";

/**
 * One version pair the screen states.
 *
 * `to` is nullable because of a fact the app cannot know before it downloads:
 * a desktop `release-manifest.json` carries the component version, the protocol
 * numbers and the asset digests — **not the version of the CLI inside the
 * bundle** (spec § 4.3). So while an app update is pending, the agent row can
 * name where the machine IS and not where it is going, and the screen falls
 * back to naming the app that ships it.
 */
export interface UpdateActRow {
  id: UpdateRowId;
  /** The product's own name, as a person reads it — never a package id. */
  label: string;
  from: string;
  to: string | null;
}

/**
 * Where the act is.
 *
 * `finishing` is the only one that survives a relaunch: it is the state a
 * process that did not exist when the person pressed wakes up in.
 */
export type UpdatePhase = "checking" | "idle" | "downloading" | "finishing" | "done";

/** Which half the primary press runs. */
export type UpdatePress = "app" | "agent";

/** Everything the act is decided from. */
export interface UpdateActInput {
  /** The release check's answer; `undefined` before one has landed. */
  check: AppUpdateCheck | undefined;
  /** The machine, `undefined` before the first probe. */
  probe: Probe | undefined;
  /** Whether the release check is in flight. */
  checking: boolean;
  /** Whether the app download and install is running — phase 1. */
  installingApp: boolean;
  /** Whether the bundled-agent install is running — phase 2, or a direct press. */
  installingAgent: boolean;
  /**
   * Whether THIS WINDOW installed the bundled agent and has not restarted the
   * daemon since.
   *
   * Page state, deliberately, exactly as `ranSetupHere` is on the server side
   * (spec § 7.1): the offer is about what just happened here, not a standing
   * verdict about the machine, and detecting the RUNNING daemon's version is
   * something no probe here can do — `rename(2)` leaves a running process on
   * its original inode, so the file says the new version while the process is
   * still the old one.
   */
  installedAgentHere: boolean;
  /** Whether the daemon has been restarted from this screen since that install. */
  restartedHere: boolean;
  /** An action is in flight on the shared runner — § 6's "already in flight". */
  busy: boolean;
}

/** What the screen draws. */
export interface UpdateAct {
  phase: UpdatePhase;
  /** The version pairs, in the order the act runs them: app first, then agent. */
  rows: UpdateActRow[];
  /**
   * Halves that cannot run, each saying what it did INSTEAD of what it
   * refused (§ 6).
   *
   * An array rather than the single string the plan sketched, because the two
   * refusals are independent facts about one machine — an air-gapped install
   * whose service also runs an unmanaged binary has both — and picking one to
   * show would hide the other behind fixing the first.
   */
  refusals: string[];
  /** Which half the primary press runs, or `null` when there is no press. */
  press: UpdatePress | null;
  /** The primary button's label, or `null` when there is none. */
  pressLabel: string | null;
  /** Whether that press is live. */
  canPress: boolean;
  /** Whether the act is finished and nothing was behind to start with. */
  upToDate: boolean;
  /**
   * The marker AS DECIDED, or null when there is nothing left of it here.
   *
   * Null on a machine whose agent half cannot run at all (see `unmanaged`
   * below), which is what keeps a marker an older build wrote from firing
   * phase 2 on a machine phase 1 would have refused. It is also what the
   * screen reads to know a press was already consented to in phase 1.
   */
  resume: PendingInstall | null;
  /**
   * Whether phase 2 should fire ITSELF, now, without asking.
   *
   * The press that consented happened in a process that no longer exists, so
   * there is nothing to ask — but a machine that cannot take the install must
   * never be one of these, or the screen auto-fires an act it is at the same
   * time refusing in words.
   */
  autoFinish: boolean;
  /**
   * Whether the act finished HERE and has nothing left to say about it.
   *
   * Its own flag rather than a corner of {@link upToDate}, which means
   * "nothing was behind to start with" and is deliberately false once this
   * window has installed something. Without it the screen went BLANK at the
   * end of a successful act — no rows, no offer, no sentence — the moment the
   * restart offer was taken or on a machine with no service to restart.
   */
  settled: boolean;
  /**
   * Phase 2's own offer (§ 7.1): the agent file was replaced and the daemon is
   * still running the previous version.
   *
   * Offered rather than done, because `node_install_agent` passes
   * `--no-restart` and that stays: restarting a node agent kills every
   * subshell on a machine whose service definition does not spare panes, which
   * is why the CLI itself refuses without `--force`. Doing it unasked would be
   * performing the destructive act on someone's behalf. **But not restarting
   * is not the same as not saying so**, and before this the app said nothing
   * at all once the install had succeeded.
   */
  offerRestart: boolean;
  /** Whether that restart would close live subshells — the sentence beside the offer. */
  restartCostsPanes: boolean;
}

/** What the app half is called on screen. */
const APP_LABEL = "Subshell Client app";
/**
 * What the CLI half is called on screen — the machine's agent, not this app.
 *
 * The binary's own name plus "CLI", so the version beside it is unambiguously
 * the agent's: this screen states TWO versions, and "Node agent" named the
 * ROLE rather than the thing whose version is on the row. Its twin in the
 * server app reads `subshell-server CLI` for the same reason (operator's
 * report, 2026-09-18).
 */
const AGENT_LABEL = "subshell CLI";

/** How a machine with no agent installed reads in a version column. */
const NOT_INSTALLED = "not installed";

/**
 * Decide the whole screen.
 *
 * Reads the probe and the release check and nothing else, so every case below
 * is reachable from a fixture.
 */
export function updateAct(input: UpdateActInput): UpdateAct {
  const { check, probe, checking, installingApp, installingAgent, installedAgentHere, restartedHere, busy } = input;

  const bundled = probe?.bundledVersion ?? null;
  const installedAgent = probe?.agent?.version ?? null;

  /**
   * Whether the agent half can run at all.
   *
   * `managed` is Rust's answer to "is the binary this machine actually runs
   * the copy at `~/.local/bin/subshell`" — so a machine whose service names a
   * binary somewhere else is one this app must not write to. Writing a file
   * the service does not invoke is an update that reports success and changes
   * nothing (root `AGENTS.md`, "never write the installed binary by
   * convention"). A machine with NO agent at all is not that case: there is
   * nothing to disagree with, and the install is a first install.
   */
  const unmanaged = probe !== undefined && probe.agent !== null && !probe.managed;
  const agentHalfRuns = bundled !== null && !unmanaged;

  /**
   * The marker, weighed once more against the half that would finish it.
   *
   * Rust now resolves an unmanaged machine's marker to `Resume::Clear`, so
   * this is defence in depth — but it is also the only layer that can SAY
   * anything: a marker written by a build that predates that fix still exists
   * on disk, and without this the act would report `finishing`, fire the
   * install by itself, and refuse it in the same breath (the § 6 sentence
   * below renders either way). Refusing it HERE means the screen shows that
   * refusal and nothing else — no press, no automatic second phase.
   */
  const resume = agentHalfRuns ? (probe?.pendingInstall ?? null) : null;

  const refusals: string[] = [];
  if (unmanaged) {
    const runs = probe?.agent?.argv[0] ?? "a binary this app did not install";
    refusals.push(
      `The agent this machine runs is ${runs}, which this app did not install and will not replace. The app is ` +
        "updated; update that agent where it came from.",
    );
  }
  // An air-gapped install is an ordinary state of a machine, not an error —
  // and the agent half is entirely local, so the screen still has a job.
  if (check?.reason) refusals.push(`${check.reason}. The agent that ships inside this app can still be installed.`);

  const rows: UpdateActRow[] = [];
  const appBehind = check?.latest != null;
  if (appBehind && check) {
    rows.push({ id: "app", label: APP_LABEL, from: check.current, to: check.latest });
  }
  // The agent row is shown whenever the act would touch the agent: because
  // the installed copy is behind the one in THIS bundle, or because a new app
  // is coming and will bring its own. The second case is where `to` is null —
  // see {@link UpdateActRow}.
  const agentBehind = probe?.agentChoice === "upgrade-available" || probe?.agentChoice === "install-bundled";
  if (agentHalfRuns && (agentBehind || appBehind)) {
    rows.push({
      id: "agent",
      label: AGENT_LABEL,
      from: installedAgent ?? NOT_INSTALLED,
      to: appBehind ? null : bundled,
    });
  }

  const phase = decidePhase({
    installingApp,
    installingAgent,
    resuming: resume !== null,
    installedAgentHere,
    checking,
    checked: check !== undefined,
  });

  // App first, always: the new bundle carries a newer agent, so installing the
  // agent first installs the outgoing copy.
  const press: UpdatePress | null = appBehind ? "app" : agentBehind && agentHalfRuns ? "agent" : null;
  const pressLabel =
    press === "app"
      ? `Download and Install ${check?.latest ?? ""}`.trim()
      : press === "agent"
        ? `Install the agent${bundled ? ` (${bundled})` : ""}`
        : null;

  // A marker halted at the attempt limit is the one state where the press is
  // a RETRY: the boot stopped firing on the person's behalf (spec § 5), so the
  // screen has to offer it rather than wait.
  const retrying = resume?.halted === true;
  // An act that is finishing itself offers NO button. A disabled control
  // lettered with the thing already happening beside it says less than no
  // control at all, and the one state where the second phase does need a press
  // is the one it has stopped making on its own.
  const silent = phase === "finishing" && !retrying;
  const offerRestart = installedAgentHere && !restartedHere && probe?.service?.installed === true;

  return {
    phase,
    rows,
    refusals,
    press: silent ? null : retrying ? "agent" : press,
    pressLabel: silent ? null : retrying ? "Retry" : pressLabel,
    canPress: !silent && !busy && !installingApp && !installingAgent && (retrying || press !== null),
    // A refusal is enough to make this false on its own: a machine running
    // somebody else's agent is not one this app may call up to date, and the
    // air-gapped `reason` it used to name explicitly is one of those refusals.
    upToDate:
      rows.length === 0 && resume === null && !installedAgentHere && check !== undefined && refusals.length === 0,
    resume,
    autoFinish: resume !== null && !retrying,
    settled: phase === "done" && rows.length === 0 && !offerRestart,
    offerRestart,
    // The same fact every other teardown action on this machine reads, never
    // a second reading of it.
    restartCostsPanes: paneRisk(probe),
  };
}

/**
 * The phase, in the order the states outrank each other.
 *
 * An act in flight outranks everything, because the screen must never say
 * "up to date" over a download that is running; the marker outranks a
 * completed install, because a machine that was interrupted twice is still
 * mid-act.
 */
function decidePhase(at: {
  installingApp: boolean;
  installingAgent: boolean;
  resuming: boolean;
  installedAgentHere: boolean;
  checking: boolean;
  checked: boolean;
}): UpdatePhase {
  if (at.installingApp) return "downloading";
  if (at.installingAgent || at.resuming) return "finishing";
  if (at.installedAgentHere) return "done";
  if (at.checking && !at.checked) return "checking";
  return "idle";
}
