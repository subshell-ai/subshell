// shadcn Field composition, scoped to the assistant's current form needs and type roles.
import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/cn";

export function FieldSet({ className, ...props }: ComponentProps<"fieldset">) {
  return <fieldset data-slot="field-set" className={cn("flex flex-col gap-3", className)} {...props} />;
}

export function FieldLegend({ className, ...props }: ComponentProps<"legend">) {
  return <legend data-slot="field-legend" className={cn("mb-2 font-strong text-label", className)} {...props} />;
}

const fieldVariants = cva("group/field flex w-full gap-2 data-[invalid=true]:text-destructive", {
  variants: {
    orientation: {
      vertical: "flex-col",
      horizontal: "flex-row items-center",
    },
  },
  defaultVariants: { orientation: "vertical" },
});

export function Field({
  className,
  orientation = "vertical",
  ...props
}: ComponentProps<"div"> & VariantProps<typeof fieldVariants>) {
  return (
    <div
      data-slot="field"
      data-orientation={orientation}
      className={cn(fieldVariants({ orientation }), className)}
      {...props}
    />
  );
}

export function FieldLabel({ className, ...props }: ComponentProps<typeof Label>) {
  return (
    <Label
      data-slot="field-label"
      className={cn("mb-0 flex w-fit gap-2 group-data-[disabled=true]/field:opacity-50", className)}
      {...props}
    />
  );
}
