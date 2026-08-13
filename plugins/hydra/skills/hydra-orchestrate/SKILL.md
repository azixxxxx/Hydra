---
name: hydra-orchestrate
description: Use when an engineering task may benefit from an independent Claude Code investigation, review, or alternative implementation and the value of delegation must be weighed against cost and risk.
---

# Hydra Orchestrate

## Principle

Keep Sol as implementation owner, verifier, and merge authority. Treat Hydra output as evidence to check, never as authority to accept.

## Workflow

1. Call `hydra_preflight` for the target repository. Stop on any preflight error. State that account usage credits remain a manual check.
2. Call `hydra_budget` with `{"action":"status"}`. Treat it as local advisory evidence, never as an account-quota source. Missing or stale evidence must not block required quality-floor work, but it blocks optional delegation.
3. Build the context capsule below. Classify kind, scope, ambiguity, novelty, risk, write need, test need, parallelizability, context overlap, partitionability, and independent-judgment need. Call `hydra_route` with the capsule's exact byte count.
4. If the route is `FAST`, continue locally. Start no Claude job.
5. Start only plan sessions whose activation is `immediate`. Use `hydra_start` with the named model, effort, role, capsule, role-specific delta, and least-privileged access mode. Use `budgetIntent.priority: "quality-floor"` for the required lead and route-required immediate panel members. Use `"opportunistic"` for conditional or manually added sessions, with `valuableWork: true` and a truthful `distinctInformationGain` value.
6. Enforce a maximum three Claude sessions, maximum one Fable session, and the lower configured concurrency limit. Do not invent a fallback model.
7. Record each returned job ID. Check `hydra_status` until a terminal state, then call `hydra_result`. Use condition-based checks; do not hold a tool call open while Claude runs.
8. Use `hydra_continue` only when the same saved context is materially useful. Preserve the model, role, and access context.
9. Verify every accepted claim against local repository evidence. Open cited files, reproduce relevant commands, and run focused tests when safe. Sol alone decides whether to apply a worktree patch.
10. Call `hydra_record_outcome` only after the job is terminal. Supply `taskType`, `scope`, accepted and rejected claims, false positives, `testsBefore`, `testsAfter`, patch verdict, and user verdict when known.

## Context capsule

Create one canonical capsule in this order:

1. current objective and decision requested;
2. active constraints and acceptance criteria;
3. canonical Git root and current Git SHA;
4. precise evidence references as paths, lines, commands, or digests;
5. open questions that repository evidence has not resolved.

Keep the role-specific delta separate: role, distinct question, named scope, and required output schema. Cap each delta at 4,096 UTF-8 bytes and measure it exactly. A delta contains no repeated objective, evidence, capsule, or transcript. Measure the capsule's exact UTF-8 bytes after assembly and pass that number as `contextProfile.capsuleBytes`. The default maximum is 32,768 UTF-8 bytes; remove stale narrative and duplicated evidence before exceeding it, and emit the route warning if the irreducible capsule is larger.

Do not copy the full host conversation. Every fresh session receives the same capsule plus only its role-specific delta. `replicatedContextBytesImmediate`, `replicatedContextBytesAllActivated`, and the durable `replicatedContextBytesActivated` count capsule replication only; retain exact delta bytes separately and never label any of these values as tokens, cost, cache use, or remaining allowance.

Set `parallelizable: true` only after naming disjoint scopes. Set strong partitionability only when the evidence references do not overlap. Set `independentJudgmentsRequired: true` only for an explicit user request or a documented decision that requires independent judgments. Expiring allowance is not evidence for any of these fields. Use at most two rounds; `hydra_continue` requires one named unresolved question and stops when that question is answered.

## Access selection

| Need | Access mode | Constraint |
|---|---|---|
| Explore or review | `analyze` | Read, Glob, and Grep only |
| Reproduce or test | `test` | Isolated worktree, sandbox, no edits |
| Produce an alternative patch | `execute` | Isolated worktree; Sol reviews the diff |

## Result contract

For every claimed result, retain:

- claim and conclusion;
- repository evidence with path and line when applicable;
- test or command evidence;
- uncertainty and unresolved assumptions;
- requested and resolved model;
- worktree path for isolated work.

## Stop rules

Stop when local evidence answers the question, another session would duplicate existing evidence, the configured session cap is reached, optional work is deferred by the budget controller, preflight fails, authentication or billing is ambiguous, a strict model mismatch occurs, sandboxing fails, or the user cancels the job. Final-burn mode authorizes no synthetic task: it only admits an already valuable backlog item. On cancellation, call `hydra_cancel` once and report the observed terminal state.

Do not use nested Claude teams, automatic fallback models, a shared write worktree, or unverified model claims.
