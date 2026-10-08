import { cn } from "@internal/node-admin";
import { SUBSHELL_REPO_SLUG } from "@internal/subshell-protocol";
import { ArrowUpCircle, ChevronDown, Info, LogOut, MessageSquare, SlidersHorizontal, UserRound } from "lucide-react";
import type { JSX } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/**
 * The signed-in user menu (spec 2026-09-02 settings-split §3) — replaces the
 * bare Logout button: identity on the trigger, Account settings + Sign out in
 * the menu. Props-only: the sidebar owns the queries and what the actions
 * mean. Collapsed rails get an initials avatar; expanded rails get the full
 * identity row. The card now sits in the rail header (spec 2026-10-07), and
 * the version/instance line folds in what the browser footer's version row
 * used to say.
 */

/** One-letter avatar: name initial, else email initial, "?" while neither.
 * Array.from, not [0] — the first CHARACTER, never a lone surrogate half. */
export function initialsOf(name: string, email: string): string {
  const c = Array.from(name.trim())[0] ?? Array.from(email.trim())[0];
  return c ? c.toUpperCase() : "?";
}

export interface UserMenuProps {
  /** Signed-in user's display name (may be empty) */
  name: string;
  /** Signed-in user's email; "" while the identity query resolves — the
   * loading placeholder ("Signed in") is THIS component's decision, not the
   * caller's, so the string never masquerades as an address in the header. */
  email: string;
  /** Icon-only trigger for the collapsed rail */
  collapsed: boolean;
  /** The server's version from public settings; "" until the read lands, and
   * the version line renders only when something can fill it. */
  serverVersion?: string;
  /** The instance name from public settings; "" while unresolved. It rides
   * the same line as the version - the rail's old instance-name row folded
   * in here (spec 2026-10-07 §B). */
  instanceName?: string;
  /** The newer server version, when one is published AND the server says this
   * viewer is an admin. null renders neither the avatar dot nor the menu row;
   * the gate lives in the caller, which fetches admin data for admins only. */
  updateNotice?: string | null;
  /** Where the update row leads. Absent renders no row even with a notice. */
  onOpenUpdates?: () => void;
  /** Opens the preferences surface (app-global + this-device controls) */
  onPreferences: () => void;
  /** Opens the account surface (routing belongs to the caller) */
  onAccountSettings: () => void;
  /** Opens the About dialog — no admin gate; anyone may ask what this is */
  onAbout: () => void;
  /** Runs sign-out */
  onSignOut: () => void;
}

export function UserMenu({
  name,
  email,
  collapsed,
  serverVersion = "",
  instanceName = "",
  updateNotice = null,
  onOpenUpdates,
  onPreferences,
  onAccountSettings,
  onAbout,
  onSignOut,
}: UserMenuProps): JSX.Element {
  const display = name.trim() || email || "Signed in";
  // The server fact and the plane's name share one detail line. Either can be
  // pending while the other has landed, so empty parts drop and the joined
  // line never carries a stray separator.
  const versionLine = [serverVersion !== "" ? `Subshell Server ${serverVersion}` : "", instanceName]
    .filter((part) => part !== "")
    .join(" · ");
  const avatar = (
    <span
      aria-hidden
      className="relative flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/15 font-strong text-detail text-primary"
    >
      {initialsOf(name, email)}
      {/* The version row's marker keeps its status-light life (spec
          2026-10-07 §B): on the face of the trigger, no menu to open, no
          off switch - and collapsed rails included, since the dot is part
          of the avatar. `bg-warning`: the same amber the whole app marks
          "newer exists" with. */}
      {updateNotice !== null && (
        <span className="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-warning ring-2 ring-card" />
      )}
    </span>
  );
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            aria-label={`Account: ${display}`}
            title={collapsed ? `Account: ${display}` : undefined}
            className={cn(
              "flex items-center rounded-md text-muted-foreground text-sm transition-colors hover:bg-accent/50 hover:text-foreground",
              collapsed ? "justify-center p-2" : "w-full justify-start gap-2 p-2",
            )}
          />
        }
      >
        {avatar}
        {!collapsed && (
          <>
            <span className="min-w-0 flex-1 truncate text-left">{display}</span>
            <ChevronDown className="h-4 w-4 shrink-0 opacity-50" />
          </>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="bottom" className="w-56">
        <div className="px-2 py-1.5">
          <p className="truncate font-strong text-sm">{name.trim() || (email ? "(no name)" : "Signed in")}</p>
          {email ? <p className="truncate text-detail text-muted-foreground">{email}</p> : null}
          {versionLine !== "" && <p className="truncate text-detail text-muted-foreground">{versionLine}</p>}
        </div>
        {updateNotice !== null && onOpenUpdates !== undefined && (
          <DropdownMenuItem onSelect={onOpenUpdates}>
            <ArrowUpCircle className="h-4 w-4 text-warning" /> Update available: v{updateNotice}
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onPreferences}>
          <SlidersHorizontal className="h-4 w-4" /> Preferences
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onAccountSettings}>
          <UserRound className="h-4 w-4" /> Account settings
        </DropdownMenuItem>
        {/* Feedback lands on the project's GitHub issue list, so this row IS
            that link — not an in-app form, not mailto. A real anchor with
            `target="_blank"`: in a browser tab it opens beside the app, and in
            a desktop shell's webview `lib/desktop-links.ts` intercepts exactly
            this markup and hands the URL to the system browser. Above About
            because both explain the product — one to its authors, one to
            anyone. */}
        <DropdownMenuItem
          render={<a href={`https://github.com/${SUBSHELL_REPO_SLUG}/issues`} target="_blank" rel="noreferrer" />}
          nativeButton={false}
        >
          <MessageSquare className="h-4 w-4" /> Feedback
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onAbout}>
          <Info className="h-4 w-4" /> About Subshell
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {/* Destructive styling via className — this wrapper has no Radix-style
            `variant` prop (see actions-menu.tsx for the same idiom). */}
        <DropdownMenuItem className="text-destructive data-highlighted:text-destructive" onSelect={onSignOut}>
          <LogOut className="h-4 w-4" /> Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
