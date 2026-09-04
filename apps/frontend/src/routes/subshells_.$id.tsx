import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate, useParams } from "@tanstack/react-router";
import type { SearchAddon } from "@xterm/addon-search";
import type { Terminal } from "@xterm/xterm";
import { SlidersHorizontal } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { DetailBackHeader } from "@/components/detail-back-header";
import { EditableText } from "@/components/editable-text";
import { SubshellNotFoundCard } from "@/components/not-found-page";
import { StatusPill } from "@/components/status-pill";
import { SubshellActionsMenu } from "@/components/subshell-actions-menu";
import { SubshellDevices } from "@/components/subshell-devices";
import { SubshellTerminal, type SubshellTerminalHandles } from "@/components/subshell-terminal";
import { TerminalKeyBar } from "@/components/terminal-key-bar";
import { TranscriptSearch } from "@/components/transcript-search";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useIsCoarsePointer } from "@/hooks/use-is-coarse-pointer";
import { useIsStackedHeader } from "@/hooks/use-is-stacked-header";
import { useSwipeOrderedSubshells } from "@/hooks/use-ordered-subshells";
import { useProfiles } from "@/hooks/use-profiles";
import { useSubshellData } from "@/hooks/use-subshell-data";
import { useSubshellLog } from "@/hooks/use-subshell-log";
import { useSubshellMutations } from "@/hooks/use-subshell-mutations";
import { useSwipeNav } from "@/hooks/use-swipe-nav";
import { apiFetch } from "@/lib/api";
import { SUBSHELL_QUERY_KEY, SUBSHELLS_QUERY_KEY, WORKSPACE_QUERY_KEY } from "@/lib/query-keys";
import { findNeighbors } from "@/lib/subshell-neighbors";
import { swipeNavEnabled } from "@/lib/swipe-nav-pref";
import type { ViewersState } from "@/lib/use-subshell-ws";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/subshells_/$id")({
  component: SubshellPage,
});

