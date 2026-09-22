/**
 * The assistants' shared rail (spec 2026-09-21): the sidebar of standing
 * options, presentational only. Each app passes its own sections and decides
 * what a select does; this renders the list and the active state, nothing
 * more — the same split as `Frame`.
 *
 * The look is the SPA sidebar's (`apps/server/web/src/components/app-sidebar.tsx`):
 * a fixed 200px column, rounded items, muted-until-hover labels, and the
 * active item in the nav gradient with strong type. That gradient is the one
 * token this primitive names that is not a universal role —
 * `--nav-active-from` / `--nav-active-to` — and each app's stylesheet carries
 * them, value for value with the SPA's, the way `--button-primary-*` rides
 * under the shadcn `Button`. A stylesheet without them renders no gradient
 * rather than a wrong one.
 *
 * `aria-current` is a boolean, not `"page"`: these are buttons, not links,
 * and `true` is what a button that IS the current view asserts
 * (`workspace-tabs.tsx`'s idiom).
 */
export interface RailSection {
  /** The section's route id — the caller's vocabulary, passed back on select. */
  id: string;
  /** The line the person reads. The only copy this component renders. */
  label: string;
}

const ITEM = "flex w-full cursor-pointer items-center rounded-md px-3 py-2 text-label transition-colors text-left";
const ACTIVE = `${ITEM} bg-[linear-gradient(90deg,var(--nav-active-from),var(--nav-active-to))] font-strong text-accent-foreground`;
const IDLE = `${ITEM} text-muted-foreground hover:bg-accent/50 hover:text-accent-foreground`;

export function Rail(props: {
  /** The standing sections, in display order. */
  sections: RailSection[];
  /** The active section's id, or null for no active state at all. */
  active: string | null;
  /** Select. The id comes back unchanged. */
  onSelect: (id: string) => void;
}): React.ReactElement {
  return (
    <nav aria-label="Main" className="flex w-[200px] shrink-0 flex-col gap-1 border-border border-r p-2">
      {props.sections.map((section) => (
        <button
          key={section.id}
          type="button"
          aria-current={props.active === section.id}
          className={props.active === section.id ? ACTIVE : IDLE}
          onClick={() => props.onSelect(section.id)}
        >
          {section.label}
        </button>
      ))}
    </nav>
  );
}
