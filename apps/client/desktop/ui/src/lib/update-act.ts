/**
 * One update act, pure (spec 2026-09-18 §§ 4, 6 and 7).
 *
 * **This app SHIPS the node CLI it drives**, so "update Subshell Client" and
 * "update the node CLI" were never two independent things: each desktop
 * bundle carries the CLI it wraps (root `AGENTS.md`, "a desktop cut re-releases
 * that CLI"), and `node_install_cli` installs precisely that sidecar. Two
 * screens with two buttons made our packaging the person's problem, and
 * produced a loop that reads as a bug — update the app, and the next launch's
 * probe sees a bundled node CLI newer than the installed one and asks again.
 *
 * So it is ONE act in TWO PHASES, separated by the relaunch that the app
 * install ends in:
 *
 * 1. show what is behind, confirm, download and install the app bundle, write
 *    the marker, relaunch;
 * 2. the new build boots, Rust's `resume_decision` reads the marker against
 *    this machine, the probe reports it as {@link Probe.pendingInstall}, and
 *    this screen finishes the act by installing the bundled node CLI.
 *
 * **The order is forced, not chosen.** The new app carries a newer bundled
 * CLI, so installing the CLI first installs the OUTGOING bundle's copy and
 * leaves the machine behind again the moment the app lands.
 *
 * **And it is a SELECTION rather than always both halves** (§ 13, amended
 * after an operator ran an app at 0.8.1 beside a CLI they had updated by hand
 * to 0.10.1). One act is a simplification exactly while the two halves point
 * the same way; when they diverge it is a claim about the machine that is
 * wrong — the screen named a version older than the running one as a target
 * and promised an install that could not happen. So every component gets a
 * row, a row with an available act carries a checkbox SELECTED BY DEFAULT, and
 * a row with none states why in the cell where its checkbox would be. It
 * degenerates correctly: with both halves behind, both are ticked and one
 * press does both, which is § 2's D1 unchanged.
 *
 * **There is no Force here** (§ 13.3). Force overrides the pane-safety refusal
 * on a service RESTART, and phase 2 in this app restarts nothing — it OFFERS
 * the restart (§ 7.1), whose own override rides on the CLI's verbatim refusal.
 * A checkbox governing nothing, rendered for symmetry with Subshell Server's
 * screen, would be the same kind of false promise § 13 removes.
 *
 * Everything here is a decision rather than a rendering, which is why it lives
 * in `lib/` and is exercised by `bun test` with no webview:
 * `components/assistant/update-screen.tsx` draws exactly what
 * {@link updateAct} returns.
 */
import type { AppUpdateCheck, PendingInstall, Probe } from "@/lib/ipc";
import { paneRisk } from "@/lib/steps";

/** Which half of the act a row is about. */
export type UpdateRowId = "app" | "node";

/**
 * What a component would become.
 *
 * `with-app` is a fact the app cannot know before it downloads: a desktop
 * `release-manifest.json` carries the component version, the protocol numbers
 * and the asset digests — **not the version of the CLI inside the bundle**
 * (spec § 4.3). So while an app update is pending, the node row names where
 * the machine IS and not where it is going, and falls back to naming the app
 * that ships it.
 *
 * `none` is a component that is not moving, whatever the press does — and it
 * is the half of the § 13 fix that shows: a machine running a node CLI NEWER
 * than the one inside this app had that CLI named as a target it would be
 * replaced by.
 */
export type UpdateRowTarget = { kind: "version"; version: string } | { kind: "with-app" } | { kind: "none" };

/**
 * One component's line in the table (spec § 13.1): what it runs, what it would
 * become, and a checkbox where there is something to do.
 *
 * The three fields at the end are one decision read three ways, and the rule
 * between them is § 13.1's: **never a disabled checkbox**. A control that
 * cannot be used says "not now" without saying anything, and here the reason
 * IS the content — so a row the person may change carries a checkbox, and a
 * row they may not carries the sentence explaining why in the cell where the
 * checkbox would have been.
 */
export interface UpdateActRow {
  id: UpdateRowId;
  /** The product's own name, as a person reads it — never a package id. */
  label: string;
  from: string;
  to: UpdateRowTarget;
  /** Whether the press will act on this row. */
  selected: boolean;
  /** Whether the person may change that — a checkbox is rendered if and only if this is true. */
  selectable: boolean;
  /**
   * Why they may not, in the cell where the checkbox would be.
   *
   * Null while an act is in flight: there is no standing decision left to
   * explain, the press is gone too, and the progress line below says what is
   * happening.
   */
  reason: string | null;
}

