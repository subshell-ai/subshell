import { BackendErrorCodes } from "@internal/backend-errors";
import { semverLt } from "@internal/subshell-protocol";
import { Elysia, t } from "elysia";
import { requireAdmin } from "@/api/auth-guard.js";
import { serverConfigDir } from "@/config-env.js";
import { apiErrorBody } from "@/lib/api-error.js";
import { apiModels } from "@/schema/index.js";
import { audit } from "@/services/audit.js";
import { resolveInstalledBinary } from "@/services/installed-binary.js";
import { type CliReleaseCheck, installableCliRelease, releaseSourceUrl } from "@/services/releases.js";
import { collectDeployment } from "@/services/server-deployment.js";
import { describeBinary, startServerUpdate, tryClaimServerUpdate, updateJobRunning } from "@/services/server-update.js";
import { readPending } from "@/services/update-transaction.js";
import { SERVER_VERSION } from "@/version.js";

const UpdateBodySchema = t.Object({
  version: t.Optional(
    t.String({
      description:
        "The published version to install. Only the NEWEST release of a component is indexed, so anything else is refused by name; omit to install whatever is newest",
    }),
  ),
  force: t.Optional(
    t.Boolean({
      description: "Update even though the installed service definition would take live panes down on the restart",
    }),
  ),
});

const UpdateStartedSchema = t.Object({
  started: t.Literal(true, { description: "The job is running in this process; poll GET /api/admin/server/update" }),
  from: t.String({ description: "The version this server is now" }),
  to: t.String({ description: "The version being installed" }),
});

/**
 * Test seams: the deployment read, the binary ladder, the release index and the
 * job itself — replaceable without a module mock, exactly as `restartSeams` is,
 * because the success path of this route ends in a process exit.
 * @internal
 */
export const updateSeams = {
  deployment: collectDeployment,
  installed: () => resolveInstalledBinary({ configDir: serverConfigDir() }),
  /**
   * The newest INSTALLABLE `cli-server` release — newest AND signature-verified —
   * or the one-sentence reason there is none. Never throws: the refusal is a
   * rendered answer, not an exception (spec 2026-09-17 §5 path 4).
   */
  release: installableCliReleaseServer,
  /** The job-slot lock — deliberately NOT replaceable by a test: the race
   *  this guards only exists in the module's real state. @see tryClaimServerUpdate */
  claim: tryClaimServerUpdate,
  start: startServerUpdate,
};

async function installableCliReleaseServer(): Promise<CliReleaseCheck> {
  return installableCliRelease("cli-server");
}

/**
 * `POST /api/admin/server/update` — replace this server's binary and exit for
 * the manager to respawn the new one (spec 2026-09-15 §4.5).
 *
 * **It is a 202 and a job, not a request that finishes.** The download is tens
 * of megabytes and the last thing the job does is exit this process, so there
 * is no response to write at the end of it: the page polls
 * `GET /api/admin/server/update` for the phase, then waits for the server to
 * come back with the same waiter the restart uses.
 *
 * **Seven refusals, evaluated in the spec's order**, and the order is the point
 * — a host with no release source AND no service manager should hear about the
 * source first, because that is the one an operator fixes. Each is a 409 with a
 * code the SPA renders verbatim.
 *
 * **The audit row is written BEFORE the job**, with the admin as actor. The
 * boot-time completion audits again with actor null (`completeUpdate`), so the
 * pair reads as "who asked" and then "what happened" — and a job that dies
 * mid-download still leaves the first half, which is the only record that
 * anyone pressed anything.
 *
 * There is no `--force` for a DOWNGRADE here, unlike the CLI: the API's target
 * comes from the release index rather than from an operator who has read the
 * consequences, and installing an older server over a migrated database is the
 * one act whose undo is the backup rather than another press.
 */
