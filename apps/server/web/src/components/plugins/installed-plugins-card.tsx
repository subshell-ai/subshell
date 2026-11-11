import {
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
import { UpdatePluginsDialog } from "@/components/plugins/update-plugins-dialog";
import { type InstancePluginRow, useSetPluginEnabled } from "@/hooks/use-instance-plugins";
import { type PluginUpdateRow, useUpdatePlugin } from "@/hooks/use-plugin-updates";

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
  updates,
  onCheck,
  checking,
  checkErrors,
}: {
  /** The rows with `installed: true`, id-sorted as the server sends them */
  plugins: InstancePluginRow[];
  /** Cookie-admin, from the server-derived `viewerIsAdmin` */
  canManage: boolean;
  /** Opens the uninstall dialog for this row */
  onUninstall: (plugin: InstancePluginRow) => void;
  /** The registry's offers, one per plugin whose `latest` is newer */
  updates: PluginUpdateRow[];
  /** Asks the registry now; the header's Check for updates */
  onCheck: () => void;
  /** True while that check is in flight */
  checking: boolean;
  /** Failed registry reads, so a plugin that was not checked never reads as current */
  checkErrors: string[];
}) {
  const setEnabled = useSetPluginEnabled();
  const update = useUpdatePlugin();
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [updateErrors, setUpdateErrors] = useState<Record<string, string>>({});
  /** The target whose install is in flight; null between rows and after the run */
  const [applyingId, setApplyingId] = useState<string | null>(null);
  /** The targets the confirmation is about; null while no question is open. */
  const [updateDialog, setUpdateDialog] = useState<PluginUpdateRow[] | null>(null);
  // An offer is only an ACTION when its row is on screen. The update query is
  // cached across installs and uninstalls, so a stale answer can name a plugin
  // the store no longer holds — and confirming that row could only 409 under
  // an id that renders nowhere. The count follows the same rule, so "Update
  // all (n)" never promises a row the reader cannot see.
  const visible = new Set(plugins.map((plugin) => plugin.id));
  const offers = new Map(updates.filter((offer) => visible.has(offer.id)).map((offer) => [offer.id, offer]));
  // The offer rides the row rather than being looked up again per cell: one
  // plugin's version pair, action and confirmation must all be the same fact.
  const groups = GROUPS.map((group) => ({
    ...group,
    rows: plugins.filter(group.matches).map((plugin) => ({ ...plugin, offer: offers.get(plugin.id) })),
  })).filter((group) => group.rows.length > 0);
  // A heading above the only list is noise: it names a distinction the reader
  // cannot be confusing anything with. They appear as soon as there are two
  // kinds of thing on the page, which is the moment they start doing work.
  const headed = groups.length > 1;

  /**
   * Replace these plugins' bytes, SEQUENTIALLY: two installs never rewrite the
   * store at once, and one refusal must not stop the rest — so the loop carries
   * on and the failing row reports itself. The question closes first: an
   * answered confirmation has nothing left to ask.
   *
   * `applyingId` names the row being replaced: the mutation's own pending flag
   * is global, so without it no row says which plugin the queue is on.
   */
  async function applyUpdates(ids: string[]): Promise<void> {
    setUpdateDialog(null);
    try {
      for (const id of ids) {
        // Drop the row's previous failure before retrying it: a stale line under
        // a run that is succeeding reads as "still broken".
        setUpdateErrors((prev) => {
          if (prev[id] === undefined) return prev;
          const { [id]: _retired, ...rest } = prev;
          return rest;
        });
        setApplyingId(id);
        try {
          await update.mutateAsync(id);
        } catch (err) {
          setUpdateErrors((prev) => ({ ...prev, [id]: errMessage(err, "The update failed.") }));
        }
      }
    } finally {
      setApplyingId(null);
    }
  }

  return (
    <Card>
      {/* No description: the page header already says what this list is and
          that acting on it is instance-wide. The two sibling cards' captions
          each say where THEIR bytes come from, which this list does per row
          with its source badge. */}
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle>Installed</CardTitle>
          {canManage && (
            <div className="flex flex-wrap items-center gap-2">
              {/* The check reads the registry and touches no bytes, but a
                  second one while a check is in flight answers nothing new. */}
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={checking || update.isPending}
                disabledReason={
                  checking ? "Wait for the update check to finish." : "Wait for the current update to finish."
                }
                onClick={onCheck}
              >
                Check for updates
              </Button>
              {offers.size > 1 && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={update.isPending}
                  disabledReason="Wait for the current update to finish."
                  onClick={() => setUpdateDialog([...offers.values()])}
                >
                  Update all ({offers.size})
                </Button>
              )}
            </div>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* A failed registry read is not "up to date": naming the plugin that
            went unchecked is the only way the offer list stays honest. */}
        {checkErrors.map((message) => (
          <p key={message} className="text-detail text-muted-foreground">
            {message}
          </p>
        ))}
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
                        {/* The version becomes the PAIR once there is an
                        offer, in its own span so from → to reads as one fact
                        rather than a version with a sibling. */}
                        {p.id}
                        {p.offer ? (
                          <>
                            {" · "}
                            <span>{`v${p.version ?? p.offer.from} → v${p.offer.to}`}</span>
                          </>
                        ) : (
                          p.version !== undefined && ` · v${p.version}`
                        )}
                        {p.binary !== undefined && ` · drives ${p.binary}`}
                      </p>
                    </div>
                  </div>
                  <span className="justify-self-start">{sourceLabel(p)}</span>
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
                            title: "Disable this network plugin?",
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
                    <span className="justify-self-start">{p.enabled ? "enabled" : "disabled"}</span>
                  )}
                  {/* Always a cell, even for a reader who manages nothing — an
                  omitted one would pull this row's earlier cells rightwards
                  out of their columns. */}
                  {canManage ? (
                    <div className="flex items-center gap-1 justify-self-end">
                      {/* The version pair above is the offer; this is the act.
                          Every update control holds while one is running, so a
                          second install cannot start over the first. */}
                      {p.offer && (
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={update.isPending}
                          disabledReason="Wait for the current update to finish."
                          onClick={() => p.offer && setUpdateDialog([p.offer])}
                        >
                          Update to {p.offer.to}
                        </Button>
                      )}
                      <Button variant="ghost" size="sm" onClick={() => onUninstall(p)}>
                        Uninstall {p.name}
                      </Button>
                    </div>
                  ) : (
                    <span />
                  )}
                  {p.description && <p className="col-span-full text-detail text-muted-foreground">{p.description}</p>}
                  {/* Which row the sequential queue is on. The mutation's
                  pending flag is global, so this is the only thing that says
                  WHICH plugin is being replaced; the accessible name carries
                  the plugin, the visible line stays short. */}
                  {p.id === applyingId && (
                    <p
                      role="status"
                      aria-label={`Updating ${p.name}`}
                      className="col-span-full text-detail text-muted-foreground"
                    >
                      Updating…
                    </p>
                  )}
                  {/* A broken install keeps its row precisely so it can say this;
                  every launch of it fails, and the operator needs to know why. */}
                  {p.broken && <p className="col-span-full text-destructive text-detail">Not loaded: {p.broken}</p>}
                  {rowErrors[p.id] && <p className="col-span-full text-destructive text-detail">{rowErrors[p.id]}</p>}
                  {/* An installed copy that lost resolution is why an update
                  can still do something: the store's bytes are not the ones
                  running, and saying which copy is which is the whole row. */}
                  {p.shadowed && (
                    <p className="col-span-full text-detail text-muted-foreground">
                      {`Installed copy v${p.shadowed.version} (${
                        p.shadowed.source === "npm" ? "npm" : "this build"
                      }) is not in use${p.shadowed.error ? `: ${p.shadowed.error}` : "; the bundled copy is newer"}.`}
                    </p>
                  )}
                  {updateErrors[p.id] && (
                    <p className="col-span-full text-destructive text-detail">{updateErrors[p.id]}</p>
                  )}
                </div>
              ))}
            </div>
          </section>
        ))}
      </CardContent>
      {/* Mounted only while targets are being confirmed: the mount is the
          open, so answering the question cannot leave stale targets behind. */}
      {updateDialog && (
        <UpdatePluginsDialog
          open
          onOpenChange={(open) => !open && setUpdateDialog(null)}
          targets={updateDialog}
          onConfirm={() => void applyUpdates(updateDialog.map((target) => target.id))}
        />
      )}
    </Card>
  );
}

/**
 * Where the answering copy's bytes came from. `source` is a newer server's
 * field; absent is an older server, where the built-in flag was the only
 * record and "npm" meant everything else.
 */
function sourceLabel(plugin: InstancePluginRow): string {
  if (plugin.source === "npm") return "npm";
  if (plugin.source === "unrecorded") return "no record";
  if (plugin.source === "build") return "this build";
  return plugin.builtIn ? "this build" : "npm";
}
