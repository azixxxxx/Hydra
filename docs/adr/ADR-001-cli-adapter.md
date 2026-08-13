# ADR-001: Use one Claude CLI process per turn

## Context

Hydra must use the locally authenticated Claude Code CLI, preserve resumable sessions, parse structured events, and avoid retaining credentials or terminal state.

## Decision

Hydra launches one normal `claude` subprocess for each new or resumed turn. It uses an argument array, `shell: false`, stream-json output, and the saved Claude session ID with `--resume` for continuation.

## Consequences

Each turn has a clear lifetime, separate standard error, durable raw sanitized events, and direct process-group cancellation. Startup cost repeats for every turn. Hydra records that cost instead of hiding it.

## Rejected alternatives

A persistent PTY pool couples unrelated jobs to terminal state, complicates crash recovery, and encourages scraping terminal output. Direct Anthropic API calls bypass the user's Claude Max login and violate the billing boundary.
