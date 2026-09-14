import { ChevronUp, Info, LogOut, SlidersHorizontal, UserRound } from "lucide-react";
import type { JSX } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

/**
 * The signed-in user menu (spec 2026-09-02 settings-split §3) — replaces the
 * bare Logout button: identity on the trigger, Account settings + Sign out in
 * the menu. Props-only: the sidebar owns the queries and what the actions
 * mean. Collapsed rails get an initials avatar; expanded rails get the full
 * identity row.
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
  onPreferences,
  onAccountSettings,
  onAbout,
  onSignOut,
}: UserMenuProps): JSX.Element {
  const display = name.trim() || email || "Signed in";
  const avatar = (
    <span
      aria-hidden
      className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/15 font-semibold text-caption text-primary"
    >
      {initialsOf(name, email)}
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
            <ChevronUp className="h-4 w-4 shrink-0 opacity-50" />
          </>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" className="w-56">
        <div className="px-2 py-1.5">
          <p className="truncate font-medium text-sm">{name.trim() || (email ? "(no name)" : "Signed in")}</p>
          {email ? <p className="truncate text-muted-foreground text-xs">{email}</p> : null}
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onPreferences}>
          <SlidersHorizontal className="h-4 w-4" /> Preferences
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onAccountSettings}>
          <UserRound className="h-4 w-4" /> Account settings
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
