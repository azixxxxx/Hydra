---
name: hydra-panel
description: Use when the user explicitly requests a multi-model panel or a high-risk, high-ambiguity engineering decision needs independent proposals and one bounded critique round.
---

# Hydra Panel

## Principle

Use diversity to expose assumptions, then let Sol verify and decide. Never turn model agreement into proof.

## Hard limits

- Use a maximum three Claude sessions.
- Use a maximum one Fable session.
- Use a maximum two debate rounds: one independent proposal round and one critique round.
- Respect the lower runtime concurrency limit returned by `hydra_route`.
- Use only top-level Claude sessions. Do not create nested teams or automatic fallback work.
- Keep each test or execute session in its own worktree.

## Setup

1. Call `hydra_preflight`. Stop on any error or ambiguous billing boundary.
2. Call `hydra_budget` with `{"action":"status"}`. Build the context capsule below. Call `hydra_route` with its exact byte count and `independentJudgmentsRequired: true`. Use `userMode: "maximum"` only when the user explicitly requested maximum mode.
3. Follow the staged plan. Start two members immediately only when the task is parallelizable and independent judgments are the explicit product requirement. A third Fable perspective remains conditional on a named contradiction or missing long-horizon assumption.
4. Define one output schema for all panel members with `proposal`, `claims`, `evidence`, `assumptions`, `uncertainty`, `tests`, and `decisionCriteria`. Cap each independent proposal at 8,192 UTF-8 bytes; it cites capsule evidence by reference and contains no copied capsule or transcript.

## Round 1: independent proposals

Call `hydra_start` separately for each member. Route-required immediate panel members use `budgetIntent.priority: "quality-floor"`. A conditional third member uses `"opportunistic"`, `valuableWork: true`, and `distinctInformationGain: true` only when a named contradiction or missing assumption makes that statement true. Give every member only:

- the original objective and constraints;
- repository root and current Git SHA;
- its distinct role;
- access mode and expected output schema.

Do not reveal another member's identity, prompt, proposal, or intermediate event. Collect terminal results with `hydra_status` and `hydra_result`. A failed job does not authorize a replacement beyond the session cap.

## Context capsule

Create one canonical capsule containing, in order: original objective; active constraints and decision criteria; canonical Git root and Git SHA; precise evidence references as paths, lines, commands, or digests; and open questions. Do not replay the full host conversation.

Measure the capsule's exact UTF-8 bytes after assembly. Keep it within 32,768 UTF-8 bytes by removing stale discussion and duplicate evidence. Each member receives that identical capsule plus one role-specific delta containing only its role, distinct question, named scope, and required output schema. Cap and measure every delta at 4,096 UTF-8 bytes; it contains no repeated capsule, evidence, proposal, or transcript. Record exact delta bytes separately from the capsule-only immediate, all-activated, and durable activated replication fields.

## Round 2: anonymized critique

1. Assign stable labels such as Proposal A, Proposal B, and Proposal C. Keep the model-to-label mapping out of critique prompts.
2. Remove requested-model, resolved-model, session, and cost metadata from proposal text shown to another member. Deduplicate shared evidence into references or digests; do not repeat the capsule or transcript.
3. Measure the anonymized proposal bundle and cap it at 24,576 UTF-8 bytes. Call `hydra_continue` for each surviving session with that identical bounded bundle and one named disagreement; no full raw proposal replay is allowed.
4. Require each critique to identify supported claims, contradicted claims, missing evidence, unsafe assumptions, test gaps, uncertainty, and the strongest remaining disagreement.
5. Run no third round. If a critical tie remains, Sol performs the tie-break with local evidence or asks the user for the product decision.

## Synthesis

Build a compact panel result with:

- consensus supported by repository or test evidence;
- explicit disagreements and which evidence would resolve them;
- rejected claims and false positives;
- uncertainty per material conclusion;
- worktree paths and changed files for alternative patches;
- Sol's verified decision, separate from model votes.

Verify every accepted claim locally. Never merge or copy a worktree patch automatically. Call `hydra_record_outcome` for each terminal job after verification with `taskType`, `scope`, `testsBefore`, `testsAfter`, false positives, patch verdict, and user verdict when known.

## Stop rules

Stop when the evidence resolves the decision, the second round completes, the session or Fable cap is reached, optional admission is deferred, results become duplicative, sandboxing fails, strict model identity fails, or the user cancels. Expiring allowance never justifies a duplicate panel seat. Report incomplete panels as incomplete rather than filling a missing seat implicitly.
