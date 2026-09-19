import { cn } from "@internal/node-admin";

/**
 * The assistant's progress: dots, not steps. Not interactive on purpose (the
 * old text rail read as breadcrumbs people tried to click); the step is
 * named for screen readers beside them.
 */
export function StepDots({ total, done, current }: { total: number; done: number; current: number }) {
  return (
    <div className="flex items-center gap-2.5">
      <span aria-hidden className="flex items-center gap-2.5">
        {Array.from({ length: total }, (_, i) => {
          const state = i === current ? "current" : i < done ? "done" : "upcoming";
          return (
            <i
              // biome-ignore lint/suspicious/noArrayIndexKey: a dot's position is its identity — total is fixed per render
              key={i}
              data-dot={state}
              className={cn(
                "block rounded-full",
                state === "current" ? "size-2.5 bg-primary" : "size-2",
                state === "done" && "bg-primary",
                state === "upcoming" && "bg-border",
              )}
            />
          );
        })}
      </span>
      <span className="sr-only">
        Step {current + 1} of {total}
      </span>
    </div>
  );
}
