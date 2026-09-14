import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

export interface PluginIconProps {
  /** Plugin id — this is what names the image route */
  pluginId: string;
  /** The plugin's display name; its first character is the fallback monogram */
  name?: string;
  /**
   * The plugin's declared icon path, straight off the catalog row. Only its
   * PRESENCE is read — the URL is derived from the id — so a plugin that
   * declares none renders the monogram without a request that would 404.
   */
  icon?: string | undefined;
  className?: string;
}

/**
 * A plugin's mark, or a monogram when it has none.
 *
 * The image is fetched from `/api/plugins/<id>/icon` rather than carried in
 * the catalog row: these are real files inside the plugin packages (a vendor's
 * own SVG, or a PNG), and a row that inlined them would put tens of kilobytes
 * of base64 into every list read.
 *
 * `<img>` and never inline SVG. The bytes are a third party's — a plugin is
 * installed by an admin, but "trusted to run in the control-plane process" is
 * not the same as "trusted to inject markup into a page holding the session
 * cookie". An `<img>` is a non-scripting context, which is what makes an
 * unreviewed SVG safe to render at all.
 */
export function PluginIcon({ pluginId, name, icon, className }: PluginIconProps) {
  const [failed, setFailed] = useState(false);
  // A different plugin in the same slot must not inherit the previous one's
  // failure — the picker reuses these rows as the selection changes.
  useEffect(() => setFailed(false), []);

  const box = cn("size-5 shrink-0 rounded-sm", className);
  if (icon === undefined || failed) {
    return (
      <span
        aria-hidden
        className={cn(box, "grid place-items-center bg-muted font-strong text-caption text-muted-foreground")}
      >
        {(name ?? pluginId).charAt(0).toUpperCase()}
      </span>
    );
  }
  return (
    <img
      // Decorative: every site that renders this also renders the plugin's
      // name as text, so an alt would be the same word twice to a screen
      // reader.
      alt=""
      aria-hidden
      className={cn(box, "object-contain")}
      src={`/api/plugins/${encodeURIComponent(pluginId)}/icon`}
      onError={() => setFailed(true)}
    />
  );
}