/**
 * Which halves the person has ticked — React state in the screen, passed in.
 *
 * Partial on purpose: an absent key means "as this act decided", which is
 * SELECTED for anything actionable (§ 13.1 — the default is the old
 * always-both behaviour, and with both halves behind one press still does
 * both). Without that, the screen would need an effect to seed a selection
 * against facts that arrive one probe later, and a seeding effect racing a
 * probe is how a checkbox comes to disagree with the row it sits on.
 */
export type UpdateSelection = Partial<Record<UpdateRowId, boolean>>;

/**
 * Where the act is.
 *
 * `finishing` is the only one that survives a relaunch: it is the state a
 * process that did not exist when the person pressed wakes up in.
 */
export type UpdatePhase = "checking" | "idle" | "downloading" | "finishing" | "done";

/** Which half the primary press runs. */
export type UpdatePress = "app" | "node";

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
  /** Whether the bundled node CLI's install is running — phase 2, or a direct press. */
  installingNode: boolean;
  /**
   * Whether THIS WINDOW installed the bundled node CLI and has not restarted the
   * daemon since.
   *
   * Page state, deliberately, exactly as `ranSetupHere` is on the server side
   * (spec § 7.1): the offer is about what just happened here, not a standing
   * verdict about the machine, and detecting the RUNNING daemon's version is
   * something no probe here can do — `rename(2)` leaves a running process on
   * its original inode, so the file says the new version while the process is
   * still the old one.
   */
  installedNodeHere: boolean;
  /** Whether the daemon has been restarted from this screen since that install. */
  restartedHere: boolean;
  /** An action is in flight on the shared runner — § 6's "already in flight". */
  busy: boolean;
  /** What the person has ticked, defaulting to everything actionable. */
  selection: UpdateSelection;
}

