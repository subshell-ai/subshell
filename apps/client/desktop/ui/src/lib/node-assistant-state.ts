/**
 * The node assistant's vocabulary, pure (spec 2026-09-12 § 6.4).
 *
 * What each screen is called, and which service verb a step calls for. Page
 * state — the action runner, the enroll form, the screen the user asked for —
 * stays in `app.tsx`, and the ROUTING moved to `lib/client-flow.ts` with the
 * first run (spec 2026-09-18): `clientScreen` asks what a person came to do
 * before it asks what the machine needs, which is a question this module's
 * probe-shaped `screenFor` could not pose. There is no second router — the
 * old one is gone rather than kept beside it, because two functions answering
 * "which screen" is how they come to disagree.
 */
import type { ProbeStep } from "@/lib/ipc";

/**
 * The assistant's screens. One decision each (spec § 6.4).
 *
 * The first seven are the first-run walk and the landing it ends on (spec
 * 2026-09-18): a person is asked what they came to do before this app touches
 * their machine, and a client that is already set up lands on `status` —
 * never on a step screen, and never on the server's dashboard, which is a
 * button there rather than something that happens to them.
 *
 * The rest are what a person asked for. `connect` is the WATCH path's one
 * screen (an address, and nothing about this machine); `enroll` is only the
 * re-enrolment a working node asks for.
 *
 * Three ids are GONE with the first run, and their absence is the design
 * rather than an omission: `connected`, `service` and `install-agent` were the
 * probe-derived landings, and `clientScreen` routes every configured client to
 * `status` instead — which carries what each of them offered (the service
 * verb, the pane-safety rewrite, the reveals, the node-binary picker, and the
 * refusal that keeps an unreadable node CLI from being offered registration). A
 * screen nothing can route to is not a recovery path, it is dead code that
 * reads like one.
 */
export type NodeScreenId =
  | "welcome"
  | "choice"
  | "tmux"
  | "register"
  | "startup"
  | "progress"
  | "status"
  | "service"
  | "plane"
  | "connect"
  | "enroll"
  | "reset"
  | "about"
  | "update";

/**
 * The runtime list beside the type, for whatever has to iterate the set —
 * today the title tests, which assert that every screen has one and that none
 * of them re-introduces a label that reads as truncated.
 */
export const NODE_SCREEN_IDS: readonly NodeScreenId[] = [
  "welcome",
  "choice",
  "tmux",
  "register",
  "startup",
  "progress",
  "status",
  "service",
  "plane",
  "connect",
  "enroll",
  "reset",
  "about",
  "update",
];

/**
 * A screen the USER chose rather than one the machine implies.
 *
 * Re-enrolling and resetting are things a person asks for from a machine that
 * is already working; no probe ever implies either. `service` and `plane`
 * joined them in wave 3's follow-ups (operator ruling 2026-09-22): the rail's
 * Service and Control Plane sections are screens a person SELECTS, and the
 * override state is how a select persists. `about` joined them when
 * the permanent colophon under every screen was removed (operator's call,
 * 2026-09-12): what this app is and under what terms is something a person
 * ASKS for, not something that sits under the question being asked.
 *
 * `update` joined them on 2026-09-15 for the same reason and one more: half
 * its facts come from the NETWORK rather than from this machine, so no probe
 * could imply it even in principle. Reached from the tray's "Check for
 * Updates…" and from the status screen's More…. It is the one user screen that
 * the machine can nevertheless RAISE: a marker left by an app update is a
 * consented act with a half still outstanding, and `app.tsx` opens this screen
 * once per launch when the probe reports one (spec 2026-09-18 § 4.2).
 */
export type NodeUserScreen = "enroll" | "reset" | "about" | "update" | "service" | "plane" | "status";

/**
 * ONE word for where you are, on both platforms (operator's call, 2026-09-12).
 *
 * There used to be a `darwin ? "This Mac" : "This Machine"` split here. The
 * macOS feel this assistant is after comes from its SHAPE — one decision per
 * full-window screen, fixed button positions, screens that ask nothing never
 * appearing — not from its vocabulary. "Mac" bought very little of that and
 * cost a branch, a test matrix on every string, and one real misreading: a
 * label ending on "Mac", which is a prefix of the other platform's own word,
 * was reported as a truncated layout bug.
 */
const HERE = "This Machine";

