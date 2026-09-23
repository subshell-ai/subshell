export function DeskShot() {
  return (
    <section
      aria-label="Subshell control plane running a Claude Code session"
      className="mx-auto mt-3.5 w-full max-w-[1220px]"
    >
      <h2 className="mb-3.5 text-center font-mono text-[13px] font-medium uppercase tracking-[.12em] text-[var(--dimmer)]">
        At the desk
      </h2>
      <div className="border border-[var(--border)]">
        <img
          src="/shots/control-plane-zoom.png"
          width={2000}
          height={1139}
          className="block h-auto w-full"
          alt="The Subshell control panel with the text zoomed in: the sidebar lists Terminal and a live Claude Code subshell, and the pane shows Claude Code v2.1.280 running Opus 5.5 on ~/projects with the prompt ready."
        />
      </div>
      <p className="mt-2.5 text-center text-[12px] text-[var(--dimmer)]">The control plane in tablet / desktop mode</p>
    </section>
  );
}
