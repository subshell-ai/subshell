import { statSync } from "node:fs";
import { BackendErrorCodes } from "@internal/backend-errors";
import { NODE_TARGETS, type NodeTarget, nodeArtifactFileName } from "@internal/subshell-protocol";
import { Elysia, t } from "elysia";
import { db } from "@/db/index.js";
import { NodeSetupKeysRepository } from "@/db/repositories/node-setup-keys.repository.js";
import { apiErrorBody } from "@/lib/api-error.js";
import { artifactPath, artifactStat } from "@/lib/node-artifacts.js";
import { extractSessionToken, resolveCookieSession } from "@/lib/session-cookie.js";
import { apiModels } from "@/schema/index.js";
import { consumeUpdateToken } from "@/services/nodes/update-tokens.js";
import { autoFetchEnabled, fetchArtifact, fetchDigest } from "@/services/releases.js";
import { getLogger } from "@/utils/logger.js";

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
        "One-time `nsk_…` setup key, minted on the Nodes page; the machine-path alternative to a session cookie; checked without being consumed",
    }),
  ),
  update_token: t.Optional(
    t.String({
      description:
        "One-time `nut_…` token the plane bakes into a node's `update` command; valid for ten minutes, ONE download, and only for this target. CONSUMED by the request that presents it",
    }),
  ),
});

/**
 * Cookie-OR-setup-key-OR-update-token gate (spec §8, extended 2026-09-15 §5.3):
 * a browser downloads with its session cookie, the install pipeline downloads
 * with `?setup_key=`, and an agent the plane told to update downloads with
 * `?update_token=`. The cookie probe mirrors `authGuard`/`resolveSetupActor`
 * semantics — a PRESENT cookie must be valid (credential precedence; the
 * bearer-ish path is never tried under a stale subshell). The setup-key path
 * is `peekValid`, i.e. consumption-free: the same key later redeems at
 * `/api/nodes/enroll`.
 *
 * **The update token is the one credential here that IS consumed**, and the
 * asymmetry is the point. A setup key has a second job after this download
 * (the enroll), so spending it here would break the flow it belongs to. An
 * update token has exactly one job: this file, once. The `target` it was
 * minted for is checked, so it buys the one artifact the command named and not
 * another platform's.
 *
 * Bearer API keys remain no download credential at all — a node key is
 * /ws/node-only (security §5.5, which this leaves true: the agent presents the
 * token, never its key), and a subshell key has no reason to fetch agent
 * binaries.
 *
 * @param updateTokenTarget - the triple an `?update_token=` may buy here, or
 *   `null` where the token is not accepted at all. The `.sha256` routes pass
 *   `null`: the agent already HAS the digest — it rides in the `update`
 *   command — so spending a single-use token on 65 bytes would leave nothing
 *   for the binary the command exists to fetch.
 * @returns true when the request may download
 */
async function authorizeDownload(
  request: Request,
  query: DownloadQuery,
  updateTokenTarget: NodeTarget | null,
): Promise<boolean> {
  const cookieHeader = request.headers.get("cookie") ?? "";
  if (extractSessionToken(cookieHeader)) return (await resolveCookieSession(cookieHeader)) !== null;
  if (query.setup_key) return await new NodeSetupKeysRepository(db).peekValid(query.setup_key);
  if (query.update_token && updateTokenTarget !== null) {
    return consumeUpdateToken(query.update_token, updateTokenTarget) !== null;
  }
  return false;
}

/** The credentials a download request may carry in its query string. */
type DownloadQuery = { setup_key?: string; update_token?: string };

/** 401 body for a request with no usable credential. */
function unauthorized() {
  return {
    code: BackendErrorCodes.INVALID_CREDENTIALS,
    message: "Download requires a signed-in session cookie, a valid ?setup_key=, or a fresh ?update_token=.",
  } as const;
}

/** Max entries in {@link shaCache} — FIFO-evicted so mtime churn can't grow it. */
const SHA_CACHE_MAX = 16;
/** Computed-sha cache, keyed `${binaryPath}:${binaryMtimeMs}[:${sidecarMtimeMs}]`. */
const shaCache = new Map<string, string>();

