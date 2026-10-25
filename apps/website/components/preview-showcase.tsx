import { ProductDemo } from "./product-demo";

export function PreviewShowcase() {
  return (
    <section
      aria-labelledby="website-preview-heading"
      className="mx-auto mb-12 mt-8 w-full max-w-[1220px] border-t border-[var(--hairline)] pt-10"
    >
      <div className="mb-6 max-w-[680px]">
        <p className="font-mono text-[12px] uppercase tracking-[.12em] text-[var(--orchid)]">Website development</p>
        <h2
          id="website-preview-heading"
          className="mt-3 text-[28px] font-semibold leading-tight tracking-[-.035em] sm:text-[36px]"
        >
          Check your website as you build.
        </h2>
        <p className="mt-4 text-[15px] leading-relaxed text-[var(--dim)]">
          Open your dev server beside your agent, click through the site, and check layouts and interactions. When
          something’s off, give your agent feedback in the same workspace.
        </p>
        <a
          href="https://docs.subshell.sh/guides/preview"
          className="mt-4 inline-block text-[14px] text-[var(--orchid)] underline underline-offset-4 hover:text-[var(--frost)]"
        >
          Preview a website →
        </a>
      </div>
      <ProductDemo
        name="website-preview"
        webm={false}
        width={1000}
        height={640}
        label="Codex fixes a website’s project filters; check the result beside the agent, then open its virtual display"
      />
      <p className="mt-2.5 text-center text-[12px] text-[var(--dimmer)]">
        Fix a filter, test it in the app preview, and view the browser running on the node.
      </p>
    </section>
  );
}
