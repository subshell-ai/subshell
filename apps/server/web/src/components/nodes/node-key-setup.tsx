import { NODE_TARGETS, SUBSHELL_REPO_SLUG } from "@internal/subshell-protocol";
import { type ReactNode, useId, useState } from "react";
import { CopyCommandRow } from "@/components/copy-command-row";
import { Label } from "@/components/ui/label";
import { Segmented } from "@/components/ui/segmented";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { usePublicSettings } from "@/hooks/use-public-settings";
import { installAddresses } from "@/lib/install-addresses";

/**
 * How a machine is handed a setup key.
 *
 * This is the half of the Add-node dialog that outgrew it. The dialog needs it (now
 * as its WHOLE body — the two-step was folded into one screen on 2026-09-18, with
 * the mint itself arriving here as the optional `generate` slot); the Setup keys
 * card needs it for a key minted TWENTY MINUTES AGO, which is the whole reason that
 * card lists the key text — and an operator who closed the dialog mid-copy could get
 * the key back but not the command, so the only way to re-read the instructions was
 * to mint a SECOND single-use key to get instructions that were never lost. Both
 * surfaces render this one component, and neither can drift from the other on the
 * two things it exists to get right: which address the node will dial, and what each
 * of the two paths actually needs.
 *
 * **A null `keyText` is a real state, not a loading state**: nothing has been minted
 * yet, and nothing here pretends the token exists. The command shows from the start
 * — its shape is the instruction, and an empty terminal panel reads as a broken tab
 * (operator's call, 2026-09-18) — but its key slot holds `<generate setup key first>`
 * and the copy button is DISABLED until a real `nsk_` value replaces it: the reader
 * sees where the key will land without being handed a command that would run with a
 * fake one. The app path is the same sentence in its own shape: the key row says
 * "Generate setup key first" where the copy row will be. The address row is copyable
 * either way; it needs no key.
 *
 * The terminal panel also owns the two verdicts about THIS SERVER's binaries — the
 * amber no-binary refusal (with the `setup` fallback row it explains) and the
 * could-not-check line. They are statements about the command, so they sit beside it,
 * not beside the generate press. The first-run-per-platform sentence is gone entirely
 * (operator's call, 2026-09-18).
 *
 * **The address is the one the node dials FOREVER**, not merely the host of the curl.
 * The download address and the dial address are separate facts (a TLS proxy shows the
 * server only loopback, the `Host` header is client-written, and one instance answers
 * at several names), and only the operator's browser can see all of them. So the
 * picker offers the same list the mobile dialog builds — the trusted-origin allowlist,
 * loopback rows dropped when anything else is known — and the terminal path carries
 * the pick to `GET /install.sh` as `server=`, which bakes it ONLY if the live registry
 * still names it (`api/install-script.ts`).
 *
 * **Two paths, because there are two ways to arrive.** The terminal one-liner carries
 * the key inside the command; the Subshell Client app cannot be handed a command, so
 * its half shows the two values its Enroll step asks for, each copyable alone.
 * Nothing on that half warns about unpublished node binaries, because the app
 * carries its own.
 *
 * **The app half reads as steps, starting with getting the app** (operator's call,
 * 2026-09-18): the reader is NOT assumed to have Subshell Client — it is served by
 * nobody but the project's GitHub Releases, so "download the Subshell Client app" is
 * step one, said first, and the two values the Enroll step takes are what follow.
 * This is the exception to "the rows ARE the instruction" the way the dialog's two
 * surviving sentences are: it changes what the operator can do — the terminal path
 * needs nothing (curl exists everywhere), this one needs an install. The link is
 * `?q=desktop-client` and never `/releases/latest`: four components share this repo
 * and GitHub's "latest" is whichever was tagged last, which can be a server release.
 */

/** The two ways to put a machine on the plane. */
type Method = "terminal" | "desktop";

const METHOD_OPTIONS = [
  { value: "terminal" as const, label: "Terminal" },
  { value: "desktop" as const, label: "Desktop App" },
];

