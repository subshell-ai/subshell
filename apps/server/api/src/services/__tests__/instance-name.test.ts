import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { setupAuthTables } from "@/api/__tests__/helpers/auth-tables.js";
import { db } from "@/db/index.js";
import { SettingsRepository } from "@/db/repositories/settings.repository.js";
import {
  INSTANCE_NAME_KEY,
  INSTANCE_NAME_MAX,
  resolveInstanceName,
  setInstanceName,
} from "@/services/instance-name.js";
import { localHostname } from "@/services/nodes/seed-local.js";

/**
 * The instance name resolves on every READ rather than being seeded as a row.
 * That is what makes "cleared" fall back to the hostname instead of to blank,
 * and it is why a rename needs no restart — there is nothing cached at boot.
 */
describe("instance name", () => {
  beforeAll(async () => {
    await setupAuthTables(); // real migrations → the settings table exists
  });

  afterEach(async () => {
    await new SettingsRepository(db).delete(INSTANCE_NAME_KEY);
  });

  it("falls back to this host's own name when unset", async () => {
    expect(await resolveInstanceName(db)).toBe(localHostname());
  });

  it("returns a stored name", async () => {
    await setInstanceName(db, "Prod plane");
    expect(await resolveInstanceName(db)).toBe("Prod plane");
  });

  it("strips control characters on write", async () => {
    // The name reaches anonymous callers and log lines; CR/LF would forge a
    // second line in a record.
    expect(await setInstanceName(db, "Prod\r\nplane")).toBe("Prod plane");
    expect(await resolveInstanceName(db)).toBe("Prod plane");
  });

  it("caps at INSTANCE_NAME_MAX", async () => {
    expect(await setInstanceName(db, "z".repeat(80))).toBe("z".repeat(INSTANCE_NAME_MAX));
  });

  it("treats a cleared value as unset rather than blank", async () => {
    await setInstanceName(db, "Prod plane");
    expect(await setInstanceName(db, "   ")).toBe(localHostname());
    expect(await resolveInstanceName(db)).toBe(localHostname());
  });

  it("survives a stored value that is nothing but control characters", async () => {
    // Written straight to the repo, bypassing setInstanceName — a value from
    // an older release or a hand-edited row must not render as blank.
    await new SettingsRepository(db).set(INSTANCE_NAME_KEY, "\r\n\t");
    expect(await resolveInstanceName(db)).toBe(localHostname());
  });
});
