import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";

/**
 * The app-wide route error screen (the root route's `errorComponent`).
 *
 * Before this existed a route crash fell through to TanStack Router's
 * default screen: unstyled, flush against the phone status bar (no safe-area
 * padding at all — it "rendered above the pressable area", 2026-09-04
 * screenshot), and with no way back except killing the app.
 *
 * The dominant real cause is a STALE PWA after a deploy: the app's already
 * loaded JS asks for a lazy route chunk by a hash the new build replaced, and
 * the import fails ("Failed to fetch dynamically imported module"). That one
 * is self-healing with a reload — so it reloads ONCE (guarded so a genuine
 * failure cannot loop), and everything else gets a calm card with an explicit
 * Reload and Back-to-sessions escape.
 */

/** sessionStorage key: when set, the chunk-failure reload has been spent. */
const CHUNK_RELOAD_KEY = "subshell-chunk-reload-at";

/**
 * Whether an error is a lazy-chunk/import failure (the messages are
 * per-browser spellings of the same event). Exported for tests.
 */
export function isChunkLoadFailure(error: unknown): boolean {
  const msg = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return /dynamically imported module|error loading dynamically imported module|importing a module script failed|Failed to fetch dynamically|Loading chunk \S+ failed/i.test(
    msg,
  );
}

/** Short human label for an unknown error (never dumped raw on phones first). */
function brief(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

export function RouteError({ error }: { error: unknown }) {
  const chunk = isChunkLoadFailure(error);
  // "reload" while null: the auto-reload decision is pending; "spent" once a
  // guarded reload has been performed (the reload remounts us anyway).
  const [autoReload, setAutoReload] = useState<"pending" | "no">(chunk ? "pending" : "no");

  useEffect(() => {
    if (!chunk) return;
    const last = Number(sessionStorage.getItem(CHUNK_RELOAD_KEY) ?? "0");
    // A reload within the last 20 s that still landed here means reloading
    // did not fix it — stop, show the card, let the human decide.
    if (Date.now() - last < 20_000) {
      setAutoReload("no");
      return;
    }
    try {
      sessionStorage.setItem(CHUNK_RELOAD_KEY, String(Date.now()));
    } catch {
      // sessionStorage blocked (private mode oddities): still try the reload.
    }
    window.location.reload();
  }, [chunk]);

  return (
    <main className="flex h-full min-h-0 flex-col items-center justify-center gap-4 bg-background p-6 pb-[calc(1.5rem+env(safe-area-inset-bottom))] text-center text-sm">
      <div className="flex max-w-md flex-col items-center gap-1.5">
        <h1 className="font-medium text-body">This page hit an error</h1>
        {chunk ? (
          <p className="text-muted-foreground">
            The app updated while this page was open.{" "}
            {autoReload === "pending"
              ? "Reloading…"
              : "Reloading did not help. Reload again or head back to your sessions."}
          </p>
        ) : (
          <p className="wrap-break-word max-w-full text-muted-foreground">{brief(error)}</p>
        )}
      </div>
      <div className="flex items-center gap-2">
        <Button onClick={() => window.location.reload()}>Reload</Button>
        {/* Plain anchor, deliberately NOT a router <Link>: this screen appears
            when the router tree has already thrown, and a hard navigation is
            the recovery anyway. */}
        <Button variant="ghost" render={<a href="/" />}>
          Back to sessions
        </Button>
      </div>
    </main>
  );
}