/** What the screen draws. */
export interface UpdateAct {
  phase: UpdatePhase;
  /** The version pairs, in the order the act runs them: app first, then node CLI. */
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
   * Null on a machine whose node half cannot run at all (see `unmanaged`
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
   * Phase 2's own offer (§ 7.1): the node binary was replaced and the daemon is
   * still running the previous version.
   *
   * Offered rather than done, because `node_install_cli` passes
   * `--no-restart` and that stays: restarting a node kills every
   * subshell on a machine whose service definition does not spare panes, which
   * is why the CLI itself refuses without `--force`. Doing it unasked would be
   * performing the destructive act on someone's behalf. **But not restarting
   * is not the same as not saying so**, and before this the app said nothing
   * at all once the install had succeeded.
   */
  offerRestart: boolean;
  /** Whether that restart would close live subshells — the sentence beside the offer. */
  restartCostsPanes: boolean;
  /**
   * Whether pressing will also install the node CLI that ships inside the app.
   *
   * The screen's own promise reads off this and nothing else (§ 13: "any
   * sentence promising the node half must stop promising it when it will not
   * run"). False on the machine § 13 was reported from — a node CLI installed by
   * hand that is NEWER than the bundled one — where phase 2 answers
   * `Resume::Clear` and installs nothing.
   */
  pressInstallsNodeCli: boolean;
}

/**
 * What the app half is called on screen — `Subshell <Product> <Form>`, the one
 * rule all three update surfaces follow since 2026-09-18, mirroring the
 * cli-server / cli-node / desktop-server / desktop-client release components.
 */
const APP_LABEL = "Subshell Client App";
/**
 * What the CLI half is called on screen — the machine's node, not this app.
 *
 * "Node" plus "CLI", so the version beside it is unambiguously that binary's:
 * this screen states TWO versions, and "Node agent" named the ROLE rather than
 * the thing whose version is on the row. Its twin in the server app reads
 * `Subshell Server CLI` for the same reason (operator's report, 2026-09-18).
 * `Subshell Client App` beside `Subshell Node CLI` is not a mismatch: this app
 * is where a machine becomes a node, which is why there is no
 * `apps/node/desktop`.
 */
const NODE_CLI_LABEL = "Subshell Node CLI";

/** How a machine with no node CLI installed reads in a version column. */
const NOT_INSTALLED = "not installed";
/**
 * What the app row's "running" cell says before a check has answered.
 *
 * The app's own version reaches this model only through the release check
 * (`check.current`), so a table opened by the NODE half alone — the node CLI is
 * behind, and the check has not landed or rejected outright — has a row it
 * cannot number. A dash and a reason beat omitting the component, which is the
 * guess § 13.1 exists to remove.
 */
const NOT_ASKED = "—";

/**
 * Decide the whole screen.
 *
 * Reads the probe and the release check and nothing else, so every case below
 * is reachable from a fixture.
 */
export function updateAct(input: UpdateActInput): UpdateAct {
  const { check, probe, checking, installingApp, installingNode, installedNodeHere, restartedHere, busy, selection } =
    input;

  const bundled = probe?.bundledVersion ?? null;
  const installedNode = probe?.nodeBinary?.version ?? null;

  /**
   * Whether the node half can run at all.
   *
   * `managed` is Rust's answer to "is the binary this machine actually runs
   * the copy at `~/.local/bin/subshell`" — so a machine whose service names a
   * binary somewhere else is one this app must not write to. Writing a file
   * the service does not invoke is an update that reports success and changes
   * nothing (root `AGENTS.md`, "never write the installed binary by
   * convention"). A machine with NO node CLI at all is not that case: there is
   * nothing to disagree with, and the install is a first install.
   */
  const unmanaged = probe !== undefined && probe.nodeBinary !== null && !probe.managed;
  const nodeHalfRuns = bundled !== null && !unmanaged;

  /**
   * What each half can do, before anyone ticks anything.
   *
   * `nodeNewerInstalled` is the state § 13 was reported from: the ladder
   * ADOPTS a node CLI somebody installed by hand when it is newer than the one
   * inside this app (`decide_node`, which never downgrades), so there is no
   * act here at all — and the screen used to name that newer version as a
   * target it would be replaced by.
   */
  const appAvailable = check?.latest != null;
  const nodeBehind = probe?.nodeChoice === "upgrade-available" || probe?.nodeChoice === "install-bundled";
  const nodeNewerInstalled = probe?.nodeChoice === "adopt-installed";
  const nodeAvailable = nodeHalfRuns && nodeBehind;

  /**
   * The marker, weighed once more against the half that would finish it.
   *
   * Rust resolves both of these to `Resume::Clear` — an unmanaged machine and
   * one running a newer node CLI than the bundle (`comparable_node_version` is
   * what `decide()` always compared) — so this is defence in depth. But it is
   * also the only layer that can SAY anything: a marker written by a build
   * that predates those fixes still exists on disk, and without this the act
   * would report `finishing`, fire the install by itself, and refuse it in the
   * same breath (the § 6 sentence below renders either way). Refusing it HERE
   * means the screen shows that refusal and nothing else — no press, no
   * automatic second phase. On the newer-CLI machine it is not only a
   * display fix: § 13.2 forbids installing an older bundled CLI over a newer
   * installed one under ANY consent, and an auto-firing marker is a consent
   * given before the machine was in that state.
   */
  const resume = nodeHalfRuns && !nodeNewerInstalled ? (probe?.pendingInstall ?? null) : null;

  /**
   * The ticks, resolved.
   *
   * **The node half is tickable under an app press too** (review,
   * 2026-09-18). It was not, on the reasoning that the act crosses a relaunch
   * and the only thing crossing it is a marker carrying no selection — so a
   * checkbox here would be a control this process could not honour in the
   * process that acts on it. That was true of `node_install_app_update` as
   * written and NOT structural: Subshell Server makes the marker's PRESENCE
   * the selection, and this app's command now takes the same boolean. A
   * cleared row writes no marker, so phase 2 simply does not run and someone
   * who deliberately keeps an older `~/.local/bin/subshell` keeps it.
   *
   * What stays true is the SHAPE of the row under an app press: the node CLI that
   * lands is the NEW bundle's, whose version this build cannot know, so the
   * target reads "ships with the new app" rather than a number. Spec § 13.3
   * says Force is the one difference between the two apps' screens; this is
   * what makes that sentence true again.
   */
  const ticked = (id: UpdateRowId): boolean => selection[id] ?? true;
  const appSelected = appAvailable && ticked("app");
  // An act of its OWN, rather than the app act's tail — which is what decides
  // whether the row names a version or says it ships with the new app.
  const nodeStandalone = nodeAvailable && !appSelected;
  const nodeSelected = nodeStandalone && ticked("node");
  /** Whether the node half is the app press's TAIL, if the row stays ticked. */
  const nodeRidesIfTicked = appSelected && nodeHalfRuns && !nodeNewerInstalled;
  /** Whether the app press ends by installing the node CLI that lands with it. */
  const nodeRidesAlong = nodeRidesIfTicked && ticked("node");
  /** Whether the node row is a checkbox at all, on either footing. */
  const nodeTickable = nodeStandalone || nodeRidesIfTicked;

  const refusals: string[] = [];
  if (unmanaged) {
    const runs = probe?.nodeBinary?.argv[0] ?? "a binary this app did not install";
    refusals.push(
      `The node CLI this machine runs is ${runs}, which this app did not install and will not replace.` +
        (appAvailable ? " The app half of this update still runs;" : "") +
        " update that CLI where it came from.",
    );
  }
  // An air-gapped install is an ordinary state of a machine, not an error —
  // and the node half is entirely local, so the screen may still have a job.
  // Only where it actually does, though: this sentence is one of the promises
  // § 13 makes conditional, and on a machine running a newer node CLI by hand
  // there is nothing here to install.
  if (check?.reason) {
    refusals.push(
      nodeAvailable ? `${check.reason}. The node CLI that ships inside this app can still be installed.` : check.reason,
    );
  }

  const phase = decidePhase({
    installingApp,
    installingNode,
    resuming: resume !== null,
    installedNodeHere,
    checking,
    checked: check !== undefined,
  });
  /** Nothing is left to decide while something is running. */
  const inFlight = installingApp || installingNode || resume !== null;

  const rows: UpdateActRow[] = [];
  /**
   * **Whether there is a TABLE at all** — and if there is, every component is
   * in it (§ 13.1; review, 2026-09-18).
   *
   * Two rules used to be one gate each, and between them they could drop a
   * component from a table the other one had opened: an air-gapped check with
   * a current node CLI stated the app and said nothing about the CLI, and a
   * current app beside a behind CLI stated the CLI and said nothing about
   * the app. Either way the reader is left guessing at exactly the component
   * the table exists to describe.
   *
   * So the question is asked ONCE. Where nothing is in question there are no
   * rows — that is this app's "nothing to say", and what `upToDate` and
   * `settled` are read from — and where anything is, both rows appear, which
   * is what Subshell Server does unconditionally.
   */
  const appInQuestion = check !== undefined && (appAvailable || check.reason !== null);
  const nodeInQuestion = nodeBehind || unmanaged;
  const showTable = appInQuestion || nodeInQuestion;
  if (showTable) {
    rows.push({
      id: "app",
      label: APP_LABEL,
      // **Including when no check has answered** (second review, 2026-09-18).
      // `check` is undefined on the first paint and PERMANENTLY when
      // `node_check_app_update` rejects — a build with no updater pubkey, the
      // reserved `Err` case — and gating the app row on it put the node row
      // alone in a table both this file and AGENTS.md say cannot happen.
      from: check?.current ?? NOT_ASKED,
      to: check?.latest != null ? { kind: "version", version: check.latest } : { kind: "none" },
      selected: appSelected,
      selectable: appAvailable && !inFlight,
      // Four states, not two (review, 2026-09-18): "no act" is a check still
      // running, a check that could not run, or an app that is simply
      // current — and calling the last one "cannot be checked" reports a
      // failure that did not happen.
      reason:
        check === undefined
          ? checking
            ? "checking…"
            : "cannot be checked"
          : appAvailable
            ? null
            : check.reason !== null
              ? "cannot be checked"
              : "up to date",
    });
  }
  // The node CLI's own row, on the same gate as the app's — see `showTable`.
  if (showTable) {
    rows.push({
      id: "node",
      label: NODE_CLI_LABEL,
      from: installedNode ?? NOT_INSTALLED,
      // The target the row would take, ticked or not — an unticked row still
      // has to say what ticking it would do.
      to: nodeRidesIfTicked
        ? { kind: "with-app" }
        : nodeStandalone
          ? { kind: "version", version: bundled }
          : { kind: "none" },
      selected: nodeSelected || nodeRidesAlong,
      selectable: nodeTickable && !inFlight,
      reason: nodeRowReason({
        unmanaged,
        nodeNewerInstalled,
        nodeTickable,
        inFlight,
        unknownBundle: bundled === null,
      }),
    });
  }

  // A marker halted at the attempt limit is the one state where the press is
  // a RETRY: the boot stopped firing on the person's behalf (spec § 5), so the
  // screen has to offer it rather than wait.
  const retrying = resume?.halted === true;
  // An act that is finishing itself offers NO button. A disabled control
  // lettered with the thing already happening beside it says less than no
  // control at all, and the one state where the second phase does need a press
  // is the one it has stopped making on its own.
  const silent = phase === "finishing" && !retrying;
  const offerRestart = installedNodeHere && !restartedHere && probe?.service?.installed === true;

  // App first, always: the new bundle carries a newer node CLI, so installing
  // the CLI first installs the outgoing copy.
  const press: UpdatePress | null = appSelected ? "app" : nodeSelected ? "node" : null;
  /** Something is offered, and the person has unticked all of it. */
  const nothingSelected = press === null && (appAvailable || nodeAvailable);
  const pressLabel =
    press === "app"
      ? `Download and Install ${check?.latest ?? ""}`.trim()
      : press === "node"
        ? `Install the node${bundled ? ` (${bundled})` : ""}`
        : // Dead rather than absent (§ 13.1), and lettered with the reason it is
          // dead: a button that still named an act nobody selected would be
          // making the same claim the table just stopped making.
          nothingSelected
          ? "Nothing selected"
          : null;

  return {
    phase,
    rows,
    refusals,
    press: silent ? null : retrying ? "node" : press,
    pressLabel: silent ? null : retrying ? "Retry" : pressLabel,
    canPress: !silent && !busy && !installingApp && !installingNode && (retrying || press !== null),
    // A refusal is enough to make this false on its own: a machine running
    // somebody else's node CLI is not one this app may call up to date, and the
    // air-gapped `reason` it used to name explicitly is one of those refusals.
    upToDate:
      rows.length === 0 && resume === null && !installedNodeHere && check !== undefined && refusals.length === 0,
    resume,
    autoFinish: resume !== null && !retrying,
    settled: phase === "done" && rows.length === 0 && !offerRestart,
    offerRestart,
    // The same fact every other teardown action on this machine reads, never
    // a second reading of it.
    restartCostsPanes: paneRisk(probe),
    pressInstallsNodeCli: nodeRidesAlong,
  };
}

/**
 * What stands where the node row's checkbox would be.
 *
 * Null means a checkbox is rendered there instead — or, while an act is in
 * flight, nothing at all: the decision has been made and the progress line is
 * what the screen has to say.
 */
function nodeRowReason(at: {
  unmanaged: boolean;
  nodeNewerInstalled: boolean;
  /** A checkbox renders here, so nothing else may. */
  nodeTickable: boolean;
  inFlight: boolean;
  /** This build does not say which node CLI it ships, so nothing can be offered. */
  unknownBundle: boolean;
}): string | null {
  // Ordered by which fact outranks which: a machine this app may not write to
  // is that before it is anything else, and a newer installed node CLI is a
  // refusal rather than a choice — `--force` may never install an older CLI
  // over a newer one (§ 13.2), so there is deliberately no way to tick it.
  if (at.unmanaged) return "runs another binary";
  // Below `unmanaged` because that is the stronger statement about the same
  // machine, and above everything else because a build that will not name what
  // it ships cannot be up to date or behind — it is unanswerable.
  if (at.unknownBundle) return "this build does not say which node CLI it ships";
  if (at.nodeNewerInstalled) return "you run a newer one";
  // A checkbox and a reason are alternatives, never both: a reason beside a
  // live control says "not now" about something that is plainly on offer.
  // "installs with the app" used to sit here, when the row under an app press
  // was a statement rather than a choice; the `to` cell says that now.
  if (at.nodeTickable || at.inFlight) return null;
  return "up to date";
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
  installingNode: boolean;
  resuming: boolean;
  installedNodeHere: boolean;
  checking: boolean;
  checked: boolean;
}): UpdatePhase {
  if (at.installingApp) return "downloading";
  if (at.installingNode || at.resuming) return "finishing";
  if (at.installedNodeHere) return "done";
  if (at.checking && !at.checked) return "checking";
  return "idle";
}
