# BetterDisplay protocol implementation

The canonical wire reference is the public
[BetterDisplay integration protocol](../apps/docs/content/docs/developers/betterdisplay-protocol.mdx).
Keep message shapes, limits, CLI arguments, and version compatibility there.
[Helper architecture](macos-display-helper.md) owns internal consent, signing,
installation, recovery, and review constraints.

The owning implementation files are:

- [`betterdisplay-cli.ts`](../packages/pane-runtime/src/preview/betterdisplay-cli.ts): CLI shapes and identity validation.
- [`betterdisplay-provider.ts`](../packages/pane-runtime/src/preview/betterdisplay-provider.ts): allocation, journals, recovery, and teardown.
- [`macos-helper.ts`](../packages/pane-runtime/src/preview/macos-helper.ts): node-side JSON transport and status validation.
- [`macos-rfb.ts`](../packages/pane-runtime/src/preview/macos-rfb.ts): RFB negotiation, framing, and input forwarding.
- [`Runtime.swift`](../native/display-helper/Runtime.swift) and [`Connection.swift`](../native/display-helper/Connection.swift): helper requests, events, bounds, and consent checks.
- [`DisplayIdentity.swift`](../native/display-helper/DisplayIdentity.swift), [`Capture.swift`](../native/display-helper/Capture.swift), and [`Input.swift`](../native/display-helper/Input.swift): native screen validation, capture, and input.
