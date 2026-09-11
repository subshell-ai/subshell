import { type ReactNode, useEffect } from "react";
import { StepDots } from "@/components/setup/step-dots";
import { Button } from "@/components/ui/button";

export interface SetupAssistantProps {
  /** 96px art: a lucide icon element or an <img>. */
  illustration: ReactNode;
  title: string;
  subtitle?: string;
  dots: { total: number; done: number; current: number };
  /** Ghost button, left. Absent = hidden. */
  back?: { label?: string; onClick: () => void };
  /** Ghost button left of the primary. */
  skip?: { label: string; onClick: () => void; disabled?: boolean };
  primary: { label: string; onClick: () => void; disabled?: boolean; pending?: boolean; pendingLabel?: string };
  /** Muted text left of the primary (a disabled reason). */
  reason?: string;
  children?: ReactNode;
}

/**
 * The setup assistant's frame (spec 2026-09-11 § 3): a centered 560px column
 * under 96px of art, and a 72px bar with Back left, dots center, Continue
 * right. Every /setup screen renders inside it; the native app renders the
 * same frame in its own page, so the two read as one program.
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
      <main className="assistant-enter flex flex-col items-center overflow-auto px-8 pt-24 pb-6">
        <div
          aria-hidden
          className="mb-7 flex size-24 items-center justify-center text-primary/55 [&_img]:size-24 [&_svg]:size-[72px]"
        >
          {illustration}
        </div>
        <h1 className="text-center font-semibold text-[30px] tracking-[-0.01em]">{title}</h1>
        {subtitle && (
          <p className="mt-2 max-w-[560px] text-center text-[15px] text-muted-foreground leading-relaxed">{subtitle}</p>
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
        <div className="flex items-center justify-end gap-3">
          {reason && primaryDisabled && <span className="text-[13px] text-muted-foreground">{reason}</span>}
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
