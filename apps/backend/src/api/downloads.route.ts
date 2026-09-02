import { type Stats, statSync } from "node:fs";
import { join } from "node:path";
import { BackendErrorCodes } from "@internal/backend-errors";
import { NODE_TARGETS, type NodeTarget } from "@internal/session-protocol";
import { Elysia, t } from "elysia";
import { NODE_ARTIFACTS_DIR } from "@/constants.js";
import { db } from "@/db/index.js";
import { NodeSetupKeysRepository } from "@/db/repositories/node-setup-keys.repository.js";
import { apiErrorBody } from "@/lib/api-error.js";
import { extractSessionToken, resolveCookieSession } from "@/lib/session-cookie.js";
import { apiModels } from "@/schema/index.js";

/**
 * The PATH-SAFETY gate, checked IN-HANDLER as the first statement of every
 * param-carrying route. The `:target` param is deliberately declared a plain
 * `t.String()` rather than a `t.Union` of the four literals: a validation
 * throw would be intercepted by the GLOBAL error handler of the assembled
 * app (`createApp()` mounts `errorHandlerPlugin` first, and it beats any
 * route-scoped `onError`), which maps it to 400 INPUT_VALIDATION_ERROR —
 * the wrong contract. Here, an unknown value (including traversal payloads
 * like `..%2F…`) returns 404 like any other unpublished build, and nothing
 * user-controlled is ever concatenated into a filesystem path: every
 * `artifactPath()` call receives only a value that passed this check.
 */
function isNodeTarget(target: string): target is NodeTarget {
  return (NODE_TARGETS as readonly string[]).includes(target);
}

/** Query shared by the binary and `.sha256` routes: the optional setup key. */
const DownloadQuerySchema = t.Object({
  setup_key: t.Optional(
    t.String({
      description:
        "One-time `nsk_…` setup key (Settings → Node setup keys) — the machine-path alternative to a session cookie; checked without being consumed",
    }),
  ),
});

/**
 * Cookie-OR-setup-key gate (spec §8): a browser downloads with its session
 * cookie, the install pipeline downloads with `?setup_key=`. The cookie probe
 * mirrors `authGuard`/`resolveSetupActor` semantics — a PRESENT cookie must
 * be valid (credential precedence; the bearer-ish path is never tried under a
 * stale session) — and the key path is `peekValid`, i.e. consumption-free:
 * the same key later redeems at `/api/nodes/enroll`. Bearer API keys are not
 * a download credential (a node key is /ws/node-only, a session key has no
 * reason to fetch agent binaries).
 * @returns true when the request may download
 */
async function authorizeDownload(request: Request, setupKey: string | undefined): Promise<boolean> {
  const cookieHeader = request.headers.get("cookie") ?? "";
  if (extractSessionToken(cookieHeader)) return (await resolveCookieSession(cookieHeader)) !== null;
  if (setupKey) return await new NodeSetupKeysRepository(db).peekValid(setupKey);
  return false;
}

/** 401 body for a request with neither credential kind. */
function unauthorized() {
  return {
    code: BackendErrorCodes.INVALID_CREDENTIALS,
    message: "Download requires a signed-in session cookie or a valid ?setup_key=.",
  } as const;
}

/** Absolute path of a target's binary. `target` is {@link isNodeTarget}-gated upstream. */
function artifactPath(target: NodeTarget): string {
  return join(NODE_ARTIFACTS_DIR, `mote-agent-${target}`);
}

/**
 * The single published-artifact rule shared by the binary route and
 * {@link artifactSha}: a build is published only when a regular, NON-EMPTY
 * file sits at the target's path — a zero-length artifact (partial write,
 * deliberate stub) is unpublished, never served as a 200 and never digested
 * as the sha of "". Both routes therefore 404 identically for the same
 * on-disk state.
 * @returns the file's stat, or null when unpublished (missing / not a file / empty)
 */
function artifactStat(target: NodeTarget): Stats | null {
  try {
    const stat = statSync(artifactPath(target));
    return stat.isFile() && stat.size > 0 ? stat : null;
  } catch {
    return null; // ENOENT/ENOTDIR → unpublished → 404 upstream
  }
}

/** Max entries in {@link shaCache} — FIFO-evicted so mtime churn can't grow it. */
const SHA_CACHE_MAX = 16;
/** Computed-sha cache, keyed `${binaryPath}:${binaryMtimeMs}[:${sidecarMtimeMs}]`. */
const shaCache = new Map<string, string>();

/**
 * SHA-256 (lowercase hex) of a target's binary, or null when unpublished —
 * "published" being exactly {@link artifactStat}'s rule, so the binary route
 * and this one never disagree. An on-disk `mote-agent-<target>.sha256`
 * sidecar wins when it holds a 64-hex digest (publisher-provided truth);
 * otherwise the digest is computed over the binary. Both paths cache under
 * the file mtimes, so a swapped binary or sidecar is noticed on the next
 * request without a stat-free fast path.
 *
 * PUBLISH NOTE: the cache keys on MTIME, so an artifact replaced in place
 * with the SAME mtime keeps serving the cached sha. The publish path must
 * therefore swap atomically (write to a temp name + rename, or at least
 * touch the file) rather than overwrite bytes through the existing inode.
 */
