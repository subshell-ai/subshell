import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";
import { cn } from "../../lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center border border-[var(--border)] text-[var(--frost)] font-semibold cursor-pointer disabled:opacity-50",
  {
    variants: {
      variant: {
        hero: "rounded-xl border border-[var(--orchid)] bg-[var(--orchid)] text-[var(--void)] hover:bg-[#e3a2e8] hover:border-[#e3a2e8]",
        chip: "border rounded-lg bg-[var(--term)] font-mono font-medium hover:text-[var(--frost)]",
        plain: "border rounded-lg bg-[var(--card)] hover:border-[var(--orchid)]",
      },
      size: {
        lg: "text-[14.5px] px-5 py-3",
        sm: "text-[11.5px] px-2.5 py-1",
      },
    },
    defaultVariants: { variant: "plain", size: "sm" },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export function Button({ className, variant, size, ...props }: ButtonProps) {
  return <button className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}
