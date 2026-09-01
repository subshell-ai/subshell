import { useEffect, useState } from "react";
import { useVisualViewportInsets } from "@/hooks/use-visual-viewport-insets";

/**
 * TEMPORARY diagnostic (2026-09-01): `?viewport-debug` in any URL paints the
 * live viewport numbers the shell sizing depends on, so the "gap under the
 * key bar" report can be diagnosed from a phone screenshot instead of from
 * theory. Also doubles as a fresh-bundle proof — the old bundle renders
 * nothing for the flag. Remove once the layout issue is closed.
 */
export function ViewportDebug() {
  const insets = useVisualViewportInsets();
  const [, tick] = useState(0);

  useEffect(() => {
    const vv = window.visualViewport;
    const on = () => tick((n) => n + 1);
    const iv = setInterval(on, 500);
    vv?.addEventListener("resize", on);
    vv?.addEventListener("scroll", on);
    window.addEventListener("scroll", on, true);
    return () => {
      clearInterval(iv);
      vv?.removeEventListener("resize", on);
      vv?.removeEventListener("scroll", on);
      window.removeEventListener("scroll", on, true);
    };
  }, []);

  const vv = window.visualViewport;
  const keybar = document.querySelector('[aria-label="Terminal special keys"]');
  const kb = keybar?.getBoundingClientRect();
  const shell = document.querySelector("body > div > div, #root > div > div");
  const lines = [
    `screen ${window.screen.height} inner ${window.innerHeight}`,
    `vv ${Math.round(vv?.height ?? -1)} top ${Math.round(vv?.offsetTop ?? -1)} scale ${vv?.scale ?? 1}`,
    `scroll ${window.scrollY} dTop ${document.documentElement.scrollTop} bTop ${document.body.scrollTop}`,
    `insets ${insets ? `${insets.heightPx}/${insets.offsetYpx}` : "null(dvh)"}`,
    kb ? `keybar btm ${Math.round(kb.bottom)} of ${window.innerHeight}` : "keybar none",
    shell ? `shell h ${Math.round(shell.getBoundingClientRect().height)}` : "shell?",
    `standalone ${window.matchMedia("(display-mode: standalone)").matches}`,
  ];

  return (
    <div className="pointer-events-none fixed right-1 bottom-1 z-[9999] whitespace-pre rounded bg-black/85 p-2 font-mono text-[10px] text-green-400 leading-4">
      {lines.join("\n")}
    </div>
  );
}
