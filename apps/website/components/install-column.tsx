"use client";

import { useEffect, useRef, useState } from "react";
import { installCopy } from "../lib/install";
import { detectIsMac, refreshReleasesHost } from "../lib/install-client";
import type { ReleasesManifest } from "../lib/releases";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";

export function InstallColumn({ manifest: initial }: { manifest: ReleasesManifest }) {
  const [manifest, setManifest] = useState(initial);
  const [isMac, setIsMac] = useState(true);
  const [kind, setKind] = useState<"server" | "client">("server");
  const [copied, setCopied] = useState(false);
  // The "Copied" reset timer, held so a re-click clears the pending reset
  // instead of racing it, and unmount clears it instead of calling setState
  // on a dead component.
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The refresh is a once-on-mount swap of the baked manifest for the live
  // one; `manifest` is read only as the fallback, so it is deliberately not a
  // dependency (listing it refetches every time the state it sets changes).
  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh exactly once on mount
  useEffect(() => {
    setIsMac(detectIsMac(navigator.userAgent, navigator.platform));
    void refreshReleasesHost(manifest).then(setManifest);
    return () => {
      if (copyTimer.current !== null) clearTimeout(copyTimer.current);
    };
  }, []);

  const copy = installCopy(manifest, kind, isMac);
  const why =
    kind === "server" ? (
      <>
        Downloads the CLI for your platform, verifies its SHA-256, installs to <code>~/.local/bin/subshell-server</code>
        , runs <code>init</code>.
      </>
    ) : (
      "Downloads Subshell Client for your platform, verifies its SHA-256, and sets it up to watch and run sessions."
    );
  // The two small headings answer "which of these is the app and which is
  // the CLI", the question the cards used to leave unasked (operator
  // observation, 2026-09-25). Same voice as the h2, one size down.
  const headingClass = "mb-1.5 font-mono text-[11px] uppercase tracking-[.14em] text-[var(--dimmer)]";

  return (
    <div className="min-w-0">
      <h2 className="mb-3.5 font-mono text-[13px] font-medium uppercase tracking-[.12em] text-[var(--dimmer)]">
        Install
      </h2>
      {/* A `fieldset`, not a `div role="group"`: what the a11y linter prescribes,
          the same call tmux-step.tsx made; preflight zeroes its default chrome. */}
      <fieldset aria-label="Which component to install" className="mb-3 flex gap-1.5">
        <Button
          variant="chip"
          size="sm"
          aria-pressed={kind === "server"}
          onClick={() => setKind("server")}
          // px-3/rounded-[7px] are the concept's chip metrics, and h-[25px]
          // pins the chip's MEASURED concept height (15px JetBrains Mono line
          // + 4px pad + 1px border, top and bottom). Line-height alone cannot
          // get there: Chrome gives this button an 18.4px content box whatever
          // its computed line-height says (measured against the concept page's
          // 25px box), and the +3.4px pushed the curl row +2.9px off the fold,
          // past the 1px landmark rule.
          className={cn(
            "px-3 rounded-[7px] h-[25px]",
            kind === "server" && "border-[rgba(217,139,224,.5)] bg-[rgba(217,139,224,.07)] !text-[var(--orchid)]",
          )}
        >
          server
        </Button>
        <Button
          variant="chip"
          size="sm"
          aria-pressed={kind === "client"}
          onClick={() => setKind("client")}
          className={cn(
            "px-3 rounded-[7px] h-[25px]",
            kind === "client" && "border-[rgba(217,139,224,.5)] bg-[rgba(217,139,224,.07)] !text-[var(--orchid)]",
          )}
        >
          client
        </Button>
      </fieldset>
      <p className={headingClass}>{copy.appHeading}</p>
      <a
        href={copy.downloadHref}
        className="block w-fit rounded-xl border border-[var(--orchid)] bg-[var(--orchid)] px-5 py-3 text-[14.5px] font-semibold text-[var(--void)] hover:bg-[#e3a2e8]"
      >
        <span suppressHydrationWarning>{copy.downloadLabel}</span>
      </a>
      {/* The artifact's name names what the button above downloads, so it
          sits under that button (operator observation, 2026-09-25); printed
          in the small print below the curl row, it read as if the CLI
          one-liner installed the .deb. */}
      {copy.artifactFile !== null && (
        <p className="mt-2">
          <code className="font-mono text-[11.5px] text-[var(--dimmer)]">
            <span suppressHydrationWarning>{copy.artifactFile}</span>
          </code>
        </p>
      )}
      <p className="mt-3 text-[13.5px] text-[var(--dim)]">
        or{" "}
        <a className="text-[var(--frost)] underline-offset-2 hover:text-[var(--orchid)]" href={copy.altHref}>
          <span suppressHydrationWarning>{copy.altLabel}</span>
        </a>
      </p>
      {copy.curlCommand !== null && (
        <>
          <p className={`${headingClass} mt-[18px]`}>{copy.curlHeading}</p>
          <div className="flex max-w-[440px] items-center gap-2.5 rounded-[10px] border border-[var(--border)] bg-[var(--term)] px-3 py-2.5">
            <span className="font-mono text-[var(--orchid)]">$</span>
            {/* Truncate only in the three-column spread: under 980 the concept
              WRAPS the one-liner; ellipsising it on a phone hides the command
              a visitor is there to copy. */}
            <code className="min-w-0 flex-1 truncate font-mono text-[11.5px] max-[980px]:overflow-visible max-[980px]:whitespace-normal max-[980px]:break-all">
              {copy.curlCommand}
            </code>
            <Button
              variant="plain"
              size="sm"
              className={cn("rounded-[7px]", copied && "!text-[var(--orchid)]")}
              onClick={() => {
                void navigator.clipboard.writeText(copy.curlCommand ?? "");
                setCopied(true);
                if (copyTimer.current !== null) clearTimeout(copyTimer.current);
                copyTimer.current = setTimeout(() => setCopied(false), 1600);
              }}
            >
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
        </>
      )}
      <p className="mt-3 max-w-[36ch] text-[12px] text-[var(--dimmer)]">
        macOS 13+ on Apple silicon · Linux x86_64 Ubuntu 24.04+ / Debian 13+
      </p>
      <p className="mt-2.5 max-w-[38ch] text-[12px] text-[var(--dimmer)]">{why}</p>
    </div>
  );
}
