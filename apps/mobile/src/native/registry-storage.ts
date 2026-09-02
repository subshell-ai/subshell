import AsyncStorage from "@react-native-async-storage/async-storage";
import type { InstanceRecord } from "@/lib/instances";

/**
 * Registry persistence — the ONLY AsyncStorage keys this app writes for
 * configuration (origins/labels/emails are non-secret; tokens never come
 * here — spec §Security notes).
 */
const K_REGISTRY = "subshell.instances";
const K_ACTIVE = "subshell.instances.active";

/** @returns The stored registry; corrupt JSON degrades to empty, never throws. */
export async function loadRegistry(): Promise<{ instances: InstanceRecord[]; activeId: string | null }> {
  const [raw, active] = await Promise.all([AsyncStorage.getItem(K_REGISTRY), AsyncStorage.getItem(K_ACTIVE)]);
  let instances: InstanceRecord[] = [];
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (Array.isArray(parsed)) instances = parsed as InstanceRecord[];
  } catch {
    instances = []; // corrupt registry is non-fatal; the operator re-adds
  }
  // The two keys are written sequentially, so a kill between writes can leave
  // `active` pointing at an origin that is no longer registered. Never hand
  // the caller an activeId the registry can't vouch for (review, altitude #8).
  const activeId = active && instances.some((i) => i.id === active) ? active : null;
  return { instances, activeId: activeId ?? instances[0]?.id ?? null };
}

/** Persist after every store mutation (fire-and-forget from the provider). */
export async function saveRegistry(instances: InstanceRecord[], activeId: string | null): Promise<void> {
  await AsyncStorage.setItem(K_REGISTRY, JSON.stringify(instances));
  if (activeId) await AsyncStorage.setItem(K_ACTIVE, activeId);
  else await AsyncStorage.removeItem(K_ACTIVE);
}
