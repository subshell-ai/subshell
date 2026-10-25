import { BackendErrorCodes } from "@internal/backend-errors";
import { ApiError, apiFetch, cn, Input } from "@internal/node-admin";
import { type InfiniteData, useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowUp, ChevronRight, FolderOpen, Star } from "lucide-react";
import type { JSX } from "react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { PermissionNotice } from "@/components/desktop/permission-notice";
import { POPUP_ROW_DENSITY } from "@/components/ui/popup-row";
import { desktopPlatform, isServerDesktop } from "@/lib/desktop";
import { patchExploreFavorite, shouldFetchNextPage } from "@/lib/explore-pagination";
import { SERVER_DEPLOYMENT_QUERY_KEY } from "@/lib/query-keys";
import { currentMode } from "@/lib/supervision";
import type { DirEntry, ExploreResult } from "@/types/files";
import type { ServerDeployment } from "@/types/server-deployment";

/**
 * Which name macOS showed in the prompt for a folder this server cannot read.
 *
 * Under the launchd service the prompt names the binary, `subshell-server`;
 * with the desktop app supervising its own child it names the app. Saying the
 * wrong one sends a person to look for a row that is not in the list — and a
 * prompt naming a binary they never typed is the one that looks like malware,
 * which is exactly why it has to be named at all.
 *
 * Unknown reads as the binary: the deployment view is admin-only, so most
 * viewers have no answer, and the service is the deployment a non-admin is
 * overwhelmingly likely to be looking at.
 */
export function blockedByName(deployment: ServerDeployment | undefined): string {
  return deployment && currentMode(deployment) === "app" ? "Subshell Server" : "subshell-server";
}

/**
 * A text input for an absolute directory path that expands the server-side
 * folder picker (container paths) the moment it is clicked. Shared by the
 * new-subshell form's working-directory field.
 *
 * Fully controlled: `value`/`onChange` come from the parent, and the panel
 * always shows the folder the input names. Every row click — folder, Recent,
 * or Favorites — selects the path AND browses the panel to it; nothing but
 * an outside click or Escape closes it. Typing in the input moves the open
 * panel to the typed path, and a path that does not exist says so in place
 * with a Start-over button that clears the field and returns to home.
 *
 * Every row carries a star (revealed on hover, solid for favorites) that
 * saves the path as a favorite without leaving the panel — the successor to
 * the removed bookmarks feature. Favorites render under Recent; a path the
 * user starred stops showing in Recent so nothing appears twice.
 *
 * When a `nodeId` is supplied (and is not `local`), the panel browses THAT
 * node's filesystem — the explore request carries `?node=<id>` exactly as the
 * recents hook does, so the picker follows the node selected in the new-
 * subshell form. The backend answers identically-shaped listings for either
 * transport; a node whose CLI predates remote browsing answers 409
 * `NODE_OUTDATED`, surfaced here as a clear update prompt.
 */
