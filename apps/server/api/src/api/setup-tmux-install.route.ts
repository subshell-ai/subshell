import { BackendErrorCodes } from "@internal/backend-errors";
import { loginPathEntries } from "@internal/pane-runtime";
import { Elysia } from "elysia";
import { invalidateDeployFacts } from "@/api/admin-status.route.js";
import { ForbiddenError } from "@/api/auth-guard.js";
import { resolveSetupActor } from "@/api/setup.route.js";
import { chooseTmuxInstaller, type TmuxInstaller } from "@/commands/tmux-install.js";
import { IS_TEST } from "@/constants.js";
import { LOCAL_NODE_ID } from "@/db/types/nodes.db-types.js";
import { apiErrorBody } from "@/lib/api-error.js";
import { resolveCookieSession } from "@/lib/session-cookie.js";
import { apiModels } from "@/schema/index.js";
import { runInstaller } from "@/services/agent-install.service.js";
import { audit } from "@/services/audit.js";

/**
 * Test seams. Production callers get the real platform table and the real
 * `Bun.which`; a test never reaches a package manager.
 */
export interface TmuxInstallDeps {
  /**
   * Which installer fits this host, or null when no supported package manager
   * is on PATH. Production: {@link chooseTmuxInstaller} over the real platform.
   */
  chooseInstaller: () => TmuxInstaller | null;
  /** Binary lookup, for the re-probe after the run. Production: `Bun.which`. */
  which: (name: string) => string | null;
  /** Deadline for the installer run. */
  timeoutMs: number;
  /** Directories to append to PATH: a service-run server carries only its baked PATH. */
  extraPath: () => Promise<string[]>;
}

/**
 * Generous on purpose, and the same order as the agent installer's: a package
 * manager on a cold cache (a brew that decides to update itself first) takes
 * minutes, and this runs unattended with no way to extend it interactively.
 */
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

const defaultDeps: TmuxInstallDeps = {
  chooseInstaller: () => chooseTmuxInstaller({ platform: process.platform, which: (name) => Bun.which(name) }),
  which: (name) => Bun.which(name),
  timeoutMs: DEFAULT_TIMEOUT_MS,
  extraPath: loginPathEntries,
};

let depsOverride: TmuxInstallDeps | undefined;

/**
 * Test seam: swap the installer table, the re-probe and the PATH lookup so a
 * suite never runs a real package manager. Refuses outside the suite, the same
 * `setAgentInstallDepsForTests` pattern: a mis-wired production import must not
 * be able to redirect what this route runs on the host.
 * @internal
 */
export function setTmuxInstallDepsForTests(deps: TmuxInstallDeps | null): void {
  if (!IS_TEST) throw new Error("setTmuxInstallDepsForTests is a test-only seam");
  depsOverride = deps ?? undefined;
}

/**
 * One tmux install at a time, instance-wide. The target is one filesystem, so
 * a second concurrent run would race the first rather than parallelize with it
 * — and package managers take their own locks, so the second would sit on one
 * for the whole deadline.
 */
let installing = false;

/**
 * The refusal this route would answer with, or undefined when it would run.
 *
 * Decided BEFORE the body opens, like the agent installer's: once a stream
 * starts the status line is already sent and 200 cannot be taken back.
 */
export function refuseTmuxInstall(deps: TmuxInstallDeps): { installer: TmuxInstaller } | { message: string } {
  if (installing) return { message: "tmux is already being installed on this host" };
  const installer = deps.chooseInstaller();
  if (!installer) {
    return {
      message:
        "No supported package manager was found on this host. Install tmux yourself and re-check. An unknown package manager is a hint, not a guess.",
    };
  }
  // THE LOAD-BEARING REFUSAL (spec 2026-09-15 § 6). The server has no terminal
  // behind this request, and the installer runs with `stdin: "ignore"` — so a
  // privileged command would sit on sudo's password prompt until the deadline
  // and report a timeout for what was really a missing password. Refusing it
  // is also what keeps "the server installs tmux" from meaning "the server
  // escalates": what this route can run is bounded to the unprivileged half of
  // `chooseTmuxInstaller`'s table, which today is brew on macOS and nothing
  // else. The Linux command is shown in the UI to copy instead.
  if (installer.argv[0] === "sudo") {
    return {
      message: `Installing tmux here needs ${installer.label} under sudo, and the server has no terminal to answer a password prompt. Run the command yourself and re-check.`,
    };
  }
  return { installer };
}

/**
 * `POST /api/setup/tmux/install` (spec 2026-09-15 § 5.1, accounted § 6).
 *
 * Its own module for the reason `setup-agent-install.route.ts` is: the GATE
 * differs from the rest of `/api/setup`. Every other setup write is public
 * while no user exists, because the wizard runs before an admin does — but
 * THIS route runs a package manager on the control-plane host, so it follows
 * the agent installer's gate instead and requires an admin COOKIE session
 * ({@link resolveSetupActor} === "admin"); bearer keys 403 like every other
 * admin surface. That is safe for the wizard because the tmux row lives on
 * step 2, which runs AFTER Create Your Account.
 *
 * It is narrower than the agent installer in every other dimension (§ 6): the
 * argv is fixed by `chooseTmuxInstaller`, with NO operator input reaching the
 * command line at all — the agent route at least takes a plugin id, this takes
 * nothing — and anything `sudo`-prefixed is refused outright.
 *
 * `ok: false` inside a 200 is a run that FAILED (the installer ran and said
 * no); a 4xx is a refusal before anything ran. `tmuxPath` is re-probed AFTER
 * the installer exits so one round trip reports both the run's log and the new
 * detection state — and the memo behind `GET /api/admin/status` is dropped, or
 * every later read would report the answer from before the install.
 */
