const CONTROLS = [
  {
    title: "Choose how people sign in",
    body: "Use passwords, passkeys, or your OIDC provider. Control account registration and revoke access when someone leaves.",
  },
  {
    title: "Set machine permissions",
    body: "Choose who can start subshells on each machine. Signing in doesn’t grant access to every node.",
  },
  {
    title: "Protect connections to your machines",
    body: "Node connections are encrypted and authenticated even when your server uses HTTP. Commands from your server are signed and bound to the intended machine.",
  },
  {
    title: "Review security changes",
    body: "Check the audit log to see who changed accounts, enrolled machines, shared subshells, or took other security actions.",
  },
] as const;

/** Presents the product's security controls alongside its execution trust boundary. */
export function SecuritySection() {
  return (
    <section
      aria-labelledby="security-feature"
      className="grid items-center gap-8 border-t border-[var(--hairline)] pt-12 lg:grid-cols-[.8fr_1.5fr] lg:gap-14"
    >
      <div>
        <p className="font-mono text-[12px] uppercase tracking-[.12em] text-[var(--orchid)]">Security</p>
        <h2
          id="security-feature"
          className="mt-3 text-[28px] font-semibold leading-tight tracking-[-.035em] sm:text-[36px]"
        >
          Manage access to your machines.
        </h2>
        <p className="mt-5 max-w-[44ch] text-[15px] leading-[1.8] text-[var(--dim)]">
          Choose how people sign in, from passwords and passkeys to your existing identity provider. Set permissions for
          the machines they can use and revoke access when needed. Node connections are encrypted and authenticated, and
          the audit log records security changes.
        </p>
        <a
          href="https://docs.subshell.sh/concepts/security"
          className="mt-5 inline-block text-[14px] text-[var(--orchid)] underline underline-offset-4 hover:text-[var(--frost)]"
        >
          Read the security model →
        </a>
      </div>
      <div>
        <ul className="m-0 grid list-none gap-8 p-0 sm:grid-cols-2 lg:gap-x-10">
          {CONTROLS.map(({ title, body }) => (
            <li key={title}>
              <h3 className="text-[16px] font-semibold">{title}</h3>
              <p className="mt-2 max-w-[52ch] text-[14px] leading-[1.8] text-[var(--dim)]">{body}</p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