function SubshellPage() {
  const { id } = useParams({ from: "/subshells_/$id" });
  // Terminal handles published by <SubshellTerminal> on every (re-)create and
  // withdrawn on dispose; "/" commands and the transcript finder drive the
  // terminal through them.
  const termRef = useRef<Terminal | null>(null);
  const sendInputRef = useRef<((data: string) => void) | null>(null);
  const openImagePickerRef = useRef<(() => void) | null>(null);
  const scrollToTopRef = useRef<(() => void) | null>(null);
  const scrollToBottomRef = useRef<(() => void) | null>(null);
  const [search, setSearch] = useState<SearchAddon | null>(null);
  const [connected, setConnected] = useState(false);
  /**
   * Who else is watching, straight off the terminal's socket. Null while the
   * socket is down — the device list is live state, not a cache.
   */
  const [viewers, setViewers] = useState<ViewersState | null>(null);
  const setSizingRef = useRef<SubshellTerminalHandles["setSizing"] | null>(null);
  const [closed, setClosed] = useState(false);
  /** Whether the Find bar is up — see the header actions row for why it matters. */
  const [findOpen, setFindOpen] = useState(false);
  /** Superseded by a newer viewer (close 4003) — the subshell runs, elsewhere. */
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { subshell, isLoading, isError, isNotFound, exited, dead } = useSubshellData(id);

  /** Renames this subshell in place (the header title edits itself). */
  async function saveName(name: string): Promise<void> {
    await apiFetch(`/api/subshells/${id}/name`, { method: "PATCH", body: JSON.stringify({ name }) });
    void queryClient.invalidateQueries({ queryKey: [...SUBSHELL_QUERY_KEY, id] });
    void queryClient.invalidateQueries({ queryKey: SUBSHELLS_QUERY_KEY });
    // Workspace pane titles carry the subshell name; their query is per-workspace.
    void queryClient.invalidateQueries({ queryKey: WORKSPACE_QUERY_KEY });
  }
  // This page's half of the shared `useSubshellMutations` implementation —
  // it drives the terminal's exited panel. The header menu uses its own
  // instance of the same hook. A restart revives the same row (the terminal
  // re-mounts via the aliveness key below); a delete leaves the dead page.
  const { restart, remove, restarting, deleting } = useSubshellMutations(id, subshell, {
    onDeleted: () => void navigate({ to: "/" }),
  });
  // Once the harness is dead, its pane-log tail is what explains the exit —
  // fetched only for the dead panel (crashed or terminated), never while the
  // terminal is attached.
  const { data: logTail } = useSubshellLog(id, dead);
  const { data: profiles } = useProfiles();
  const profile = profiles?.find((p) => p.id === subshell?.profileId);
  // Touch UX (spec §5): the accessory key bar appears on coarse pointers.
  // Soft-keyboard pinning is the shell's job (`__root.tsx`); `h-full` below
  // resolves against the already-pinned scroll container.
  const coarse = useIsCoarsePointer();
  // On phones the title moves to the header's second row as a display-only
  // line — editing lives in the actions menu ("Edit title"). Desktop keeps
  // click-to-edit inline, at any window width. Same signal DetailBackHeader
  // uses for the reflow.
  const stacked = useIsStackedHeader();
  // On phones the Find bar shares the chrome row and does not fit beside the
  // badge, the actions menu, or the back arrow — while it is open they all
  // vacate (desktop keeps everything; the ✕ closes the bar and they return).
  const findTakesRow = stacked && findOpen;

  // Swipe prev/next (spec 2026-09-04): walk the sidebar order with the thumb.
  // Neighbours are recomputed per render — SSE reshuffles the list live, so
  // the gesture must never hold a stale neighbour id.
  // Creation order, not sidebar order: the sidebar re-ranks by activity,
  // which would move the swipe target while the user is swiping.
  const ordered = useSwipeOrderedSubshells();
  const { prev, next } = useMemo(() => findNeighbors(ordered, id), [ordered, id]);
  // Per-device opt-out (Preferences → This device, default on). A mount-time
  // read is enough: toggling it lives on /preferences, and coming back here
  // remounts this page.
  const [swipeOn] = useState(() => swipeNavEnabled());
  const swipeZoneRef = useRef<HTMLDivElement>(null);
  useSwipeNav(swipeZoneRef, {
    enabled: swipeOn && Boolean(prev ?? next),
    onPrev: () => {
      if (prev) void navigate({ to: "/subshells/$id", params: { id: prev } });
    },
    onNext: () => {
      if (next) void navigate({ to: "/subshells/$id", params: { id: next } });
    },
  });

  /** Takes ownership of a freshly created terminal and its addons. */
  function handleTerminalReady(handles: SubshellTerminalHandles) {
    termRef.current = handles.term;
    sendInputRef.current = handles.sendInput;
    openImagePickerRef.current = handles.openImagePicker;
    scrollToTopRef.current = handles.scrollToTop;
    scrollToBottomRef.current = handles.scrollToBottom;
    setSizingRef.current = handles.setSizing;
    setSearch(handles.search);
  }

  /** Drops the handles: the terminal behind them is about to be disposed. */
  function handleTerminalDispose() {
    termRef.current = null;
    sendInputRef.current = null;
    openImagePickerRef.current = null;
    scrollToTopRef.current = null;
    scrollToBottomRef.current = null;
    setSizingRef.current = null;
    setSearch(null);
  }

  /** Key-bar byte sink: every button writes its bytes to the pane as an
   * input frame, exactly like a physical key. */
  function handleKeyBarBytes(bytes: string) {
    sendInputRef.current?.(bytes);
  }

  /** Scroll jumps drive the LOCAL xterm scrollback — no socket round-trip. */
  function handleScrollTop() {
    scrollToTopRef.current?.();
  }
  function handleScrollBottom() {
    scrollToBottomRef.current?.();
  }

  // "reconnecting…" pill: the WS dropped (or is still retrying after a
  // backend restart) and the subshell may still be running. The hook
  // reconnects automatically and the terminal stays mounted; history is
  // re-streamed on every attach. Only when the subshell query reports the
  // process dead (the exited state) or the server refused the attach (closed)
  // is the terminal replaced by a state panel.
  // `isLoading` is NOT a reconnect: the terminal is not even mounted yet, and
  // claiming "reconnecting…" before a first attach would be a lie.
  const showPill = !connected && !closed && !dead && !restarting && !isLoading;

  // Gone is gone: a 404 means the record will never arrive (deleted, or never
  // shared with this viewer — the backend answers 404 for both), so do NOT
  // mount the terminal: its token POST and WS attach are both doomed, and the
  // not-running panel would offer Restart/Delete on a row that doesn't exist.
  // Only while NO record is cached — one deleted mid-view keeps the live-pane
  // path below (spec 2026-09-03 §3). Placed after the LAST hook call in the
  // component, so the early return never skips a hook.
  if (isNotFound && !subshell) return <SubshellNotFoundCard />;

  return (
    <main className="flex h-full flex-col">
      <DetailBackHeader
        to="/"
        backLabel="Back to subshells"
        hideBack={findTakesRow}
        title={
          stacked ? (
            <span className={cn("truncate", !subshell?.name && "text-muted-foreground")}>{subshell?.name || id}</span>
          ) : (
            /* Click to rename; the id stands in, muted, until the record loads. */
            <EditableText
              value={subshell?.name ?? ""}
              placeholder={id}
              label="Rename subshell"
              onSave={saveName}
              className="font-medium"
              inputClassName="w-56"
            />
          )
        }
        subtitle={subshell?.workingDir}
        actions={
          <>
            {/* Node-offline outranks `exited` (spec §5.6): with no live agent
                the process state is unobservable, not dead — same precedence
                the home cards use. `findTakesRow` covers the phone Find-bar
                vacate (see its definition). */}
            {!findTakesRow && (
              <>
                <Badge
                  variant={
                    subshell?.nodeOffline
                      ? "warning"
                      : exited
                        ? "warning"
                        : subshell?.status === "running"
                          ? "success"
                          : "muted"
                  }
                >
                  {subshell?.nodeOffline ? "node unreachable" : exited ? "exited" : (subshell?.status ?? "…")}
                </Badge>
                {subshell && subshell.backoffCount > 0 && (
                  <span className="text-muted-foreground text-xs">restart #{subshell.backoffCount} pending</span>
                )}
                {/* Same menu the cards and rows use, fed by the same mutation hook
                this page's exited panel uses — so both surfaces run the same
                actions and refresh the same queries the page observes. Disabled
                while the panel's own restart/delete is in flight (the menu holds
                a separate hook instance and can't see it). */}
                {/* Why the terminal is the size it is — and how to change
                    which device decides. Renders itself away when this is the
                    only device attached. */}
                <SubshellDevices
                  state={viewers}
                  onSizing={
                    subshell?.access === "view" ? undefined : (mode, viewerId) => setSizingRef.current?.(mode, viewerId)
                  }
                />
                {subshell && (
                  <SubshellActionsMenu
                    subshell={subshell}
                    disabled={restarting || deleting}
                    onDeleted={() => void navigate({ to: "/" })}
                  />
                )}
              </>
            )}
            {connected && (
              <TranscriptSearch
                search={search}
                onOpenChange={setFindOpen}
                onClose={() => {
                  // nothing to reset — the bar owns its own state
                }}
              />
            )}
          </>
        }
      />

      <div ref={swipeZoneRef} className="relative flex-1 overflow-hidden bg-terminal-strip p-0">
        {/* Mount only once the record has settled: attaching under a
            "loading" key and remounting when the query lands replayed the
            whole pane twice per visit (the visible double-jumble). An errored
            query (gone/unknown id) still mounts — that is exactly when the
            "not running" panel has to show.
            Keyed by the row's startedAt, not aliveness: a restart mints a NEW
            startedAt (reviveRow stamps it), so exactly one remount lands on
            every birth — including a LIVE restart, where the client never sees
            `alive:false` (the POST returns after the pane is already respawned)
            and an aliveness key would leave the socket wedged on the transient
            4004 it hits during the kill→respawn gap. */}
        {(subshell || isError) && (
          <SubshellTerminal
            key={`${id}:${subshell?.startedAt ?? "missing"}`}
            subshellId={id}
            subshell={subshell}
            onReady={handleTerminalReady}
            onDispose={handleTerminalDispose}
            onStatusChange={(status) => {
              setConnected(status.connected);
              setClosed(status.closed);
            }}
            onViewers={setViewers}
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
        )}
        {showPill && <StatusPill tone="warning">reconnecting…</StatusPill>}
      </div>

      {/* The accessory key bar is an input affordance — a `view` grantee
          (spec §4.1) gets the reading half only: no byte keys, no image
          picker, just the scroll-to-top/bottom jumps (which drive the LOCAL
          xterm scrollback, so they work for any audience). */}
      {/* The image button doubles as the touch upload gesture: dropping or
        clipboard-pasting files has no equivalent on a phone. */}
      {coarse && subshell && (
        <TerminalKeyBar
          disabled={!connected}
          readOnly={subshell.access === "view"}
          onBytes={handleKeyBarBytes}
          onPickImage={subshell.access === "view" ? undefined : () => openImagePickerRef.current?.()}
          onScrollTop={handleScrollTop}
          onScrollBottom={handleScrollBottom}
        />
      )}
    </main>
  );
}