export function DirectoryPickerInput({
  id,
  value,
  onChange,
  placeholder,
  helper,
  clearOption,
  nodeId,
  nodeName,
}: {
  /** Optional `id` for the input/label association. */
  id?: string;
  /** Current path value. */
  value: string;
  /** Called with the chosen/typed path. */
  onChange: (path: string) => void;
  /** Input placeholder. */
  placeholder?: string;
  /** Optional helper text rendered under the picker. */
  helper?: string;
  /** When set AND the field holds a path, the panel lists this label as its
   *  FIRST row; clicking it clears the field and closes the panel. The
   *  preset editor uses it because there, "no directory yet" is a real
   *  choice ("Decide at launch") and a picked path needs a row that gives
   *  that choice back. The launch form never passes it: there the path is
   *  required, and the picker's only exit from a dead path is Start over. */
  clearOption?: string;
  /** Browse this node instead of the control plane; `local`/undefined = local. */
  nodeId?: string;
  /** Human label for `nodeId`, shown in the too-old prompt when set. */
  nodeName?: string;
}) {
  // `local` (and an absent pick) mean the control plane — the node param is
  // then omitted entirely, keeping the request byte-identical to local.
  const remoteNode = nodeId && nodeId !== "local" ? nodeId : undefined;
  const remoteLabel = nodeName || remoteNode || "that node";
  const [pickerPath, setPickerPath] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  // The `h-56` listing body, held as state rather than a ref, and it has to
  // be that way: the virtualizer inside `DirRows` can only attach its scroll
  // listeners once the element actually exists, and on the mount commit the
  // parent's refs land after the child's layout effects have already run. A
  // callback ref feeding state is what hands the element over as soon as it
  // does exist. Only the listing state attaches it.
  const [listingEl, setListingEl] = useState<HTMLDivElement | null>(null);
  const queryClient = useQueryClient();

  // Typing in the input moves the open panel to the typed folder. The sync
  // is debounced so a burst of keystrokes — most of them paths that don't
  // exist yet — fires at most one explore fetch. Panel clicks that change
  // `value` set `lastTypedRef` themselves: the change is not typing, and a
  // stale timer must not later yank the panel back up the tree.
  const lastTypedRef = useRef(value);
  useEffect(() => {
    if (!pickerOpen) {
      lastTypedRef.current = value;
      return;
    }
    if (value === lastTypedRef.current) return;
    const timer = setTimeout(() => {
      lastTypedRef.current = value;
      setPickerPath(value || "~");
    }, 250);
    return () => clearTimeout(timer);
  }, [value, pickerOpen]);

  // A machine change re-anchors the panel: the folder it showed belongs to
  // the filesystem the user just switched AWAY from, and "that listing" has
  // no meaning on the new machine — the panel goes to home and the node-
  // keyed explore query fetches what is actually there. The launch form also
  // clears its path on a switch (which the typing-sync would follow at the
  // debounce), but this effect is what guarantees the refresh for ANY caller,
  // not only as a side effect of form state. `~` means this machine's home
  // on both transports (the route expands it locally; the remote service
  // maps it to the agent's home).
  const lastNodeRef = useRef(remoteNode);
  useEffect(() => {
    if (lastNodeRef.current === remoteNode) return;
    lastNodeRef.current = remoteNode;
    setPickerPath("~");
  }, [remoteNode]);

  // The panel is dismissed by anything outside it, or by Escape. Both
  // listeners live with `pickerOpen` so an idle field costs nothing.
  useEffect(() => {
    if (!pickerOpen) return;
    function onPointerDown(e: PointerEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setPickerOpen(false);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setPickerOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [pickerOpen]);

  // The node rides the query key too: the same path on a different machine
  // is a different listing, and switching nodes mid-open must refetch.
  //
  // Infinite, because a local browse now arrives in pages of 200: a folder
  // with 31k entries is not ONE response anymore, and a panel that only ever
  // showed the first page would pass a third of a directory off as the whole
  // thing. `pageParam` is the opaque cursor the previous page named (empty on
  // the first, where the param is omitted); the walk stops when a page answers
  // without `nextCursor`. `limit` is deliberately unsent: the server's default
  // is its tuned page size. Remote browses ignore both params and answer whole
  // in one page, so `hasNextPage` is simply false there.
  const {
    data: exploreListing,
    error,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInfiniteQuery({
    queryKey: remoteNode ? (["explore", remoteNode, pickerPath] as const) : (["explore", pickerPath] as const),
    queryFn: ({ pageParam }) =>
      apiFetch<ExploreResult>(
        `/api/files/explore?path=${encodeURIComponent(pickerPath)}${
          remoteNode ? `&node=${encodeURIComponent(remoteNode)}` : ""
        }${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ""}`,
      ),
    initialPageParam: "",
    // `|| undefined` rather than `??`: a cursor the server would echo as "" is
    // indistinguishable from none, and treating it as "more" loops forever.
    getNextPageParam: (lastPage) => lastPage.nextCursor || undefined,
    enabled: pickerOpen,
    // Remounting with the cache present must NOT refetch an infinite query's
    // every page: the default would replay a walked listing's whole cursor
    // chain on every remount of the picker. Freshness comes from navigation
    // (each browse is a fresh key, a machine switch re-keys), so a
    // stale-but-instant listing beats a silent full re-walk. Only an
    // explicit invalidation refetches on mount: the node page's dirs-rule
    // change, where the cached listing is genuinely filtered by a rule that
    // no longer holds. A stale re-enable is a different door and stays open:
    // closing and reopening the picker flips `enabled`, and TanStack refetches
    // a stale infinite query on enable, replaying the walk once. Not replaying
    // that would mean changing the semantics of `enabled`, deliberately not
    // taken on. (staleTime stays at its default; that is the point of gating
    // on `isInvalidated` rather than on staleness.)
    refetchOnMount: (query) => query.state.isInvalidated,
  });
  // PAGE 1 is the source for everything except the entries. The server rides
  // parent/recent/favorites/blocked on every page (each must stand as a usable
  // answer), but reading them per page would render the shortcut sections once
  // per walked cursor.
  const explore = exploreListing?.pages[0];
  // Every page's entries in wire order, deduped by path keeping the first
  // occurrence: the server re-scans per request, so a file added or removed
  // between two pages shifts the offsets and the same entry can land in two
  // pages, and a repeated path is a duplicate virtualizer row key. Dirs only
  // after the merge: the server pages the raw sorted listing, so files sit
  // INSIDE pages, and filtering late keeps the folder order identical to an
  // unpaginated answer.
  const allEntries = useMemo(() => {
    const seen = new Set<string>();
    const merged: DirEntry[] = [];
    for (const page of exploreListing?.pages ?? []) {
      for (const entry of page.entries) {
        if (seen.has(entry.path)) continue;
        seen.add(entry.path);
        merged.push(entry);
      }
    }
    return merged;
  }, [exploreListing]);
  // Directory rows are the only unbounded content the panel renders, and the
  // only rows virtualized. Deriving the array once per response keeps the
  // virtualizer's count and row keys stable across unrelated re-renders.
  const dirEntries = useMemo(() => allEntries.filter((e) => e.kind === "dir"), [allEntries]);
  // A typed path that does not exist (404) is a different message from a
  // browse failure (500/forbidden/network): one invites a correction, the
  // other only explains. A too-old node (409 NODE_OUTDATED) is neither —
  // nothing about the path or a retry helps; the node itself must update.
  const notFound = error instanceof ApiError && error.status === 404;
  // Read from the CACHE, never fetched: `GET /api/admin/server` is admin-only,
  // so a request from here would 403 for most viewers to decide one word. The
  // Service page is what fills this, and `undefined` is a fine answer.
  const deployment = queryClient.getQueryData<ServerDeployment>(SERVER_DEPLOYMENT_QUERY_KEY);
  // Two independent ways to KNOW the machine being browsed is a Mac, and
  // either is enough (review, 2026-09-14). The shell answers it for the person
  // sitting at the machine; the deployment view answers it for an admin in a
  // browser, which is the reading most of these refusals get looked at from.
  // With neither — a browser with no cached view, a Linux shell — a refused
  // folder may be plain unix modes, and naming macOS would be a guess about a
  // machine this page cannot see.
  //
  // Both signals describe the CONTROL PLANE, so neither says anything while
  // another machine's filesystem is on screen: a Linux node browsed from a Mac
  // plane would otherwise be told macOS blocked it.
  const serverOnMac =
    !remoteNode && ((isServerDesktop() && desktopPlatform() === "macos") || deployment?.platform === "darwin");
  const nodeOutdated = error instanceof ApiError && error.code === BackendErrorCodes.NODE_OUTDATED;

  /**
   * Stars/unstars a path ON THE MACHINE BEING BROWSED; sections refresh from
   * the same responses. Favorites carry the node dimension since 0034 —
   * a star planted while walking node X is X's row and only ever renders in
   * X's panel. The param is omitted for the control plane, keeping the local
   * wire byte-identical to the pre-scoping request.
   */
  const favorite = useMutation({
    mutationFn: ({ path, on }: { path: string; on: boolean }) =>
      apiFetch("/api/files/favorite", {
        method: "PATCH",
        body: JSON.stringify(remoteNode ? { path, favorite: on, node: remoteNode } : { path, favorite: on }),
      }),
    onSuccess: (_data, { path, on }) => {
      // A targeted cache patch, NOT an invalidation: this query is infinite
      // now, and invalidating refetches EVERY page the cursor walk has loaded:
      // a walked 32k listing would fire 160+ requests to change one star.
      // The star moves exactly two cached facts (the path in `favorites` and
      // in `recent`), so `patchExploreFavorite` flips them in place; the next
      // navigation re-reads the truth from the server anyway. And the patch is
      // scoped to the machine the star was planted ON: favorites are
      // per-machine since 0034, the explore key names the machine
      // (`["explore", node, path]` remote, the two-element `["explore", path]`
      // local), and a bare `["explore"]` prefix-match would prepend this path
      // into every OTHER machine's cached listing too.
      queryClient.setQueriesData<InfiniteData<ExploreResult>>(
        {
          queryKey: ["explore"],
          predicate: (query) => (remoteNode ? query.queryKey[1] === remoteNode : query.queryKey.length === 2),
        },
        (old) => patchExploreFavorite(old, path, on),
      );
      void queryClient.invalidateQueries({ queryKey: ["recent-paths"] });
    },
  });

  // Shared by every star in the panel (Recent, Favorites, and the listing rows),
  // so the shortcut section can render identically in the listing and the
  // blocked-recovery states without a second copy.
  function toggleFavorite(path: string, on: boolean) {
    favorite.mutate({ path, on });
  }

  function openPicker() {
    setPickerPath(value || "~");
    setPickerOpen(true);
  }

  /**
   * Selects `path` — it becomes the input's value — and browses into it,
   * keeping the panel open. Claiming the change in `lastTypedRef` first is
   * what keeps this self-inflicted `value` change from being mistaken for
   * typing by the sync effect above.
   */
  function pick(path: string) {
    lastTypedRef.current = path;
    onChange(path);
    setPickerPath(path);
  }

  /**
   * Gives up on a path that does not exist: the input is cleared and the
   * panel restarts at the home directory, so the next move is a fresh browse
   * rather than an edit of the dead path.
   */
  function startOver() {
    lastTypedRef.current = "";
    onChange("");
    setPickerPath("~");
  }

  /** The optional empty-is-a-choice row's act (see `clearOption`): the pick
   *  is COMPLETE (back to "decide at launch"), so the panel closes the way
   *  a select closes on its empty item — unlike Start over, which keeps the
   *  browse going. */
  function clearChoice() {
    lastTypedRef.current = "";
    onChange("");
    setPickerOpen(false);
  }

  return (
    <div ref={rootRef} className="space-y-2">
      <Input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onFocus={openPicker}
        placeholder={placeholder}
      />

      {/* The panel opens the moment the input is focused. Rendering it only
          once a result exists made a slow or failed browse look like a dead
          field.

          IN FLOW, not an overlay (user report 2026-09-11: "the directory
          selector is cut off"). Every surface that hosts this field is now a
          scroll container — the launch dialog and the add-subshell dialog cap
          at `max-h-[85dvh] overflow-y-auto`, the setup assistant's screen
          scrolls too — and an absolutely positioned child of a scroll
          container is clipped at its edge BY CONSTRUCTION: `overflow-y: auto`
          forces the x axis to a scrolling value as well, so there is no
          "let this one child escape". Floating it correctly instead would
          mean measuring the room on every open and flipping the panel above
          the input when it does not fit, which is a positioning engine this
          hand-rolled picker does not have.

          The cost is honest and small: opening the panel pushes what is below
          it down, and a person who wants the buttons back dismisses the panel
          the same way they already did. The cut-off panel was unusable; a
          panel that moves the page is merely a panel. */}
      {pickerOpen && (
        <div className="mt-1 w-full rounded-md border bg-background p-2 shadow-md">
          {/* The body is exactly `h-56` in every state — listing, loading,
              error — with Recent and Favorites folded into the scroll area.
              A content-sized body grew and shrank as you moved between
              folders, so the panel jumped height on every navigation. */}
          {/* Data first, error second: a FAILED cursor walk leaves a fully
              usable listing in cache, and `error` alone would replace it with
              the browse-failure message for a folder that listed fine. The
              error UI renders only when page 1 itself never arrived, which is
              exactly what its copy describes. */}
          {error && !explore ? (
            notFound ? (
              <div className="flex h-56 flex-col items-start justify-center gap-2 px-2 text-sm">
                <p className="text-destructive">
                  That path doesn&apos;t exist.{" "}
                  <span className="text-muted-foreground">Check the spelling, or start over.</span>
                </p>
                <button
                  type="button"
                  onClick={startOver}
                  className="rounded-md border px-2 py-1 text-detail text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  Start over
                </button>
              </div>
            ) : nodeOutdated ? (
              <div className="flex h-56 items-center px-2 text-sm">
                {/* One unbroken text run naming the machine — the remedy is
                    on the NODE (update the subshell app), so neither the
                    path correction nor Start over applies here. */}
                <p className="text-muted-foreground">
                  The subshell app on {remoteLabel} is too old to browse folders there. Update it.
                </p>
              </div>
            ) : (
              // A browse failure that is none of the named cases (a 403, a
              // network error, a 500): explain, AND give the one escape that
              // never needs this folder to read — home. Without it the panel was
              // a dead end you could only click away from.
              <div className="flex h-56 flex-col items-start justify-center gap-2 px-2">
                <p className="text-destructive text-detail">Couldn&apos;t browse this path.</p>
                <button
                  type="button"
                  onClick={startOver}
                  className="rounded-md border px-2 py-1 text-detail text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  Start over
                </button>
              </div>
            )
          ) : explore?.blocked === "permission" || explore?.blocked === "timeout" ? (
            // The folder is NOT empty-and-shown — the read was refused
            // (permission) or never answered (timeout). Rendering either as an
            // empty listing would say the opposite (operator's report,
            // 2026-09-14), and leaving NO escape trapped the person in a panel
            // they could only close and reopen (2026-09-30: the same dead
            // feeling as the hung server this flag now bounds). The server
            // echoes parent/recent/favorites on a blocked read, so offer the
            // ways out that need no read of THIS folder.
            <div className="h-56 overflow-y-auto px-2 py-2">
              {explore.blocked === "permission" ? (
                <>
                  {/* The server flags EACCES as well as EPERM, on every
                      platform, so the copy names macOS only where this page can
                      know the server is on a Mac (review, 2026-09-14). */}
                  <p className="text-sm">{serverOnMac ? "Blocked by macOS" : "Not allowed to read this folder"}</p>
                  <PermissionNotice
                    pane="files"
                    message={
                      serverOnMac
                        ? `macOS is not letting ${blockedByName(deployment)} read this folder.`
                        : `${blockedByName(deployment)} was refused when it tried to list this folder.`
                    }
                  />
                </>
              ) : (
                <p className="text-muted-foreground text-sm">
                  This folder took too long to read. It may be on a slow or disconnected drive.
                </p>
              )}
              {/* The recovery row: back up toward a folder that reads, or
                  abandon the dead path for home. "Up" is offered only when the
                  server could name a parent (never at the filesystem root). */}
              <div className="mt-2 flex gap-2">
                {explore.parent && (
                  <button
                    type="button"
                    onClick={() => pick(explore.parent ?? "")}
                    className="rounded-md border px-2 py-1 text-detail text-muted-foreground hover:bg-accent hover:text-foreground"
                  >
                    Go up one level
                  </button>
                )}
                <button
                  type="button"
                  onClick={startOver}
                  className="rounded-md border px-2 py-1 text-detail text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  Start over
                </button>
              </div>
              {/* And the saved shortcuts: the escape that survives a folder this
                  server cannot read (a favorite is a different path, and a
                  browse into it starts fresh). Without them a blocked home left
                  only Start over, which re-opens the same blocked folder. */}
              {(explore.recent.length > 0 || explore.favorites.length > 0) && (
                <div className="mt-2 border-t pt-2">
                  <ShortcutSections explore={explore} onPick={pick} onToggleFavorite={toggleFavorite} />
                </div>
              )}
            </div>
          ) : explore ? (
            <div ref={setListingEl} className="h-56 overflow-y-auto">
              {clearOption !== undefined && value.trim() !== "" && (
                <button
                  type="button"
                  onClick={clearChoice}
                  className={cn(
                    POPUP_ROW_DENSITY,
                    "mb-1 w-full rounded px-2 text-left text-muted-foreground hover:bg-accent hover:text-foreground",
                  )}
                >
                  {clearOption}
                </button>
              )}
              {/* Saved paths first — Recent (top 3) over Favorites — each
                  section rendered only when it has rows. The directory
                  listing lives at the BOTTOM on purpose: a busy folder can
                  hold dozens of entries, and shortcuts buried under them
                  would be useless; the listing is the one section meant to
                  scroll. */}
              <ShortcutSections explore={explore} onPick={pick} onToggleFavorite={toggleFavorite} />

              {(explore.parent !== null || allEntries.length > 0) && (
                <div className="mt-2 border-t pt-2">
                  {/* One click per folder: it becomes the input's value and
                      the panel descends into it. */}
                  {explore.parent && (
                    <div className="group flex items-center">
                      <button
                        type="button"
                        title="Go up one level"
                        onClick={() => pick(explore.parent ?? "")}
                        className={cn(
                          POPUP_ROW_DENSITY,
                          "flex min-w-0 flex-1 items-center gap-2 rounded px-2 text-left hover:bg-accent",
                        )}
                      >
                        <ArrowUp className="h-3 w-3 shrink-0 text-muted-foreground" />
                        ..
                      </button>
                    </div>
                  )}
                  <DirRows
                    dirs={dirEntries}
                    scrollerEl={listingEl}
                    onPick={pick}
                    onToggleFavorite={toggleFavorite}
                    hasNextPage={hasNextPage}
                    isFetchingNextPage={isFetchingNextPage}
                    lastFetchFailed={error !== null}
                    onLoadNextPage={fetchNextPage}
                  />
                  {/* The agent caps a REMOTE listing at 1,000 entries and no
                      cursor recovers the rest (remote browses answer whole),
                      so say it once instead of passing the partial list off
                      as everything. The cap counts only the dirs it lists:
                      `fs_ls` skips dotfiles and non-directories before the
                      check, and the panel renders dirs anyway, so the
                      sentence can honestly count folders. A local browse
                      never carries the flag. */}
                  {explore.truncated && (
                    <p className="px-2 py-1 text-detail text-muted-foreground">
                      The listing stops at 1,000 folders, so some may be missing.
                    </p>
                  )}
                </div>
              )}
            </div>
          ) : (
            <div className="flex h-56 items-center px-2 text-muted-foreground text-sm">Loading…</div>
          )}
        </div>
      )}

      {helper && <p className="text-detail text-muted-foreground">{helper}</p>}
    </div>
  );
}

/**
 * The height of one folder row in px, matching `POPUP_ROW_DENSITY`
 * (13px text, 2px vertical padding, and a 28px minimum). Rows are one truncated
 * line by construction, which is why the virtualizer sizes them from this
 * constant rather than measuring each row: a per-row measure would add a
 * layout read to answer what the CSS already fixes, and a constant is what
 * keeps the window jump-free. Change the row's padding or its type role and
 * this number must change with it.
 */
const DIR_ROW_HEIGHT = 28;

/**
 * The folder rows of the listing state, windowed.
 *
 * A huge directory used to freeze the whole page: the server answers `/tmp`'s
 * 31k folders in about 86 ms, but committing the two buttons per row (roughly
 * 62k DOM nodes) in one React pass blocked the main thread so long that the
 * panel never even painted its "Loading…". Only the rows that fit the `h-56`
 * viewport, plus a small overscan, are in the DOM; the rest is scroll
 * arithmetic over the fixed row height.
 *
 * The rows above this block (the clear row, Recent/Favorites, the `..` row)
 * stay ordinary DOM. They are never the unbounded part, and replacing only
 * the folder rows keeps small directories pixel-identical. `scrollMargin`
 * tells the virtualizer how tall that pre-list content is: its window is
 * computed against the scroller's scroll position, and the content above
 * changes as you navigate.
 */
function DirRows({
  dirs,
  scrollerEl,
  onPick,
  onToggleFavorite,
  hasNextPage,
  isFetchingNextPage,
  lastFetchFailed,
  onLoadNextPage,
}: {
  /** Directory entries loaded so far, in listing order: across every page
   *  already walked, files already filtered out. */
  dirs: DirEntry[];
  /** The `h-56` panel body: the element that scrolls this list, handed over
   *  as a value (null until the listing state has committed it, since the panel
   *  renders this component and the scroller in the same commit). */
  scrollerEl: HTMLDivElement | null;
  /** Selects and browses into a folder, exactly as a row click does. */
  onPick: (path: string) => void;
  /** Stars or unstars a folder row's path. */
  onToggleFavorite: (path: string, on: boolean) => void;
  /** The listing query still has a cursor to spend. */
  hasNextPage: boolean;
  /** Its next page is in flight right now. */
  isFetchingNextPage: boolean;
  /** The listing query's last fetch failed: a failed page stops the walk
   *  rather than re-firing the tail effect at network speed. */
  lastFetchFailed: boolean;
  /** Asks the listing query for the next page. */
  onLoadNextPage: () => unknown;
}): JSX.Element {
  const listRef = useRef<HTMLDivElement | null>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  // Measured after every commit (the content above the list is conditional),
  // re-set only when it actually moved, so the scroll listener and scroll
  // re-renders see a stable value between navigations. `offsetTop` cannot be
  // used here: it counts from the nearest positioned ancestor, which is the
  // dialog or the page, not this scroller's content.
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list || !scrollerEl) return;
    const next = list.getBoundingClientRect().top - scrollerEl.getBoundingClientRect().top + scrollerEl.scrollTop;
    setScrollMargin((prev) => (prev === next ? prev : next));
  });

  const virtualizer = useVirtualizer({
    count: dirs.length,
    getScrollElement: () => scrollerEl,
    estimateSize: () => DIR_ROW_HEIGHT,
    overscan: 10,
    scrollMargin,
    // A row's identity is its path, not its index: scrolling reuses the DOM
    // row that shows the same folder, exactly like the keyed `.map` did.
    getItemKey: (index) => dirs[index]?.path ?? index,
  });

  // Scroll-to-load: when the window reaches the end of the folders loaded so
  // far (or starts within the margin of it) and the walk still has a cursor,
  // ask for the next page. The predicate lives in `lib/explore-pagination.ts`
  // because what makes it correct is arithmetic a browser cannot show: a page
  // can carry ZERO new dirs (files fill it), leaving both the count and the
  // window unchanged, and the answer must stay true through that so the walk
  // keeps going until the cursor runs out. `lastFetchFailed` is the stop
  // valve: the query's error state stays until some fetch succeeds and this
  // panel offers no gesture that forces one, so a failed page would otherwise
  // re-fire this effect on every flag flip and loop a dead endpoint at
  // network speed; the walk stops, the cached listing stays on screen, and
  // the next navigation starts fresh. `range` is null until the
  // virtualizer's first update pass, which reads as -1: "nothing visible".
  // Re-checking on every render is safe: while a page is in flight the
  // predicate is false, and TanStack dedupes calls that race the flag flip.
  // `lastVisibleIndex` is hoisted out of the effect as a primitive so the
  // dependency list says exactly what re-runs it: the window's tail row.
  const lastVisibleIndex = virtualizer.range ? virtualizer.range.endIndex : -1;
  useEffect(() => {
    if (
      shouldFetchNextPage({
        lastVisibleIndex,
        totalLoadedDirs: dirs.length,
        hasNextPage,
        isFetchingNextPage,
        lastFetchFailed,
      })
    ) {
      onLoadNextPage();
    }
  }, [lastVisibleIndex, dirs.length, hasNextPage, isFetchingNextPage, lastFetchFailed, onLoadNextPage]);

  return (
    <div ref={listRef} style={{ height: virtualizer.getTotalSize(), position: "relative", width: "100%" }}>
      {virtualizer.getVirtualItems().map((vi) => {
        const e = dirs[vi.index];
        if (!e) return null;
        return (
          <div
            key={vi.key}
            className="group absolute left-0 flex w-full items-center"
            style={{ height: vi.size, top: 0, transform: `translateY(${vi.start - scrollMargin}px)` }}
          >
            <button
              type="button"
              title={`Open ${e.name}`}
              onClick={() => onPick(e.path)}
              className={cn(
                POPUP_ROW_DENSITY,
                "flex min-w-0 flex-1 items-center gap-2 rounded px-2 text-left hover:bg-accent",
              )}
            >
              <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
              <span className="truncate">{e.name}</span>
            </button>
            {/* Favorites carry the browsed machine since 0034 (the PATCH
                rides `node`, the listing ships that node's rows), so a star
                HERE means "this path on THIS machine" and can never be a dead
                click in another machine's panel, the defect the star used to
                be hidden for. It is offered everywhere. */}
            <StarButton path={e.path} starred={false} onToggle={(on) => onToggleFavorite(e.path, on)} />
          </div>
        );
      })}
    </div>
  );
}

