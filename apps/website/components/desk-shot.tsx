import { ProductDemo } from "./product-demo";

export function DeskShot() {
  return (
    <section
      aria-label="Subshell workspace with Codex and Claude Code sessions"
      className="mx-auto mt-3.5 w-full max-w-[1220px]"
    >
      <h2 className="mb-3.5 text-center font-mono text-[13px] font-medium uppercase tracking-[.12em] text-[var(--dimmer)]">
        At the desk
      </h2>
      <ProductDemo
        name="desktop"
        webm={false}
        width={1280}
        height={800}
        label="Subshell desktop workspace sending a prompt to Codex, showing a notification sample, and switching to Claude Code"
      />
      <p className="mt-2.5 text-center text-[12px] text-[var(--dimmer)]">
        The Subshell dashboard on desktop and tablet
      </p>
    </section>
  );
}