/** The `origin` of a config value, or null when it cannot be one. */
function canonicalOrigin(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

/**
 * The one-liner for the chosen address.
 *
 * `&server=` rides ONLY on a deliberate deviation: when the pick is the
 * canonicalized `APP_BASE_URL` the route's default already answers the chosen
 * address, and the stock command stays byte-identical to the one this dialog has
 * always rendered. When the base URL is unknown (still loading, a server predating
 * the field) nothing is compared and nothing is carried — a server old enough to
 * lack the field ignores the param anyway.
 *
 * A bracketed IPv6 row (a link-local or tailnet address the LAN probe derives)
 * additionally earns `-g`: curl reads `[fe80::1]` as a glob range and dies with
 * `(3) bad range in URL` before the server is reached, and the flag travels only
 * with the commands that contain a glob character — every other command is the same
 * bytes it has always been. With `-g` the param needs no percent-encoding, and the
 * route admits the raw bracketed spelling (pinned in the downloads-route tests).
 */
export function installCommandFor(selected: string, key: string, appBaseUrl: string | undefined): string {
  const canonical = canonicalOrigin(appBaseUrl);
  const carry = canonical !== null && selected !== canonical ? `&server=${selected}` : "";
  const glob = selected.includes("[") ? "g" : "";
  return `curl -fsSL${glob} "${selected}/install.sh?setup_key=${key}${carry}" | bash`;
}

/**
 * The air-gapped fallback: the node CLI got there another way, so this is the verb run
 * directly, on the machine.
 *
 * `setup` rather than `enroll` on purpose — `enroll` is the primitive that takes every
 * fact as an argument and therefore REQUIRES `--name`, which is exactly what a person
 * standing at the machine should be ASKED for instead of being made to supply to a
 * command line they are reading off a browser.
 */
export function setupCommandFor(selected: string, key: string): string {
  return `subshell setup --server "${selected}" --key "${key}"`;
}

/**
 * The key slot of a command that cannot be copied yet. Angle brackets and words —
 * unmistakably not an `nsk_` token — and the copy button beside it is disabled until
 * the mint replaces it. (Operator's call, 2026-09-18: the command shows from the
 * start; an empty terminal panel reads as a broken tab, and the shape IS the
 * instruction.)
 */
export const KEY_PENDING_TOKEN = "<generate setup key first>";

/**
 * What this server can actually serve, and the paragraphs that say so.
 *
 * Read by {@link NodeKeySetup} alone now that the dialog is one screen: the amber
 * no-binary refusal and the could-not-check line render in the terminal panel beside
 * the command they describe, and the same `hasMissingTargets` verdict decides whether
 * the fallback command appears. The Add-node dialog shares only the QUERY (it
 * refetches on open through `usePublicSettings`), so no two surfaces can disagree
 * mid-dialog.
 */
export function useSetupKeyVerdict() {
  const { data: publicSettings, isPending, isError } = usePublicSettings();
  const appBaseUrl = publicSettings?.appBaseUrl;
  const targets = publicSettings?.nodeArtifactTargets;
  const autoFetch = publicSettings?.nodeArtifactsAutoFetch ?? false;
  // The dialog cannot know the NEW machine's platform, so it judges the one-liner by
  // what the server can serve: a target missing from `nodeArtifactTargets` 404s the
  // download on that machine. `undefined` = a server predating the field → stay silent.
  //
  // And a target absent from the list is only a PROBLEM when this server will not go
  // and get it. With a release source configured (the default) the first machine of a
  // platform to run the one-liner triggers the download, so warning about "missing"
  // binaries would be warning about a cache that has not been filled yet — which is
  // every fresh install, and which fixes itself.
  const missingTargets = targets && !autoFetch ? NODE_TARGETS.filter((t) => !targets.includes(t)) : [];
  const missingNote = missingTargets.length > 0 && (
    <p className="text-amber-600 text-detail dark:text-amber-400">
      This server has no node binary for: {missingTargets.join(", ")}, and it is configured not to download one. The
      install command 404s on those machines. Publish the binaries on the server (run{" "}
      <code className="font-mono">bun run release:cli-node</code> from a checkout, or copy them from a cli-node-vX.Y.Z
      GitHub Release into that dir), or install the node another way and run <code className="font-mono">setup</code>{" "}
      there — or add the machine with the Subshell Client app, which ships its own node CLI.
    </p>
  );
  // Settings neither loaded nor errored ⇒ no verdict exists; say so instead of
  // silently showing the 404-bound command (undefined field on a LOADED older server is
  // a different case, and stays silent by design).
  const unknownNote = (isPending || isError) && (
    <p className="text-detail text-muted-foreground">Could not check whether this server publishes node binaries.</p>
  );
  return {
    appBaseUrl,
    trustedOrigins: publicSettings?.trustedOrigins,
    hasMissingTargets: missingTargets.length > 0,
    missingNote,
    unknownNote,
  };
}

/**
 * The address picker, the Terminal | Desktop App switch, and what each shows.
 *
 * `keyText` is the only FACT a caller supplies (null = nothing minted yet), and
 * `generate` is an optional slot rendered between the picker and the switch — the
 * Add-node dialog puts the mint press and the terminal-path verdicts there, and the
 * Setup keys card puts nothing, because its key already exists. Everything else is a
 * function of the key and of this instance's own public settings. It renders no
 * dialog and no footer, so the Add-node dialog can wrap it in its enrollment watcher
 * and the Setup keys card can wrap it in a plain close button, around the same fields.
 */
export function NodeKeySetup({ keyText, generate }: { keyText: string | null; generate?: ReactNode }) {
  const addressId = useId();
  const [chosen, setChosen] = useState<string | null>(null);
  // Terminal first: it is the one that works on a headless box, which is most of what
  // gets added.
  const [method, setMethod] = useState<Method>("terminal");
  const { appBaseUrl, trustedOrigins, hasMissingTargets, missingNote, unknownNote } = useSetupKeyVerdict();

  // The address comes from the trusted-origin allowlist (spec 2026-08-31 §9.3 loopback
  // trap), the same three sources and loopback drop the mobile picker uses — which is
  // also the exact set the install.sh route will accept as `server=`. Nothing reachable
  // ⇒ the old single row (APP_BASE_URL, origin as pre-load fallback), because a command
  // with no address is not a command. It sits ABOVE the path switch because BOTH paths
  // need it: the terminal one bakes it into the script, and the app's Connect step is
  // typed this same URL.
  const baseUrl = appBaseUrl ?? window.location.origin;
  const addressRows = installAddresses({
    here: window.location.origin,
    baseUrl: appBaseUrl,
    trustedOrigins,
  }).map((address) => address.url);
  const rows = addressRows.length > 0 ? addressRows : [baseUrl];
  // Dropped when no longer on offer (a settings refetch can grow or shrink the list
  // while this is open), then derived — not synced in an effect, so a selection cannot
  // survive as a stale string.
  const selected = rows.find((url) => url === chosen) ?? rows[0];

  return (
    <>
      {/* The dropdown, not a paragraph. Every row is an address this instance trusts a
          sign-in from — and the one chosen is what install.sh bakes as the node's
          SERVER (see the module header), which is why picking here and picking in the
          mobile dialog read the same allowlist. A loopback-only instance gets the
          single row it always got; the script's runtime loopback guard is the note that
          fires where the fact is knowable. */}
      <div className="space-y-2">
        <Label htmlFor={addressId}>Select Subshell server address</Label>
        <Select value={selected} onValueChange={(url: string | null) => url && setChosen(url)}>
          <SelectTrigger id={addressId} className="w-full min-w-0">
            <SelectValue placeholder="Choose an address" />
          </SelectTrigger>
          <SelectContent>
            {rows.map((url) => (
              <SelectItem key={url} value={url}>
                <span className="truncate">{url}</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {generate}
      <Segmented
        ariaLabel="How the machine joins"
        options={METHOD_OPTIONS}
        value={method}
        onChange={setMethod}
        className="w-full"
      />
      {method === "terminal" ? (
        <div className="space-y-3">
          {/* No paragraph above the command. One used to describe what the script does
              ("installs the node CLI to ~/.local/bin, asks what to call this machine,
              enrolls it, and then asks about the background service…"), and it is GONE
              — operator's call, 2026-09-18. The command is the instruction; the script
              says what it is doing, on the machine, at the moment it does it. Pinned as
              an absence in the dialog's tests so it is not "restored" as an oversight.
              Before the key exists the command shows with `KEY_PENDING_TOKEN` in the
              key slot and copy disabled — the shape is the instruction, the fake token
              is unmistakable, and nothing runs until the mint replaces it. */}
          <CopyCommandRow
            text={installCommandFor(selected, keyText ?? KEY_PENDING_TOKEN, appBaseUrl)}
            label="install command"
            disabled={keyText === null}
          />
          {/* The amber verdict sits with the command it refuses — the panel, not the
              generate slot, is where the operator reads the command and decides. */}
          {missingNote}
          {/* The fallback only reads as a fallback when the one-liner cannot work here,
              which is the verdict `missingNote` states two lines above it. */}
          {hasMissingTargets && (
            <CopyCommandRow
              text={setupCommandFor(selected, keyText ?? KEY_PENDING_TOKEN)}
              label="setup command"
              disabled={keyText === null}
            />
          )}
          {unknownNote}
        </div>
      ) : (
        <div className="space-y-3">
          {/* Step one, stated as a step: nobody is assumed to already have the app.
              The sentence that used to walk someone through opening it is gone
              (operator's call, 2026-09-18), but GETTING it was never such a
              sentence — it is a download, and it comes before the values. */}
          <p className="text-detail text-muted-foreground">
            First,{" "}
            <a
              href={`https://github.com/${SUBSHELL_REPO_SLUG}/releases?q=desktop-client`}
              target="_blank"
              rel="noreferrer"
              className="underline"
            >
              download the Subshell Client app
            </a>
            .
          </p>
          {/* Then the two values, and nothing else. The app cannot be handed a
              command — its Enroll step takes these two — so the rows ARE the rest
              of the instruction.
              Label over value, the line-item shape: two rows, and the button in each
              says out loud which of the two it copies. */}
          <div className="space-y-1">
            <p className="font-strong text-label">Server address</p>
            <CopyCommandRow text={selected} label="server address" />
          </div>
          <div className="space-y-1">
            <p className="font-strong text-label">Setup key</p>
            {/* The placeholder names the one press that fills this row — and the row
                above it was copyable all along, because it needs no key. */}
            {keyText === null ? (
              <p className="text-detail text-muted-foreground">Generate setup key first</p>
            ) : (
              <CopyCommandRow text={keyText} label="setup key" />
            )}
          </div>
        </div>
      )}
    </>
  );
}
