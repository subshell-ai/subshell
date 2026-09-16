import { useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { LoaderCircle, ShieldAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { Fact } from "@/components/admin-status/fact-list";
import { ConfigWriteOutcome } from "@/components/networking/config-write-outcome";
import { NetworkAddresses } from "@/components/networking/network-addresses";
import { NetworkHintBlock, NetworkHints, NetworkNotice, splitLeadHints } from "@/components/networking/network-hints";
import { hasGroupedSteps, PrivilegedSteps } from "@/components/networking/network-privileged-steps";
import { NetworkProcessLine } from "@/components/networking/network-process-line";
import { NetworkSettingsForm, secretIsSet } from "@/components/networking/network-settings-form";
import { PluginIcon } from "@/components/plugin-icon";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CopyableValue } from "@/components/ui/copyable-value";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Segmented } from "@/components/ui/segmented";
import {
  NETWORK_QUERY_KEY,
  useInstallNetwork,
  useJoinNetwork,
  useLeaveNetwork,
  usePublishNetwork,
  useUnpublishNetwork,
} from "@/hooks/use-network";
import { PUBLIC_SETTINGS_QUERY_KEY } from "@/hooks/use-public-settings";
import { useServerRestart } from "@/hooks/use-server-restart";
import { ApiError, errMessage } from "@/lib/api";
import { confirmAction } from "@/lib/confirm";
import { connectBlocker } from "@/lib/network-connect";
import { safeHref } from "@/lib/safe-href";
import type { NetworkRow, NetworkStatus } from "@/types/network";

/** What this host's platform is called in a sentence. */
const PLATFORM_NAMES: Record<string, string> = { darwin: "macOS", linux: "Linux" };

