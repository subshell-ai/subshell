import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate, useParams } from "@tanstack/react-router";
import type { SearchAddon } from "@xterm/addon-search";
import type { Terminal } from "@xterm/xterm";
import { SlidersHorizontal } from "lucide-react";
import { useRef, useState } from "react";
import { DetailBackHeader } from "@/components/detail-back-header";
import { EditableText } from "@/components/editable-text";
import { SessionActionsMenu } from "@/components/session-actions-menu";
import { SessionTerminal, type SessionTerminalHandles } from "@/components/session-terminal";
import { StatusPill } from "@/components/status-pill";
import { TerminalKeyBar } from "@/components/terminal-key-bar";
import { TranscriptSearch } from "@/components/transcript-search";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useIsCoarsePointer } from "@/hooks/use-is-coarse-pointer";
import { useProfiles } from "@/hooks/use-profiles";
import { useSessionData } from "@/hooks/use-session-data";
import { useSessionLog } from "@/hooks/use-session-log";
import { useSessionMutations } from "@/hooks/use-session-mutations";
import { apiFetch } from "@/lib/api";
import { SESSION_QUERY_KEY, SESSIONS_QUERY_KEY, WORKSPACE_QUERY_KEY } from "@/lib/query-keys";

export const Route = createFileRoute("/sessions_/$id")({
  component: SessionPage,
});

