import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { router } from "expo-router";
import { createContext, type ReactNode, useContext, useEffect, useMemo, useRef, useState } from "react";
import { MoteClient } from "@/lib/api";
import { useApp } from "@/lib/app-state";
import { loadRegistry, saveRegistry } from "@/native/registry-storage";
import { secureTokenStore } from "@/native/secure-token-store";

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 1500, retry: 1 } },
});

const MoteContext = createContext<{ client: MoteClient | null }>({ client: null });

/**
 * Wires the M2 transport to the app: registry hydration (AsyncStorage), one
 * MoteClient per active instance (Keychain token store), and the 401 path —
 * the token store is cleared by MoteClient itself and the guard screen
 * re-presents sign-in from the cleared state.
 */
export function MoteProvider({ children }: { children: ReactNode }) {
  const hydrated = useApp((s) => s.hydrated);
  const hydrate = useApp((s) => s.hydrate);
  const instances = useApp((s) => s.instances);
  const activeId = useApp((s) => s.activeId);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    // .catch matters twice: a rejection used to leave the app rendering `null`
    // forever (black screen, no redbox), and skipping hydrate() in the catch
    // would just swap that for the guard's infinite spinner. A storage that
    // rejects on READ will reject on WRITE too, so falling back to an empty
    // registry cannot silently destroy data — it matches the corrupt-data
    // path in registry-storage.ts (review #3, 2026-08-31).
    void loadRegistry()
      .then(({ instances, activeId }) => {
        hydrate(instances, activeId);
      })
      .catch((err) => {
        console.warn("[mote] registry hydration failed; starting empty", err);
        hydrate([], null);
      })
      .finally(() => setReady(true));
  }, [hydrate]);

  useEffect(() => {
    if (hydrated) void saveRegistry(instances, activeId).catch(() => undefined);
  }, [instances, activeId, hydrated]);

  // Queries are keyed by NAME ("sessions", "summary", "session/<id>"), so an
  // instance switch would otherwise show (and poll) the previous instance's
  // data under the same keys. Drop the whole cache on switch — cheap, and the
  // resumed poll re-populates it.
  const prevActive = useRef(activeId);
  useEffect(() => {
    if (prevActive.current === activeId) return;
    prevActive.current = activeId;
    queryClient.clear();
  }, [activeId]);

  const client = useMemo(() => {
    if (!activeId) return null;
    return new MoteClient({
      baseUrl: activeId,
      store: secureTokenStore(activeId),
      // 401 mid-session is expected (7-day session): drop cached reads and
      // surface sign-in over whatever screen hit it. The instance token is
      // already cleared by MoteClient.request itself (spec §Auth: never a
      // silent retry).
      onUnauthorized: () => {
        queryClient.clear();
        router.replace("/sign-in");
      },
    });
  }, [activeId]);

  if (!ready) return null;
  return (
    <QueryClientProvider client={queryClient}>
      <MoteContext.Provider value={{ client }}>{children}</MoteContext.Provider>
    </QueryClientProvider>
  );
}

/** The active client or null (pre-connect / no instance). */
export function useMote(): { client: MoteClient | null } {
  return useContext(MoteContext);
}
