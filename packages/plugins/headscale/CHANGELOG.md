# @subshell-ai/plugin-headscale

## 0.1.2

### Patch Changes

- [`4a4fc56`](https://github.com/subshell-ai/subshell/commit/4a4fc56193477bc72ae09ceb40eb07415222b676) Thanks [@theogravity](https://github.com/theogravity)! - Headscale hints now say the page notices, not "then re-check"
  
  The same five sentences as Tailscale's plugin (Headscale drives the same client) end "… — this page will notice when you do." instead of "…, then re-check.", matching the card that removed the button (operator's sixth live read, 2026-09-16). The ownership hint keeps its no-tail form, and its comment now records why neither tail ever fit it.

## 0.1.1

### Patch Changes

- [`b68c249`](https://github.com/subshell-ai/subshell/commit/b68c2495e2beea0b470d089dd9ec705f46d669e8) Thanks [@theogravity](https://github.com/theogravity)! - The networking page reads like a form now
  
  Three copy fixes from an operator working through the live Headscale and
  NetBird cards. Each address in the Addresses list leads with its kind label
  above the URL — "NetBird FQDN", then the address — instead of a big bold URL
  with a small muted tag trailing it, which read as two disjoint things. The
  disabled Connect/Sign-in reason now says `Save the Control server URL first.`
  — naming the button that actually delivers the value, and keeping the label's
  own casing so the sentence names the same box the form does. And every
  credential box that can — all four built-ins now do — carries a Docs link
  beside its label, pointing at the vendor page where that key is minted:
  "Auth key" told you what to paste, and nothing on the card said where to get
  one. The link is new manifest data (`labels.credentialDocsUrl`, http(s)
  refused at parse), so third-party network plugins can carry one too.

- [`a9cf342`](https://github.com/subshell-ai/subshell/commit/a9cf34279140d1a2d25957fe4ab065225793918b) Thanks [@theogravity](https://github.com/theogravity)! - A machine on the wrong tailnet stops showing as Joined
  
  Both Tailscale-family rows read the same daemon, so a machine connected to
  Tailscale's own service used to show "Joined" on its Headscale row — and could
  even show "Published", because the publish check read that same foreign
  daemon's serve config. Each row now asks the daemon itself with
  `tailscale debug prefs`, whose `ControlURL` names the control server it serves:
  the Headscale row claims a running daemon only when it names your configured
  Control server URL, and the Tailscale row only when it names Tailscale's own
  service. A machine that positively belongs to the other network reports
  needs-login with a hint naming where it actually goes — the Headscale one
  offers the `tailscale logout` line to type in a terminal, and this server never
  runs it. A daemon too old to answer keeps behaving exactly as before.

- [`c77f90c`](https://github.com/subshell-ai/subshell/commit/c77f90c3e8d1bc71652cd35d5876223482900294) Thanks [@theogravity](https://github.com/theogravity)! - The foreign-tailnet hint stops sending you to Re-check
  
  "Set the control server URL for this plugin, then re-check" described a
  manual step for something the save itself already does: saving re-runs the
  ownership check against the daemon. The hint now says that, because the
  button advice made Re-check look like part of the ritual when it is a
  refresh for states a human had to go and change by hand.

- [`b36ef5f`](https://github.com/subshell-ai/subshell/commit/b36ef5f7897f361f71bdacbe097a9262423aeea9) Thanks [@theogravity](https://github.com/theogravity)! - Plugin icons: the vendor's own mark, or the letter fallback — never a drawing of ours
  
  NetBird's row now carries NetBird's actual brand mark (from the project's own
  repository), and Tailscale's is its official favicon squircle. Headscale and
  Cloudflare Tunnel shipped placeholder tiles someone had drawn here — a literal
  "N"/"H" indistinguishable from the monogram fallback, and a dot grid that is
  not Tailscale's mark — so the made-up ones are gone: those two rows show their
  letter monogram until an official square mark exists to link to.
