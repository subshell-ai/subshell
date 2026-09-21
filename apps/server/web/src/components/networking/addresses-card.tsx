import { BackendErrorCodes } from "@internal/backend-errors";
import {
  ApiError,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  errMessage,
  Input,
  Label,
} from "@internal/node-admin";
import { useState } from "react";
// Deliberate (review, 2026-09-17): the card moved to `networking/`, but
// RESTARTING is service-domain and these two are shared with ServiceCard —
// copying them per-page would fork the one sentence that says "the server
// has not come back".
import { RestartDialog } from "@/components/service/restart-dialog";
import { RestartStrip } from "@/components/service/restart-strip";
import { useUpdateServerConfig } from "@/hooks/use-server-deployment";
import type { ServerRestart } from "@/hooks/use-server-restart";
import { formProblems } from "@/lib/config-validation";
import { isServerDesktop } from "@/lib/desktop";
import type { ServerConfigPatch, ServerDeployment, ServerSettingKey } from "@/types/server-deployment";

/**
 * The four editable keys, in the order the card lays them out — each with the
 * one thing about it that is not obvious from its label.
 *
 * Per FIELD rather than one description for the card, because these four are
 * not variations on a theme: two decide where the server listens and two
 * decide what a browser may be when it calls, and the mistakes they invite are
 * different mistakes. A card-level sentence had to gloss all four at once, so
 * it ended up saying something true of none of them in particular — and the
 * one field that genuinely needed a warning had it hard-coded beside the
 * input, which is the shape this replaces.
 */
const FIELDS = [
  {
    key: "SERVER_PORT",
    id: "server-port",
    label: "Port",
    hint: "The port this server listens on. The public base URL below usually has to name it too.",
  },
  {
    key: "HOST",
    id: "server-host",
    label: "Bind address",
    // The genuinely non-obvious one, and the default is the permissive value.
    hint: "0.0.0.0 accepts connections from anywhere on your network; 127.0.0.1 only from this machine.",
  },
  {
    key: "APP_BASE_URL",
    id: "server-base-url",
    label: "Public base URL",
    // The passkey consequence is not guessable and is not reversible for a
    // credential already registered against the old host.
    hint: "The address this server hands out in links and to nodes. Changing it moves where passkeys work.",
  },
  {
    key: "TRUSTED_ORIGINS",
    id: "server-trusted-origins",
    label: "Other addresses browsers will use",
    // The trap this field exists for, and what is left of it: addresses from
    // joined networks arrived automatically with the Networking page
    // (2026-09-15), and the machine's own interface addresses followed with
    // the server's LAN probe (2026-09-17) — a phone on the Wi-Fi needs no
    // entry here. What still fails sign-in with an error that names nothing
    // you could change is a NAME that is not one of this host's addresses, so
    // that is what the hint says this field's own job is.
    hint: "Comma-separated. Addresses from networks you joined under Networking are trusted automatically; list anything else here (a LAN name, a reverse proxy) or a browser there is refused at sign-in with \u201cInvalid origin\u201d.",
  },
] as const satisfies readonly { key: ServerSettingKey; id: string; label: string; hint: string }[];

/** The keys this card may write. `DATABASE_PATH` is deliberately not one of them. */
type EditableKey = (typeof FIELDS)[number]["key"];

/**
 * Keys the running server re-reads on every request, so a save touching
 * ONLY these needs no restart. `TRUSTED_ORIGINS` joined the set on
 * 2026-09-16 when the allowlist became a live registry; the other three
 * are still read at boot. Deciding the button from this set rather than
 * from `restart.available` alone is what stops "Save and restart" \u2014 and
 * the dialog it opens \u2014 appearing over a change the server has already applied.
 */
const LIVE_KEYS: ReadonlySet<EditableKey> = new Set<EditableKey>(["TRUSTED_ORIGINS"]);

