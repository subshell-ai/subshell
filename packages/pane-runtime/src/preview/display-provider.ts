import type {
  NodePreviewScreenLost,
  NodePreviewScreenWire,
  PreviewDisplayReadiness,
} from "@internal/subshell-protocol";

export const PREVIEW_DISPLAY_UNSUPPORTED = "preview-display-unsupported";
export const PREVIEW_DISPLAY_MISSING_REQUIREMENTS = "preview-display-missing-requirements";
export const PREVIEW_DISPLAY_NOT_READY = "preview-display-not-ready";

/** A JSON-serializable descriptor. Local launch credentials never belong here. */
export type PreviewScreenHandle = NodePreviewScreenWire;

/** Resource counts from a completed, authoritative census. */
export interface DisplaySweepResult {
  /** Displays removed because their subshell or backing process ended. */
  reaped: number;
  /** Live displays recovered after a daemon restart. */
  rehydrated: number;
  /** Stale allocation locks released by the provider. */
  locksFreed: number;
}

/**
 * Machine-local display backend, shared by the server and enrolled nodes.
 * Providers own their state directory, process identity checks, and rollback.
 * A failed allocation must leave no resources behind. Recovery and cleanup
 * must touch only resources whose ownership the provider can verify.
 */
export interface VirtualDisplayRuntime {
  /** Read-only prerequisites for this backend on the current machine. */
  readiness(): PreviewDisplayReadiness | Promise<PreviewDisplayReadiness>;
  /** Public descriptor of an allocated display; contains no launch secrets. */
  getFor(paneId: string): PreviewScreenHandle | null;
  /** Allocate or return the pane's existing display. */
  openFor(paneId: string, size: { width: number; height: number }): Promise<PreviewScreenHandle>;
  /** Local environment overrides for launching apps on this display. */
  launchEnv(paneId: string): Record<string, string>;
  /** Component lost while the pane stayed alive; cleared on close or allocation. */
  lostFor(paneId: string): NodePreviewScreenLost | null;
  /** Release owned resources; safe to call repeatedly and while disabled. */
  closeFor(paneId: string): void | Promise<void>;
  /** Recover or reap resources only after the caller obtains a complete census. */
  sweepOrphans(alivePaneIds: string[]): Promise<DisplaySweepResult>;
}

/** A provider owns its resources; the runtime adds permissions and selection. */
export interface VirtualDisplayProvider extends VirtualDisplayRuntime {
  /** Stable identifier used to namespace this provider's persisted state. */
  readonly id: string;
}
