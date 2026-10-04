import { cn } from "@internal/node-admin";
import type { ComponentProps } from "react";

export function FieldGroup({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("flex flex-col gap-6", className)} {...props} />;
}

export function Field({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("flex flex-col gap-2", className)} {...props} />;
}

export function FieldLabel({ className, htmlFor, children, ...props }: ComponentProps<"label">) {
  return (
    <label htmlFor={htmlFor} className={cn("text-body text-foreground", className)} {...props}>
      {children}
    </label>
  );
}
