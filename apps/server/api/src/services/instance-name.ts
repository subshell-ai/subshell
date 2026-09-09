import { normalizeLabel } from "@internal/subshell-protocol";
import type { Kysely } from "kysely";
import { SettingsRepository } from "@/db/repositories/settings.repository.js";
import type { Database } from "@/db/types/index.js";
import { localHostname } from "@/services/nodes/seed-local.js";

/** Settings key holding the operator-chosen name for this control plane. */
export const INSTANCE_NAME_KEY = "instance_name";

/** Cap on the instance name, matching a node name's 64. */
export const INSTANCE_NAME_MAX = 64;

/**
 * This control plane's display name: the operator's choice, or this host's own
 * name when they have not made one (spec 2026-09-08).
 *
 * Resolved on every read rather than seeded as a row. Three things follow from
 * that: clearing the field falls back to the hostname instead of to blank, a
 * hostname change is picked up on its own, and there is no settings migration
 * to write. It is also why a rename applies with no restart — nothing here is
 * read once at boot and cached, unlike everything in config.env.
 *
 * The stored value is re-normalized on the way OUT as well as in, so a row
 * written by an older release or edited by hand cannot put control characters
 * into a log line or an anonymous response.
 *
 * @param db - The app's Kysely handle
 */
export async function resolveInstanceName(db: Kysely<Database>): Promise<string> {
  const stored = await new SettingsRepository(db).get<string | null>(INSTANCE_NAME_KEY, null);
  const clean = stored ? normalizeLabel(stored, INSTANCE_NAME_MAX) : "";
  return clean || localHostname();
}

/**
 * Stores a new instance name and returns what will now be read back.
 *
 * A value with nothing printable in it is stored as null — "unset", not
 * "blank" — so the hostname fallback takes over. That is the only way an
 * operator can say "go back to the default".
 *
 * @param db - The app's Kysely handle
 * @param raw - The submitted name, unsanitized
 * @returns The resolved name after the write
 */
export async function setInstanceName(db: Kysely<Database>, raw: string): Promise<string> {
  const clean = normalizeLabel(raw, INSTANCE_NAME_MAX);
  await new SettingsRepository(db).set(INSTANCE_NAME_KEY, clean || null);
  return clean || localHostname();
}
