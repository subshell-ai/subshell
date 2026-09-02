import * as SecureStore from "expo-secure-store";
import type { TokenStore } from "@/lib/api";

/**
 * Keychain/Keystore-backed session token for ONE instance —
 * `subshell.token.<instanceId>` (spec §Auth: SecureStore, never AsyncStorage).
 * SecureStore keys must be filesystem-safe (A-Za-z0-9._-) and origins carry
 * `//` and `:`, hence the slug.
 */
function keyFor(instanceId: string): string {
  return `subshell.token.${instanceId.replace(/[^A-Za-z0-9._-]/g, "_")}`;
}

/** @param instanceId - Normalized origin (the InstanceRecord id) */
export function secureTokenStore(instanceId: string): TokenStore {
  const key = keyFor(instanceId);
  return {
    get: async () => (await SecureStore.getItemAsync(key)) ?? null,
    set: async (token) => SecureStore.setItemAsync(key, token),
    clear: async () => {
      await SecureStore.deleteItemAsync(key);
    },
  };
}
