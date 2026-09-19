import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  confirmAction,
  errMessage,
  Switch,
} from "@internal/node-admin";
import { useState } from "react";
import { PluginIcon } from "@/components/plugin-icon";
import { type InstancePluginRow, useSetPluginEnabled } from "@/hooks/use-instance-plugins";

/**
 * The headings, in the order a reader meets these things: what runs an agent,
 * what runs a plain shell, and what this server is REACHED over.
 *
 * Networks earn a heading rather than sitting in one undifferentiated list
 * because disabling one is a different kind of act — it stops publishing this
 * server at an address people are using, where disabling an agent stops a
 * kind of subshell being launchable. A list that reads as one thing invites
 * the same shrug for both.
 */
const GROUPS = [
  // An absent `type` is an older server's payload and reads as an agent —
  // the same missing-field-means-old-build posture as `canLaunch`.
  {
    id: "agent-harness",
    heading: "Agents",
    matches: (p: InstancePluginRow) => p.type === undefined || p.type === "agent-harness",
  },
  { id: "terminal", heading: "Terminal", matches: (p: InstancePluginRow) => p.type === "terminal" },
  { id: "network", heading: "Networks", matches: (p: InstancePluginRow) => p.type === "network" },
] as const;

/**
 * The installed half of the instance page (spec 2026-09-10 §6.1): each row
 * carries where its bytes came from (this build or npm), its version, an
 * Enabled switch and an Uninstall, and a broken plugin says why on its face
 * rather than presenting as an unexplained launch failure. For a non-admin
 * the same rows render read-only: the list is every authenticated actor's
 * read, the controls are the admin's.
 */