export const updateRoute = new Elysia()
  .use(requireAdmin)
  .use(apiModels)
  .post(
    "/update",
    async ({ body, user, status }) => {
      // 1. The release source, which everything after this depends on.
      if (releaseSourceUrl() === null) {
        return status(
          409,
          apiErrorBody({
            code: BackendErrorCodes.UPDATE_SOURCE_DISABLED,
            message:
              "This server does not fetch releases (SUBSHELL_RELEASE_URL is empty). Install the new binary by hand, or with `subshell-server update --from <file>`.",
          }),
        );
      }

      // 2. Supervision. A swap without a restart would leave a running OLD
      //    process beside a NEW file, and the marker would then blame the next
      //    boot for a transaction this one never completed.
      const deployment = updateSeams.deployment();
      if (!deployment.service.supervised) {
        return status(
          409,
          apiErrorBody({
            code: BackendErrorCodes.RESTART_UNAVAILABLE,
            message: deployment.restart.reason ?? "This server is not running under a service manager",
          }),
        );
      }

      // 3. Which file would be replaced.
      const binary = describeBinary(updateSeams.installed());
      if (binary.kind !== "compiled" || binary.path === null || binary.reason !== null) {
        return status(
          409,
          apiErrorBody({
            code: BackendErrorCodes.UPDATE_BINARY_UNKNOWN,
            message: binary.reason ?? "This host does not name an installed server binary",
          }),
        );
      }

      // 4. One transaction at a time — the marker on disk covers a CLI update
      //    started in a terminal, the job covers a second press here. This is
      //    the EARLY refusal (the polite 409 before any network work); it is
      //    NOT the lock. Everything below awaits, so the decision taken here
      //    can go stale before the job is set — which is exactly the race
      //    round-3 sweep C4 found: two concurrent POSTs both passed this
      //    check, both started, and shared one `<name>.download-<pid>` temp
      //    file while the loser's cleanup unlinked the winner's bytes. The
      //    lock is step 8's `updateSeams.claim`: one synchronous check-and-set
      //    with no await inside it, taken here-and-checked-here with the job.
      if (readPending() !== null || updateJobRunning()) {
        return status(
          409,
          apiErrorBody({
            code: BackendErrorCodes.UPDATE_IN_PROGRESS,
            message:
              "An update is already in progress; run `subshell-server update --rollback` on this host if it is stuck.",
          }),
        );
      }

      // 5. What there is to install — and the answer is "installable", not
      //    merely "newest": the release's manifest must carry a signature the
      //    compiled-in publisher key verifies (spec 2026-09-17 §5 path 2). No
      //    manifest, unsigned manifest and failed signature each refuse with
      //    their own sentence, one implementation with the Server row and the
      //    CLI's `update`.
      const gate = await updateSeams.release();
      if (!gate.ok) {
        return status(
          409,
          apiErrorBody({
            code: BackendErrorCodes.UPDATE_NOT_AVAILABLE,
            message: gate.reason,
          }),
        );
      }
      const release = gate.release;
      if (body.version !== undefined && body.version !== release.version) {
        // Only the newest release of a component is indexed, so a `version`
        // naming an older one has nothing to resolve. Say which one IS
        // available rather than "not found", which reads as a broken source.
        return status(
          409,
          apiErrorBody({
            code: BackendErrorCodes.UPDATE_NOT_AVAILABLE,
            message: `The newest published server release is ${release.version}, not ${body.version}.`,
          }),
        );
      }
      if (release.version === SERVER_VERSION) {
        return status(
          409,
          apiErrorBody({
            code: BackendErrorCodes.UPDATE_NOT_AVAILABLE,
            message: `This server is already running ${SERVER_VERSION}, the newest release.`,
          }),
        );
      }

      // 6. Never backwards from here. The CLI has `--force` for this; a browser
      //    does not, because the undo for an older server on a migrated
      //    database is the backup rather than another press.
      if (semverLt(release.version, SERVER_VERSION)) {
        return status(
          409,
          apiErrorBody({
            code: BackendErrorCodes.UPDATE_DOWNGRADE,
            message: `${release.version} is older than the running ${SERVER_VERSION}; install it with \`subshell-server update --to ${release.version} --force\` on this host.`,
          }),
        );
      }

      // 7. Pane safety, last because it is the only one `force` can answer.
      const forced = body.force === true;
      if (deployment.service.paneSafety !== "keeps" && !forced) {
        // Wording rule shared with `restart.route.ts`: an unreadable
        // definition says so; only a read that answered `kills` promises
        // anything about the panes.
        return status(
          409,
          apiErrorBody({
            code: BackendErrorCodes.RESTART_KILLS_PANES,
            message:
              deployment.service.paneSafety === "kills"
                ? "The installed service definition would close every running subshell when the server restarts; reinstall the service definition, or pass force to update anyway"
                : "The installed service definition could not be read, so whether the restart keeps the running subshells is unknown; reinstall the definition, or pass force to update anyway",
          }),
        );
      }

      // 8. The claim is the lock — one synchronous check-and-set, no await
      //    inside it (step 4's comment carries the race that makes this
      //    necessary). It re-reads the on-disk marker as well, so a
      //    `subshell-server update` that opened in a terminal while this
      //    request was looking up its release is refused HERE, not inside
      //    `beginUpdate` after the audit row. The loser gets the honest
      //    refusal and owes no audit row — it was refused, like every other
      //    409 on this route. The winner still audits BEFORE the job: the
      //    row is the record that someone pressed, and a job that dies
      //    mid-download leaves it (§4.5).
      if (!updateSeams.claim(release.version)) {
        return status(
          409,
          apiErrorBody({
            code: BackendErrorCodes.UPDATE_IN_PROGRESS,
            message:
              "An update is already running; follow its phase on GET /api/admin/server/update, or run `subshell-server update --rollback` on this host if it is stuck.",
          }),
        );
      }

      await audit({
        actorUserId: user.id,
        action: "server.update",
        targetType: "server",
        targetId: "process",
        metadataJson: JSON.stringify({ from: SERVER_VERSION, to: release.version, forced, origin: "api" }),
      });
      updateSeams.start({ release, binary: binary.path, forced });
      return status(202, { started: true as const, from: SERVER_VERSION, to: release.version });
    },
    {
      body: UpdateBodySchema,
      response: {
        202: UpdateStartedSchema,
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
        409: "ApiErrorResponse",
      },
      detail: {
        operationId: "startServerUpdate",
        tags: ["admin"],
        description:
          "Download the newest published server release, verify its digest, back up the database, swap the binary and exit for the service manager. 202 and an in-process job; poll GET /api/admin/server/update for the phase. Cookie-admin only.",
      },
    },
  );
