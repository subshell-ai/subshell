/**
 * The enrollment form: a URL, a one-time key, and an optional name.
 *
 * Stacked rather than gridded because a URL and a setup key are both long
 * enough that two columns truncate the one value a user most needs to eyeball
 * before spending it.
 */
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { EnrollForm } from "@/hooks/use-enroll-form";
import { cn } from "@/lib/cn";
import { ENROLL_FIELDS, LOOPBACK_NOTE } from "@/lib/copy";
import { isLoopback } from "@/lib/steps";

export function EnrollFields({ form, busy }: { form: EnrollForm; busy: boolean }) {
  return (
    <div className="mt-3.5 grid gap-3">
      {ENROLL_FIELDS.map((field) => {
        const error = form.errors[field.name];
        // A warning, never a block: running the control plane and a node on one
        // box is exactly what the desktop pair exists for. Said here as well as
        // in the Rust side's confirmation, because that one arrives after the
        // key has already been pasted.
        const advisory = field.name === "server" && !error && isLoopback(form.values.server) ? LOOPBACK_NOTE : "";
        const note = error || advisory;
        return (
          <div key={field.name}>
            <Label htmlFor={`field-${field.name}`} className="mb-1 block text-muted-foreground text-xs">
              {field.label}
            </Label>
            <Input
              id={`field-${field.name}`}
              type="text"
              value={form.values[field.name]}
              placeholder={field.placeholder}
              disabled={busy}
              onChange={(event) => form.setField(field.name, event.target.value)}
              // A setup key and a URL are both pasted, never dictated:
              // autocorrect on either turns a working credential into a support
              // question. The key is deliberately NOT masked — it is
              // single-use, 24-hour, and cleared on success, and seeing that a
              // paste landed whole is worth more here than hiding it from the
              // room.
              spellCheck={false}
              autoCapitalize="off"
              autoComplete="off"
              autoCorrect="off"
            />
            {note && (
              <p className={cn("mt-1 text-caption leading-normal", error ? "text-destructive" : "text-warning")}>
                {note}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}
