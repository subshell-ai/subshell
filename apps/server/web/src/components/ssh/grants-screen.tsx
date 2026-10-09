import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  confirmAction,
  errMessage,
} from "@internal/node-admin";
import { Trash2 } from "lucide-react";
import { useNodes } from "@/hooks/use-nodes";
import { useRevokeSshGrant, useSshGrants } from "@/hooks/use-ssh";
import type { SshGrant } from "@/lib/ssh";

/**
 * The grants screen (spec 2026-10-08 §6.1, §8): the owner's standing key
 * grants, the selected public identities that carry them, and the revoke.
 * The rows are line items, `label` over `detail`: the name, then machine and
 * selector, then the fingerprints (public `SHA256:` identifiers, deliberately
 * on the owner's own screen; "which keys serve" is what the owner manages).
 *
 * Which keys serve is IMMUTABLE by design: the server refuses to widen a
 * standing selection (spec §6.1), so this screen has no key picker at all -
 * the way to change a selection is revoke and re-ask, and the screen must
 * not offer what the routes refuse. Revoke is the screen's one destructive
 * act: it cuts both ways instantly (the row goes, live relays under it are
 * torn down), so it confirms, with the consequence said in the body and a
 * STATIC title.
 */
export function GrantsScreen() {
  const { data: view } = useSshGrants();
  const { data: nodeData } = useNodes();
  const revoke = useRevokeSshGrant();
  const grants = view?.grants ?? [];

  const nameById = new Map<string, string>(
    (Array.isArray(nodeData?.nodes) ? nodeData.nodes : []).map((n) => [n.id, n.name]),
  );

  async function revokeGrant(grant: SshGrant) {
    const ok = await confirmAction({
      // Static title (ruling 2026-09-30); the body carries the name.
      title: "Revoke this grant?",
      description: `"${grant.name}" stops signing right away, and every session already running under it is cut. You can grant again from the next approval.`,
      confirmLabel: "Revoke",
      danger: true,
    });
    if (!ok) return;
    revoke.mutate(grant.id);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Key grants</CardTitle>
        <CardDescription>
          Which machine&apos;s agent keys sign for which destinations. Revoking cuts the grant and every live session
          running under it at once.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {grants.length === 0 ? (
          <p className="text-detail text-muted-foreground">
            No key grants yet. A first-use approval you answer yes becomes a standing grant here.
          </p>
        ) : (
          <ul className="space-y-4">
            {grants.map((grant) => (
              <li key={grant.id} className="flex items-start gap-3">
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="truncate font-strong text-label">{grant.name}</div>
                  <div className="truncate text-detail text-muted-foreground">
                    {[nameById.get(grant.keyHomeNodeId) ?? grant.keyHomeNodeId, grant.resolvedSelector].join(" · ")}
                  </div>
                  {grant.fingerprints.map((fingerprint) => (
                    <div key={fingerprint} className="break-all font-mono text-detail">
                      {fingerprint}
                    </div>
                  ))}
                  <div className="text-detail text-muted-foreground">
                    {grant.createdVia === "first-use" ? "From a first-use approval" : "Added by hand"} ·{" "}
                    {grant.createdAt.slice(0, 10)}
                  </div>
                  {revoke.isError && revoke.variables === grant.id && (
                    <p role="alert" className="text-destructive text-detail">
                      {errMessage(revoke.error, "The grant could not be revoked.")}
                    </p>
                  )}
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Revoke grant ${grant.name}`}
                  title={`Revoke ${grant.name}`}
                  onClick={() => void revokeGrant(grant)}
                  className="shrink-0 text-muted-foreground hover:text-destructive"
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
