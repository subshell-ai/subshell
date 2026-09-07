import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Merge Tailwind classes with conditional variants (shadcn/ui convention).
 *
 * The same function as `apps/server/web/src/lib/utils.ts` — copied for the same
 * reason the primitives under `components/ui/` are, so extracting the set into
 * a shared package later is a straight move.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
