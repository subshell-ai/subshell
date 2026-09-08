import { COPYRIGHT_LINE, LICENSE_SUMMARY, LICENSE_URL } from "@internal/subshell-protocol";
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
 * The two halves version INDEPENDENTLY — `apps/server/api` and `apps/node/agent` carry
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
    <div className="space-y-3 text-xs">
      <dl className="space-y-1">
        <Row label="Server" value={data?.serverVersion} />
        <Row label="App build" value={__BUILD_ID__} />
      </dl>
      {/* Ownership and licence sit with the version because this is the block
          people screenshot into a bug report or quote when asking what they
          may do with Subshell — and because a web UI, unlike the CLIs, has no
          other place that answers it. Not mono: it is prose, not a value to
          copy. */}
      <div className="space-y-1 text-muted-foreground">
        <p>{COPYRIGHT_LINE}</p>
        <p>
          {LICENSE_SUMMARY} ·{" "}
          <a href={LICENSE_URL} target="_blank" rel="noreferrer" className="underline hover:text-foreground">
            Full text
          </a>
        </p>
      </div>
    </div>
  );
}
