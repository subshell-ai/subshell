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
  /** macOS lists the login item but has not been told to start it. */
  loginItemNeedsApproval: boolean;
}

export const EMPTY_STATE: PanelState = {
  enabled: false,
  screenRecording: false,
  accessibility: false,
  viewers: 0,
  error: "",
  loginItemNeedsApproval: false,
};

/** What the page sends back. One field, an action name, keeps the bridge small enough to audit. */
export type PanelAction =
  | "enable"
  | "disable"
  | "requestCapture"
  | "requestInput"
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
