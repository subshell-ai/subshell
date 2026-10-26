import { type ApiKeyPermission, isApiKeyPermission } from "@internal/subshell-protocol";

/** Null identifies legacy keys. Malformed or unknown versioned permissions always fail closed. */
export function systemKeyPermissions(metadata: Record<string, unknown> | null): ApiKeyPermission[] | null {
  if (!metadata || (!("permissionVersion" in metadata) && !("systemPermissions" in metadata))) return null;
  if (metadata.permissionVersion !== 1 || !Array.isArray(metadata.systemPermissions)) return [];
  return metadata.systemPermissions.filter(isApiKeyPermission);
}

/** A child or restarted token can keep or lose grants, never gain them. Null is legacy unrestricted access. */
export function intersectSystemPermissions(
  previous: ApiKeyPermission[] | null,
  requested: ApiKeyPermission[] | null,
): ApiKeyPermission[] | null {
  if (previous === null) return requested;
  if (requested === null) return previous;
  return previous.filter((permission) => requested.includes(permission));
}
