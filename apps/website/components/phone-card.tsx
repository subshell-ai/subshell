export function PhoneCard() {
  return (
    <div>
      <div className="border border-[var(--border)]">
        {/* biome-ignore lint/performance/noImgElement: static export with images.unoptimized; raw img is the approved concept markup */}
        <img
          src="/shots/phone-approval-390.png"
          width={1170}
          height={2532}
          className="block h-auto w-full"
          alt="The Subshell app on a phone: the refactor-auth session open to a Claude Code approval prompt asking whether to edit src/user.ts, with the terminal key bar (Esc, Ctrl-C, arrows) along the bottom."
        />
      </div>
      <p className="mt-2.5 text-center text-[12px] text-[var(--dimmer)]">Running Subshell as a PWA</p>
    </div>
  );
}
