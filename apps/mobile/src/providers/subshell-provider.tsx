import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { router } from "expo-router";
import { createContext, type ReactNode, useContext, useEffect, useMemo, useRef, useState } from "react";
import { SubshellClient } from "@/lib/api";
import { useApp } from "@/lib/app-state";
import { loadRegistry, saveRegistry } from "@/native/registry-storage";
import { secureTokenStore } from "@/native/secure-token-store";

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 1500, retry: 1 } },
});

const SubshellContext = createContext<{ client: SubshellClient | null }>({ client: null });

/**
 * Wires the M2 transport to the app: registry hydration (AsyncStorage), one
 * SubshellClient per active instance (Keychain token store), and the 401 path —
 * the token store is cleared by SubshellClient itself and the guard screen
 * re-presents sign-in from the cleared state.
 */
export function SubshellProvider({ children }: { children: ReactNode }) {
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
        console.warn("[subshell] registry hydration failed; starting empty", err);
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
    return new SubshellClient({
      baseUrl: activeId,
      store: secureTokenStore(activeId),
      // 401 mid-session is expected (7-day session): drop cached reads and
      // surface sign-in over whatever screen hit it. The instance token is
      // already cleared by SubshellClient.request itself (spec §Auth: never a
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
      <SubshellContext.Provider value={{ client }}>{children}</SubshellContext.Provider>
    </QueryClientProvider>
  );
}

/** The active client or null (pre-connect / no instance). */
export function useSubshell(): { client: SubshellClient | null } {
  return useContext(SubshellContext);
}
