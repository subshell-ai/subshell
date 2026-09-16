import { useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { LoaderCircle, ShieldAlert } from "lucide-react";
import { useState } from "react";
import { NetworkAddresses } from "@/components/networking/network-addresses";
import { NetworkHintBlock, NetworkHints, NetworkNotice, splitLeadHints } from "@/components/networking/network-hints";
import { hasGroupedSteps, PrivilegedSteps } from "@/components/networking/network-privileged-steps";
import { NetworkProcessLine } from "@/components/networking/network-process-line";
import { NetworkRestartNotice } from "@/components/networking/network-restart-notice";
import { NetworkSettingsForm } from "@/components/networking/network-settings-form";
import { PluginIcon } from "@/components/plugin-icon";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CopyableValue } from "@/components/ui/copyable-value";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  NETWORK_QUERY_KEY,
  useInstallNetwork,
  useJoinNetwork,
  useLeaveNetwork,
  usePublishNetwork,
  useUnpublishNetwork,
} from "@/hooks/use-network";
import { ApiError, errMessage } from "@/lib/api";
import { confirmAction } from "@/lib/confirm";
import { safeHref } from "@/lib/safe-href";
import type { NetworkRow } from "@/types/network";

/** What this host's platform is called in a sentence. */
const PLATFORM_NAMES: Record<string, string> = { darwin: "macOS", linux: "Linux" };