async function artifactSha(target: NodeTarget): Promise<string | null> {
  const path = artifactPath(target);
  const stat = artifactStat(target);
  if (!stat) return null;
  let sideMtime = 0;
  try {
    sideMtime = statSync(`${path}.sha256`).mtimeMs;
  } catch {
    // No sidecar — computed-digest path; key stays mtime-of-binary only.
  }

  const key = `${path}:${stat.mtimeMs}${sideMtime ? `:${sideMtime}` : ""}`;
  const cached = shaCache.get(key);
  if (cached) return cached;

  let sha: string;
  const sidecarHex = sideMtime
    ? (
        await Bun.file(`${path}.sha256`)
          .text()
          .catch(() => "")
      )
        .trim()
        .split(/\s+/)[0]
        ?.toLowerCase()
    : undefined;
  if (sidecarHex && /^[0-9a-f]{64}$/.test(sidecarHex)) {
    sha = sidecarHex;
  } else {
    const digest = await crypto.subtle.digest("SHA-256", await Bun.file(path).arrayBuffer());
    sha = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  // FIFO cap (Map iterates in insertion order): artifact files are large and
  // rebuilds churn mtimes, so an unbounded cache would be a slow leak.
  if (shaCache.size >= SHA_CACHE_MAX) {
    const oldest = shaCache.keys().next().value;
    if (oldest !== undefined) shaCache.delete(oldest);
  }
  shaCache.set(key, sha);
  return sha;
}

const notPublished = (target: string) => ({
  code: BackendErrorCodes.NOT_FOUND_ERROR,
  message: `No mote-agent build for "${target}" is published on this instance yet.`,
});

/**
 * `/api/downloads/node/*` — serve the prebuilt `mote-agent` binaries and
 * their checksums (spec 2026-08-31 §8). Auth: session cookie OR a valid,
 * unconsumed `?setup_key=` ({@link authorizeDownload}); neither → 401.
 *
 * The `.sha256` variants are one STATIC route per target rather than a
 * `:target.sha256` param route — Elysia's tokenizer cannot express a static
 * suffix after a param (it would fold into the param's name), and static
 * segments outrank `:target` in the matcher, so `/node/linux-x64.sha256`
 * serves the checksum while every other dotted value (including unknown
 * `.sha256` names) still falls into the binary route, where {@link
 * isNodeTarget} answers 404. The sha routes need no runtime target gate:
 * their path segments are literals copied out of {@link NODE_TARGETS}, so
 * user input never reaches their filesystem calls.
 */
export const downloadsRoutes = new Elysia({ prefix: "/api/downloads" }).use(apiModels).get(
  "/node/:target",
  async ({ request, query, params, status }) => {
    // First statement, before auth and before ANY path construction: the
    // closed set is enforced here, not in a params schema (see isNodeTarget).
    if (!isNodeTarget(params.target)) return status(404, apiErrorBody(notPublished(params.target)));
    if (!(await authorizeDownload(request, query.setup_key))) return status(401, apiErrorBody(unauthorized()));
    if (!artifactStat(params.target)) return status(404, apiErrorBody(notPublished(params.target)));
    const file = Bun.file(artifactPath(params.target));
    return new Response(file, {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="mote-agent-${params.target}"`,
        "Cache-Control": "private, no-cache",
      },
    });
  },
  {
    params: t.Object({
      target: t.String({
        description: `Platform triple — one of ${NODE_TARGETS.join(", ")} (gated in-handler; any other value → 404)`,
      }),
    }),
    query: DownloadQuerySchema,
    response: { 401: "ApiErrorResponse", 404: "ApiErrorResponse" },
    detail: {
      operationId: "downloadNodeAgent",
      tags: ["downloads"],
      description:
        "Downloads the prebuilt mote-agent binary for one platform target (session cookie or valid ?setup_key=; unknown target → 404)",
    },
  },
);

for (const target of NODE_TARGETS) {
  downloadsRoutes.get(
    `/node/${target}.sha256`,
    async ({ request, query, status }) => {
      if (!(await authorizeDownload(request, query.setup_key))) return status(401, apiErrorBody(unauthorized()));
      const sha = await artifactSha(target);
      if (!sha) return status(404, apiErrorBody(notPublished(target)));
      return new Response(`${sha}\n`, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
    },
    {
      query: DownloadQuerySchema,
      response: { 401: "ApiErrorResponse", 404: "ApiErrorResponse" },
      detail: {
        operationId: `downloadNodeAgentSha256${target.replace(/-/g, "")}`,
        tags: ["downloads"],
        description: `SHA-256 (64-hex) of the ${target} mote-agent build (same cookie-or-setup_key gate as the binary)`,
      },
    },
  );
}
