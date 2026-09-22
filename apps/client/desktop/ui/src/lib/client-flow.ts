/**
 * The client's first run, pure (spec 2026-09-18 §§ 4-6).
 *
 * `node-assistant-state.ts` answers "what does this machine need next"; this
 * module answers the question that comes BEFORE it — "what did this person
 * come here to do" — and then the one that comes after: where a client that is
 * already set up lands. Both are decisions rather than facts, which is why
 * they live in a module a `bun test` can exercise with no webview.
 *
 * Two rules carry the whole design, and every branch below serves one of them:
 *
 * 1. **A configured client lands in the app, never on the dashboard.** Opening
 *    a control plane's own UI used to be the first-run action — the Connect
 *    screen's primary button persisted an address and opened the other window,
 *    while the setup this person had come to do carried on behind it. Nothing
 *    here opens that window; the doors live on the Control Plane section's
 *    Dashboard card as buttons.
 * 2. **Nothing touches this machine before the person says which half of the
 *    app they want.** Welcome and Choice exist so the register path is chosen
 *    rather than defaulted into, and so a watcher is never walked past tmux,
 *    a node install and a setup key to reach an address field.
 *
 * The walk itself is in-memory ({@link FteStep}, held by the page) and
 * deliberately NOT persisted: every fact it would store — an address, an
 * node CLI, a node config — is one the probe already reports, and a second source
 * of truth for a step that costs one re-pick to redo is the expensive kind of
 * cheap.
 */
import type { RailSection } from "@internal/assistant";
import type { NodeSettings, Probe } from "@/lib/ipc";
import type { NodeScreenId, NodeUserScreen } from "@/lib/node-assistant-state";

/**
 * Where in the first-run walk the page is, if it is in one at all.
 *
 * ```
 * welcome -> choice -> [node] -> tmux? -> register -> startup -> registering(progress) -> status
 *                   \-> [watch] -> connect -> status
 * ```
 *
 * `intro` and `null` both render Welcome — `null` is "the page has not started
 * a walk", `intro` is "the page started one and is on its first screen" — so a
 * relaunch and a Back from Choice land in the same place without the page
 * having to remember which it was.
 *
 * **`startup` sits BEFORE `registering`, and the order is the whole reason it
 * is a step of its own.** The chain's last act is `service install`, and the
 * start-at-login answer is what parameterizes that act — so asking afterwards
 * would mean either installing the service twice or collecting an answer that
 * arrives after the only moment it could have been used. The sibling app puts
 * the same question in the same place: Subshell Server's supervision choice is
 * on the Set Up screen ahead of its chain, never on the progress screen.
 *
 * `registering` is the phase the chain actually runs in, and the one place the
 * walk's precedence over {@link configured} is load-bearing — see
 * {@link clientScreen}.
 */
export type FteStep = "intro" | "choice" | "node" | "startup" | "registering" | "watch";

/** Everything the screen decision is made from. */
export interface FlowInput {
  /** The machine's own state, `undefined` before the first read. */
  probe?: Probe;
  /** This app's settings, `undefined` before the first read. */
  settings?: NodeSettings;
  /** The in-memory first-run phase; `null` when no walk is in progress. */
  step: FteStep | null;
  /** A screen the USER asked for (re-enrol, reset, about, app update), or null. */
  override: NodeUserScreen | null;
}

/**
 * Whether this client is set up — the one fact that decides whether a person
 * is shown a first run at all.
 *
 * Two rungs, since the plane list (operator ruling 2026-09-22): a saved list
 * of at least one address means someone has connected this app somewhere, and
 * an enrolled node means this machine belongs to a plane whatever the list
 * holds — a machine enrolled from the CLI has no stored rows yet, and it is
 * still not one to walk through a first run. The second rung matters on its
 * own now that Rust folds nothing: walking such a machine ends at Register,
 * and Register on an enrolled machine mints a second node row and discards
 * the only copy of its node key.
 *
 * @param settings - this app's settings, `undefined` before the first read
 * @param probe - the machine's own state, `undefined` before the first read
 */
export function configured(settings: NodeSettings | undefined, probe: Probe | undefined): boolean {
  if ((settings?.planes.length ?? 0) > 0) return true;
  return probe?.status?.nodeId != null;
}

