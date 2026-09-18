import { type JSX, useEffect, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { NAME_MAX_DEFAULT } from "@/lib/name-limits";
import { cn } from "@/lib/utils";

/**
 * One line of metadata that edits itself in place: it reads as text, becomes
 * an input on click, saves on Enter or blur, and reverts on Escape or an
 * unchanged value. A blank or over-`maxLength` draft is rejected with an
 * inline error before any request. Shared by the subshell, workspace, and
 * node detail headers, which own their save mutations; tests live beside it.
 */
export function EditableText({
  value,
  label,
  onSave,
  placeholder,
  className,
  inputClassName,
  maxLength = NAME_MAX_DEFAULT,
  maxChars,
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
  /** Reject commits longer than this (post-trim) and cap typing; mirrors the backend rule for this entity, counted in UTF-16 units the way a DOM `maxlength` and a JSON Schema `maxLength` count them */
  maxLength?: number;
  /**
   * The same limit counted in CHARACTERS, for an entity whose rule counts
   * characters — node names, capped by `normalizeNodeName` since 2026-09-17. When
   * set this is what a commit is refused on and what the message names; `maxLength`
   * then only caps what the input will take.
   */
  maxChars?: number;
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
    if (next === value) {
      cancel();
      return;
    }
    // Pre-flight the backend's rules (name-limits) so a rejected value says
    // why in place instead of reverting silently or eating a round-trip.
    // Deliberately `!next` and not "would the backend's normalizer call this empty":
    // emptiness is the ONE rule every entity shares, while a name that trims to
    // something printable but normalizes to nothing (a stray control character) is a
    // per-entity rule, and the entity's own route refuses it — the message lands here
    // anyway, through the rejection below. Importing `normalizeNodeName` into this
    // shared component would have the workspace form refuse by the node's rule.
    if (!next) {
      setError("A name is required");
      return;
    }
    // The cap the ENTITY's rule sets, in the unit that rule counts. `maxLength` is
    // UTF-16 units, which is what a DOM `maxlength` and a JSON Schema `maxLength`
    // count; `maxChars` is code points, for a rule that counts characters — node
    // names since the 2026-09-17 revamp, whose cap `normalizeNodeName` applies to
    // characters. A name within `maxChars` is always within twice its units, so the
    // two never both have an opinion about the same commit.
    if (maxChars !== undefined && [...next].length > maxChars) {
      setError(`Keep it under ${maxChars} characters`);
      return;
    }
    if (next.length > maxLength) {
      setError(`Keep it under ${maxLength} characters`);
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
        maxLength={maxLength}
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
      {error && <span className="shrink-0 text-destructive text-detail">{error}</span>}
    </span>
  );
}