/** "macOS and Linux" — the platforms a plugin can drive, as prose. */
function platformList(platforms: string[]): string {
  const names = platforms.map((p) => PLATFORM_NAMES[p] ?? p);
  if (names.length <= 1) return names[0] ?? "no platform this build knows";
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/**
 * What this host's membership consists of, as the app's one shape for a block
 * of read-only facts.
 *
 * These used to be paragraphs, and the first was a bare
 * `suteki.nu · MacBook Pro · 1.102.4` — three facts about three different
 * things in one joined string, in the same muted grey as the hints under it,
 * so nothing on screen said which part was the network's name and which was a
 * version number. Labelling them is what turns that back into data. `Fact` is
 * the node detail page's own component, so this adds no visual vocabulary.
 *
 * Each row renders only when its own part exists — the identity a plugin
 * reports is partial in the general case, and a labelled "Machine:" over
 * nothing is worse than the line that quietly omitted it. And the whole block
 * renders only when at least one row does: a `<dl>` that is empty is a frame
 * around a gap.
 */
function JoinedFacts({ row, status, compact }: { row: NetworkRow; status: NetworkStatus; compact: boolean }) {
  const process = !compact && row.process ? row.process : undefined;
  const identity = status.identity;
  if (!identity && !process) return null;
  return (
    <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-3">
      {identity?.network && <Fact label="Network">{identity.network}</Fact>}
      {identity?.hostname && <Fact label="Machine">{identity.hostname}</Fact>}
      {identity?.version && (
        <Fact label="Client version" mono>
          {identity.version}
        </Fact>
      )}
      {process && (
        <Fact label="Publish process" wide>
          <NetworkProcessLine process={process} />
        </Fact>
      )}
    </dl>
  );
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
 *   the SERVER's rather than the network's — what a non-secure context
 *   costs, and the restart a config write defers.
 */
/**
 * One, two, or many, in English. The restart confirmation names addresses
 * by value and there may be several (a tailnet MagicDNS name beside a mesh
 * IP); "a, b and c" reads, "a, b, c" does not, and none of the three forms
 * may borrow the other's comma.
 */
function andList(items: string[]): string {
  if (items.length <= 2) return items.join(" and ");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

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
  /**
   * Which of the two join paths the `needs-login` card shows.
   *
   * Nothing else reads it: the choice is this block's, and the two panels are
   * two ways of asking the SAME `join` route for the same thing — a URL, or a
   * key. It is state rather than derived because neither path is "the real
   * one" — a person comes to this card intending one of them.
   */
  const [joinMode, setJoinMode] = useState<"signin" | "key">("signin");
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
  /** The card's one restart waiter: the result blocks show it, `busy` gates on it. */
  const restart = useServerRestart();
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
    savingSettings ||
    // An act started against a server that is coming back is an act that
    // fails offline; the outage is a state of the CARD, not only of the
    // notice showing the spinner. The blocker disjunctions must never be
    // able to re-enable a button during it — folded into `busy`, every
    // `disabled={busy}` site (blocker included) stays shut.
    restart.outcome === "waiting";

  const status = row.status;
  const state = status?.state;
  /**
   * The word this row uses for the publish act, derived ONCE.
   *
   * The joined sentence and the button both read this expression because the
   * vocabularies differ per plugin — Publish, Publish with Tailscale Serve,
   * Start tunnel, Use this address — and the sentence explaining the button used
   * to say "publishing" while the thing under it said something else. NetBird's
   * "Use this address" made an operator ask how to publish — since the join IS
   * its publish (spec §5.3 amended 2026-09-16), that word now rides only the
   * fallback button, for the joined-and-unrecorded gap.
   */
  const publishLabel = row.labels.publish ?? "Publish";
  /**
   * The credential's name in the join-mode choice's grammar: "Use auth key",
   * "Use setup key", "Use access key".
   *
   * Lower-cased because the option names the thing rather than quoting the
   * field — the Label above the input keeps the vendor's own casing.
   */
  const credentialLabel = (row.labels.credential ?? "Access key").toLowerCase();
  /**
   * Where this plugin's credential is minted, when the manifest names a page.
   *
   * Checked at the sink like every other plugin-authored URL on this surface
   * (`safe-href`'s docblock carries why the parser upstream is not enough):
   * absent or non-http(s) renders no link at all.
   */
  const credentialDocs = safeHref(row.labels.credentialDocsUrl);
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
  /**
   * Why the join would fail whatever gets typed, when it would: the first
   * required non-secret field the SERVER's own gate (`configurationRefusal`)
   * refuses an unconfigured row on. Rendered as the buttons' attached reason
   * rather than discovered as a 409 naming the page the press came from.
   */
  const blocker = connectBlocker(row);
  const blockerId = `network-${row.id}-connect-blocker`;
  const blockerProps = blocker ? { "aria-describedby": blockerId } : {};

  const published = publish.data;
  const unpublished = unpublish.data;
  /**
   * What a restart that LANDS refetches.
   *
   * The config the restarted process just read is what every row's addresses
   * now MEAN — boot reconciles publishes (`prepare.ts`) — and a restart is
   * also the event that lands an `APP_BASE_URL` edit the public settings
   * carry into install commands. The hook has already landed the deployment
   * view and admin status; these are the two the card owns.
   */
  useEffect(() => {
    if (restart.outcome !== "back") return;
    void queryClient.invalidateQueries({ queryKey: NETWORK_QUERY_KEY });
    void queryClient.invalidateQueries({ queryKey: PUBLIC_SETTINGS_QUERY_KEY });
  }, [restart.outcome, queryClient]);
  /**
   * A 404 from the install route is not a failure.
   *
   * It means this plugin ships no installer — which is a fact the row is
   * already rendering, as the privileged steps a person copies instead. Three
   * of the four built-ins are in that case today: their every install path
   * needs root, and the manifest parser refuses a `sudo` install command.
   * `cloudflared` is the one that needs no root anywhere, so it is the one
   * that ships an `install.command` — which makes the route's absence the
   * per-plugin fact rather than the per-build rule. Either way, a button
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

  /**
   * The credential box: the vendor's own word for the key, the page that mints
   * one where the plugin names it, and the input itself.
   *
   * A value rather than markup written once at its use site, because the
   * join-mode choice seats it in one of two places: inside the key panel of an
   * interactive row, or — for a plugin with no choice to make — above the
   * blocker, where it has sat since before the choice existed. A second copy of
   * the box would be a second input `id`, and the `aria-describedby` wiring
   * below counts on there being exactly one of each.
   */
  const credentialBox = (
    <div className="space-y-1.5">
      {/* The label row: the box's name, and — where the plugin names one — the
          vendor page that mints the thing the box asks for. A card could tell
          you WHAT to paste ("Auth key", "Setup key", "Tunnel token") while
          saying nothing about WHERE it comes from, and the four vendors word and
          mint that differently enough that only the plugin can say. The Label
          keeps pointing at the input; this is a sibling on the row, styled as
          every other plugin link (hints). */}
      <div className="flex flex-wrap items-baseline justify-between gap-x-2">
        <Label htmlFor={`network-${row.id}-credential`}>{row.labels.credential ?? "Access key"}</Label>
        {credentialDocs && (
          <a href={credentialDocs} target="_blank" rel="noreferrer" className="text-detail underline">
            Docs ↗
          </a>
        )}
      </div>
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
              ? { reason: `Unpublish ${row.name} to change these — a change cannot reach the running publish.` }
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
              {/* The full card ALSO shows this plugin's secret in the settings
                  form, so two doors carry one credential and read alike —
                  which is the sentence that tells them apart, and the one that
                  says which THIS act writes. (`compact` drops the form's
                  secret row: the wizard renders only what a join cannot
                  proceed without, and a join IS the delivery, so the box is
                  the only door there.)

                  It speaks of the Connect BOX, and it renders for exactly the
                  plugins that keep one permanently on screen: a secret settings
                  field and an interactive path do not coexist among the
                  built-ins (Cloudflare Tunnel has the only secret, and no
                  interactive path), so this sentence never sits above a panel
                  the person may be looking away from. Were that ever to change,
                  it belongs inside the key panel. */}
              {row.settingsFields.some((field) => field.type === "secret") && (
                <p className="text-detail text-muted-foreground">
                  To connect for the first time, paste it into the Connect box below.
                </p>
              )}
              {/* THE CHOICE AND ITS PANEL ARE ONE UNIT (the operator's second
                  read of the live Headscale card, 2026-09-16). A pill strip
                  with content loose beneath it reads as a widget floating above
                  orphaned text, so the control, the refusal line and whichever
                  panel is up share one border — the same bounded-control
                  language the sign-in-link block below already uses. A
                  single-path plugin has nothing to scope, so for it the wrapper
                  is the plain flow it always was: the box appears exactly where
                  there is a choice to scope.

                  No visible caption above the pills: `Segmented` names the
                  group for a screen reader already ("How to connect"), so a
                  heading saying it again is the same words read twice, and the
                  pills name the two ways in the vendors' own verbs. The border
                  is what makes it one unit; the panel sentence says what the
                  chosen one does. */}
              <div className={row.interactiveLogin ? "join-group space-y-3 rounded-md border p-4" : "space-y-3"}>
                {/* HOW TO JOIN IS A MODE CHOICE, and it now reads as one
                    (amended 2026-09-16, on the operator's live Headscale card).
                    The two mutually exclusive paths used to be a credential box
                    above two sibling buttons, which got both halves wrong: the
                    OPTIONAL path's empty box read as a required field, and two
                    buttons side by side read as related-but-different acts on one
                    form rather than as one-or-the-other. Now one control carries
                    the choice and exactly one panel sits under it — a thing that
                    is absent until you ask for it cannot be misread as a thing you
                    have to fill in.

                    `Segmented` rather than a tab strip because it is this app's
                    established mode switch (the tiled/list toggle, the
                    add-subshell dialog, the split-placement picker) and this is
                    the same kind of thing: two ways to do ONE act, not two pages.
                    "Sign in" is the default because the human sitting at this page
                    is the common case; a pasted key is what an automation or a
                    headless host brings.

                    A single-path plugin gets no choice at all — one road does not
                    need a fork drawn on it. */}
                {row.interactiveLogin && (
                  <Segmented
                    ariaLabel="How to connect"
                    className="w-fit"
                    options={[
                      { value: "signin", label: "Sign in" },
                      { value: "key", label: `Use ${credentialLabel}` },
                    ]}
                    value={joinMode}
                    onChange={setJoinMode}
                  />
                )}
                {/* A single-path plugin's box keeps its seat ABOVE the blocker,
                    exactly where it sat before the choice existed; an interactive
                    row's box lives inside the key panel, below it, because there
                    the blocker explains the CHOICE and has to sit where both
                    panels read under it. */}
                {row.interactiveLogin ? null : credentialBox}
                {/* The server refuses EITHER join while a required setting is
                    unset, so this gates both paths and both buttons. Attached
                    rather than merely placed above: both are disabled, and a
                    screen reader skips disabled controls — the people most likely
                    to wonder why reach a bare paragraph least. Same pattern the
                    settings form uses for its own disabled reason. */}
                {blocker && (
                  <p id={blockerId} className="text-detail text-muted-foreground">
                    {blocker}
                  </p>
                )}
                {row.interactiveLogin && joinMode === "signin" ? (
                  <div className="space-y-1.5">
                    {/* Not "opens … in a new tab": nothing here opens a tab. The
                        press ASKS the vendor, the link arrives on this card, and
                        the person opens it wherever they are — possibly on
                        another device, which is why the link below is copyable
                        and its code set in large type. A promise this control
                        cannot keep would be the same defect as the empty box
                        that read as required. */}
                    <p className="text-detail text-muted-foreground">
                      Asks {row.name} for a sign-in link to open in your browser. This card updates when you are done.
                    </p>
                    {/* Not a second act but one `join` with an EMPTY body: that is
                        what asks the vendor for a URL instead of presenting a key.
                        Primary-styled like its sibling in the other panel — they
                        are two answers to one question, and neither is the
                        secondary thing now that only one of them is on screen. */}
                    <Button
                      size="sm"
                      {...blockerProps}
                      disabled={busy || blocker !== null}
                      onClick={() => begin(() => join.mutate({ id: row.id }))}
                    >
                      Sign in with {row.name}
                    </Button>
                  </div>
                ) : (
                  <div className="space-y-1.5">
                    {row.interactiveLogin ? credentialBox : null}
                    <Button
                      size="sm"
                      {...blockerProps}
                      disabled={busy || blocker !== null || credential.trim() === ""}
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
                  </div>
                )}
              </div>
              {/* OUTSIDE the mode choice, deliberately: a login URL arrives from
                  the join stream or the poll regardless of which panel is up,
                  and the sign-in panel's second sentence points at exactly this
                  block. Switching tabs under a live URL must not hide it. */}
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
              <JoinedFacts row={row} status={status} compact={compact} />
              {/* Its own section, because the list is the thing a person
                  copies to their phone and it used to sit unlabelled directly
                  under an identity line it has nothing to do with. The heading
                  hides WITH the list: `NetworkAddresses` renders nothing when
                  there are no addresses, and a heading over a gap reads as a
                  component that failed. */}
              {status.addresses.length > 0 && (
                <div className="space-y-2">
                  <h3 className="font-strong text-label">Addresses</h3>
                  <NetworkAddresses addresses={status.addresses} />
                </div>
              )}
              {/* The published half's standing FACT stays a bare line among
                  the card's facts: it states what IS, and the controls that
                  follow (Unpublish, Disconnect) act on the row, not on a
                  question. The joined half is now a section — see below. The
                  post-publish block says what JUST happened and is cleared by
                  the next act, so after a reload an admin saw addresses,
                  hints and an Unpublish button with nothing stating the row's
                  status; this line is that statement. */}
              {state === "published" && (
                <p className="text-detail text-muted-foreground">Subshell is published on {row.name}.</p>
              )}
              {/* Hints do not stop at the door. A network that has joined can
                  still have something to say about the addresses it did NOT
                  hand out — no certificates on the tailnet means no https
                  address at all, and the only place that is explained is
                  here. Rendering hints only in the states before joining left
                  that answer nowhere, under a list quietly one address short. */}
              <NetworkHints hints={status.hints} />

              {/* Two joined states, two asks, because they are two different
                  facts (spec §5.3 amended 2026-09-16, operator: "do we really
                  need this?").

                  **Joining IS the publish for a `publishImplicit` network**:
                  the join route records the publish, widens TRUSTED_ORIGINS
                  and answers the restart through the join stream itself, so a
                  row joined-and-unrecorded is only ever the GAP — a manual
                  `netbird up`, a sign-in finished in another tab, or the
                  half-second an address table takes to settle. The gap gets
                  one line and the button, not a section with a heading and a
                  skip paragraph: the rare fallback must not wear the
                  furniture of the normal path.

                  An explicit-publish network keeps the section EXACTLY as it
                  was, down to the necessity answer — its press carries real
                  costs (public CT logs, a public tunnel) and is genuinely
                  optional, which is what the box is for. */}
              {state === "joined" && row.publishImplicit && (
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-detail text-muted-foreground">
                    {row.name} publishes by joining — “{publishLabel}” records its addresses and trusts them for
                    sign-in.
                  </p>
                  <Button size="sm" disabled={busy} onClick={() => begin(() => publish.mutate({ id: row.id }))}>
                    {publish.isPending && <LoaderCircle aria-hidden className="mr-1.5 size-3.5 animate-spin" />}
                    {publish.isPending ? "Publishing…" : publishLabel}
                  </Button>
                </div>
              )}
              {state === "joined" && !row.publishImplicit && (
                <div className="space-y-3 rounded-md border p-4">
                  <h3 className="font-strong text-label">Publish</h3>
                  <p className="text-detail text-muted-foreground">
                    Subshell is not published on {row.name} yet — “{publishLabel}” is what lets your other devices open
                    this dashboard over the network.
                  </p>
                  {/* The necessity question, answered before it is asked: the
                      section exists because an operator could not tell from
                      the card whether this press was required, and the honest
                      answer has an if-clause. */}
                  <p className="text-detail text-muted-foreground">
                    You can skip this while you only use Subshell on this machine, or at an address you have already
                    allowed.
                  </p>
                  <Button size="sm" disabled={busy} onClick={() => begin(() => publish.mutate({ id: row.id }))}>
                    {publish.isPending && <LoaderCircle aria-hidden className="mr-1.5 size-3.5 animate-spin" />}
                    {publish.isPending ? "Publishing…" : publishLabel}
                  </Button>
                </div>
              )}
              <div className="flex flex-wrap items-center gap-2">
                {state === "published" && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={async () => {
                      // The LAST sentence is the point on both branches: the
                      // origins this publish trusted leave with it when the
                      // server restarts (spec §5.4, amended 2026-09-16) — and
                      // sign-in from an address stops being accepted BEFORE
                      // the address itself necessarily stops answering (a
                      // mesh IP keeps answering on membership alone). A
                      // person has to know that order before pressing.
                      //
                      // The FIRST depends on what unpublishing even IS here.
                      // For a `publishImplicit` network (NetBird) no vendor
                      // mechanism stops — membership is what makes its
                      // addresses answer — so the sentence says exactly what
                      // DOES end: the server's permission to sign in over
                      // them, and names Disconnect as the act that ends the
                      // addresses themselves (spec §5.3 reversed 2026-09-16).
                      // For the serve/tunnel kinds the record names the
                      // mechanism and the published addresses do go down.
                      const proceed = await confirmAction({
                        title: `Stop publishing Subshell on ${row.name}?`,
                        description: row.publishImplicit
                          ? `Unpublishing ${row.name} takes its addresses out of the trusted origins when the server restarts, and sign-in from them stops then — the addresses themselves keep answering while this machine stays a member, because membership is what makes them answer. "Disconnect" takes the machine off the network.`
                          : `The published addresses stop answering — addresses the network routes to this machine directly keep answering while it stays a member. This machine stays on the network; the addresses this publish trusted leave the trusted origins when the server restarts, and sign-in from them stops then — before the address itself may stop answering.`,
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
                    // Every plugin's leave is MACHINE-wide — `tailscale
                    // logout`, `netbird down`, cloudflare deletes the stored
                    // token — so the sentence says this machine leaves the
                    // network, not merely that this server went quiet. And
                    // where a credential is stored, leaving deletes it with
                    // the rest: reconnecting then means pasting it again,
                    // which belongs before the press rather than at the next
                    // attempt.
                    const storesSecret = row.settingsFields.some(
                      (field) => field.type === "secret" && secretIsSet(row, field.key),
                    );
                    const proceed = await confirmAction({
                      title: `Disconnect this server from ${row.name}?`,
                      description:
                        `This machine leaves the ${row.name} network, and the addresses this server answered on stop working.` +
                        (storesSecret
                          ? " Stored credentials for this network are deleted; reconnecting means pasting them again."
                          : ""),
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
              {/* Result-copy rule (see `ConfigWriteOutcome`): outcome first;
                  the key it wrote is not prose; and because a fresh trust
                  only works after the restart, the clause says so — this
                  line and the notice under it read as one sentence. */}
              <p className="text-detail text-success">
                Published on {row.name}
                {published.config.changed.length > 0 &&
                  " — your other devices can open this dashboard over it once the server restarts"}
              </p>
              <ConfigWriteOutcome
                config={published.config}
                restartRequired={published.restartRequired}
                restart={restart}
                enables={
                  <>
                    Once it is back, your other devices can sign in at{" "}
                    {andList(published.addresses.map((address) => address.url))}.
                  </>
                }
              />
            </div>
          )}
          {/* The join that published (spec §5.3 amended 2026-09-16): a
              `publishImplicit` join carries its config write and restart
              answer on its own done frame, so the press that completed the
              whole path reports it here — the same block the publish route's
              result uses, the same single restart waiter. An explicit
              network's join writes nothing, and so never renders this. */}
          {join.data?.config && (
            <div className="space-y-2">
              <p className="text-detail text-success">
                Published on {row.name}
                {join.data.config.changed.length > 0 &&
                  " — your other devices can open this dashboard over it once the server restarts"}
              </p>
              <ConfigWriteOutcome
                config={join.data.config}
                restartRequired={join.data.restartRequired === true}
                restart={restart}
                enables={
                  <>
                    Once it is back, your other devices can sign in at{" "}
                    {andList(join.data.status.addresses.map((address) => address.url))}.
                  </>
                }
              />
            </div>
          )}
          {/* The outcome of the last unpublish: what became of the origins,
              in the same shape the publish result uses. Two sentences —
              removed, or nothing removed — because after the §5.3 reversal
              every kind subtracts and no third truth is left to tell. The
              implicit kind's row lands on `joined` afterwards: the machine is
              still a member and its daemon still answers at those addresses;
              what ended is this server's permission to sign in over them. */}
          {unpublished && (
            <div className="space-y-2">
              {unpublished.config && unpublished.config.changed.length > 0 ? (
                // ASKED, not REMOVED: the subtraction is by value, and the
                // list printed here is what the publish had recorded, not a
                // receipt of what the file held. If one of those origins had
                // already been hand-deleted, saying "Removed" would claim a
                // match the writer never confirmed.
                <p className="text-detail text-success">
                  Asked this server to stop accepting sign-in from {unpublished.origins.join(", ")}
                </p>
              ) : (
                <p className="text-detail text-muted-foreground">
                  Nothing was removed — the addresses this server accepts sign-in from are unchanged.
                </p>
              )}
              {unpublished.config && (
                <ConfigWriteOutcome
                  config={unpublished.config}
                  restartRequired={unpublished.restartRequired}
                  restart={restart}
                  removal
                  enables={<>{andList(unpublished.origins)} will stop accepting sign-ins.</>}
                />
              )}
            </div>
          )}

          {/* The leave, answered in the same shape. This is NetBird's NORMAL
              strip path — the unpublish button is not what a joined implicit
              row shows — so the trio the route now carries renders here too:
              one sentence about what left, and the shared tail that names
              what awaits the restart. */}
          {leave.data && (
            <div className="space-y-2">
              {leave.data.config && leave.data.config.changed.length > 0 ? (
                <p className="text-detail text-success">
                  Left {row.name} — asked this server to stop accepting sign-in from {leave.data.origins.join(", ")}
                </p>
              ) : (
                <p className="text-detail text-success">Left {row.name}.</p>
              )}
              {leave.data.config && (
                <ConfigWriteOutcome
                  config={leave.data.config}
                  restartRequired={leave.data.restartRequired}
                  restart={restart}
                  removal
                  enables={<>{andList(leave.data.origins)} will stop accepting sign-ins.</>}
                />
              )}
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
