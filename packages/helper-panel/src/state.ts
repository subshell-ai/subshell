/**
 * The state the helper pushes into the page. The page owns no state of its
 * own: every field is a fact about the machine that only the Swift side can
 * know, and the panel is a render of the latest one.
 */
export interface PanelState {
  /** The person's own consent, stored by the helper. */
  enabled: boolean;
  screenRecording: boolean;
  accessibility: boolean;
  /** Virtual displays being captured right now, so the local user can see when someone is looking. */
  viewers: number;
  /** The last refusal, shown in red. Empty when there is nothing to report. */
  error: string;
  /** macOS's own answer about the sign-in registration, not a guess built from one case. */
  loginItem: LoginItemState;
}

/**
 * The three states `SMAppService.Status` can report about this helper's login
 * item that a person can act on. They are kept apart because each needs a
 * different sentence: `requiresApproval` means macOS is waiting for a switch
 * the person has not thrown, while `notRegistered` means the item is gone from
 * the list, which is what turning it OFF in System Settings does. Collapsing
 * the two is how a disabled sign-in start kept reading "Starts at sign-in".
 */
export type LoginItemState = "registered" | "needsApproval" | "notRegistered";

export const LOGIN_ITEM_STATES: readonly LoginItemState[] = ["registered", "needsApproval", "notRegistered"];

export const EMPTY_STATE: PanelState = {
  enabled: false,
  screenRecording: false,
  accessibility: false,
  viewers: 0,
  error: "",
  loginItem: "notRegistered",
};

/**
 * A state word and whether it still needs the person to act on it. Gold is the
 * design system's "the owner can fix this here"; the page's own ink is a fact
 * that is already true.
 */
export interface StateValue {
  text: string;
  blocked: boolean;
}

/** What the page sends back. One field, an action name, keeps the bridge small enough to audit. */
export type PanelAction =
  | "enable"
  | "disable"
  | "registerLoginItem"
  | "unregisterLoginItem"
  | "requestCapture"
  | "requestInput"
  | "openCaptureSettings"
  | "openInputSettings"
  | "openLoginItems"
  | "openDocs"
  | "minimize"
  | "quit";

/**
 * What the page sends back. `{ action: "resize" }` is the one message the
 * helper answers without a person asking: the window sizes to the document, so
 * the document reports what it needs and nothing inside it scrolls.
 */
export type PanelMessage = { action: PanelAction } | { action: "resize"; width: number; height: number };

/** Everything the helper must refuse while consent is off. */
export function isPermissionAction(action: PanelAction): boolean {
  return action === "requestCapture" || action === "requestInput";
}
