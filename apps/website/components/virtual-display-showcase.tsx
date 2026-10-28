import Image from "next/image";

/** A real display screenshot shared with the setup documentation. */
export function VirtualDisplayShowcase() {
  return (
    <section
      id="virtual-displays"
      aria-labelledby="virtual-displays-heading"
      className="mx-auto mb-12 mt-8 w-full max-w-[1220px] border-t border-[var(--hairline)] pt-10"
    >
      <div className="grid items-center gap-8 lg:grid-cols-[.8fr_1.5fr] lg:gap-14">
        <div>
          <p className="font-mono text-[12px] uppercase tracking-[.12em] text-[var(--orchid)]">Virtual displays</p>
          <h2
            id="virtual-displays-heading"
            className="mt-3 text-[28px] font-semibold leading-tight tracking-[-.035em] sm:text-[36px]"
          >
            Open a screen alongside your agent.
          </h2>
          <p className="mt-5 max-w-[44ch] text-[15px] leading-[1.8] text-[var(--dim)]">
            Run a browser or graphical app on your node, then view and control its screen from the same workspace. Check
            the result and give your agent feedback without switching machines.
          </p>
          <p className="mt-4 max-w-[44ch] text-[15px] leading-[1.8] text-[var(--dim)]">
            On Linux, give a subshell its own virtual display. On macOS, use BetterDisplay with Subshell Display Helper,
            included in both desktop apps.
          </p>
          <div className="mt-5 flex flex-wrap gap-x-6 gap-y-3">
            <a
              href="https://docs.subshell.sh/guides/preview#use-a-virtual-display-on-linux"
              className="inline-block text-[14px] text-[var(--orchid)] underline underline-offset-4 hover:text-[var(--frost)]"
            >
              Linux setup guide →
            </a>
            <a
              href="https://docs.subshell.sh/nodes/manage#macos-display-helper"
              className="inline-block text-[14px] text-[var(--orchid)] underline underline-offset-4 hover:text-[var(--frost)]"
            >
              macOS setup guide →
            </a>
          </div>
        </div>
        <DisplayScreenshot
          name="virtual-display"
          width={1560}
          height={1520}
          alt="A maximized Virtual display tab showing the Northstar sample website in a browser on the node"
          caption="A browser running on a Linux node, controlled from its virtual-display tab."
        />
      </div>
    </section>
  );
}

function DisplayScreenshot({
  name,
  width,
  height,
  alt,
  caption,
}: {
  name: string;
  width: number;
  height: number;
  alt: string;
  caption: string;
}) {
  return (
    <figure className="m-0 min-w-0">
      <a
        href={`/shots/${name}.webp`}
        target="_blank"
        rel="noreferrer"
        aria-label={`Enlarge screenshot: ${caption}`}
        className="block overflow-hidden rounded-lg border border-[var(--screenshot-border)] bg-[var(--screenshot-background)] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[var(--orchid)]"
      >
        <Image
          src={`/shots/${name}.webp`}
          alt={alt}
          width={width}
          height={height}
          unoptimized
          loading="lazy"
          className="block h-auto w-full"
        />
      </a>
      <figcaption className="mt-3 text-[12px] leading-relaxed text-[var(--dim)]">{caption}</figcaption>
    </figure>
  );
}
