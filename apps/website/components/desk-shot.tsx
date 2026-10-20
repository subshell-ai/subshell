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
        label="Codex delegates implementation and tests to subagents, with collapsible sidebar branches"
      />
      <p className="mt-2.5 text-center text-[12px] text-[var(--dimmer)]">
        Follow Codex and its subagents in one workspace
      </p>
    </section>
  );
}