function SessionPage() {
  const { id } = useParams({ from: "/sessions_/$id" });
  // Terminal handles published by <SessionTerminal> on every (re-)create and
  // withdrawn on dispose; "/" commands and the transcript finder drive the
  // terminal through them.
  const termRef = useRef<Terminal | null>(null);
  const sendInputRef = useRef<((data: string) => void) | null>(null);
  const openImagePickerRef = useRef<(() => void) | null>(null);
  const [search, setSearch] = useState<SearchAddon | null>(null);
  const [connected, setConnected] = useState(false);
  const [closed, setClosed] = useState(false);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { session, exited, dead } = useSessionData(id);

  /** Renames this session in place (the header title edits itself). */
  async function saveName(name: string): Promise<void> {
    await apiFetch(`/api/sessions/${id}/name`, { method: "PATCH", body: JSON.stringify({ name }) });
    void queryClient.invalidateQueries({ queryKey: [...SESSION_QUERY_KEY, id] });
    void queryClient.invalidateQueries({ queryKey: SESSIONS_QUERY_KEY });
    // Workspace pane titles carry the session name; their query is per-workspace.
    void queryClient.invalidateQueries({ queryKey: WORKSPACE_QUERY_KEY });
  }
  // This page's half of the shared `useSessionMutations` implementation —
  // it drives the terminal's exited panel. The header menu uses its own
  // instance of the same hook. A restart revives the same row (the terminal
  // re-mounts via the aliveness key below); a delete leaves the dead page.
  const { restart, remove, restarting, deleting } = useSessionMutations(id, session, {
    onDeleted: () => void navigate({ to: "/" }),
  });
  // Once the harness is dead, its pane-log tail is what explains the exit —
  // fetched only for the dead panel (crashed or terminated), never while the
  // terminal is attached.
  const { data: logTail } = useSessionLog(id, dead);
  const { data: profiles } = useProfiles();
  const profile = profiles?.find((p) => p.id === session?.profileId);
  // Touch UX (spec §5): the accessory key bar appears on coarse pointers.
  // Soft-keyboard pinning is the shell's job (`__root.tsx`); `h-full` below
  // resolves against the already-pinned scroll container.
  const coarse = useIsCoarsePointer();

  /** Takes ownership of a freshly created terminal and its addons. */
  function handleTerminalReady(handles: SessionTerminalHandles) {
    termRef.current = handles.term;
    sendInputRef.current = handles.sendInput;
    openImagePickerRef.current = handles.openImagePicker;
    setSearch(handles.search);
  }

  /** Drops the handles: the terminal behind them is about to be disposed. */
  function handleTerminalDispose() {
    termRef.current = null;
    sendInputRef.current = null;
    openImagePickerRef.current = null;
    setSearch(null);
  }

  /** Key-bar byte sink: every button writes its bytes to the pane as an
   * input frame, exactly like a physical key. */
  function handleKeyBarBytes(bytes: string) {
    sendInputRef.current?.(bytes);
  }

  // "reconnecting…" pill: the WS dropped (or is still retrying after a
  // backend restart) and the session may still be running. The hook
  // reconnects automatically and the terminal stays mounted; history is
  // re-streamed on every attach. Only when the session query reports the
  // process dead (the exited state) or the server refused the attach (closed)
  // is the terminal replaced by a state panel.
  const showPill = !connected && !closed && !dead && !restarting;

  return (
    <main className="flex h-full flex-col">
      <DetailBackHeader
        to="/"
        backLabel="Back to sessions"
        title={
          <>
            {/* Click to rename; the id stands in, muted, until the record loads. */}
            <EditableText
              value={session?.name ?? ""}
              placeholder={id}
              label="Rename session"
              onSave={saveName}
              className="font-medium"
              inputClassName="w-56"
            />
            <span className="ml-2 hidden truncate text-muted-foreground text-xs sm:inline">{session?.workingDir}</span>
          </>
        }
        actions={
          <>
            {/* Node-offline outranks `exited` (spec §5.6): with no live agent
                the process state is unobservable, not dead — same precedence
                the home cards use. */}
            <Badge
              variant={
                session?.nodeOffline
                  ? "warning"
                  : exited
                    ? "warning"
                    : session?.status === "running"
                      ? "success"
                      : "muted"
              }
            >
              {session?.nodeOffline ? "node unreachable" : exited ? "exited" : (session?.status ?? "…")}
            </Badge>
            {session && session.backoffCount > 0 && (
              <span className="text-muted-foreground text-xs">restart #{session.backoffCount} pending</span>
            )}
            {/* Same menu the cards and rows use, fed by the same mutation hook
                this page's exited panel uses — so both surfaces run the same
                actions and refresh the same queries the page observes. Disabled
                while the panel's own restart/delete is in flight (the menu holds
                a separate hook instance and can't see it). */}
            {session && (
              <SessionActionsMenu
                session={session}
                disabled={restarting || deleting}
                onDeleted={() => void navigate({ to: "/" })}
              />
            )}
            {connected && (
              <TranscriptSearch
                search={search}
                onClose={() => {
                  // nothing to reset — the bar owns its own state
                }}
              />
            )}
          </>
        }
      />

      <div className="relative flex-1 overflow-hidden bg-terminal-strip p-0">
        {/* Keyed by the row's startedAt, not aliveness: a restart mints a NEW
            startedAt (reviveRow stamps it), so exactly one remount lands on
            every birth — including a LIVE restart, where the client never sees
            `alive:false` (the POST returns after the pane is already respawned)
            and an aliveness key would leave the socket wedged on the transient
            4004 it hits during the kill→respawn gap. `startedAt ?? "loading"`
            is stable across the initial load→loaded transition for a crash
            (reconcile never clears startedAt), so a crash shows the dead panel
            without remounting, and the auto-restart that follows re-keys it. */}
        <SessionTerminal
          key={`${id}:${session?.startedAt ?? "loading"}`}
          sessionId={id}
          session={session}
          onReady={handleTerminalReady}
          onDispose={handleTerminalDispose}
          onStatusChange={(status) => {
            setConnected(status.connected);
            setClosed(status.closed);
          }}
          onRestart={() => void restart()}
          restarting={restarting}
          onDelete={() => void remove()}
          deleting={deleting}
          diagnostics={logTail ?? null}
          extraActions={
            profile && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => void navigate({ to: "/profiles/$id", params: { id: profile.id } })}
              >
                <SlidersHorizontal className="h-3 w-3" /> Edit profile
              </Button>
            )
          }
        />
        {showPill && <StatusPill tone="warning">reconnecting…</StatusPill>}
      </div>

      {/* The accessory key bar is an input affordance — a `view` grantee has
          none (the terminal itself is read-only for them, spec §4.1). */}
      {/* The image button doubles as the touch upload gesture: dropping or
        clipboard-pasting files has no equivalent on a phone. */}
      {coarse && session?.access !== "view" && (
        <TerminalKeyBar
          disabled={!connected}
          onBytes={handleKeyBarBytes}
          onPickImage={() => openImagePickerRef.current?.()}
        />
      )}
    </main>
  );
}
