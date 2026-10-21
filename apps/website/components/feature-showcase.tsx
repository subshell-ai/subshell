import Image from "next/image";
import { SecuritySection } from "./security-section";
import { SelfHostedSection } from "./self-hosted-section";

const SHOTS = {
  workspace: {
    name: "workspace-layout",
    width: 2096,
    height: 668,
    alt: "A project shell and test results side by side in a Subshell workspace",
    caption: "Two subshells, one workspace. On your phone, panes become tabs.",
  },
  prompts: {
    name: "prompt-stack-members",
    width: 1848,
    height: 714,
    alt: "A saved review checklist combining project context, review instructions, and report format in order",
    caption: "Build a prompt stack from instructions you already use.",
  },
  presets: {
    name: "preset-library",
    width: 1848,
    height: 984,
    alt: "Saved launch presets for a Codex repository review and a project terminal",
    caption: "Save launch settings for each agent as a preset.",
  },
  sharing: {
    name: "session-sharing",
    width: 1072,
    height: 884,
    alt: "Subshell sharing dialog with permission dropdowns and a searchable recipient picker",
    caption: "Choose who can watch and who can type into the subshell.",
  },
  ssh: {
    name: "ssh-connection",
    width: 1200,
    height: 2092,
    alt: "SSH connection form with a connecting node, destination, authentication choices, and a local port forward",
    caption: "Choose how to connect and forward ports through the same SSH connection.",
  },
  nodes: {
    name: "node-enrollment",
    width: 1072,
    height: 984,
    alt: "Add node instructions for connecting another machine with Subshell Client, a server address, and a setup key",
    caption: "Connect another machine using a setup key from your dashboard.",
  },
} as const;

function Screenshot({ shot }: { shot: (typeof SHOTS)[keyof typeof SHOTS] }) {
  const src = `/shots/${shot.name}.webp`;
  return (
    <figure className="m-0 min-w-0">
      <div className="overflow-hidden rounded-lg border border-[var(--screenshot-border)] bg-[var(--screenshot-background)]">
        <Image
          src={src}
          alt={shot.alt}
          width={shot.width}
          height={shot.height}
          unoptimized
          loading="lazy"
          className="block h-auto w-full"
        />
      </div>
      <figcaption className="mt-3 text-[12px] leading-relaxed text-[var(--dim)]">{shot.caption}</figcaption>
    </figure>
  );
}

function DocumentationLink({ path, children }: { path: string; children: React.ReactNode }) {
  return (
    <a
      href={`https://docs.subshell.sh${path}`}
      className="inline-block text-[14px] text-[var(--orchid)] underline underline-offset-4 hover:text-[var(--frost)]"
    >
      {children} →
    </a>
  );
}