/** "macOS and Linux" — the platforms a plugin can drive, as prose. */
function platformList(platforms: string[]): string {
  const names = platforms.map((p) => PLATFORM_NAMES[p] ?? p);
  if (names.length <= 1) return names[0] ?? "no platform this build knows";
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/**
 * One network plugin, and everything a person can do about it here.
 *
 * **The whole state machine lives in this one component** — deliberately, and
 * it is why the first-run step reuses it in `compact` rather than rendering a
 * shorter version of the same six states. Those states are a sequence a person
 * walks once (nothing installed → a daemon that is not up → not signed in →
 * joined → published), and a second implementation of it would be a second
 * place for "what can I do from here" to be answered differently on two pages
 * a person meets minutes apart.
 *
 * Three rules it keeps throughout:
 *
 * - **A refusal is an ANSWER, not an error.** A publish that comes back
 *   `ok: false` with a `refused` hint renders inline, in the plugin's own
 *   words, where the button was. An error banner would say "something went
 *   wrong" about a server that worked correctly and told us why not.
 * - **Nothing privileged is ever a button.** A command needing root is
 *   copyable and nothing more: this server has no terminal to answer a
 *   password prompt, so a control that ran it would always fail.
 * - **The plugin owns its copy.** Hints, labels and step text are rendered
 *   verbatim. What this page owns is the shape and the consequences that are
 *   the SERVER's rather than the network's — what a non-secure context costs,
 *   what moving the base URL does to passkeys.
 */
export function NetworkPluginCard({
  row,
  headerless = false,
  compact = false,
}: {
  /** The network, as `GET /api/network` listed it */
  row: NetworkRow;
  /**
   * Suppress this component's own header — the name and description line.
   *
   * For the settings page's collapsed row, which renders that header itself
   * and expands this card underneath it: two names, one above the other,
   * would say the same word twice.
   */
  headerless?: boolean;
  /**
   * First-run shape: no card chrome, no header — the caller renders the name —
   * no description, no supervisor detail, and only the settings a join cannot
   * proceed without. The states and the controls are identical — this changes
   * what surrounds them, never what a person can do.
   */
  compact?: boolean;
}) {
  const queryClient = useQueryClient();
  const [credential, setCredential] = useState("");
  const [promoteBaseUrl, setPromoteBaseUrl] = useState(false);
  /**
   * The most recent line the running act printed.
   *
   * One piece of state for all three streaming acts, because a row runs at
   * most one of them at a time — installing, joining and publishing are
   * points on one sequence. Cleared at the start of each, so a new act never
   * opens with the last one's last word.
   */
  const [line, setLine] = useState<string | undefined>(undefined);
  const note = (_id: string, text: string) => {
    // Blank lines are spacing in a program's output, not progress; showing
    // one would blank the only thing on screen that is saying anything.
    if (text.trim() !== "") setLine(text);
  };

  const install = useInstallNetwork(note);
  const join = useJoinNetwork(note);
  const publish = usePublishNetwork(note);
  const unpublish = useUnpublishNetwork();
  const leave = useLeaveNetwork();
  /**
   * True while a settings write the FORM owns is in flight.
   *
   * Reported upward because the mutation lives inside `NetworkSettingsForm`
   * and this component never sees it, so a publish could be started on top of
   * a settings write — exactly the staleness § 10d refuses, and exactly what
   * the route's own in-flight gate already counts. These two are supposed to
   * agree. A shared `useIsMutating` key would have been simpler and wrong:
   * every mutation here carries the same key, so one row's write would disable
   * every other row's buttons.
   */
  const [savingSettings, setSavingSettings] = useState(false);
  const busy =
    install.isPending ||
    join.isPending ||
    publish.isPending ||
    unpublish.isPending ||
    leave.isPending ||
    savingSettings;

  const status = row.status;
  const state = status?.state;
  /**
   * Whether the `not-installed` row is a SEQUENCE worth numbering, and where
   * the hints' own numbers carry on from.
   *
   * Counted over the hints that carry a COMMAND, matching what
   * {@link NetworkHints} will actually number: a plugin opens this list with
   * a sentence saying what is wrong before the steps that fix it, so counting
   * every hint would turn one real step plus its explanation into a two-step
   * sequence. With one command in total there is no sequence at all — a lone
   * "1." promises a second step that never comes.
   *
   * Derived once because BOTH lists read it: the privileged steps take their
   * numbers from the same count, and the two disagreeing would number the
   * first list and not the second.
   */
  const commandSteps = row.privileged.length + (status?.hints ?? []).filter((hint) => hint.command).length;
  const numberSteps = commandSteps > 1;
  /**
   * Whether the privileged steps are alternatives rather than one sequence.
   *
   * Read here as well as inside {@link PrivilegedSteps} because it changes what
   * the HINTS may do: a number continued from a grouped list belongs to no
   * group, so "3." under a two-step route reads as that route's third step when
   * the plugin is in fact talking about the machine rather than about either
   * route. Grouped means the hints carry no numbers at all.
   */
  const groupedSteps = hasGroupedSteps(row.privileged);
  const recheck = () => void queryClient.invalidateQueries({ queryKey: NETWORK_QUERY_KEY });
  /**
   * Starts one act, having forgotten every previous one.
   *
   * Resetting ALL five mutations rather than only the output line, because a
   * mutation's result outlives the state it describes: `publish.data` renders
   * outside every state branch, so after Unpublish the card went on saying
   * "Published on Tailscale, updated the trusted origins" above a row that had
   * gone back to `joined` — and after Disconnect, above one that had fallen to
   * `needs-login`. Errors behaved the same way, since the banner takes the
   * first non-null error across all five: a failed join's message stayed on
   * screen through every later act.
   *
   * Every act goes through here, `unpublish` and `leave` included, which is
   * what makes that true rather than nearly true.
   */
  const begin = (run: () => void) => {
    setLine(undefined);
    install.reset();
    join.reset();
    publish.reset();
    unpublish.reset();
    leave.reset();
    run();
  };

  /**
   * Where the interactive sign-in is, from whichever half knows.
   *
   * The join stream says it first; the polled status carries it afterwards.
   * Preferring the stream means the URL appears the moment it exists rather
   * than at the next poll, and falling back to the status means it survives
   * this component re-rendering or the mutation being reset.
   */
  const joinOutcome = join.data?.outcome;
  const loginUrl = (joinOutcome?.state === "needs-login" ? joinOutcome.loginUrl : undefined) ?? status?.loginUrl;
  const loginCode = (joinOutcome?.state === "needs-login" ? joinOutcome.loginCode : undefined) ?? status?.loginCode;

  const published = publish.data;
  /**
   * A 404 from the install route is not a failure.
   *
   * It means this plugin ships no installer — which is a fact the row is
   * already rendering, as the privileged steps a person copies instead. No
   * plugin available today HAS one (every Tailscale install path needs root,
   * and the manifest parser refuses a `sudo` install command), so a button
   * somehow pressed against a route that is not there must leave the hints
   * standing rather than cover them with an error about them.
   */
  const installMissing = install.error instanceof ApiError && install.error.status === 404;

  /** A failed CALL, which is not the same thing as a refusal the server explained. */
  const failure =
    (installMissing ? null : install.error) ?? join.error ?? publish.error ?? unpublish.error ?? leave.error;
  const actionError = failure ? errMessage(failure, "The request failed. Nothing changed.") : null;

  const header = (
    <div className="flex min-w-0 items-center gap-3">
      <PluginIcon pluginId={row.id} name={row.name} className="size-8" />
      <div className="min-w-0">
        <p className="truncate font-strong text-label">{row.name}</p>
        {!compact && <p className="truncate text-detail text-muted-foreground">{row.description}</p>}
      </div>
    </div>
  );

  /**
   * The amber note a `public-with-gate` network carries FOREVER, above
   * everything else on the row.
   *
   * Same visual language as the trust indicators (`components/trust-indicators.tsx`):
   * amber rather than red, because putting a server behind an identity gate on
   * the public internet is an ordinary, intended thing to do — and permanent,
   * because it governs a decision the operator makes every time they look at
   * this row, not one they make once. Every other network in this list keeps
   * the server on a private network, so the difference has to be visible
   * without reading two descriptions.
   */
  const exposureNote = row.exposure === "public-with-gate" && (
    <div className="flex items-start gap-2 rounded-md border border-warning/50 px-3 py-2 text-detail text-warning">
      <ShieldAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
      <p>
        Publishing here puts this server on the public internet with an identity check in front. Everything else in this
        list stays on a private network.
      </p>
    </div>
  );

  /** The act in flight, in its own words. */
  const progress = busy && (
    <p aria-live="polite" className="truncate font-mono text-detail text-muted-foreground">
      {line ?? "Working…"}
    </p>
  );

  const body = (
    <div className="space-y-4">
      {exposureNote}

      {/* Two short-circuits, before any state: a plugin this host cannot run
          and a plugin the instance is not offering have no status to render,
          and every control below them would act on nothing. */}
      {!row.supported ? (
        <p className="text-detail text-muted-foreground">
          Not available on this server's platform. {row.name} runs on {platformList(row.platforms)}.
        </p>
      ) : !row.enabled ? (
        <p className="text-detail text-muted-foreground">
          Disabled in{" "}
          <Link to="/settings/plugins" className="underline">
            Settings → Plugins
          </Link>
          .
        </p>
      ) : status === undefined ? (
        // Supported and offered, but the server sent no status: it has not
        // asked this host yet. Saying so beats rendering the first state as
        // though it were a finding.
        <div className="space-y-2">
          <p className="text-detail text-muted-foreground">This network has not reported its status yet.</p>
          <Button variant="outline" size="sm" onClick={recheck}>
            Re-check
          </Button>
        </div>
      ) : (
        <>
          {/* Disabled while published, because the server refuses the write
              (nothing re-derives the guard, the argv or the hydrated secret
              from it) and a form that invites an act the server will refuse
              puts the explanation AFTER the edit. */}
          <NetworkSettingsForm
            row={row}
            disabled={busy || row.published}
            onPendingChange={setSavingSettings}
            requiredOnly={compact}
            {...(row.published
              ? { reason: `Unpublish ${row.name} to change these — a change cannot reach a running tunnel.` }
              : {})}
          />

          {state === "not-installed" && (
            <div className="space-y-3">
              {/* The state's own sentence FIRST, in a notice. It is the one
                  thing the live status knows that the manifest cannot, and it
                  used to render below the steps it explains, in the same muted
                  grey as a step label — so the card opened with "1. Install
                  the daemon" and buried "…is not installed on this machine"
                  in the middle of the sequence. */}
              <NetworkNotice hints={splitLeadHints(status.hints).lead} />
              {/* The privileged steps, numbered when they are part of a
                  sequence, because running the third one first does nothing.
                  A platform that offers ALTERNATIVES — macOS, where the
                  Tailscale app and the command-line daemon are two ways to the
                  same place — gets one heading per route and an `or` between
                  them instead of one long count. Copy-only either way: see the
                  component docblock. */}
              <PrivilegedSteps steps={row.privileged} numbered={numberSteps} />
              {row.install && (
                <div className="space-y-1.5">
                  <p className="text-detail text-muted-foreground">
                    Runs <code className="font-mono">{row.install.command}</code> on this machine.{" "}
                    {safeHref(row.install.docsUrl) && (
                      <a href={safeHref(row.install.docsUrl)} target="_blank" rel="noreferrer" className="underline">
                        Install docs ↗
                      </a>
                    )}
                  </p>
                  <Button size="sm" disabled={busy} onClick={() => begin(() => install.mutate({ id: row.id }))}>
                    {install.isPending && <LoaderCircle aria-hidden className="mr-1.5 size-3.5 animate-spin" />}
                    {install.isPending ? "Installing…" : "Install"}
                  </Button>
                </div>
              )}
              {/* The way back, and the state that most needs one. Installing
                  the vendor's tool happens in a TERMINAL — every step above is
                  copy-only, because this server has no way to run a privileged
                  command — so the person leaves this page, does the work
                  elsewhere, and returns. Without this their only option is to
                  reload, and a row that says "not installed" about a machine
                  where it now IS reads as the feature being broken. */}
              {/* The hints continue the numbered sequence rather than
                  starting a second list. On a machine with nothing installed
                  they are setup steps like the ones above — for a plugin
                  whose every install path needs root, they are the ENTIRE
                  install experience, since a manifest may not ship a `sudo`
                  command and the host would refuse to run one anyway. */}
              <NetworkHints
                hints={splitLeadHints(status.hints).rest}
                startAt={numberSteps && !groupedSteps ? row.privileged.length + 1 : undefined}
              />
              <Button variant="outline" size="sm" onClick={recheck}>
                Re-check
              </Button>
            </div>
          )}

          {(state === "daemon-down" || state === "needs-privilege") && (
            <div className="space-y-3">
              <NetworkHints hints={status.hints} />
              {/* The only control these two states have: whatever fixes them
                  happens on the machine, not in this page, and what the page
                  can do is ask again. */}
              <Button variant="outline" size="sm" onClick={recheck}>
                Re-check
              </Button>
            </div>
          )}

          {/* `needs-login` gets one too. A plugin's hint in this state can
              legitimately say "turn it back on, then re-check" — Tailscale's
              `Stopped` hint does — and a sentence pointing at a control that
              is not on screen is worse than no sentence. Signing in also
              finishes on ANOTHER device, so the page needs a way to be told
              rather than only a poll that runs while a login URL exists. */}
          {state === "needs-login" && (
            <div className="space-y-3">
              <NetworkHints hints={status.hints} />
              <div className="space-y-1.5">
                <Label htmlFor={`network-${row.id}-credential`}>{row.labels.credential ?? "Access key"}</Label>
                <Input
                  id={`network-${row.id}-credential`}
                  type="password"
                  autoComplete="off"
                  placeholder={row.settingsFields.find((f) => f.type === "secret")?.placeholder}
                  value={credential}
                  disabled={busy}
                  onChange={(event) => setCredential(event.target.value)}
                />
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  disabled={busy || credential.trim() === ""}
                  onClick={() =>
                    begin(() =>
                      join.mutate(
                        { id: row.id, credential: credential.trim() },
                        // Cleared on success, so a later return to this state
                        // does not re-populate the field with a key that has
                        // already been spent. A failed join keeps it: the
                        // usual cause is a typo worth correcting rather than
                        // retyping.
                        { onSuccess: () => setCredential("") },
                      ),
                    )
                  }
                >
                  Connect
                </Button>
                {/* The other half of the same act, not a second act: an empty
                    body asks the vendor for a URL instead of presenting a key.
                    Offered only where the plugin says that path exists. */}
                {row.interactiveLogin && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => begin(() => join.mutate({ id: row.id }))}
                  >
                    Sign in with {row.name}
                  </Button>
                )}
              </div>
              {loginUrl && (
                <div className="space-y-1.5 rounded-md border p-3">
                  <p className="text-detail text-muted-foreground">
                    Open this link to finish signing in. This page updates when you are done.
                  </p>
                  <CopyableValue value={loginUrl} label="Sign-in link" />
                  {/* Prominent because a person is about to read it off this
                      screen and type it into another device. */}
                  {loginCode && <p className="font-mono font-strong text-heading tracking-[0.2em]">{loginCode}</p>}
                </div>
              )}
              <div>
                <Button variant="outline" size="sm" onClick={recheck}>
                  Re-check
                </Button>
              </div>
            </div>
          )}

          {(state === "joined" || state === "published") && (
            <div className="space-y-4">
              {status.identity && (
                <p className="text-detail text-muted-foreground">
                  {[status.identity.network, status.identity.hostname, status.identity.version]
                    .filter((part): part is string => part !== undefined && part !== "")
                    .join(" · ")}
                </p>
              )}
              <NetworkAddresses addresses={status.addresses} copyable={state === "published"} />
              {/* Hints do not stop at the door. A network that has joined can
                  still have something to say about the addresses it did NOT
                  hand out — no certificates on the tailnet means no https
                  address at all, and the only place that is explained is
                  here. Rendering hints only in the states before joining left
                  that answer nowhere, under a list quietly one address short. */}
              <NetworkHints hints={status.hints} />
              {!compact && row.process && <NetworkProcessLine process={row.process} />}

              {state === "joined" && (
                <div className="space-y-2">
                  <label className="flex items-start gap-2" htmlFor={`network-${row.id}-promote`}>
                    <input
                      id={`network-${row.id}-promote`}
                      type="checkbox"
                      className="mt-0.5 h-4 w-4 rounded border border-input bg-background accent-primary"
                      checked={promoteBaseUrl}
                      disabled={busy}
                      onChange={(event) => setPromoteBaseUrl(event.target.checked)}
                    />
                    <span>
                      <span className="text-label">Set as this server's base URL</span>
                      {/* The consequence nobody guesses, and the one that is
                          not reversible for a credential already registered
                          against the old host. */}
                      <span className="block text-detail text-muted-foreground">
                        Moves where passkeys work. Passkeys registered at the current address stop working there. Adding
                        this address to trusted origins does not have that effect, and is enough to sign in from it —
                        which publishing has already done.
                      </span>
                    </span>
                  </label>
                  <Button
                    size="sm"
                    disabled={busy}
                    onClick={() => begin(() => publish.mutate({ id: row.id, promoteBaseUrl }))}
                  >
                    {publish.isPending && <LoaderCircle aria-hidden className="mr-1.5 size-3.5 animate-spin" />}
                    {publish.isPending ? "Publishing…" : (row.labels.publish ?? "Publish")}
                  </Button>
                </div>
              )}

              {/* The standing FACT, not the outcome of the last act. The
                  post-publish block says what just happened and is cleared by
                  the next act, so after a reload an admin saw addresses, hints
                  and an Unpublish button with nothing stating the row's
                  status. */}
              {state === "published" && (
                <p className="text-detail text-muted-foreground">Subshell is published on {row.name}.</p>
              )}

              <div className="flex flex-wrap items-center gap-2">
                {state === "published" && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={async () => {
                      // The last sentence is the point. Leaving the trusted
                      // origin behind is deliberate (spec §5.4) — removing one
                      // is the Addresses card's act — and it is surprising
                      // enough that discovering it later reads as a bug.
                      const proceed = await confirmAction({
                        title: `Stop publishing Subshell on ${row.name}?`,
                        description: `This server stops answering at the addresses ${row.name} gave it. This machine stays on the network, and the address stays in the trusted origins — remove it under Settings → Service if you want it gone.`,
                        confirmLabel: "Unpublish",
                      });
                      if (proceed) begin(() => unpublish.mutate({ id: row.id }));
                    }}
                  >
                    {unpublish.isPending ? "Unpublishing…" : "Unpublish"}
                  </Button>
                )}
                {/* The shared confirmation, not a type-the-name field.
                    Leaving is recoverable by rejoining, so it does not
                    deserve the ceremony the desktop reset's typed hostname
                    has — and the token the route compares is the plugin ID,
                    which differs from the name a person is looking at by its
                    case alone (`tailscale` against "Tailscale"). A field
                    asking someone to type what is on screen would refuse
                    exactly that. So the id goes programmatically and the
                    question stays a question. */}
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-destructive hover:text-destructive"
                  disabled={busy}
                  onClick={async () => {
                    const proceed = await confirmAction({
                      title: `Disconnect this server from ${row.name}?`,
                      description: `The addresses this server answered on over ${row.name} stop working, and anything reaching it through them — a phone, another laptop — loses it until you connect again.`,
                      confirmLabel: "Disconnect",
                      danger: true,
                    });
                    if (proceed) begin(() => leave.mutate({ id: row.id, confirm: row.id }));
                  }}
                >
                  Disconnect
                </Button>
              </div>
            </div>
          )}

          {/* The outcome of the last publish, wherever the row has got to
              since. A refusal is rendered as the plugin worded it, with its
              command and its docs — an answer in the place the button was,
              never a banner. */}
          {published && !published.ok && published.refused && (
            <div className="rounded-md border border-warning/50 p-3">
              <NetworkHintBlock hint={published.refused} />
            </div>
          )}
          {published?.ok && (
            <div className="space-y-2">
              <p className="text-detail text-success">
                Published on {row.name}
                {published.config.changed.length > 0 && <> · updated {published.config.changed.join(", ")}</>}
              </p>
              {published.config.warnings.map((warning) => (
                <p key={warning} className="text-detail text-warning">
                  {warning}
                </p>
              ))}
              {/* The write did not land, and the reason is that the key is
                  the environment's — the same "environment wins, and a write
                  the next read would mask is not a success" rule the rest of
                  the config ladder follows. Naming the key is the whole
                  point: it is where the change has to be made instead. */}
              {/* Names the KEY that did not land, never a reason for it and
                  never the whole file. `unwritableKey` is set on three
                  different paths — the environment owning the key, an
                  unreadable config file, a validator refusal — so naming the
                  first unconditionally sent an admin to edit a unit file over
                  what was really a validation error; the true reason is in
                  `config.warnings` just above, in the server's own words.
                  And a write is PARTIAL more often than not: `written` is
                  false whenever ANY key was refused, so a publish that added
                  the trusted origin and could not promote the base URL said
                  "updated TRUSTED_ORIGINS" and "config.env was not changed"
                  four lines apart, about one write. */}
              {!published.config.written && (
                <p className="text-detail text-warning">
                  {published.config.unwritableKey ? (
                    <>
                      <span className="font-mono">{published.config.unwritableKey}</span> was not written to config.env.
                    </>
                  ) : (
                    "config.env was not changed."
                  )}
                </p>
              )}
              {published.restartRequired && <NetworkRestartNotice />}
            </div>
          )}

          {progress}
          {actionError && <p className="text-destructive text-detail">{actionError}</p>}
        </>
      )}
    </div>
  );

  // The caller owns the list item AND the name: `NetworkRow` renders both,
  // and nesting a second `<li aria-label>` inside its row would have named
  // every network twice.
  if (compact) return <div className="space-y-3">{body}</div>;

  // `role="group"` so the row is addressable as a whole — by a screen reader
  // moving between networks, and by a test asserting that one card carries a
  // control and another does not. A bare div with an aria-label exposes
  // neither.
  if (headerless) {
    // The caller's row IS the card: its frame surrounds this header row and
    // the body below. A second Card (or a second name) inside would nest one
    // border inside another.
    return <CardContent className="px-6 pt-2 pb-6">{body}</CardContent>;
  }
  return (
    <Card role="group" aria-label={row.name}>
      <CardHeader>
        <CardTitle>{header}</CardTitle>
      </CardHeader>
      <CardContent>{body}</CardContent>
    </Card>
  );
}
