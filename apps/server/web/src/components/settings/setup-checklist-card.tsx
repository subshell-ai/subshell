import { Link } from "@tanstack/react-router";
import { REINSTALL_COMMAND } from "@/components/service/service-card";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { CopyableValue } from "@/components/ui/copyable-value";
import { useAdminStatus } from "@/hooks/use-admin-status";
import { useHarnesses } from "@/hooks/use-harnesses";
import { usePublicSettings } from "@/hooks/use-public-settings";
import { type ServerAutostart, useServerDeployment, useSetServerAutostart } from "@/hooks/use-server-deployment";
import { type ChecklistRemedy, checklistItems } from "@/lib/setup-checklist";
import { LINGER_COMMAND } from "@/lib/supervision";

/**
 * How often this card's deployment read polls: once a minute, not the hook's
 * five seconds.
 *
 * `GET /api/admin/server` is a `Bun.spawnSync` of `netstat` and the service
 * manager, and Bun is single-threaded — every poll stalls the whole process,
 * terminal WebSocket frames included. `/settings/service` pays that because an
 * operator watches it WHILE changing the machine from a terminal. Nobody
 * watches this card for a change; they read it and go and do something.
 * `/settings/status` picked 60 s for the same reason.
 */
const DEPLOYMENT_POLL_MS = 60_000;

/**
 * **Finish setting up** — the one place that says what this instance still
 * needs (spec 2026-09-15 § 5.2).
 *
 * It is a composition, not an endpoint: every fact here is already on some
 * page — tmux on `/settings/status`, supervision and lingering on
 * `/settings/service`, the placeholder secret on the security card, the
 * effective allowlist on `GET /api/settings/public`, agent CLIs nowhere at
 * all once the wizard is behind you. A headless operator had no
 * single place that said which of them were still true, and finding out meant
 * knowing which pages to visit — which is knowledge the person who most needs
 * this card does not have yet.
 *
 * Three rules it keeps:
 *
 * - **Nothing to do renders NOTHING.** Not an empty state, not a green tick —
 *   this sits above the cards a person came to `/settings` to use, and a
 *   permanent card saying "all clear" is rent paid forever for an answer that
 *   is interesting once.
 * - **No dismiss.** A checklist you can silence is a checklist that lies: the
 *   only way an item leaves is the machine changing.
 * - **An unanswered read renders nothing either.** The list is composed from
 *   three reads that land at different times; rendering the first version of
 *   it and then a longer one is a flash of a wrong answer on exactly the
 *   surface whose job is being trustworthy about what is wrong.
 *
 * Admin-only, and it gates itself rather than trusting a prop: all three
 * reads are `enabled`-gated on the server's own `viewerIsAdmin`, so the flag
 * is needed here whatever the caller believes.
 */
export function SetupChecklistCard() {
  const { data: publicSettings } = usePublicSettings();
  const isAdmin = publicSettings?.viewerIsAdmin === true;
  const { data: status } = useAdminStatus(isAdmin);
  const { data: deployment } = useServerDeployment(isAdmin, DEPLOYMENT_POLL_MS);
  // Unconditional and un-`enabled`, unlike the two above: `/api/setup/harnesses`
  // answers any signed-in caller, and the key is shared with the launch form
  // and the preset editor, so a page that already holds it pays nothing.
  const { data: harnesses } = useHarnesses();
  const autostart = useSetServerAutostart();

  if (!isAdmin || !status || !deployment || !harnesses) return null;

  const items = checklistItems({
    tmuxPath: status.runtime.tmuxPath,
    platform: deployment.platform,
    persistence: {
      manager: deployment.service.manager,
      installed: deployment.service.installed,
      enabled: deployment.service.enabled,
      linger: deployment.service.linger,
    },
    // SAVED for the two boot-time keys: this mirrors a warning `applyConfig`
    // emits about what is written to config.env, and a saved value not yet
    // restarted into is `restartRequired`'s business.
    host: deployment.settings.HOST.saved,
    appBaseUrl: deployment.settings.APP_BASE_URL.saved,
    // EFFECTIVE for the origins: the allowlist is a live registry, only the
    // public-settings route knows the union, and a joined tailnet has to
    // silence this item without anything being written.
    effectiveOrigins: publicSettings?.trustedOrigins,
    usingPlaceholderSecret: status.security.usingPlaceholderSecret,
    configEnvPath: deployment.configEnv.path,
    // The same set and the same question the wizard's Add an Agent screen
    // asks: an agent harness whose CLI this host actually has.
    anyAgentInstalled: harnesses.some((h) => h.type === "agent-harness" && h.installed),
  });

  if (items.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Finish setting up</CardTitle>
        <CardDescription>
          What this instance still needs. Items leave this list when the machine changes; there is nothing to dismiss.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="space-y-4">
          {items.map((item) => (
            <li key={item.id} className="space-y-1">
              <p className="font-strong text-label">{item.title}</p>
              <p className="text-detail text-muted-foreground">{item.consequence}</p>
              {item.remedy && <Remedy remedy={item.remedy} autostart={autostart} />}
              {/* Rendered under the first, not instead of it: two ways out of
                  one problem, in the order of how much they ask for. */}
              {item.alternative && <Remedy remedy={item.alternative} autostart={autostart} />}
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

/**
 * One item's way out.
 *
 * The supervision branch renders the same three fixes the Service page's
 * `PersistenceFacts` renders, in this card's words rather than that one's —
 * which is the arrangement `lib/supervision.ts` documents: it returns a
 * `PersistenceFix` and deliberately no copy, because "install it" reads
 * differently on a page about this machine, a page about a node, and a list of
 * things still to do.
 */
function Remedy({ remedy, autostart }: { remedy: ChecklistRemedy; autostart: ServerAutostart }) {
  if (remedy.kind === "command") {
    return (
      <div className="space-y-1 text-detail text-muted-foreground">
        <CopyableValue value={remedy.command} label={remedy.label} />
        {remedy.note && <p>{remedy.note}</p>}
      </div>
    );
  }
  if (remedy.kind === "link") {
    // Split by destination rather than spreading a `to`/`params` pair: the
    // router types `params` against the route named by `to`, so this is the
    // shape that fails to compile if either route is renamed.
    return remedy.to === "/nodes/$id" ? (
      <Link to="/nodes/$id" params={remedy.params} className="text-detail underline">
        {remedy.label}
      </Link>
    ) : (
      <Link to={remedy.to} className="text-detail underline">
        {remedy.label}
      </Link>
    );
  }
  if (remedy.fix.kind === "install") {
    return (
      <p className="text-detail text-muted-foreground">
        Run <CopyableValue value={REINSTALL_COMMAND} label="Install command" /> on this machine.
      </p>
    );
  }
  if (remedy.fix.kind === "enable") {
    return (
      <div className="space-y-1.5">
        {/* The `true` direction only, as everywhere else in a browser: a
            reader who is not at that machine does not set out to disarm a
            server they would then have to walk to. */}
        <Button variant="outline" size="sm" disabled={autostart.pending} onClick={() => autostart.set(true)}>
          Start automatically
        </Button>
        {autostart.error && <p className="text-destructive text-detail">{autostart.error}</p>}
      </div>
    );
  }
  return (
    <p className="text-detail text-muted-foreground">
      {/* `measured` is logind saying this user does not linger; unmeasured is
          logind not answering, so the command is offered without claiming
          anything was found wrong. */}
      {remedy.fix.measured ? "Run" : "If nobody logs in to this machine, run"}{" "}
      <CopyableValue value={LINGER_COMMAND} label="Lingering command" /> there.
    </p>
  );
}
