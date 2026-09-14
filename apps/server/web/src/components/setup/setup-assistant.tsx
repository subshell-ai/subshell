import { type ReactNode, useEffect } from "react";
import { StepDots } from "@/components/setup/step-dots";
import { Button } from "@/components/ui/button";

export interface SetupAssistantProps {
  /**
   * Art on a 96px floor: a lucide icon element, or an <img> sized by height.
   *
   * OPTIONAL, and every `/setup` screen now omits it. The three that had one
   * opened with a 72px outline — a key, a bot, a rocket — above a heading
   * that said the same thing in words, and the box cost 124px (a 96px floor
   * plus its margin) of a frame a person meets on a laptop. Decorative by
   * construction: the wrapper is `aria-hidden`, so nothing was announced and
   * nothing was lost. The prop stays because the frame is one specification
   * with the native assistant, whose Welcome screen still carries the
   * wordmark — that art is the product naming itself, which is work.
   */
  illustration?: ReactNode;
  title: string;
  subtitle?: string;
  dots: { total: number; done: number; current: number };
  /** Ghost button, left. Absent = hidden. */
  back?: { label?: string; onClick: () => void };
  /** Ghost button left of the primary. */
  skip?: { label: string; onClick: () => void; disabled?: boolean };
  primary: { label: string; onClick: () => void; disabled?: boolean; pending?: boolean; pendingLabel?: string };
  /**
   * Muted text left of the primary (a disabled reason). No `/setup` caller
   * passes this today - it exists for parity with the native assistant's
   * `.reason` span, which IS used there ("Waiting for tmux"). Keep it: the
   * two frames are one specification, and a future SPA screen with its own
   * disabled reason should have somewhere to put it without re-adding this.
   */
  reason?: string;
  children?: ReactNode;
}

/**
 * The setup assistant's frame (spec 2026-09-11 § 3): a 560px column under its
 * art, centered both ways, and a 72px bar with Back left, dots center,
 * Continue right. Every /setup screen renders inside it; the native app
 * renders the same frame in its own page, so the two read as one program.
 *
 * `justify-center-safe` rather than plain centering: a screen taller than the
 * frame would otherwise overflow past the TOP edge, where a scroll container
 * cannot reach it.
 */
export function SetupAssistant({
  illustration,
  title,
  subtitle,
  dots,
  back,
  skip,
  primary,
  reason,
  children,
}: SetupAssistantProps) {
  const primaryDisabled = primary.disabled || primary.pending;
  useEffect(() => {
    // Enter is Continue, unless the person is in a textarea, on a button, or the primary is disabled.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Enter" || primaryDisabled) return;
      if (e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLButtonElement) return;
      e.preventDefault();
      primary.onClick();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [primary, primaryDisabled]);

  return (
    <div className="grid h-dvh grid-rows-[1fr_72px] bg-background text-foreground">
      <main className="assistant-enter justify-center-safe flex flex-col items-center overflow-auto p-8">
        {/* Rendered only when there IS art: an empty box still reserves its
            floor and margin, which is the 124px this exists to stop spending. */}
        {illustration && (
          <div
            aria-hidden
            className="mb-7 flex min-h-24 items-center justify-center text-primary/55 [&_img]:h-16 [&_img]:w-auto [&_svg]:size-[72px]"
          >
            {illustration}
          </div>
        )}
        <h1 aria-live="polite" className="text-center font-strong text-display tracking-[-0.01em]">
          {title}
        </h1>
        {subtitle && (
          <p className="mt-2 max-w-[560px] text-center text-body text-muted-foreground leading-[1.55]">{subtitle}</p>
        )}
        {children && <section className="mt-9 w-full max-w-[560px]">{children}</section>}
      </main>
      <footer className="grid grid-cols-[1fr_auto_1fr] items-center border-t px-8">
        <div className="flex gap-2">
          {back && (
            <Button variant="ghost" onClick={back.onClick}>
              {back.label ?? "Back"}
            </Button>
          )}
        </div>
        <StepDots {...dots} />
        <div className="flex items-center justify-end gap-2">
          {reason && primaryDisabled && <span className="text-detail text-muted-foreground">{reason}</span>}
          {skip && (
            <Button variant="ghost" onClick={skip.onClick} disabled={skip.disabled}>
              {skip.label}
            </Button>
          )}
          <Button className="min-w-[120px]" onClick={primary.onClick} disabled={primaryDisabled}>
            {primary.pending ? (primary.pendingLabel ?? primary.label) : primary.label}
          </Button>
        </div>
      </footer>
    </div>
  );
}
