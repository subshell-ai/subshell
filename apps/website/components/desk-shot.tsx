import { ProductDemo } from "./product-demo";

export function DeskShot() {
  return (
    <section
      aria-label="Subshell workspace with Codex subagents and project tests"
      className="mx-auto mt-3.5 w-full max-w-[1220px]"
    >
      <h2 className="mb-3.5 text-center font-mono text-[13px] font-medium uppercase tracking-[.12em] text-[var(--dimmer)]">
        At the desk
      </h2>
      <ProductDemo
        name="desktop-workspace"
        webm={false}
        width={900}
        height={560}
        label="Codex builds a feature with subagents; move a test subshell out of and back into the workspace, then run its tests"
      />
      <p className="mt-2.5 text-center text-[12px] text-[var(--dimmer)]">
        Follow subagents and move subshells in one workspace
      </p>
    </section>
  );
}
