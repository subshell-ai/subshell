import AsyncStorage from "@react-native-async-storage/async-storage";
import type { InstanceRecord } from "@/lib/instances";

/**
 * Registry persistence — the ONLY AsyncStorage keys this app writes for
 * configuration (origins/labels/emails are non-secret; tokens never come
 * here — spec §Security notes).
 */
const K_REGISTRY = "mote.instances";
const K_ACTIVE = "mote.instances.active";

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
  return { instances, activeId: active ?? instances[0]?.id ?? null };
}

/** Persist after every store mutation (fire-and-forget from the provider). */
export async function saveRegistry(instances: InstanceRecord[], activeId: string | null): Promise<void> {
  await AsyncStorage.setItem(K_REGISTRY, JSON.stringify(instances));
  if (activeId) await AsyncStorage.setItem(K_ACTIVE, activeId);
  else await AsyncStorage.removeItem(K_ACTIVE);
}
