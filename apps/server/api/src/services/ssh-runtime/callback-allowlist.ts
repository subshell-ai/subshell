import { isNodeSubshellId } from "@internal/subshell-protocol";

/**
 * The pane's own-token callback allowlist (design 2026-10-05 §5): a fixed
 * prefix list with the pane's id substituted SERVER-SIDE - never a general
 * proxy, and never an id taken from the frame.
 *
 * The runtime forwards whatever the pane typed into `callback.sock`; THIS
 * decides what the plane will execute as that pane. The shape of the answer is
 * a pure function so the whole gate has a unit test and no DB, no socket, and
 * no session object to reach it. A frame naming `/api/users` or another
 * pane's id must be refused here, where refusal is checkable, not in the
 * auth guard's downstream accident.
 *
 * The set is exactly what the pane's own token can call: its own per-subshell
 * routes (the self-report family, input, log, terminal, extend-token), the
 * identities list, and the channels the token's map carries. Anything else -
 * nodes, settings, admin, another pane's id - is out, by name.
 */

/** Methods the callback door ever opens on (curl's GET and POST; a PUT is a pane editing resources the token does not own through this seam). */
const ALLOWED_METHODS: ReadonlySet<string> = new Set(["GET", "POST"]);

/** The self-family and shared-surface path shapes; `{id}` is substituted with the SESSION's pane id before comparison. */
const OWN_PANE_PREFIX = "/api/subshells/";
const IDENTITIES_PATH = "/api/identities";
/**
 * The channels family (design §5's allowlist line, module doc's third item):
 * the pane's token map already gates which channel operations its routes
 * accept - the door forwards the path, the route decides. The slice shipped
 * identities and the self family and left this line to task 25 because the
 * MCP surface it serves (list/read/post) is exactly what a runtime pane's
 * cross-agent coordination needs.
 */
const CHANNELS_PATH = "/api/channels";

/** The decision: allowed, with the pane the frame is (forced to) address; or a named refusal reason for the log line. */
export type CallbackDecision = { allow: true; paneId: string } | { allow: false; reason: string };

/**
 * Match one forwarded callback against the pane's own-token reach.
 *
 * @param path - the frame's path (pathname, no origin; the runtime normalized it)
 * @param method - the HTTP verb
 * @param paneId - the session's pane id, server-side truth (never read from the frame's path as authority: a path that NAMES this id is required to equal it)
 */
export function matchCallbackPath(path: string, method: string, paneId: string): CallbackDecision {
  if (!ALLOWED_METHODS.has(method)) return { allow: false, reason: `method ${method} is not a callback verb` };
  if (path === IDENTITIES_PATH || path.startsWith(`${IDENTITIES_PATH}/`)) return { allow: true, paneId };
  if (path === CHANNELS_PATH || path.startsWith(`${CHANNELS_PATH}/`)) return { allow: true, paneId };
  if (!path.startsWith(OWN_PANE_PREFIX)) return { allow: false, reason: "not a per-subshell path" };
  const rest = path.slice(OWN_PANE_PREFIX.length);
  const slash = rest.indexOf("/");
  const namedId = slash === -1 ? rest : rest.slice(0, slash);
  if (!isNodeSubshellId(namedId)) return { allow: false, reason: "path names no valid subshell id" };
  // The substitution rule made concrete: the frame's id must EQUAL the
  // session's pane. A path naming someone else's pane is refused even though
  // the executing token belongs to this pane (the route would 404 it anyway -
  // the refusal here is what stops the round trip and names why).
  if (namedId !== paneId) return { allow: false, reason: "path names a pane other than this session's" };
  return { allow: true, paneId };
}