/**
 * The value the ROUTE will actually see for this key, from what was typed.
 *
 * **Validation and the patch body have to agree about this string**, and they
 * did not. `patchFor` drops empty entries from the origin list, so a trailing
 * comma — an entirely ordinary typing artifact in a comma-separated field —
 * was cleaned on the way out and accepted by the route, while validation ran
 * against the RAW draft and refused it first. The form was rejecting input
 * its own patch builder would have fixed: strictly worse than a round trip,
 * and the exact thing importing the server's rules was supposed to prevent.
 *
 * So normalization happens once, here, and both halves read it.
 */
function wireValue(key: EditableKey, draft: string): string {
  return key === "TRUSTED_ORIGINS"
    ? draft
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean)
        .join(",")
    : draft;
}

/**
 * Whether saving this base URL will move Subshell Server's own window.
 *
 * TRUE only inside that app, and only for an `https://` value: the app opens
 * its dashboard window on the configured address when that address is https
 * (`Probe::window_origin`), because better-auth marks the session cookie
 * `Secure` for an https `APP_BASE_URL` (measured, 1.7.1) and a loopback http
 * window could never hold one. So the app restarts onto a different origin,
 * with its own cookie jar, and the person signs in there.
 *
 * **It answered a different question until 2026-09-19**: whether the save would
 * lock this app's window out for good, which is what happened while the window
 * only ever opened on loopback. It was also gated on THIS page's protocol, for
 * a reason that went with the lockout — the consequence is about where the app
 * reopens, not about where this page happens to be.
 *
 * A note rather than a refusal, because an https base URL is the RIGHT setting
 * for an instance people reach over the network — the cost just has to be
 * visible at the moment it is chosen rather than discovered at the next
 * sign-in.
 */
export function movesThisAppsWindow(value: string): boolean {
  return isServerDesktop() && value.trim().toLowerCase().startsWith("https://");
}

/**
 * One key's contribution to the PATCH body — the SPA's spelling of the key on
 * the left, the value in the shape the route wants on the right.
 *
 * Takes a {@link wireValue}, so the split below is over an already-normalized
 * string and cannot disagree with what was validated.
 */
function patchFor(key: EditableKey, value: string): ServerConfigPatch {
  switch (key) {
    case "SERVER_PORT":
      return { port: Number(value) };
    case "HOST":
      return { host: value };
    case "APP_BASE_URL":
      return { baseUrl: value };
    case "TRUSTED_ORIGINS":
      return {
        trustedOrigins: value
          .split(",")
          .map((entry) => entry.trim())
          .filter(Boolean),
      };
  }
}

/**
 * The key a `CONFIG_INVALID` refusal is about, when it is about one.
 *
 * The route answers 400 `CONFIG_INVALID` with `"<CONFIG KEY>: <reason>"` — the
 * same sentence the CLI prints, naming the config key rather than this form's
 * field name. Matching that prefix is what lets the reason land under the
 * field it belongs to instead of at the bottom of the form (spec § 4.2).
 *
 * Everything else stays form-level on purpose: an unreadable config.env comes
 * back as `BAD_REQUEST` naming no field, and `CONFIG_KEY_FROM_ENV` is about
 * where a value comes from rather than about what was typed.
 *
 * @param error - the mutation's failure, if any
 * @returns the key it names and the reason, or null when it names no field
 */
export function invalidField(error: unknown): { key: EditableKey; reason: string } | null {
  if (!(error instanceof ApiError) || error.code !== BackendErrorCodes.CONFIG_INVALID) return null;
  for (const { key } of FIELDS) {
    const marker = `${key}: `;
    const at = error.message.indexOf(marker);
    if (at !== -1) return { key, reason: error.message.slice(at + marker.length) };
  }
  return null;
}

/** How a key's saved value is shown in its field. */
function displayValue(key: EditableKey, saved: string): string {
  // Stored as one line; shown comma-separated because that is how a person
  // types a short list into a single field.
  return key === "TRUSTED_ORIGINS"
    ? saved
        .split(/[,\s]+/)
        .filter(Boolean)
        .join(", ")
    : saved;
}

