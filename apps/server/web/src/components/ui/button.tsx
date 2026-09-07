import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md font-medium text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        // Dreamframe M1: primary buttons are a sunk plum gradient with frost
        // text — deliberately quieter than --primary, which stays bright for
        // links/glows. Gradient can't ride the color token, so it lives here.
        default:
          "border-transparent bg-[linear-gradient(135deg,oklch(0.34_0.10_322),oklch(0.40_0.10_340))] text-[oklch(0.90_0.05_320)] hover:bg-[linear-gradient(135deg,oklch(0.40_0.11_322),oklch(0.46_0.11_340))]",
        destructive: "bg-destructive text-destructive-foreground hover:bg-destructive/90",
        outline: "border border-input bg-background hover:bg-accent hover:text-accent-foreground",
        secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        ghost: "hover:bg-accent hover:text-accent-foreground",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2",
        sm: "h-8 rounded-md px-3 text-xs",
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
export interface ButtonProps extends ButtonPrimitive.Props, VariantProps<typeof buttonVariants> {}

/**
 * Styled button on Base UI's `Button` primitive. Polymorphism uses
 * `render={<Link/>}` instead of the retired `asChild`-on-Slot idiom; without
 * `render` it stays a real `<button>`.
 */
export function Button({ className, variant, size, ...props }: ButtonProps) {
  return <ButtonPrimitive data-slot="button" className={cn(buttonVariants({ variant, size, className }))} {...props} />;
}

export { buttonVariants };
