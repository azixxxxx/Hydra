# ADR-004: Isolate test and execute jobs with worktrees

## Context

Delegated testing and editing must not change the user's main checkout. Concurrent writing jobs must not share mutable files.

## Decision

Analyze jobs receive only read, glob, and grep tools and repository snapshots before and after execution. Test and execute jobs receive a unique detached Git worktree under Hydra state. Claude sandbox settings fail when sandboxing is unavailable, deny network by default, and restrict writes to the worktree and job temporary directory.

## Consequences

Sol can inspect evidence and choose whether to apply an execute patch. Hydra preserves changed or useful worktrees and never auto-resets user files. Clean worktrees may be removed after durable result storage.

## Rejected alternatives

Sharing the main checkout risks user data. Sharing one worktree between models creates nondeterministic patches. Permission bypass modes remove the isolation guarantee.
