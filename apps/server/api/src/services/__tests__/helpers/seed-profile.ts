import type { ProfilesRepository } from "@/db/repositories/profiles.repository.js";

/**
 * Inserts a profile row with the repo's full required shape filled with
 * service-test defaults (user "u1", claude-code, name "P"); override any field.
 * One spelling so a new required column is a one-file change, not a hunt
 * through every service suite.
 */
export async function seedProfile(
  repo: ProfilesRepository,
  overrides: Partial<Parameters<ProfilesRepository["create"]>[0]> = {},
): Promise<string> {
  const profile = await repo.create({
    id: crypto.randomUUID(),
    userId: "u1",
    harnessId: "claude-code",
    name: "P",
    description: null,
    envJson: null,
    flagsJson: null,
    settingsJson: null,
    configIsolation: 0,
    ...overrides,
  });
  return profile.id;
}