/**
 * Which screen this client shows.
 *
 * The order is the argument:
 *
 * 1. **Nothing read yet ⇒ `null`**, and nothing outranks it — the frame shows
 *    its checking state rather than a screen it may have to replace a moment
 *    later. (The probe may still be missing here; Welcome and Choice touch
 *    nothing and need no machine facts, so waiting for it would only be a
 *    slower first paint.)
 * 2. **A screen the user asked for**, because it answers a press. It outranks
 *    the walk too: About from the tray is not a reason to lose the walk, and
 *    the page restores the step when the screen closes.
 * 3. **The walk, while the page says one is in progress.** This deliberately
 *    outranks {@link configured}, and `registering` is the concrete case:
 *    enroll settles the node's address mid-flight, before the service act it precedes
 *    has finished, so a configured-wins rule would replace the checklist a
 *    person is watching with Status between two rows of it. A walk ends when
 *    the page clears the step, not when a side effect lands.
 * 4. **A configured client ⇒ Control Plane** (operator ruling 2026-09-22,
 *    second addendum: the section is also the landing; previously Status),
 *    whatever the probe says. A stopped service, a node that will not answer,
 *    a client that never enrolled: all of them are one standing section or
 *    another of the app they had already set up, and Control Plane first says
 *    which plane they came back to.
 * 5. **A machine already half-built ⇒ Register.** A node that reports
 *    `not-enrolled` is a first run that got as far as installing and stopped
 *    (spec § 5.5): the walk is not news to this machine, and Register's chain
 *    re-runs the install as a no-op.
 * 6. Otherwise the machine is untouched, which is the only state Welcome is
 *    for.
 */
export function clientScreen(i: FlowInput): NodeScreenId | null {
  if (!i.settings) return null;
  if (i.override) return i.override;
  if (i.step) return walkScreen(i.step, i.probe);
  if (configured(i.settings, i.probe)) return "plane";
  // Spec § 5.5's resume: a node CLI exists and has no config. Keyed on the step
  // rather than on `probe.nodeBinary`, because `no-node` also covers a binary that
  // answered `version` and not `status --json` — a machine we cannot say
  // anything about, whose remedy is the register chain's own install.
  if (i.probe?.step === "not-enrolled") return "register";
  return "welcome";
}

/** The screen one phase of the walk shows. */
function walkScreen(step: FteStep, probe: Probe | undefined): NodeScreenId {
  switch (step) {
    case "choice":
      return "choice";
    case "watch":
      // The watch path's one screen: an address, and nothing about this
      // machine. No node, no key, nothing installed.
      return "connect";
    case "node":
      // tmux is a HARD gate, not a caption (spec § 2): every subshell runs in
      // a tmux pane, `subshell enroll` preflights it before the network call
      // precisely so an unenrollable box does not burn a one-time setup key,
      // and a Register button that only ever produces that refusal teaches
      // people to click through warnings. Unknown reads the same as absent —
      // fail closed, because the cost of being wrong is a spent key.
      return probe?.tmux ? "register" : "tmux";
    case "startup":
      // Asked with the form's answers in hand and before a single act runs:
      // the chain ends on `service install`, and this is the question that
      // parameterizes it.
      return "startup";
    case "registering":
      // The chain is running. The screen is the checklist ({@link registerSteps}),
      // not a spinner, because a dead button lettered "Registering…" reads
      // exactly like a hang.
      return "progress";
    default:
      return "welcome";
  }
}

/** How far the register chain has got. `form` is "nothing has run yet". */
export type RegisterPhase = "form" | "installing" | "enrolling" | "starting" | "done";

/** One act of the register chain, as the Setting Up… checklist renders it. */
export interface RegisterRow {
  id: "install" | "enroll" | "start";
  /** Names the ACT, in the imperative the chain performs it in. */
  label: string;
  state: "pending" | "active" | "done" | "failed";
}

/**
 * The three acts, in the order the chain runs them (spec § 6.1).
 *
 * The labels name what is done rather than what it is called — "Enroll this
 * machine", not "Enrollment" — because a row that fails has to read as the
 * sentence "this is the act that failed".
 */
const REGISTER_ACTS: readonly { id: RegisterRow["id"]; label: string }[] = [
  { id: "install", label: "Install the Subshell Node CLI" },
  { id: "enroll", label: "Enroll this machine" },
  { id: "start", label: "Start the node service" },
];

/** Which act each phase is running; `-1` for a phase that is running none. */
const PHASE_ACT: Record<RegisterPhase, number> = {
  form: -1,
  installing: 0,
  enrolling: 1,
  starting: 2,
  done: REGISTER_ACTS.length,
};

/** Whether the machine already shows the effect of one act, so the chain will skip it. */
function alreadyTrue(probe: Probe | undefined, id: RegisterRow["id"]): boolean {
  if (!probe) return false;
  switch (id) {
    // The same test the chain itself branches on (spec § 6.1): it installs
    // only when nothing on the ladder answered.
    case "install":
      return probe.step !== "no-node";
    case "enroll":
      return probe.status?.nodeId != null;
    case "start":
      return probe.step === "online";
  }
}

/**
 * The Setting Up… checklist: what the register chain has done, is doing, and
 * has not reached.
 *
 * Rows come from the PROBE and the act in flight, never from a timer — the
 * runner re-probes between acts, so they tick as effects land. That is what
 * makes "working" legible from "stuck", which is the defect this repo already
 * learned once on the server's reset: a dead button lettered "Registering…"
 * reads exactly like a hang.
 *
 * Two precedences, each with a way of lying it prevents:
 *
 * - **The act in flight outranks the probe.** A row whose effect is already on
 *   the machine still reads `active` while its act runs, so nothing says
 *   "done" over a spawn that has not returned.
 * - **A failure outranks both, forwards.** Rows after the one that failed stay
 *   `pending` even where the machine happens to satisfy them, because the
 *   person is reading this to learn how far THIS run got.
 *
 * @param probe - the machine, `undefined` before the first read
 * @param phase - which act the chain is running
 * @param failed - the act that failed, if one did; later rows never advance past it
 */
