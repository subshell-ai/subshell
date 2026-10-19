import { cn, confirmAction } from "@internal/node-admin";
import { SUBSHELL_REPO_SLUG } from "@internal/subshell-protocol";
import { Link, useLocation } from "@tanstack/react-router";
import { LogOut } from "lucide-react";
import { MOBILE_INSTALL_STEPS, PLATFORM_OPTIONS } from "@/components/mobile-install-content";
import { isNavGroup, visibleNavEntries } from "@/components/sidebar/sidebar-nav";
import { signOutAndRedirect } from "@/lib/auth";
import { installPlatformFor } from "@/lib/mobile-install";
import type { SidebarSection } from "@/lib/sidebar-context";

const rowClass = (active: boolean) =>
  cn(
    "flex items-center gap-3 rounded-md px-3 py-2 text-body transition-colors",
    active ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
  );

/** Contextual links reuse the established route roster and its admin gate. */
export function ContextNavigation({
  section,
  isAdmin,
  onAbout,
}: {
  section: SidebarSection;
  isAdmin: boolean;
  onAbout: () => void;
}) {
  const location = useLocation();
  const active = (to: string) =>
    location.pathname === to || (to !== "/settings" && location.pathname.startsWith(`${to}/`));
  if (section === "mobile") {
    const value = new URLSearchParams(location.searchStr).get("platform") ?? installPlatformFor();
    return (
      <nav aria-label="Mobile setup" className="flex flex-col gap-1">
        {PLATFORM_OPTIONS.map(({ value: platform }) => (
          <Link
            key={platform}
            to="/mobile"
            search={{ platform }}
            aria-current={value === platform ? "page" : undefined}
            className={rowClass(value === platform)}
          >
            {MOBILE_INSTALL_STEPS[platform].label}
          </Link>
        ))}
      </nav>
    );
  }
  if (section === "account")
    return (
      <nav aria-label="Account pages" className="flex flex-col gap-1">
        <Link
          to="/account"
          className={rowClass(active("/account"))}
          aria-current={active("/account") ? "page" : undefined}
        >
          Profile
        </Link>
        <Link
          to="/preferences"
          className={rowClass(active("/preferences"))}
          aria-current={active("/preferences") ? "page" : undefined}
        >
          Preferences
        </Link>
        <a
          href={`https://github.com/${SUBSHELL_REPO_SLUG}/issues`}
          target="_blank"
          rel="noreferrer"
          className={rowClass(false)}
        >
          Feedback
        </a>
        <button type="button" className={rowClass(false)} onClick={onAbout}>
          About
        </button>
        <button
          type="button"
          className={cn(rowClass(false), "mt-3 text-destructive hover:text-destructive")}
          onClick={async () => {
            const confirmed = await confirmAction({
              title: "Sign out?",
              description: "You’ll need to sign in again to access this server. Your subshells will keep running.",
              confirmLabel: "Sign out",
              danger: true,
            });
            if (confirmed) await signOutAndRedirect();
          }}
        >
          <LogOut className="size-4 shrink-0" /> Sign out
        </button>
      </nav>
    );
  return (
    <nav aria-label="Settings pages" className="flex flex-col gap-4">
      {visibleNavEntries(isAdmin).map((entry) => {
        if (isNavGroup(entry)) {
          if (section !== "settings") return null;
          return (
            <section key={entry.id} className="flex flex-col gap-1">
              <h3 className="px-3 py-1 text-detail text-muted-foreground">
                {entry.id === "personal-settings" ? "Personal" : entry.label}
              </h3>
              {entry.children.map((item) => (
                <Link
                  key={item.to}
                  to={item.to as never}
                  className={rowClass(active(item.to))}
                  aria-current={active(item.to) ? "page" : undefined}
                >
                  <item.icon className="size-4 shrink-0" />
                  {item.label}
                </Link>
              ))}
            </section>
          );
        }
        return null;
      })}
    </nav>
  );
}