export function InstalledPluginsCard({
  plugins,
  canManage,
  onUninstall,
}: {
  /** The rows with `installed: true`, id-sorted as the server sends them */
  plugins: InstancePluginRow[];
  /** Cookie-admin, from the server-derived `viewerIsAdmin` */
  canManage: boolean;
  /** Opens the uninstall dialog for this row */
  onUninstall: (plugin: InstancePluginRow) => void;
}) {
  const setEnabled = useSetPluginEnabled();
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const groups = GROUPS.map((group) => ({ ...group, rows: plugins.filter(group.matches) })).filter(
    (group) => group.rows.length > 0,
  );
  // A heading above the only list is noise: it names a distinction the reader
  // cannot be confusing anything with. They appear as soon as there are two
  // kinds of thing on the page, which is the moment they start doing work.
  const headed = groups.length > 1;

  return (
    <Card>
      {/* No description: the page header already says what this list is and
          that acting on it is instance-wide. The two sibling cards' captions
          each say where THEIR bytes come from, which this list does per row
          with its source badge. */}
      <CardHeader>
        <CardTitle>Installed</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {plugins.length === 0 && <p className="text-muted-foreground text-sm">Nothing installed yet.</p>}
        {groups.map((group) => (
          <section key={group.id} className="space-y-2">
            {headed && <h3 className="font-strong text-label">{group.heading}</h3>}
            {/* A headerless table: ONE grid per GROUP, so the source
            badge, the switch and Uninstall share their tracks and line up
            down the card. Each row was its own bordered flex box before, and
            `auto` sizes per CONTAINER — so every row placed its controls
            wherever that row's own name and version left them, a different x
            in every row. One grid with `auto` tracks sizes each column to its
            widest cell, which is the alignment a table gives and per-row flex
            containers cannot.

            Rows are `display: contents` (the inner wrapper below): the row
            element draws nothing, so its cells are the grid's own children.
            That is also why every cell is ALWAYS rendered, even when empty —
            a skipped cell would slide the rest of that row one column left.

            Two columns below `sm`, four above: the badge, the switch and
            Uninstall fall to a second line on a phone rather than crushing
            the name.

            One grid per group rather than one for the card: `auto` tracks
            size to the widest cell in THEIR OWN grid, so columns line up
            within a group and need not across groups. That is the right
            trade — a reader compares agents with agents, and one grid
            spanning the headings would let a long network name push every
            agent's switch rightwards. */}
            <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 sm:grid-cols-[minmax(0,1fr)_auto_auto_auto]">
              {group.rows.map((p, index) => (
                <div key={p.id} className="contents">
                  {/* Spans the full width, so it starts its own grid row and
                  cannot displace a cell: the rows carry no border of their
                  own any more, and a rule between them is what keeps a
                  multi-line row from reading as two. */}
                  {index > 0 && <div aria-hidden className="col-span-full border-t" />}
                  <div className="flex min-w-0 items-center gap-3">
                    <PluginIcon pluginId={p.id} name={p.name} className="size-8" />
                    <div className="min-w-0">
                      <p className="truncate font-strong">{p.name}</p>
                      <p className="truncate text-detail text-muted-foreground">
                        {[p.id, p.version ? `v${p.version}` : undefined, p.binary ? `drives ${p.binary}` : undefined]
                          .filter((s): s is string => s !== undefined)
                          .join(" · ")}
                      </p>
                    </div>
                  </div>
                  <Badge variant={p.builtIn ? "muted" : "outline"} className="justify-self-start">
                    {p.builtIn ? "this build" : "npm"}
                  </Badge>
                  {canManage ? (
                    <Switch
                      className="justify-self-start"
                      checked={p.enabled}
                      aria-label={`${p.name} enabled`}
                      disabled={setEnabled.isPending}
                      onCheckedChange={async (checked) => {
                        // Disabling a NETWORK stops publishing this server at an
                        // address someone is currently reaching it on — a phone,
                        // a laptop elsewhere — which is not what "disable a
                        // plugin" reads as anywhere else in this list. Every
                        // other type is a launch option that stops being
                        // offered, and asking about those would be the ask
                        // nobody reads. Enabling is never confirmed: it takes
                        // nothing away.
                        if (!checked && p.type === "network") {
                          const proceed = await confirmAction({
                            title: `Disable ${p.name}?`,
                            description: `Disabling stops publishing this server on ${p.name}.`,
                            confirmLabel: "Disable",
                            danger: true,
                          });
                          // The switch is controlled by the SERVER's answer, so a
                          // cancel leaves it exactly where it was with nothing to
                          // put back.
                          if (!proceed) return;
                        }
                        setEnabled.mutate(
                          { id: p.id, enabled: checked },
                          {
                            // A later success retires the row's old failure text:
                            // leaving it up reads as "still broken" under a
                            // switch that just moved, and the error IS gone.
                            onSuccess: () =>
                              setRowErrors((prev) => {
                                if (prev[p.id] === undefined) return prev;
                                const { [p.id]: _retired, ...rest } = prev;
                                return rest;
                              }),
                            onError: (err) =>
                              setRowErrors((prev) => ({
                                ...prev,
                                [p.id]: errMessage(err, "The change was not saved."),
                              })),
                          },
                        );
                      }}
                    />
                  ) : (
                    <Badge variant={p.enabled ? "success" : "warning"} className="justify-self-start">
                      {p.enabled ? "enabled" : "disabled"}
                    </Badge>
                  )}
                  {/* Always a cell, even for a reader who manages nothing — an
                  omitted one would pull this row's earlier cells rightwards
                  out of their columns. */}
                  {canManage ? (
                    <Button variant="ghost" size="sm" className="justify-self-end" onClick={() => onUninstall(p)}>
                      Uninstall {p.name}
                    </Button>
                  ) : (
                    <span />
                  )}
                  {p.description && <p className="col-span-full text-detail text-muted-foreground">{p.description}</p>}
                  {/* A broken install keeps its row precisely so it can say this;
                  every launch of it fails, and the operator needs to know why. */}
                  {p.broken && <p className="col-span-full text-destructive text-detail">Not loaded: {p.broken}</p>}
                  {rowErrors[p.id] && <p className="col-span-full text-destructive text-detail">{rowErrors[p.id]}</p>}
                </div>
              ))}
            </div>
          </section>
        ))}
      </CardContent>
    </Card>
  );
}