/** Shows concrete workflows using screenshots from the isolated product demo. */
export function FeatureShowcase() {
  return (
    <div className="mx-auto mb-14 mt-20 w-full max-w-[1220px] space-y-16 sm:mt-24 sm:space-y-24">
      <section
        aria-labelledby="workspace-feature"
        className="grid items-center gap-8 border-t border-[var(--hairline)] pt-12 lg:grid-cols-[.8fr_1.5fr] lg:gap-14"
      >
        <div>
          <p className="font-mono text-[12px] uppercase tracking-[.12em] text-[var(--orchid)]">Workspaces</p>
          <h2
            id="workspace-feature"
            className="mt-3 text-[28px] font-semibold leading-tight tracking-[-.035em] sm:text-[36px]"
          >
            Work with your agents side by side.
          </h2>
          <p className="mt-5 max-w-[44ch] text-[15px] leading-[1.8] text-[var(--dim)]">
            A subshell is a terminal session running an agent or a shell. Keep Codex, Claude Code, and a shell together
            in one workspace, with split panes so you can follow their progress and compare output.
          </p>
          <p className="mt-3 max-w-[44ch] text-[15px] leading-[1.8] text-[var(--dim)]">
            Browse your other subshells in the same sidebar. Drag one into the workspace to add a tab, or out to remove
            it while its session keeps running.
          </p>
          <div className="mt-5">
            <DocumentationLink path="/guides/workspaces">Explore workspaces</DocumentationLink>
          </div>
        </div>
        <Screenshot shot={SHOTS.workspace} />
      </section>

      <section
        aria-labelledby="reuse-feature"
        className="grid items-center gap-8 border-t border-[var(--hairline)] pt-12 lg:grid-cols-[1.5fr_.8fr] lg:gap-14"
      >
        <div className="lg:col-start-2 lg:row-start-1">
          <p className="font-mono text-[12px] uppercase tracking-[.12em] text-[var(--orchid)]">Prompts &amp; presets</p>
          <h2
            id="reuse-feature"
            className="mt-3 text-[28px] font-semibold leading-tight tracking-[-.035em] sm:text-[36px]"
          >
            Save your setup for next time.
          </h2>
          <p className="mt-5 max-w-[44ch] text-[15px] leading-[1.8] text-[var(--dim)]">
            Save your project context, review checklist, and preferred response format as reusable prompts. A stack
            combines them into one prompt. Use a preset to save the agent settings, machine, and working directory for
            your next launch.
          </p>
          <div className="mt-5 flex flex-wrap gap-x-6 gap-y-2">
            <DocumentationLink path="/prompts">Build reusable prompts</DocumentationLink>
            <DocumentationLink path="/presets">Create a preset</DocumentationLink>
          </div>
        </div>
        <div className="grid min-w-0 gap-7 lg:col-start-1 lg:row-start-1">
          <Screenshot shot={SHOTS.prompts} />
          <Screenshot shot={SHOTS.presets} />
        </div>
      </section>

      <section
        aria-labelledby="sharing-feature"
        className="grid items-center gap-8 border-t border-[var(--hairline)] pt-12 lg:grid-cols-[.8fr_1.5fr] lg:gap-14"
      >
        <div>
          <p className="font-mono text-[12px] uppercase tracking-[.12em] text-[var(--orchid)]">Subshell sharing</p>
          <h2
            id="sharing-feature"
            className="mt-3 text-[28px] font-semibold leading-tight tracking-[-.035em] sm:text-[36px]"
          >
            Work together in the same subshell.
          </h2>
          <p className="mt-5 max-w-[44ch] text-[15px] leading-[1.8] text-[var(--dim)]">
            Share a subshell with a teammate on your server so they can follow the live terminal and read its history.
            Give them edit access when you want them to type alongside you.
          </p>
          <div className="mt-5">
            <DocumentationLink path="/guides/sharing">How to share a subshell</DocumentationLink>
          </div>
        </div>
        <div className="w-full max-w-[536px] justify-self-center">
          <Screenshot shot={SHOTS.sharing} />
        </div>
      </section>

      <section
        aria-labelledby="nodes-feature"
        className="grid items-center gap-8 border-t border-[var(--hairline)] pt-12 lg:grid-cols-[1.5fr_.8fr] lg:gap-14"
      >
        <div className="lg:col-start-2 lg:row-start-1">
          <p className="font-mono text-[12px] uppercase tracking-[.12em] text-[var(--orchid)]">Run on other machines</p>
          <h2
            id="nodes-feature"
            className="mt-3 text-[28px] font-semibold leading-tight tracking-[-.035em] sm:text-[36px]"
          >
            Manage your machines from one dashboard.
          </h2>
          <p className="mt-5 max-w-[44ch] text-[15px] leading-[1.8] text-[var(--dim)]">
            Run an agent on your workstation, a spare Mac, or a headless Linux machine. Each machine you connect is a
            node. Choose a node and project directory when you start a subshell, then follow its output and type into it
            from your phone or desktop.
          </p>
          <div className="mt-5">
            <DocumentationLink path="/nodes">How to connect a machine</DocumentationLink>
          </div>
        </div>
        <div className="w-full max-w-[512px] justify-self-center lg:col-start-1 lg:row-start-1">
          <Screenshot shot={SHOTS.nodes} />
        </div>
      </section>
      <section
        aria-labelledby="ssh-feature"
        className="grid items-center gap-8 border-t border-[var(--hairline)] pt-12 lg:grid-cols-[.8fr_1.5fr] lg:gap-14"
      >
        <div>
          <p className="font-mono text-[12px] uppercase tracking-[.12em] text-[var(--orchid)]">SSH</p>
          <h2
            id="ssh-feature"
            className="mt-3 text-[28px] font-semibold leading-tight tracking-[-.035em] sm:text-[36px]"
          >
            Open a remote shell from your dashboard.
          </h2>
          <p className="mt-5 max-w-[44ch] text-[15px] leading-[1.8] text-[var(--dim)]">
            Connect over SSH and work in the terminal alongside your agents. Use keys from a connected node, choose a
            key from your own machine, or enter a password when connecting. Save frequently used connections as SSH
            presets, including port forwards to reach a web app, database, or other service through the connection.
          </p>
          <div className="mt-5">
            <DocumentationLink path="/guides/ssh">Explore SSH connections</DocumentationLink>
          </div>
        </div>
        <div className="w-full max-w-[536px] justify-self-center">
          <Screenshot shot={SHOTS.ssh} />
        </div>
      </section>
      <SecuritySection />
      <SelfHostedSection />
    </div>
  );
}
