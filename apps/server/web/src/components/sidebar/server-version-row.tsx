import { useNavigate } from "@tanstack/react-router";
import { VersionRow } from "@/components/sidebar/version-row";
import { usePublicSettings } from "@/hooks/use-public-settings";
import { useUpdates } from "@/hooks/use-updates";

/**
 * The footer row a BROWSER gets: which server this page is talking to, and a
 * dot when a newer one is published (operator's request, 2026-09-18).
 *
 * The desktop rail has carried a version line for a while and a browser
 * carried none, which read as a missing feature and was really a missing ROW:
 * `DesktopAppUpdateRow` reports the app BUNDLE's version over IPC, and a
 * browser is inside no app, so there was nothing for it to report. The server's
 * own version is a different fact and is not privileged —
 * `GET /api/settings/public` hands `serverVersion` to every signed-in caller,
 * for the reason that route states: "a version nobody can see without an admin
 * session is a version nobody quotes in a bug report."
 *
 * **The two halves have different audiences, and that is not an oversight.**
 * Everyone signed in reads the version. Only an ADMIN gets the dot and the
 * press, because `GET /api/admin/updates` is admin-only and, more to the
 * point, only an admin can act on a server update — a member shown a dot could
 * do nothing but ask someone. So a member's row is inert by construction
 * rather than a control that refuses.
 *
 * It mounts inside `AppSidebar`'s footer, which lives in `__root` and is
 * therefore built once per document: the updates read is one request per page
 * load, behind the server's own 15-minute memo, not a poll.
 */
export function ServerVersionRow({ collapsed }: { collapsed: boolean }) {
  const { data: settings } = usePublicSettings();
  const navigate = useNavigate();
  // `viewerIsAdmin === true`, never a truthiness test: `undefined` is the read
  // still in flight, and counting that as admin fires a doomed 403 — the gate
  // `/settings/status` established and every admin surface copies.
  const isAdmin = settings?.viewerIsAdmin === true;
  const { data: updates } = useUpdates(isAdmin);

  const version = settings?.serverVersion;
  // Nothing to say until the settings read lands. Rendering "Subshell Server"
  // with no number would be a row that flickers into correctness.
  if (version === undefined) return null;

  const latest = updates?.server;
  // `updateAvailable` is the server's own comparison, not a version string
  // compared here — it already accounts for an air-gapped source and a
  // release list that would not answer.
  const notice = latest?.updateAvailable === true ? (latest.latest?.version ?? null) : null;

  return (
    <VersionRow
      label={`Subshell Server ${version}`}
      notice={notice}
      onActivate={isAdmin ? () => void navigate({ to: "/settings/updates" }) : undefined}
      actionLabel="Open updates"
      collapsed={collapsed}
    />
  );
}
