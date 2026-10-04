// shadcn Alert composition; warnings use the shared semantic warning token.
import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "@/lib/cn";

const alertVariants = cva(
  "grid gap-1 rounded-lg border p-4 text-body has-[>svg]:grid-cols-[auto_1fr] has-[>svg]:gap-x-3 [&>svg]:row-span-2 [&>svg]:size-4 [&>svg]:mt-1",
  {
    variants: {
      variant: { default: "bg-card text-foreground", warning: "border-warning/40 bg-warning/5 text-warning" },
    },
    defaultVariants: { variant: "default" },
  },
);
export function Alert({ className, variant, ...props }: ComponentProps<"div"> & VariantProps<typeof alertVariants>) {
  return <div data-slot="alert" role="alert" className={cn(alertVariants({ variant }), className)} {...props} />;
}
export function AlertTitle({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="alert-title" className={cn("text-label font-strong", className)} {...props} />;
}
export function AlertDescription({ className, ...props }: ComponentProps<"div">) {
  return (
    <div data-slot="alert-description" className={cn("text-detail text-muted-foreground", className)} {...props} />
  );
}