/**
 * The screen's title, in the assistant's voice (spec 2026-09-11 § 3.2: Title
 * Case, one line, no trailing punctuation).
 *
 * It takes the screen and nothing else. The one title that ever read the probe
 * was the service screen's, which named WHICH failure it was looking at; that
 * screen is gone, and the state a configured machine is in is now said by the
 * status screen's own badge and problem line rather than by a heading that
 * changes under a person while they read it.
 */
export function screenTitle(screen: NodeScreenId): string {
  switch (screen) {
    case "welcome":
      // Subshell Server's own first screen reads "Welcome to Subshell"; this
      // one names the PRODUCT the person just installed, because both apps
      // can be on one machine and the welcome is the one moment nothing else
      // on screen says which of them is asking.
      return "Welcome to Subshell Client";
    case "choice":
      // The one title that is a question rather than a verb phrase, and so
      // the one that carries punctuation: the screen's whole job is to ask
      // (spec 2026-09-18 § 4), and a question mark removed to satisfy a house
      // rule reads as a statement the app cannot make.
      return "What Would You Like to Do?";
    case "tmux":
      // Verbatim the server's own tmux title. Both apps install the same
      // program for the same reason, and one string is how they read as one
      // product. Lower-case `tmux` because that is the program's name.
      return "Install tmux";
    case "register":
      // "Register", not "Enroll": this is the press that makes the machine a
      // node, and `enroll` is the CLI's word for the same act — which this
      // window still uses for the DIFFERENT, destructive one (re-enrolling a
      // working node). Two acts, two words.
      return `Register ${HERE}`;
    case "startup":
      return "How This Node Runs";
    case "progress":
      // Names the act rather than its result, exactly as the server's
      // "Setting Up Subshell…" does — and the ellipsis is the one thing on
      // the screen that says it has not finished.
      return "Setting Up…";
    case "status":
      // The landing, for a watcher and for a node alike, so it can claim
      // neither. It is the one screen that asks nothing, which is why it is
      // named after the app rather than after a decision.
      return "Subshell Client";
    case "service":
      // The rail section's own name (operator ruling 2026-09-22): the node's
      // install and its service lifecycle live here.
      return "Service";
    case "plane":
      // Same: the Control Plane section's screen. One word for the thing both
      // addresses name — the server this app and this node talk to.
      return "Control Plane";
    case "connect":
      return "Connect to a Server";
    case "enroll":
      return `Enroll ${HERE}`;
    case "reset":
      // The one title that names no machine at all, on either platform
      // (operator's call, 2026-09-12). It was "Reset This Mac", and that was
      // wrong twice over.
      //
      // It OVERCLAIMED. This deletes Subshell's own state — the config, the
      // node key, the data directory — and touches nothing else on the
      // computer. A destructive label that reads as "erase this computer" is
      // alarming about the wrong thing, which is worse than being alarming,
      // because it teaches people not to trust what these labels say.
      //
      // And it read as TRUNCATED: "Mac" is a prefix of "Machine", the
      // sibling string on Linux really is "This Machine", and the label ends
      // there under the ellipsis a button that opens a screen carries. That
      // is how it was reported — as a layout bug.
      //
      // Naming WHAT IS RESET fixes both and needs no platform word:
      // everything this app does is on this machine, so saying so was only
      // ever redundant (operator's call, 2026-09-12). The two apps do NOT
      // share a string — Subshell Server's twin reads "Reset this server",
      // because the two resets destroy different things and one label over
      // both is the overloading the vocabulary rule exists to prevent.
      return "Reset this client";
    case "about":
      return "About Subshell Client";
    case "update":
      // The app AND the node CLI it ships, which is why the name can be
      // this plain (spec 2026-09-18 D6). It used to read the same while
      // meaning only the application, beside a separate "Update the node
      // to X" button that did the other half — two controls whose names
      // differed by a possessive, for one thing a person experiences once.
      // The name became TRUE rather than being disambiguated.
      return "Update Subshell Client";
  }
}

/** The one service verb a step calls for, or null when the step needs none. */
export function serviceAction(step: ProbeStep): { label: string; verb: "install" | "start" | "restart" } | null {
  switch (step) {
    case "no-service":
      return { label: "Install and Start", verb: "install" };
    case "stopped":
      return { label: "Start", verb: "start" };
    case "offline":
      return { label: "Restart", verb: "restart" };
    default:
      return null;
  }
}
