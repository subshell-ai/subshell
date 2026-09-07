import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** Dot fills, by what the pill is reporting. */
const DOT_TONES = {
  /** Ordinary progress (uploads in flight) */
  primary: "bg-primary",
  /** Attention without failure (WS reconnecting) */
  warning: "bg-warning",
  /** Live/healthy (running stream) */
  success: "bg-success",
} as const;

/** Tone names accepted by {@link StatusPillProps.tone}. */
export type StatusPillTone = keyof typeof DOT_TONES;

export interface StatusPillProps {
  /** Dot color family; default `primary` */
  tone?: StatusPillTone;
  /** The pill's text — callers own the wording (e2e pins some of it verbatim) */
  children: ReactNode;
  /** Extra classes for callers whose surface is positioned/scaled differently */
  className?: string;
}

/**
 * Small floating overlay pill over a terminal surface: pulsing dot plus a
 * short status line, horizontally centered near the top.
 *
 * The reconnecting notice and the upload-progress indicator were the same
 * floating pill spelled twice with different accents; this is their shared
 * shape (the superset: pointer-events-none so the terminal keeps every
 * gesture, `z-20` so it clears the tiles) with the accent as a `tone` prop.
 */
export function StatusPill({ tone = "primary", children, className }: StatusPillProps) {
  return (
    <div
      className={cn(
        "pointer-events-none absolute top-3 left-1/2 z-20 flex -translate-x-1/2 items-center gap-2 rounded-full border bg-background/90 px-3 py-1 text-muted-foreground text-xs shadow backdrop-blur",
        className,
      )}
    >
      <span className={cn("h-2 w-2 animate-pulse rounded-full", DOT_TONES[tone])} aria-hidden />
      {children}
    </div>
  );
}
