import { useEffect, useState } from "react";
import { useSessionsList } from "@/hooks/use-sessions";
import { apiFetch } from "@/lib/api";
import type { SessionView } from "@/types/session";

/**
 * Live session list for the home page.
 *
 * Prefers an SSE stream (`GET /api/events`) for near-real-time card updates.
 * Because EventSource cannot send the HttpOnly session cookie, auth uses the
 * same short-lived ws token as the WS attach path (POST /api/auth/ws-token →
 * `?token=` query param). Tokens are single-use and expire after 30s, so the
 * stream is (re)opened with a fresh token whenever the previous one dies.
 *
 * Falls back to the plain REST list (`GET /api/sessions`) when the stream is
 * unavailable (e.g. older backend without /api/events), so the page always
 * renders something. The REST failure is reported separately from emptiness:
 * when neither feed has anything (`isError`), the page shows an honest error
 * instead of the "No sessions yet" card.
 */
export function useLiveSessions(): {
  sessions: SessionView[];
  connected: boolean;
  isLoading: boolean;
  /** True when the REST list failed AND the SSE stream has delivered nothing */
  isError: boolean;
  /** Re-runs the REST list fetch (the retry affordance for `isError`) */
  refetch: () => Promise<unknown>;
} {
  const [sessions, setSessions] = useState<SessionView[] | null>(null);
  const [connected, setConnected] = useState(false);

  // REST fallback + initial load (also feeds invalidation after notes PATCH).
  const rest = useSessionsList();

  useEffect(() => {
    let es: EventSource | null = null;
    let cancelled = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    async function connect() {
      try {
        const { token } = await apiFetch<{ token: string }>("/api/auth/ws-token", { method: "POST" });
        if (cancelled) return;
        // One connection per token (tokens are single-use + 30s TTL).
        es = new EventSource(`/api/events?token=${encodeURIComponent(token)}`);
        es.onmessage = (e) => {
          try {
            const data = JSON.parse(e.data as string) as { sessions: SessionView[] };
            setSessions(data.sessions);
            setConnected(true);
          } catch {
            // ignore malformed frame
          }
        };
        // EventSource auto-reconnects on network errors, but the consumed/expired
        // token would 401 forever — tear the stream down and retry with a fresh
        // token (bounded backoff).
        es.onerror = () => {
          setConnected(false);
          es?.close();
          es = null;
          if (!cancelled) {
            const delay = reconnectTimer ? 3000 : 1000;
            reconnectTimer = setTimeout(() => {
              reconnectTimer = null;
              void connect();
            }, delay);
          }
        };
      } catch {
        // token fetch failed; rely on the REST fallback below
        setConnected(false);
      }
    }
    void connect();

    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      es?.close();
    };
  }, []);

  // `isError` is deliberately gated on `sessions === null`: once the stream
  // has delivered a list, the page has current data no matter what the REST
  // fallback did, and calling that an error would be a lie of its own.
  return {
    sessions: sessions ?? rest.data ?? [],
    connected,
    isLoading: rest.isLoading && sessions === null,
    isError: rest.isError && sessions === null,
    refetch: rest.refetch,
  };
}