/**
 * Where this server listens and which addresses a browser may use (spec
 * 2026-09-12 § 4.2).
 *
 * Two rules hold the card together. Fields are seeded from `saved` **only
 * while untouched** — an edit in progress is never overwritten by a poll
 * landing underneath it, which is the same rule `InstanceNameCard` follows
 * and for the same reason. And the strip above the form is driven by the
 * VIEW's `restartRequired`, not by whether this card just saved: someone who
 * edited config.env over ssh gets the same sentence without the SPA having
 * written anything.
 */
export function AddressesCard({ view, restart }: { view: ServerDeployment; restart: ServerRestart }) {
  const [drafts, setDrafts] = useState<Partial<Record<EditableKey, string>>>({});
  const [confirming, setConfirming] = useState(false);
  const update = useUpdateServerConfig();
  const touched = Object.keys(drafts) as EditableKey[];
  const needsRestart = touched.some((key) => !LIVE_KEYS.has(key));
  const fieldFailure = invalidField(update.error);

  // Saving and applying are two acts, and this button is both — because
  // nobody edits a port in order to leave it not listening there. It saves
  // first and then opens the RESTART DIALOG rather than restarting: that
  // dialog is where the cost is stated (running subshells close on an old
  // service definition; open terminals reconnect either way) and where the
  // `force` override and the "comes back at…" link live, for the case where
  // the value just changed is the address this page is served from.
  //
  // Cancelling it is therefore the save-without-restarting path, and it is
  // the honest one: the change IS saved, and the banner above says so. That
  // covers the admin staging a change for a quiet window without giving the
  // button two meanings.
  //
  // A save that touches only a live-read key (`LIVE_KEYS`) skips the dialog:
  // there is nothing to apply.
  const canRestart = view.restart.available;

  // Checked on SAVE, not on every keystroke: a reason appearing under a field
  // while someone is halfway through typing a URL reads as being told off for
  // an unfinished thought. Held in state rather than recomputed, so it clears
  // on the next attempt instead of following a field that has since been
  // corrected.
  const [problems, setProblems] = useState<Partial<Record<EditableKey, string>>>({});

  function save(): void {
    // Validated as the ROUTE will see it, not as it was typed — see
    // `wireValue`. The rules themselves are the server's, imported (see
    // `lib/config-validation.ts`): nothing here decides what a value may be.
    const wire = Object.fromEntries(touched.map((key) => [key, wireValue(key, drafts[key] ?? "")])) as Partial<
      Record<EditableKey, string>
    >;
    const found = formProblems(wire);
    setProblems(found);
    if (Object.keys(found).length > 0) {
      // The previous SERVER refusal is no longer about what is on screen.
      // Without this, a click that never reaches the route leaves the last
      // 400 rendered under a field the person has since corrected — so the
      // page says the server rejects a value that is not there any more.
      // Before this early return existed, every Save reached `mutate`, which
      // cleared it; the guard is what made a stale one reachable.
      update.reset();
      return;
    }
    const patch = touched.reduce<ServerConfigPatch>(
      (body, key) => Object.assign(body, patchFor(key, wire[key] ?? "")),
      {},
    );
    update.mutate(patch, {
      // The answer is the fresh view and it is already in the cache, so
      // dropping the drafts re-seeds every field from what the server stored
      // — including anything it canonicalized on the way in.
      onSuccess: () => {
        setDrafts({});
        setProblems({});
        if (canRestart && needsRestart) setConfirming(true);
      },
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Addresses</CardTitle>
        {/* No card-level description. It said "Saved to the config file; a
            restart is what applies them", which existed to explain why Save
            appeared to do nothing and is stale now the button says "Save and
            restart"; and it glossed four fields at once, which is work each
            field's own `hint` does better. */}
      </CardHeader>
      <CardContent className="space-y-4">
        {view.restartRequired && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-warning/50 px-3 py-2 text-sm text-warning">
            <span>
              {view.restart.available
                ? "Saved. Restart the server to apply."
                : `Saved. ${view.restart.reason ?? "This server cannot restart itself from here."}`}
            </span>
            {/* Gated: this button was always live, so on a server nothing
                supervises it opened a dialog for an act the route then 409s. */}
            {view.restart.available && (
              <Button variant="outline" size="sm" onClick={() => setConfirming(true)}>
                Restart
              </Button>
            )}
          </div>
        )}

        {FIELDS.map(({ key, id, label, hint }) => {
          const setting = view.settings[key];
          const fromEnv = setting.source === "process env";
          return (
            <div key={key} className="space-y-1.5">
              <Label htmlFor={id}>{label}</Label>
              <Input
                id={id}
                value={drafts[key] ?? displayValue(key, setting.saved)}
                readOnly={fromEnv}
                disabled={update.isPending}
                className={fromEnv ? "text-muted-foreground" : undefined}
                onChange={(event) => {
                  setDrafts((prev) => ({ ...prev, [key]: event.target.value }));
                  // This field's complaint goes as soon as it is being worked
                  // on; the others stay, because they are still true.
                  setProblems((prev) => (key in prev ? { ...prev, [key]: undefined } : prev));
                }}
              />
              {fromEnv && (
                <p className="text-detail text-muted-foreground">Set by the environment ({key}); change it there.</p>
              )}
              {/* The field's own explanation, in the same place for every
                  field — replacing a card-level gloss and a hard-coded
                  special case for one of them. Suppressed where the value is
                  the environment's: the line above already says the only
                  thing that matters there, which is that this is not where to
                  change it. */}
              {!fromEnv && <p className="text-detail text-muted-foreground">{hint}</p>}
              {/* What changing this costs, said BEFORE the save rather than
                  discovered after (operator's report, 2026-09-18). One
                  sentence, shared verbatim with the assistant's Server
                  Addresses screen and pinned equal by test. It named a lockout
                  until 2026-09-19, when the app began opening its window on
                  the configured address — see `movesThisAppsWindow`. */}
              {key === "APP_BASE_URL" && movesThisAppsWindow(drafts[key] ?? setting.saved) && (
                <p className="text-detail text-muted-foreground">
                  Changing the base URL will require an app restart and sign in.
                </p>
              )}
              {setting.saved !== setting.running && (
                <p className="text-detail text-warning">
                  Saved {setting.saved || "(blank)"} · running {setting.running || "(blank)"}
                </p>
              )}
              {(problems[key] ?? (fieldFailure?.key === key ? fieldFailure.reason : null)) && (
                <p className="text-destructive text-detail">{problems[key] ?? fieldFailure?.reason}</p>
              )}
              {setting.problems?.map((problem) => (
                <p key={problem.entry} className="text-destructive text-detail">
                  {problem.entry}: {problem.reason}
                </p>
              ))}
            </div>
          );
        })}

        <div className="flex items-center gap-3">
          {/* Named for what it does. Where the server cannot restart itself —
              nothing supervising it — it saves and says so, rather than
              promising an act the route would refuse. */}
          <Button
            variant="outline"
            size="sm"
            disabled={touched.length === 0 || update.isPending}
            title={canRestart || !needsRestart ? undefined : (view.restart.reason ?? undefined)}
            onClick={save}
          >
            {update.isPending ? "Saving…" : canRestart && needsRestart ? "Save and restart" : "Save"}
          </Button>
          {update.isSuccess && touched.length === 0 && <span className="text-detail text-success">saved</span>}
        </div>

        {/* The restart this button can start needs its failure face HERE, not
            only on Service (review, 2026-09-17): a timed-out restart used to
            leave this page as if nothing had been pressed. One component,
            same sentence as ServiceCard — quiet unless the press errored or
            never landed. */}
        <RestartStrip view={view} restart={restart} />

        {update.error && !fieldFailure && (
          <p className="text-destructive text-sm">
            {errMessage(update.error, "The configuration could not be saved.")}
          </p>
        )}
        {update.data?.warnings.map((warning) => (
          <p key={warning} className="text-sm text-warning">
            {warning}
          </p>
        ))}
      </CardContent>
      <RestartDialog
        open={confirming}
        onOpenChange={setConfirming}
        view={view}
        onConfirm={(force) => {
          setConfirming(false);
          void restart.restart(force ? { force: true } : {});
        }}
      />
    </Card>
  );
}