/**
 * The row's favorite toggle. Hidden until the row is hovered (or keyboard-
 * focused) so the list reads as text, but a starred row shows its solid star
 * always — the affordance to UN-star has to be discoverable. Clicking it
 * never selects the path or closes the panel.
 */
function StarButton({
  path,
  starred,
  onToggle,
}: {
  /** The path this star controls (also the accessible name). */
  path: string;
  /** True renders the solid star and unstars on click. */
  starred: boolean;
  /** Called with the desired favorite state. */
  onToggle: (on: boolean) => void;
}): JSX.Element {
  return (
    <button
      type="button"
      aria-label={`${starred ? "Unfavorite" : "Favorite"} ${path}`}
      title={starred ? "Remove from favorites" : "Save to favorites"}
      onClick={() => onToggle(!starred)}
      className={
        starred
          ? "shrink-0 rounded p-1 text-amber-400"
          : "shrink-0 rounded p-1 text-muted-foreground opacity-0 hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
      }
    >
      <Star className={starred ? "h-3.5 w-3.5 fill-current" : "h-3.5 w-3.5"} />
    </button>
  );
}

/**
 * The panel's saved-shortcut sections — Recent (top 3) over Favorites — each
 * rendered only when it has rows. Shared by the normal listing AND the blocked
 * (permission / timeout) recovery state: a folder you cannot read is exactly
 * when the starred and recent paths matter most, because they are the escape
 * that needs no read of the dead folder (review M1). Kept as one component so
 * the two states can never drift.
 */
