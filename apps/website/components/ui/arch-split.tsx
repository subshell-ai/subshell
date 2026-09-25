"use client";

import { useEffect, useRef, useState } from "react";

export interface ArchOption<K extends string> {
  key: K;
  label: string;
}

/**
 * The VS Code / Rust-style architecture split: one control, two jobs. The
 * wide half is the download itself (a plain anchor — selection already
 * decided its href), the narrow half is a `menu` of `menuitemradio` rows
 * that chooses WHICH build that anchor carries.
 *
 * Keyboard follows the menu-button convention, not a bespoke one: ArrowDown
 * from the chevron opens onto the current selection, arrows walk and wrap,
 * Escape closes and returns focus to the chevron, and a pointerdown anywhere
 * outside the control closes it. The menu is not rendered while closed —
 * nothing is focusable or announced that the visitor did not ask for.
 *
 * Styling is the hero button's, split across the two halves: the site's own
 * orchid-on-void idiom, no new colors.
 */
export function ArchSplitButton<K extends string>({
  label,
  href,
  options,
  selected,
  onSelect,
}: {
  label: string;
  href: string;
  options: readonly ArchOption<K>[];
  selected: K;
  onSelect: (key: K) => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  const chevronRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef(new Map<K, HTMLButtonElement>());

  // Opening focuses the current selection (the row a keyboard visitor would
  // re-pick is the one under the cursor already). Re-opening re-runs this,
  // so a previous ArrowDown excursion never persists as the focus point.
  useEffect(() => {
    if (open) itemRefs.current.get(selected)?.focus();
  }, [open, selected]);

  useEffect(() => {
    if (!open) return;
    // `pointerdown` not `click`: the closing tap must not also activate
    // whatever it lands on, and it fires before any click could.
    const away = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);

  const close = (refocusChevron: boolean) => {
    setOpen(false);
    if (refocusChevron) chevronRef.current?.focus();
  };

  const focusedIndex = () => {
    const active = document.activeElement;
    const key = active instanceof HTMLElement ? (active.dataset.key ?? "") : "";
    return options.findIndex((o) => o.key === key);
  };
  const focusItem = (index: number) => {
    const wrap = (i: number) => (i + options.length) % options.length;
    const option = options[wrap(index)];
    if (option) itemRefs.current.get(option.key)?.focus();
  };

  const onItemKeyDown = (event: React.KeyboardEvent) => {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        focusItem(focusedIndex() + 1);
        break;
      case "ArrowUp":
        event.preventDefault();
        focusItem(focusedIndex() - 1);
        break;
      case "Escape":
        event.preventDefault();
        close(true);
        break;
    }
  };

  const shell = "text-[14.5px] font-semibold text-[var(--void)] bg-[var(--orchid)] hover:bg-[#e3a2e8]";
  return (
    <span ref={root} className="relative inline-flex w-fit items-stretch rounded-xl border border-[var(--orchid)]">
      <a href={href} className={`${shell} rounded-l-xl px-5 py-3`}>
        {label}
      </a>
      <button
        ref={chevronRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Choose which Mac build"
        onClick={() => setOpen((was) => !was)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
            // Enter/Space already reach onClick on a button; only ArrowDown
            // needs turning into "open" here, but claiming them keeps the
            // menu opening from the keyboard on engines with odd defaults.
            event.preventDefault();
            setOpen(true);
          } else if (event.key === "Escape") {
            setOpen(false);
          }
        }}
        className={`${shell} rounded-r-xl border-l border-[rgba(54,11,60,.35)] px-2.5`}
      >
        <span aria-hidden className="text-[11px]">
          ▼
        </span>
      </button>
      {open && (
        <span
          role="menu"
          aria-label="Mac build"
          onKeyDown={(event) => {
            // On the container, not only the rows: a focused row's Escape
            // arrives by bubbling, and this is the one handler that must
            // answer even if focus somehow rests on the menu itself.
            if (event.key === "Escape") {
              event.preventDefault();
              close(true);
            }
          }}
          className="absolute left-0 top-full z-10 mt-1.5 flex min-w-full flex-col rounded-[10px] border border-[var(--border)] bg-[var(--card)] p-1"
        >
          {options.map((option) => (
            <button
              key={option.key}
              type="button"
              role="menuitemradio"
              aria-checked={option.key === selected}
              data-key={option.key}
              ref={(el) => {
                if (el) itemRefs.current.set(option.key, el);
                else itemRefs.current.delete(option.key);
              }}
              onClick={() => {
                onSelect(option.key);
                close(true);
              }}
              onKeyDown={onItemKeyDown}
              className={`cursor-pointer whitespace-nowrap rounded-md px-3 py-1.5 text-left text-[13px] hover:bg-[var(--term)] ${
                option.key === selected ? "text-[var(--orchid)]" : "text-[var(--frost)]"
              }`}
            >
              {option.label}
            </button>
          ))}
        </span>
      )}
    </span>
  );
}
