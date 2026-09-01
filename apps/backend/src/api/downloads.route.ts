import { statSync } from "node:fs";
import { join } from "node:path";
import { BackendErrorCodes } from "@internal/backend-errors";
import { Elysia, t } from "elysia";
import { NODE_ARTIFACTS_DIR } from "@/constants.js";
import { db } from "@/db/index.js";
import { NodeSetupKeysRepository } from "@/db/repositories/node-setup-keys.repository.js";
import { apiErrorBody } from "@/lib/api-error.js";
import { extractSessionToken, resolveCookieSession } from "@/lib/session-cookie.js";
import { apiModels } from "@/schema/index.js";

/** The closed set of platform triples the agent is published for (spec §8). */
export const NODE_TARGETS = ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"] as const;

/** One {@link NODE_TARGETS} entry. */
export type NodeTarget = (typeof NODE_TARGETS)[number];

/**
 * Closed enum — this schema is the PATH-SAFETY gate: a `:target` that is not
 * one of these four literal strings never reaches the handler (Elysia's
 * param validation throws first and {@link downloadsRoutes}' `onError` maps
 * that to a 404), so nothing user-controlled is ever concatenated into a
 * filesystem path. Traversal payloads (`..%2F…`) fail the enum like any
 * other unknown value.
 */
const NodeTargetSchema = t.Union([
  t.Literal("linux-x64"),
  t.Literal("linux-arm64"),
  t.Literal("darwin-x64"),
  t.Literal("darwin-arm64"),
]);

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

/** Absolute path of a target's binary. `target` is enum-validated upstream. */
function artifactPath(target: NodeTarget): string {
  return join(NODE_ARTIFACTS_DIR, `mote-agent-${target}`);
}

/** Max entries in {@link shaCache} — FIFO-evicted so mtime churn can't grow it. */
const SHA_CACHE_MAX = 16;
/** Computed-sha cache, keyed `${binaryPath}:${binaryMtimeMs}[:${sidecarMtimeMs}]`. */
const shaCache = new Map<string, string>();

/**
 * SHA-256 (lowercase hex) of a target's binary, or null when unpublished.
 * An on-disk `mote-agent-<target>.sha256` sidecar wins when it holds a 64-hex
 * digest (publisher-provided truth); otherwise the digest is computed over
 * the binary. Both paths cache under the file mtimes, so a swapped binary or
 * sidecar is noticed on the next request without a stat-free fast path.
 */
async function artifactSha(target: NodeTarget): Promise<string | null> {
  const path = artifactPath(target);
  let stat;
  let sideMtime = 0;
  try {
    stat = statSync(path);
    try {
      sideMtime = statSync(`${path}.sha256`).mtimeMs;
    } catch {
      // No sidecar — computed-digest path; key stays mtime-of-binary only.
    }
  } catch {
    return null; // binary not on disk (ENOENT/ENOTDIR) → 404 upstream
  }
  if (!stat.isFile()) return null;

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
 * `.sha256` names) still falls into the enum-validated binary route.
 */
export const downloadsRoutes = new Elysia({ prefix: "/api/downloads" })
  .use(apiModels)
  // Registered BEFORE the routes so it covers them (instance hooks are
  // order-scoped). The only validation these routes can fail is the closed
  // target enum — and an unknown target should read as 404, not the global
  // 400: the builds are a fixed public set, "no such build" IS not-found.
  .onError(({ code, status }) => {
    if (code === "VALIDATION") return status(404, apiErrorBody(notPublished("unknown")));
  })
  .get(
    "/node/:target",
    async ({ request, query, params, status }) => {
      if (!(await authorizeDownload(request, query.setup_key))) return status(401, apiErrorBody(unauthorized()));
      const path = artifactPath(params.target);
      const file = Bun.file(path);
      if (!(await file.exists()) || file.size === 0) return status(404, apiErrorBody(notPublished(params.target)));
      return new Response(file, {
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Disposition": `attachment; filename="mote-agent-${params.target}"`,
          "Cache-Control": "private, no-cache",
        },
      });
    },
    {
      params: t.Object({ target: NodeTargetSchema }),
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
