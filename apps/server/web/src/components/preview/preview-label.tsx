import { QueryObserver, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { type PreviewInfo, previewInfoQueryKey } from "@/hooks/use-subshell-preview";
import { type WorkspacePreviewTarget, workspacePreviewLabel } from "@/lib/workspace-preview";

/** Reuse discovery already fetched by the picker/viewer; tab labels never start scans. */
export function PreviewLabel({
  subshellId,
  view,
  suffix,
}: {
  subshellId: string;
  view: WorkspacePreviewTarget;
  suffix?: string;
}) {
  const client = useQueryClient();
  const key = useMemo(() => previewInfoQueryKey(subshellId), [subshellId]);
  // Follow discovery, never start it. `enabled: false` keeps this reading the
  // entry the picker or the header badge already fetched, and an observer is
  // per-query, so a poll of some unrelated list no longer wakes every open tab's
  // label the way a cache-wide subscription did.
  const observer = useMemo(
    () =>
      new QueryObserver<PreviewInfo | undefined, Error, PreviewInfo | undefined, PreviewInfo | undefined, typeof key>(
        client,
        { queryKey: key, enabled: false },
      ),
    [client, key],
  );
  useEffect(() => () => observer.destroy(), [observer]);
  const subscribe = useCallback((notify: () => void) => observer.subscribe(notify), [observer]);
  const snapshot = useCallback(() => observer.getCurrentResult().data, [observer]);
  const data = useSyncExternalStore(subscribe, snapshot, snapshot);
  const pageTitle = view.kind === "app" ? data?.ports.find((row) => row.port === view.port)?.title : undefined;
  const label = pageTitle && view.kind === "app" ? `${pageTitle} · ${view.port}` : workspacePreviewLabel(view);
  const text = suffix ? `${label} · ${suffix}` : label;
  if (pageTitle && view.kind === "app")
    return (
      <span className="inline-flex min-w-0 max-w-56 items-center gap-1" title={text}>
        <span className="min-w-0 truncate">{pageTitle}</span>
        <span className="shrink-0">· {view.port}</span>
        {suffix && <span className="sr-only"> · {suffix}</span>}
      </span>
    );
  return (
    <span className="block min-w-0 max-w-56 truncate" title={text}>
      {text}
    </span>
  );
}