export const setupTmuxInstallRoute = new Elysia({ prefix: "/api/setup/tmux" }).use(apiModels).post(
  "/install",
  async ({ request, status }) => {
    if ((await resolveSetupActor(request)) !== "admin") throw new ForbiddenError();
    const deps = depsOverride ?? defaultDeps;
    const decision = refuseTmuxInstall(deps);
    if ("message" in decision) {
      // 409 for all three refusals, and EXISTS_ERROR because that is what the
      // global error handler assigns a THROWN 409 (`codeForStatus` in
      // `error-handler.plugin.ts`) — this route answers via `status()` so an
      // expected refusal writes no error log line, and the body must still
      // describe the status it is attached to.
      return status(409, apiErrorBody({ code: BackendErrorCodes.EXISTS_ERROR, message: decision.message }));
    }
    const { installer } = decision;
    // Taken HERE, synchronously between the check above and the stream below:
    // nothing awaits in between, so two concurrent requests cannot both see it
    // free.
    installing = true;

    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        /** One NDJSON frame. A closed stream (the page navigated) must not throw into the installer. */
        const send = (frame: unknown) => {
          try {
            controller.enqueue(encoder.encode(`${JSON.stringify(frame)}\n`));
          } catch {
            // The reader is gone. The install carries on regardless — it is
            // changing this machine, and abandoning it half-done because
            // nobody is watching would be worse than finishing unobserved.
          }
        };
        try {
          const result = await runInstaller(installer.argv, {
            timeoutMs: deps.timeoutMs,
            extraPath: deps.extraPath,
            onLine: (line) => send({ type: "line", text: line }),
          });
          // The memo first, then the probe: `GET /api/admin/status` caches
          // tmuxPath for the life of the process, and a Status page still
          // reporting "tmux not found" after a successful install is the
          // defect this call closes.
          invalidateDeployFacts();
          const tmuxPath = deps.which("tmux");
          // Best-effort actor id for the audit row; the gate above already
          // proved a valid admin cookie, so this just reads it back out.
          const actor = await resolveCookieSession(request.headers.get("cookie") ?? "");
          await audit({
            actorUserId: actor?.user.id ?? null,
            action: "tmux.install",
            targetType: "node",
            // The control-plane host IS the `local` node, and that is the
            // machine this changed — an audit row naming no target would read
            // as an instance-wide act.
            targetId: LOCAL_NODE_ID,
            metadataJson: JSON.stringify({
              ok: result.ok,
              exitCode: result.exitCode,
              durationMs: result.durationMs,
              installer: installer.label,
              found: tmuxPath !== null,
            }),
          });
          // `ok` is the INSTALLER's verdict and `tmuxPath` is the host's; they
          // disagree exactly in the case the CLI's own offer re-probes for (a
          // package manager that installed into a directory this process
          // cannot see), so both ride the frame and the page says which
          // happened rather than inferring one from the other.
          send({ type: "done", ...result, tmuxPath });
        } catch (err) {
          // The status line is long gone, so a failure has to arrive as a
          // FRAME. A client that sees neither `done` nor `error` before the
          // stream ends treats that as a failure too.
          send({ type: "error", message: err instanceof Error ? err.message : "The install failed." });
        } finally {
          installing = false;
          controller.close();
        }
      },
    });
    return new Response(body, {
      headers: {
        "content-type": "application/x-ndjson; charset=utf-8",
        // Nothing between here and the page may hold these frames back: the
        // whole point is that they arrive while the installer is still going.
        "cache-control": "no-store, no-transform",
        "x-accel-buffering": "no",
      },
    });
  },
  {
    // NO typed 200: this route streams. The body is NDJSON — one
    // `{"type":"line","text":…}` per line the installer prints, then exactly
    // one `{"type":"done", ok, exitCode, output, durationMs, tmuxPath}` or
    // `{"type":"error","message":…}`.
    response: {
      401: "ApiErrorResponse",
      403: "ApiErrorResponse",
      409: "ApiErrorResponse",
    },
    detail: {
      operationId: "installSetupTmux",
      tags: ["setup"],
      description:
        "Installs tmux on the control-plane host with this platform's package manager, as the server's own user. Admin cookie only, never public, audited. Refuses (409) when no supported package manager is known and when the installer would need sudo — the server has no terminal to answer a password prompt. STREAMS application/x-ndjson while it runs: a {type:line,text} per line of installer output, then one terminal {type:done,...} carrying ok/exitCode/output/tmuxPath, or {type:error,message}. ok:false inside a done frame is a run that failed; a 4xx is a refusal decided before the body opened and before anything ran.",
    },
  },
);
