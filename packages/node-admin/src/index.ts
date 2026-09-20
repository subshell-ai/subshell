/**
 * `@internal/node-admin` — the shared admin UI for operating a Subshell node.
 *
 * One copy of the six node cards (runtime, service, log, maintenance, control
 * plane, allowed directories), the hooks and types they speak, and the UI
 * primitives they render, so the control plane's Nodes pages and the node's
 * OWN loopback dashboard show the same machine in the same words and answer
 * to the same `/api/nodes/:id/*` contract from two backends.
 *
 * ## The relicensing this package is
 *
 * These files live under `apps/server/**`'s AGPL line and were moved here on
 * 2026-09-19 — which makes them Apache-2.0, deliberately (root AGENTS.md:
 * "Moving a file into or out of `apps/server/` relicenses it… Decide it,
 * don't discover it"). The copyleft was chosen for the piece a competitor
 * would fork into a hosted service, and this is the UI shell, not it; the
 * permissive half is the product's operating surface for third parties, which
 * is exactly what a node's own machine now runs.
 *
 * ## Rules this package keeps
 *
 * - **No app imports.** Nothing from `apps/server/web` or `apps/node/web` may
 *   be imported here — every surface-specific affordance arrives by prop
 *   (`local`, `readOnly`, `renderEditor`, `updateHref`, `onMaintenanceChanged`,
 *   `onDirsSaved`). App-coupled components (the sharing dialog, key rotation,
 *   the harness card, the setup-keys section, the folder picker) stay in the
 *   plane's SPA, which composes them around these.
 * - **Peers, not deps**, for React and TanStack — the consuming SPA owns the
 *   instances; a second copy of react-query in a bundle is a silent cache
 *   split.
 * - **Design tokens live OUTSIDE.** The classes here are the shared design
 *   system (`docs/design-system.md`); each consuming app ships its own
 *   `styles.css` and is scanned by `bun run lint:design` — including this
 *   package, whose `src` is wired into the scan.
 */

export { Fact, FactCard } from "./components/fact-list";
export { NodeAllowedDirs } from "./components/node-allowed-dirs";
export { NodeLogCard } from "./components/node-log-card";
export { NodeMaintenanceCard } from "./components/node-maintenance-card";
export { NodeRuntimeCard, supervisionLine } from "./components/node-runtime-card";
export { NodeServerUrlCard } from "./components/node-server-url-card";
export { NodeServiceCard } from "./components/node-service-card";
export {
  nodeDetailQuery,
  useNode,
  useNodeLogSlice,
  useNodeService,
  useSetNodeAllowedDirs,
  useSetNodeLogging,
  useSetNodeMaintenance,
  useSetNodeServerUrl,
} from "./hooks/use-node-detail";
export {
  isNewNodeProcess,
  type NodeRestartWait,
  type RestartWaitOutcome,
  useNodeRestartWait,
} from "./hooks/use-node-restart-wait";
export {
  ApiError,
  apiFetch,
  apiPost,
  errMessage,
  isAbortError,
  isAlreadyGone,
  isNetworkError,
  NetworkError,
  parseErrorBody,
} from "./lib/api";
export { type ConfirmOptions, confirmAction, setConfirmHandler } from "./lib/confirm";
export { confirmStartMaintenance } from "./lib/node-confirmations";
export { maintenanceRefusalNotice, subshellCount } from "./lib/node-maintenance";
export { LINGER_COMMAND, type PersistenceFix, type PersistenceInput, persistence } from "./lib/persistence";
export { NODE_QUERY_KEY, NODES_QUERY_KEY } from "./lib/query-keys";
export { relativeElapsed } from "./lib/relative-elapsed";
export { cn } from "./lib/utils";
export type {
  CreatedSetupKey,
  HeldReason,
  MaintenanceResult,
  MaintenanceSource,
  Node,
  NodeAccess,
  NodeDetail,
  NodeHarness,
  NodeHeld,
  NodeKind,
  NodeRuntime,
  NodeShare,
  NodeStatus,
  RotatedNodeKey,
  SetupKeyRow,
} from "./types/node";
export { Badge, badgeVariants } from "./ui/badge";
export { Button } from "./ui/button";
export { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";
export { CopyableValue } from "./ui/copyable-value";
export { Input } from "./ui/input";
export { Label } from "./ui/label";
export { Switch } from "./ui/switch";
