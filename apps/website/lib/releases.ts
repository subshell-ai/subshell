import { z } from "zod";

/** Schema for the repo-root releases.json (spec 2026-09-23 §3). Extra fields
 * survive (forward compatible); a wrong schemaVersion or a bad shape refuses. */
export const ReleasesManifestSchema = z.object({
  schemaVersion: z.literal(1),
  generatedAt: z.string(),
  // The value is .optional() on purpose: in zod 4 an enum-keyed record makes
  // EVERY key required, and a manifest missing one component (a component not
  // yet cut) must still parse — callers read components[id]?. Callers still
  // get the id constraint: an unknown key refuses.
  components: z.record(
    z.enum(["cli-server", "cli-node", "desktop-server", "desktop-client"]),
    z
      .object({
        version: z.string().regex(/^\d+\.\d+\.\d+$/),
        tag: z.string().min(1),
        url: z.string().url(),
        installScript: z.string().min(1).optional(),
      })
      .optional(),
  ),
});

export type ReleasesManifest = z.infer<typeof ReleasesManifestSchema>;

export const RAW_MANIFEST_URL = "https://raw.githubusercontent.com/subshell-ai/subshell/main/releases.json";

export function parseReleases(text: string): ReleasesManifest | null {
  try {
    return ReleasesManifestSchema.parse(JSON.parse(text));
  } catch {
    return null;
  }
}

/**
 * The fetched truth when it parses, the build-time baked copy for anything
 * else: offline, 404, an HTML error page, a future schema. A visitor never
 * sees a spinner or an error, only possibly-slightly-old version strings
 * (the raw URL is CDN-cached for ~5 minutes anyway).
 */
export async function refreshReleases(
  baked: ReleasesManifest,
  fetchImpl: typeof fetch = fetch,
): Promise<ReleasesManifest> {
  try {
    const res = await fetchImpl(RAW_MANIFEST_URL, { headers: { accept: "application/json" } });
    if (!res.ok) return baked;
    return parseReleases(await res.text()) ?? baked;
  } catch {
    return baked;
  }
}
