# Contributing

Hydra 1.0 is intentionally narrow: local Codex-to-Claude delegation, Claude.ai subscription authentication, bounded durable jobs, isolated write worktrees, staged fan-out, and manually attested allowance pacing.

Before proposing a change:

1. Keep provider fallback, automatic quota scraping, autonomous task invention, network-enabled write jobs, and implicit Git publication out of scope.
2. Add a failing test before changing runtime behavior.
3. Run `npm run check` from the repository root.
4. Document any change to an MCP contract, state schema, CLI flag, environment policy, or supported platform.
5. Never include credentials, raw account-usage pages, or unsanitized Claude transcripts in fixtures or issues.

Pull requests should explain the invariant being protected and include the observed verification result. Linux promotion requires a named maintainer and CI coverage for process identity, cancellation trees, settings discovery, sandboxing, filesystem isolation, and the subscription boundary.
