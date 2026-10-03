// shadcn Card composition with the assistant's spacing and typography tokens.

import { cn } from "@internal/node-admin";
import type { ComponentProps } from "react";

export function Card({ className, ...props }: ComponentProps<"section">) {
  return (
    <section
      data-slot="card"
      className={cn("rounded-lg border border-border bg-card text-foreground shadow-sm", className)}
      {...props}
    />
  );
}
export function CardHeader({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="card-header" className={cn("flex flex-col gap-1 p-4", className)} {...props} />;
}
export function CardTitle({ className, ...props }: ComponentProps<"h2">) {
  return <h2 data-slot="card-title" className={cn("m-0 font-strong text-heading", className)} {...props} />;
}
export function CardDescription({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="card-description" className={cn("text-detail text-muted-foreground", className)} {...props} />;
}
export function CardContent({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="card-content" className={cn("p-4 pt-0", className)} {...props} />;
}