/**
 * SHA-256 (lowercase hex) of a target's binary, or null when unpublished —
 * "published" being exactly {@link artifactStat}'s rule, so the binary route
 * and this one never disagree. An on-disk `subshell-node-cli-<target>.sha256`
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

/** A thrown value's words, for the one log line a failed fetch leaves behind. */
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

const notPublished = (target: string) => ({
  code: BackendErrorCodes.NOT_FOUND_ERROR,
  message: `No subshell build for "${target}" is published on this instance yet.`,
});

/**
 * `/api/downloads/node/*` — serve the prebuilt `subshell` binaries and
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
    if (!(await authorizeDownload(request, query, params.target))) return status(401, apiErrorBody(unauthorized()));
    const headers = {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename=${nodeArtifactFileName(params.target)}`,
      "Cache-Control": "private, no-cache",
    };
    // On disk wins, always: a binary an operator published with `release:cli-node`
    // is what this instance serves, and nothing here second-guesses it.
    if (artifactStat(params.target)) {
      return new Response(Bun.file(artifactPath(params.target)), { headers });
    }
    // Nothing local. THIS is the lazy fetch: the first machine of a platform
    // to ask pays for the download, and it is streamed past rather than staged
    // (see services/releases.ts). A plane whose nodes are all one platform
    // never spends a byte on the others.
    if (!autoFetchEnabled()) return status(404, apiErrorBody(notPublished(params.target)));
    try {
      const fetched = await fetchArtifact(params.target);
      return new Response(fetched.stream, { headers });
    } catch (error) {
      // A release that cannot be read is the same OUTCOME as an unpublished
      // build — the machine cannot install — so it is the same 404 rather than
      // a 502 the install script has no branch for. The reason is logged
      // where an operator can find it.
      getLogger().warn(`node artifacts: could not fetch ${params.target} from the release: ${errorText(error)}`);
      return status(404, apiErrorBody(notPublished(params.target)));
    }
  },
  {
    params: t.Object({
      target: t.String({
        description: `Platform triple: one of ${NODE_TARGETS.join(", ")} (gated in-handler; any other value → 404)`,
      }),
    }),
    query: DownloadQuerySchema,
    response: { 401: "ApiErrorResponse", 404: "ApiErrorResponse" },
    detail: {
      operationId: "downloadNodeAgent",
      tags: ["downloads"],
      description:
        "Downloads the prebuilt subshell binary for one platform target (session cookie or valid ?setup_key=; unknown target → 404)",
    },
  },
);

for (const target of NODE_TARGETS) {
  downloadsRoutes.get(
    `/node/${target}.sha256`,
    async ({ request, query, status }) => {
      // `null`: an update token is not spendable on a digest — see authorizeDownload.
      if (!(await authorizeDownload(request, query, null))) return status(401, apiErrorBody(unauthorized()));
      const local = await artifactSha(target);
      if (local) return new Response(`${local}\n`, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
      // `install.sh` asks for the sha AFTER the binary, so by here the
      // streaming fetch has normally written the sidecar and the line above
      // answered. This is the other order: the digest alone, which is 65
      // bytes and does not pull the binary down with it.
      if (!autoFetchEnabled()) return status(404, apiErrorBody(notPublished(target)));
      try {
        return new Response(`${await fetchDigest(target)}\n`, {
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        });
      } catch (error) {
        getLogger().warn(`node artifacts: could not fetch the ${target} digest from the release: ${errorText(error)}`);
        return status(404, apiErrorBody(notPublished(target)));
      }
    },
    {
      query: DownloadQuerySchema,
      response: { 401: "ApiErrorResponse", 404: "ApiErrorResponse" },
      detail: {
        operationId: `downloadNodeAgentSha256${target.replace(/-/g, "")}`,
        tags: ["downloads"],
        description: `SHA-256 (64-hex) of the ${target} subshell build (same cookie-or-setup_key gate as the binary)`,
      },
    },
  );
}
