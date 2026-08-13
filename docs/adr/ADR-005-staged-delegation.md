# ADR-005: Stage delegation and bound replicated context

## Status

Accepted for Hydra 1.0.

## Context

Every fresh Claude session rereads its supplied context. Naive fan-out can therefore spend more allowance than one stronger lead while producing duplicate evidence. A public plugin also needs durable enforcement rather than prompt-only session caps.

## Decision

`hydra_route` returns a deterministic content-addressed plan and launches no work. The runtime admits only sessions present in that immutable plan.

- Default to one strongest justified immediate lead.
- Permit a second immediate session only for an explicit independent panel or named disjoint scopes.
- Keep a third perspective conditional on terminal evidence from the same group.
- Cap each plan at three fresh sessions, one Fable session, and two rounds.
- Treat route-required immediate sessions as quality-floor work. Treat conditional and manual additions as opportunistic work.
- Require useful work for every session and distinct expected information gain for opportunistic fan-out.
- Share one 32,768-byte evidence capsule. Cap role deltas at 4,096 bytes, proposals at 8,192 bytes, and the deduplicated critique bundle at 24,576 bytes.
- Persist plan identity, session indices, activation reasons, evidence job IDs, exact supplied-context bytes, and raw usage dimensions.

## Consequences

Hydra spends less allowance on repeated repository context and can reject duplicate or out-of-plan starts across process restarts. Some panels remain incomplete when evidence or allowance does not justify the conditional member. This is an intended stop condition.

## Rejected alternatives

- Unbounded parallel subagents: context replication and concurrency are not controlled.
- Model-vote majority: agreement is not repository evidence.
- Shared write worktree: competing edits break isolation and attribution.
- Automatic replacement after a failed seat: failure does not expand the immutable cap.
