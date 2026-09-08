import { create } from "zustand";
import { normalizeInstanceOrigin } from "@/lib/instance-url";
import { removeInstance as drop, type InstanceRecord, upsertInstance } from "@/lib/instances";

/**
 * The app's own store: which instances exist, which one is active, and the
 * auth hint screens read to route themselves. Persistence is wired by the
 * native layer (`src/native/registry-storage.ts`) — this file stays pure so
 * the transitions are unit-testable and no `src/lib` module imports a native
 * module (the rule `api.ts` states).
 */
interface AppState {
  instances: InstanceRecord[];
  /** Origin of the instance every screen talks to. */
  activeId: string | null;
  /** Registry loaded from disk — guards the splash→guard flicker. */
  hydrated: boolean;
  /** Called once by the provider after loadRegistry(). */
  hydrate(instances: InstanceRecord[], activeId: string | null): void;
  /**
   * Normalizes+stores+activates one typed address.
   * @throws InvalidInstanceUrl when the input is not an instance address
   */
  addInstance(input: string): InstanceRecord;
  /** Drops an entry (long-press delete); falls back to the next newest active. */
  forgetInstance(id: string): void;
  setActive(id: string): void;
  /** Records the sign-in email against the active instance. */
  setEmail(email: string): void;
  /** Records a probe verdict (the save-probe writes wsBlocked). */
  setWsBlocked(id: string, blocked: boolean): void;
}

export const useApp = create<AppState>((set, get) => ({
  instances: [],
  activeId: null,
  hydrated: false,
  hydrate: (instances, activeId) => set({ instances, activeId, hydrated: true }),
  addInstance: (input) => {
    const origin = normalizeInstanceOrigin(input);
    const prior = get().instances.find((r) => r.id === origin);
    const rec: InstanceRecord = {
      id: origin,
      label: new URL(origin).host,
      email: prior?.email ?? null,
      wsBlocked: prior?.wsBlocked ?? false,
      plainHttp: origin.startsWith("http://"),
    };
    set({ instances: upsertInstance(get().instances, rec), activeId: origin });
    return rec;
  },
  forgetInstance: (id) => {
    const instances = drop(get().instances, id);
    set({ instances, activeId: get().activeId === id ? (instances[0]?.id ?? null) : get().activeId });
  },
  setActive: (id) => set({ activeId: id }),
  setEmail: (email) => {
    const activeId = get().activeId;
    set({ instances: get().instances.map((r) => (r.id === activeId ? { ...r, email } : r)) });
  },
  setWsBlocked: (id, blocked) =>
    set({ instances: get().instances.map((r) => (r.id === id ? { ...r, wsBlocked: blocked } : r)) }),
}));
