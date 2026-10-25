import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { Tooltip } from "@base-ui/react/tooltip";
import { cva, type VariantProps } from "class-variance-authority";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { cn } from "../lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md font-strong text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 aria-disabled:cursor-not-allowed aria-disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        // Dreamframe M1: primary buttons are a sunk plum gradient with frost
        // text — deliberately quieter than --primary, which stays bright for
        // links/glows. The five values are palette tokens — the --button-primary-*
        // lines in styles.css.
        default:
          "border-transparent bg-[linear-gradient(135deg,var(--button-primary-from),var(--button-primary-to))] text-[var(--button-primary-foreground)] hover:bg-[linear-gradient(135deg,var(--button-primary-hover-from),var(--button-primary-hover-to))]",
        destructive: "bg-destructive text-destructive-foreground hover:bg-destructive/90",
        outline: "border border-input bg-background hover:bg-accent hover:text-accent-foreground",
        secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        ghost: "hover:bg-accent hover:text-accent-foreground",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2",
        sm: "h-8 rounded-md px-3 text-detail",
        lg: "h-10 rounded-md px-8",
        icon: "h-9 w-9",
        /** Dense icon-only control for toolbars and card corners — the size
            the hand-rolled `h-6 w-6`/`h-7 w-7` overrides converge on. */
        "icon-sm": "h-7 w-7",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

/**
 * Styled button props: Base UI's native-button props — including the
 * polymorphic `render` prop, the Base UI replacement for Radix's `asChild` —
 * plus the cva variant selectors.
 */
export interface ButtonProps extends ButtonPrimitive.Props, VariantProps<typeof buttonVariants> {
  /**
   * Explain the current blocker, including what the user can do about it.
   * A node renders a richer card; pair it with `disabledReasonText` so the
   * accessible description still carries the same sentence.
   */
  disabledReason?: ReactNode;
  /** Plain-text form of a node `disabledReason`, for `aria-description`. */
  disabledReasonText?: string;
}

/**
 * Styled button on Base UI's `Button` primitive. Polymorphism uses
 * `render={<Link/>}` instead of the retired `asChild`-on-Slot idiom; without
 * `render` it stays a real `<button>`.
 */
export function Button({ className, variant, size, ...props }: ButtonProps) {
  return <ExplainedButton className={cn(buttonVariants({ variant, size, className }))} {...props} />;
}

/**
 * Use the same disabled explanation on controls with their own layout.
 * While disabled, suppress activation capture handlers too: they may perform
 * the action themselves. The explanation replaces any native title tooltip.
 */
export function ExplainedButton({
  disabledReason,
  disabledReasonText,
  ...props
}: ButtonPrimitive.Props & { disabledReason?: ReactNode; disabledReasonText?: string }) {
  const reasonId = useId();
  const hasExplanation = useRef(false);
  if (disabledReason !== undefined) hasExplanation.current = true;
  const [open, setOpen] = useState(false);
  const explained = Boolean(props.disabled && disabledReason);
  useEffect(() => {
    if (!explained) setOpen(false);
  }, [explained]);
  const button = (
    <ButtonPrimitive
      data-slot="button"
      {...props}
      aria-describedby={
        [props["aria-describedby"], explained && open ? reasonId : undefined].filter(Boolean).join(" ") || undefined
      }
      aria-description={
        explained
          ? typeof disabledReason === "string"
            ? disabledReason
            : // A node reason without its text twin keeps whatever description
              // the caller wrote, rather than silently dropping it: the visual
              // tooltip renders either way, but the accessible one must not go
              // undefined just because nobody paired a string.
              (disabledReasonText ?? props["aria-description"])
          : props["aria-description"]
      }
      onClickCapture={(event) => {
        if (explained) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        props.onClickCapture?.(event);
      }}
      onKeyDownCapture={(event) => {
        if (explained && (event.key === "Enter" || event.key === " ")) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        props.onKeyDownCapture?.(event);
      }}
      onBlurCapture={(event) => {
        setOpen(false);
        props.onBlurCapture?.(event);
      }}
      onTouchEnd={(event) => {
        props.onTouchEnd?.(event);
        if (explained && !event.defaultPrevented) setOpen((current) => !current);
      }}
      title={explained ? undefined : props.title}
      focusableWhenDisabled={explained || props.focusableWhenDisabled}
    />
  );
  // Closed tooltip stores still subscribe and run effects. Ordinary actions
  // need no explanation, so a control that never carries one renders bare.
  // Once a reason appears the tree stays wrapped, so enabling a control
  // preserves focus and DOM refs; a control whose reason appears only while
  // busy remounts at that flip, which is where a native disabled button
  // used to drop focus anyway.
  if (!hasExplanation.current) return button;

  // Keep the button itself in the layout and tab order. Base UI blocks activation
  // while allowing hover and focus to explain why the action is unavailable.
  return (
    <Tooltip.Provider delay={300}>
      <Tooltip.Root disabled={!explained} open={explained && open} onOpenChange={setOpen}>
        <Tooltip.Trigger render={button} closeOnClick={false} />
        <Tooltip.Portal>
          <Tooltip.Positioner sideOffset={6} className="z-50">
            <Tooltip.Popup
              id={reasonId}
              role="tooltip"
              aria-hidden={!explained || !open}
              className="z-50 max-w-xs rounded-md border bg-popover px-2.5 py-1.5 text-body text-popover-foreground shadow-md"
            >
              {disabledReason}
              <Tooltip.Arrow className="size-2 rotate-45 bg-popover data-[side=bottom]:-top-1 data-[side=left]:-right-1 data-[side=top]:-bottom-1 data-[side=right]:-left-1 data-[side=bottom]:border-t data-[side=left]:border-t data-[side=left]:border-r data-[side=top]:border-r data-[side=right]:border-b data-[side=top]:border-b data-[side=bottom]:border-l data-[side=right]:border-l" />
            </Tooltip.Popup>
          </Tooltip.Positioner>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}

export { buttonVariants };
