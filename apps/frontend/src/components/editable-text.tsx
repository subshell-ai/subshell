import { type JSX, useEffect, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/**
 * One line of metadata that edits itself in place: it reads as text, becomes
 * an input on click, saves on Enter or blur, and reverts on Escape or an
 * empty value. Shared by the session and workspace detail headers, which own
 * their save mutations; tests live beside it.
 */
export function EditableText({
  value,
  label,
  onSave,
  placeholder,
  className,
  inputClassName,
}: {
  /** The stored value; empty renders the placeholder */
  value: string;
  /** Tooltip explaining the interaction, e.g. "Rename" */
  label: string;
  /** Resolves when saved; a rejection leaves the input open with the error */
  onSave: (next: string) => Promise<void>;
  /** Shown, muted, when there is no value yet */
  placeholder?: string;
  className?: string;
  /** Width and friends for the editing input, which the text class lacks */
  inputClassName?: string;
}): JSX.Element {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // Select the current text so a click lands as "start retyping".
    if (editing) inputRef.current?.select();
  }, [editing]);

  function cancel() {
    setEditing(false);
    setError(null);
  }

  async function commit() {
    const next = draft.trim();
    if (!next || next === value) {
      cancel();
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave(next);
      cancel();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  if (!editing) {
    return (
      <button
        type="button"
        title={label}
        aria-label={label}
        onClick={() => {
          setDraft(value);
          setEditing(true);
        }}
        className={cn(
          "-mx-1 max-w-full cursor-text truncate rounded px-1 text-left transition-colors hover:bg-accent/60",
          !value && "text-muted-foreground",
          className,
        )}
      >
        {value || placeholder}
      </button>
    );
  }

  return (
    <span className="inline-flex min-w-0 items-center gap-2">
      <Input
        ref={inputRef}
        value={draft}
        disabled={saving}
        aria-label={label}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") void commit();
          else if (e.key === "Escape") cancel();
        }}
        // Blur commits, but not while an error is on screen — dismissing it
        // by clicking away must not silently retry the rejected save.
        onBlur={() => {
          if (!error && !saving) void commit();
        }}
        className={cn("h-7", className, inputClassName)}
      />
      {error && <span className="shrink-0 text-destructive text-xs">{error}</span>}
    </span>
  );
}
