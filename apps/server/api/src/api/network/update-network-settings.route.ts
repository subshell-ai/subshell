import { BackendErrorCodes } from "@internal/backend-errors";
import { createPluginSecrets } from "@internal/pane-runtime";
import { Elysia, t } from "elysia";
import {
  auditNetwork,
  invalidateNetworkStatus,
  networkDeps,
  prepareNetworkAct,
  requireNetworkAdmin,
} from "@/api/network/network-gate.js";
import { buildNetworkRow } from "@/api/network/network-view.js";
import { NetworkParamsSchema, NetworkRowSchema } from "@/api/network/schemas.js";
import { SUBSHELL_SERVER_DATA_DIR } from "@/constants.js";
import { apiErrorBody } from "@/lib/api-error.js";
import { apiModels } from "@/schema/index.js";
import { readNetworkState, writeNetworkState } from "@/services/network/state.js";

const SettingsBodySchema = t.Record(
  t.String({ description: "A settings field key the plugin declared" }),
  t.String({ description: "The value to store. A `secret` field's value goes to the write-only secret store" }),
  {
    description:
      "The settings to store, merged over what is already there. Only keys the plugin declares are accepted; an empty string clears the field (and deletes a secret)",
  },
);

/**
 * `PATCH /api/network/:id/settings` (spec 2026-09-15 § 5.1).
 *
 * **Two stores, one request, and the split is the point.** A `secret` field's
 * value goes to the plugin's write-only secret store (0600, under the server's
 * data dir); every other field goes to `network.json`. Writing a credential
 * into the settings object would make that file a second, weaker copy of the
 * secret store — and it is the object handed to the plugin on every call, so
 * the plugin would then hold a value the contract says it never receives.
 *
 * A key the plugin does not declare is REFUSED rather than stored: settings
 * are a schema the plugin publishes, and accepting an unknown key would write
 * a row nothing reads and nothing can ever remove through this route.
 *
 * The audit row names the FIELDS and never the values. That is not a
 * convention here, it is the whole reason this route audits at all — and a
 * test scans the serialized metadata for the credential string.
 */
export const updateNetworkSettingsRoute = new Elysia().use(apiModels).patch(
  "/:id/settings",
  async ({ params, body, request, status }) => {
    await requireNetworkAdmin(request);
    const prepared = await prepareNetworkAct(params.id);
    if ("status" in prepared) {
      return status(prepared.status, apiErrorBody({ code: prepared.code, message: prepared.message }));
    }
    const { resolved, ctx, release } = prepared;
    try {
      // REFUSED WHILE PUBLISHED, and the refusal is the point rather than the
      // behaviour. Writing settings here changes what the plugin would
      // describe, and nothing re-derives from it: the installed request guard
      // keeps naming the hostname and audience it was built with, the
      // supervised child keeps the argv and the hydrated SECRET it was spawned
      // with, and every surface reports success. An admin rotating a leaked
      // tunnel token would see the field read `set` and the process read
      // running while the old credential stayed live — a rotation that
      // silently does not apply, on the one credential class this feature
      // introduces.
      //
      // Re-deriving all three is phase 3's work, written against the Cloudflare
      // plugin that actually exercises them. Until then this refusal is what
      // makes the gap unreachable BY CONSTRUCTION: phase 3 has to delete a
      // refusal to get the wrong thing, rather than remember to find a bug.
      // Same reasoning as `enabledHarnessPlugins` excluding network plugins at
      // one accessor instead of at five call sites.
      if ((await readNetworkState(resolved.entry.manifest.id)).published) {
        release();
        return status(
          409,
          apiErrorBody({
            code: BackendErrorCodes.EXISTS_ERROR,
            message: `${resolved.entry.manifest.name} is published. Unpublish it first, change these settings, then publish again — otherwise the change would not reach the running tunnel.`,
          }),
        );
      }
      const fields = resolved.entry.plugin.settingsFields?.() ?? [];
      const byKey = new Map(fields.map((f) => [f.key, f]));
      const unknown = Object.keys(body).filter((key) => !byKey.has(key));
      if (unknown.length > 0) {
        return status(
          400,
          apiErrorBody({
            code: BackendErrorCodes.INPUT_VALIDATION_ERROR,
            message: `${resolved.entry.manifest.name} has no setting named ${unknown.map((k) => `"${k}"`).join(", ")}.`,
          }),
        );
      }

      // Validation runs against the NON-secret half only: a plugin never
      // receives a secret's value, so it could not validate one, and handing
      // it the string here to check would be the one place the contract's
      // "named, never held" rule leaked.
      const nextSettings = { ...ctx.settings };
      const secretWrites: { name: string; value: string }[] = [];
      for (const [key, value] of Object.entries(body)) {
        if (byKey.get(key)?.type === "secret") secretWrites.push({ name: key, value });
        else if (value === "") delete nextSettings[key];
        else nextSettings[key] = value;
      }

      const issues = resolved.entry.plugin.validateSettings?.(nextSettings) ?? [];
      if (issues.length > 0) {
        return status(
          400,
          apiErrorBody({
            code: BackendErrorCodes.INPUT_VALIDATION_ERROR,
            message: issues.map((i) => `${i.field}: ${i.message}`).join("; "),
          }),
        );
      }

      const secrets = createPluginSecrets(SUBSHELL_SERVER_DATA_DIR, resolved.entry.manifest.id);
      for (const { name, value } of secretWrites) {
        // An empty string CLEARS a secret. Storing it would leave a field
        // reporting `set: true` with nothing usable behind it, which is the
        // state a "required" check cannot see through.
        if (value === "") await secrets.delete(name);
        else await secrets.set(name, value);
      }
      await writeNetworkState(resolved.entry.manifest.id, { settings: nextSettings });

      // The settings are what `status()` computes against, so the memo has
      // to go before the row is built or the response describes the state
      // from before this write.
      invalidateNetworkStatus(resolved.entry.manifest.id);
      await auditNetwork(request, "network.configure", resolved.entry.manifest.id, {
        // NAMES only. Never `Object.entries(body)`, never a value, and
        // never the count of characters in one.
        fields: Object.keys(body).sort(),
      });
      return await buildNetworkRow(resolved.entry, { enabled: true, platform: networkDeps().platform() });
    } finally {
      release();
    }
  },
  {
    params: NetworkParamsSchema,
    body: SettingsBodySchema,
    response: {
      200: NetworkRowSchema,
      400: "ApiErrorResponse",
      401: "ApiErrorResponse",
      403: "ApiErrorResponse",
      404: "ApiErrorResponse",
      409: "ApiErrorResponse",
    },
    detail: {
      operationId: "updateNetworkSettings",
      tags: ["network"],
      description:
        "Stores this network plugin's settings (admin cookie only). Secret fields go to the host's write-only secret store and are never returned; everything else goes to the plugin's state file. Audited as network.configure with the field NAMES only.",
    },
  },
);
