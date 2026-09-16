/**
 * Hand-written mirror of one `GET /api/plugins` row (spec 2026-09-10: the
 * INSTANCE store is the single plugin catalog; nodes declare nothing). Only the
 * fields the New screen's Agent chips and the default rule read.
 */

/**
 * Manifest plugin type: an agent CLI, a plain shell (spec 2026-09-13 §4), or
 * a NETWORK — a plugin that connects a control plane to a private network and
 * drives no pane at all.
 *
 * Mobile has no network surface and never will have one from here: joining a
 * network is an act on the SERVER's machine. The type exists in this union so
 * the catalog can be FILTERED by it (`hooks/use-plugins.ts`), not so anything
 * on a phone can render it.
 */
export type PluginType = "agent-harness" | "terminal" | "network";

/** One plugin as the instance list returns it. */
export interface PluginView {
  /** Plugin id (also the harness id on a preset/subshell) */
  id: string;
  /** Display name — the Agent chip label */
  name: string;
  /** Manifest type. Optional for older servers; `undefined` is treated as
   * non-terminal, the same missing-field-means-old-build posture as
   * `canLaunch` on a node. */
  type?: PluginType;
  /** One-line description */
  description: string;
  /** Icon label (an emoji) — rendered inline on the chip when present */
  icon?: string;
  /** Driven program's command name (absent when unresolvable) */
  binary?: string;
  /** Installed package version (absent when not installed) */
  version?: string;
  /** Whether the instance store holds this plugin */
  installed: boolean;
  /** Offered or merely held (spec §6.1) */
  enabled: boolean;
  /** Present = the plugin failed to load in the control-plane process — never launchable */
  broken?: string;
}
