import { Button, errMessage } from "@internal/node-admin";
import { ArrowUp, ChevronRight, Folder } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useSshListDirs } from "@/hooks/use-ssh-runtime";

/**
 * The remote folder picker over a LIVE session (design §7's browse step):
 * one-level listings through the session's `list_dirs`, the absolute path
 * always shown, `Up` walking to the parent the server names. It lists the
 * destination, never the connecting machine - the path line says whose disk
 * this is. Empty and failure read differently on purpose: a failure says the
 * listing did not answer, an empty says the folder simply has no subfolders.
 */
export function DirBrowser({
  sessionId,
  host,
  value,
  onChange,
}: {
  sessionId: string;
  /** Destination host, for the line that says whose disk is being browsed. */
  host: string;
  /** The chosen working directory ("" = the home the session starts in). */
  value: string;
  onChange: (path: string) => void;
}) {
  const listDirs = useSshListDirs();
  // The open panel path, for Retry: "" asks the destination account's home,
  // which the server resolves and answers with its realpath - the path shown
  // is the one that came back, never a typed one.
  const [askedPath, setAskedPath] = useState("");

  const browse = (path: string) => {
    setAskedPath(path);
    listDirs.mutate(
      { sessionId, path },
      {
        // The home request ("" = the destination account's home) SELECTS its
        // realpath when nothing is chosen yet: the server's answer, never a
        // guess. Later browses leave the chosen row's value alone.
        onSuccess: (listing) => {
          if (path === "" && valueRef.current === "") onChange(listing.path);
        },
      },
    );
  };
  // The current value at SUCCESS time, read through a ref so the callback
  // above never closes over a stale one (and the effect below stays simple).
  const valueRef = useRef(value);
  valueRef.current = value;
  // First paint browses the chosen value (the wizard starts at the home, ""
  // until the server's realpath lands); a session change re-browses. The
  // mutation object and `value` are deliberately NOT deps: naming them would
  // re-fire this effect on every listing (the home selection changes `value`)
  // and ping-pong the destination forever.
  // biome-ignore lint/correctness/useExhaustiveDependencies: browse re-arms only for a new session
  useEffect(() => {
    browse(value);
  }, [sessionId]);

  const failed = listDirs.isError;
  const listing = listDirs.isSuccess ? listDirs.data : null;
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <p className="font-strong text-label">Choose the folder</p>
        <p className="text-detail text-muted-foreground">
          Disk on <span className="font-mono">{host}</span>
        </p>
      </div>
      {/* The absolute path the picker stands on, stated as the fact it is. */}
      <p className="truncate font-mono text-detail text-muted-foreground" data-testid="connect-current-path">
        Current folder: {listing?.path ?? "Home"}
      </p>
      {failed && (
        <div className="flex items-center gap-2">
          <p role="alert" className="text-destructive text-detail">
            {errMessage(listDirs.error, "This folder could not be read on the destination.")}
          </p>
          <Button variant="outline" size="sm" onClick={() => browse(askedPath)}>
            Retry
          </Button>
        </div>
      )}
      {!failed && listDirs.isPending && <p className="text-detail text-muted-foreground">Loading…</p>}
      {listing !== null && (
        <div className="rounded-md border">
          {listing.parent !== null && (
            <button
              type="button"
              className="flex w-full items-center gap-2 border-b px-3 py-2 text-left hover:bg-accent"
              onClick={() => {
                onChange(listing.parent as string);
                browse(listing.parent as string);
              }}
            >
              <ArrowUp className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate text-sm">Up to {listing.parent}</span>
            </button>
          )}
          {listing.entries.length === 0 && !listDirs.isPending && (
            <p className="px-3 py-2 text-detail text-muted-foreground">
              This folder has no subfolders. You can still launch in it.
            </p>
          )}
          {listing.entries.map((entry) => (
            <button
              key={entry.path}
              type="button"
              className={`flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-accent ${
                entry.path === value ? "bg-accent" : ""
              }`}
              onClick={() => {
                onChange(entry.path);
                browse(entry.path);
              }}
              aria-pressed={entry.path === value}
            >
              <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate text-sm">{entry.name}</span>
              <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
            </button>
          ))}
          {listing.truncated && (
            <p className="border-t px-3 py-2 text-detail text-muted-foreground">
              The listing is capped; more folders exist here.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
