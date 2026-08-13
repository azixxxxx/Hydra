# ADR-002: Enforce a local subscription-only boundary

## Context

The user requires Claude Max authentication and no silent use of API credits, cloud providers, gateways, private Claude.ai endpoints, or browser-based quota retrieval.

## Decision

Subscription-only preflight requires a compatible Claude Code version, first-party `claude.ai` authentication, and a Pro or Max subscription. It rejects API credentials, custom endpoints, profile routing, `apiKeyHelper`, Bedrock, Vertex, Foundry, and unknown gateways. Hydra checks only whether `CLAUDE_CODE_OAUTH_TOKEN` exists and never reads its value.

## Consequences

Hydra fails closed when authentication or routing is ambiguous. It reports usage-credit state as unknown and requires the user to disable usage credits manually for a hard no-charge guarantee.

## Rejected alternatives

API-key fallback and usage-credit fallback can create charges. Private usage endpoints, website scraping, and browser automation are undocumented, brittle, and outside the local CLI boundary.