export function registerSteps(
  probe: Probe | undefined,
  phase: RegisterPhase,
  failed: RegisterRow["id"] | null = null,
): RegisterRow[] {
  // `?? -1` rather than an assertion: a phase this build predates should show
  // an untouched checklist, not throw inside a render.
  const running = PHASE_ACT[phase] ?? -1;
  const failedAt = failed ? REGISTER_ACTS.findIndex((a) => a.id === failed) : -1;
  return REGISTER_ACTS.map((act, index) => ({
    id: act.id,
    label: act.label,
    state: actState({ index, running, failedAt, satisfied: alreadyTrue(probe, act.id) }),
  }));
}

function actState(at: { index: number; running: number; failedAt: number; satisfied: boolean }): RegisterRow["state"] {
  if (at.failedAt >= 0) {
    if (at.index === at.failedAt) return "failed";
    if (at.index > at.failedAt) return "pending";
    return "done";
  }
  if (at.index < at.running) return "done";
  if (at.index === at.running) return "active";
  return at.satisfied ? "done" : "pending";
}

/**
 * The rail's standing sections, in display order (wave 3; the server's
 * {@link railFor} carries the same rule with its own five). Reset is the
 * destructive one, marked for the Rail's danger styling — the DOOR in the
 * rail, whose CONFIRMATION rides the rail (operator ruling 2026-09-22,
 * final word on the layout). FRAME-REPLACING is the RUNNING chain now:
 * from the confirm press to its end the rail hides and no exit renders,
 * off the runner's busy — which is where the "only thing happening"
 * premise, no way out from under the chain, actually lives. The press
 * itself stays visible and labeled (reset-screen.tsx), the same busy
 * affordance the server's room carries.
 */
export const CLIENT_RAIL_SECTIONS: RailSection[] = [
  // Control Plane reads FIRST (operator ruling 2026-09-22, second addendum):
  // the plane relationship is this app's subject, and the section is also
  // the landing (see {@link clientScreen} rule 4).
  { id: "plane", label: "Control Plane" },
  { id: "status", label: "Status" },
  // The node's own machinery (operator ruling 2026-09-22, live screenshots):
  // when the node is not installed, the install offer lives here; when it
  // is, the service lifecycle does. The status screen keeps machine state.
  { id: "service", label: "Service" },
  { id: "update", label: "Update" },
  { id: "about", label: "About" },
  { id: "reset", label: "Reset", danger: true },
];

/**
 * Whether THIS screen gets the rail, and which sections it shows (wave 3;
 * the same rule the server's `railFor` carries — spec 2026-09-21, with the
 * operator's 2026-09-22 rulings): the rail appears when the machine is
 * settled — configured, no first-run walk in progress — and the screen is
 * one of the standing kinds. Everything else answers null: every step of
 * the FTE walk, the focused acts (re-enroll, and the not-read state).
 * Reset's CONFIRMATION is a standing render since the 2026-09-22 ruling —
 * the sidebar stays; the frame-replacing premise moved to the running
 * chain, which reset-screen.tsx enforces off the runner's busy.
 *
 * `settled` is the part the screen cannot see: the tray can raise About
 * MID-WALK and the router honours it, and wave 2's ruling keeps the render
 * but takes away the rail — the exclusion is about the machine's journey,
 * not about who asked.
 *
 * The active section is not folded in here — a `RailSection` is
 * `{id, label}` by design — so {@link railActive} answers it, keyed on the
 * same screen.
 */
export function railFor(screen: NodeScreenId | null, settled: boolean): RailSection[] | null {
  if (!settled) return null;
  switch (screen) {
    case "status":
    case "service":
    case "plane":
    case "update":
    case "about":
    // The reset CONFIRMATION rides the rail now (operator ruling 2026-09-22,
    // final word on the layout): the sidebar stays, reset active and
    // danger-styled. The frame-replacing premise moves to the CHAIN — while
    // the reset runs, the rail and bar hide and the screen goes full-window
    // again (reset-screen.tsx owns that flip off the runner's busy).
    case "reset":
      return CLIENT_RAIL_SECTIONS;
    default:
      return null;
  }
}

/** The rail section THIS standing screen has active, or null when there is no rail. */
export function railActive(screen: NodeScreenId | null): string | null {
  switch (screen) {
    case "reset":
      return "reset";
    case "status":
      return "status";
    case "service":
      return "service";
    case "plane":
      return "plane";
    case "update":
      return "update";
    case "about":
      return "about";
    default:
      return null;
  }
}
