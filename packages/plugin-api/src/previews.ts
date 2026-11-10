/**
 * How a harness reports loopback ports its own tooling started, for the
 * preview picker.
 *
 * Port discovery attributes sockets by walking the pane's process tree. A
 * harness that brokers its tool shells through a shared daemon (oh-my-pi
 * does) leaves that tree, so a server its tools start is reachable but
 * invisible. A plugin that declares the `previews` capability ships a
 * reporter the control plane can list those ports from.
 *
 * The report carries ports only, never a host: the node dials loopback, so a
 * report cannot point the proxy at another machine.
 */
export type HarnessPreviewReporting = "extension" | "hooks";

/** The full value set, for validation that refuses an unknown reporter by name. */
export const HARNESS_PREVIEW_REPORTINGS: readonly HarnessPreviewReporting[] = ["extension", "hooks"];

/**
 * What a harness declares about its preview reporting. The rules mirror
 * {@link HarnessSubagentSupport}: `reporting` is checked against the union at
 * load, and `setup` is the copy the preset editor shows when a human act is
 * needed before reports start.
 */
export interface HarnessPreviews {
  /** How reports reach the plane: a per-launch extension, or harness lifecycle hooks. */
  reporting: HarnessPreviewReporting;
  /** One-time human action required for reporting to work, if any. */
  setup?: string;
}