function ShortcutSections({
  explore,
  onPick,
  onToggleFavorite,
}: {
  explore: ExploreResult;
  onPick: (path: string) => void;
  onToggleFavorite: (path: string, on: boolean) => void;
}): JSX.Element | null {
  if (explore.recent.length === 0 && explore.favorites.length === 0) return null;
  return (
    <>
      {explore.recent.length > 0 && (
        <div>
          <p className="mb-1 px-2 text-detail text-muted-foreground">Recent</p>
          {explore.recent.map((r) => (
            <div key={r.path} className="group flex items-center">
              <button
                type="button"
                title={r.path}
                onClick={() => onPick(r.path)}
                className={cn(
                  POPUP_ROW_DENSITY,
                  "flex min-w-0 flex-1 items-center gap-2 rounded px-2 text-left hover:bg-accent",
                )}
              >
                <FolderOpen className="h-3 w-3 shrink-0 text-muted-foreground" />
                <span className="truncate">{r.label ?? r.path}</span>
              </button>
              <StarButton path={r.path} starred={false} onToggle={(on) => onToggleFavorite(r.path, on)} />
            </div>
          ))}
        </div>
      )}
      {explore.favorites.length > 0 && (
        <div className={explore.recent.length > 0 ? "mt-2 border-t pt-2" : undefined}>
          <p className="mb-1 px-2 text-detail text-muted-foreground">Favorites</p>
          {explore.favorites.map((f) => (
            <div key={f.path} className="group flex items-center">
              <button
                type="button"
                title={f.path}
                onClick={() => onPick(f.path)}
                className={cn(
                  POPUP_ROW_DENSITY,
                  "flex min-w-0 flex-1 items-center gap-2 rounded px-2 text-left hover:bg-accent",
                )}
              >
                <FolderOpen className="h-3 w-3 shrink-0 text-muted-foreground" />
                <span className="truncate">{f.label ?? f.path}</span>
              </button>
              <StarButton path={f.path} starred onToggle={(on) => onToggleFavorite(f.path, on)} />
            </div>
          ))}
        </div>
      )}
    </>
  );
}
