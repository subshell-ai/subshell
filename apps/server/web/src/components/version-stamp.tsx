import { usePublicSettings } from "@/hooks/use-public-settings";

/**
 * One row of the stamp. `undefined` appears only while the shared public
 * settings query is in flight — an em-dash beats a spinner for a line nobody
 * is waiting on.
 */
function Row({ label, value }: { label: string; value: string | undefined }) {
  return (
    <div className="flex gap-3">
      <dt className="w-20 shrink-0 text-muted-foreground">{label}</dt>
      <dd className="truncate font-mono">{value ?? "—"}</dd>
    </div>
  );
}

/**
 * What this instance and this browser are actually RUNNING.
 *
 * The two halves version INDEPENDENTLY — `apps/server/api` and `apps/client/agent` carry
 * their own package.json versions (changesets bump them separately), and this
 * bundle is stamped by build time — so there is deliberately no single
 * "subshell version" printed here.
 *
 * They sit together because a bug report needs the PAIR: the server build
 * decides which behaviour is expected, and the app build says whether this
 * device actually picked a fix up (iOS caches are sticky enough to have fooled
 * a fix review once). The server half rides the shared `usePublicSettings`
 * payload, so this costs no request of its own.
 */
export function VersionStamp() {
  const { data } = usePublicSettings();
  return (
    <dl className="space-y-1 text-xs">
      <Row label="Server" value={data?.serverVersion} />
      <Row label="App build" value={__BUILD_ID__} />
    </dl>
  );
}
