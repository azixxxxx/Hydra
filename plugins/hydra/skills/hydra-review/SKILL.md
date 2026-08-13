---
name: hydra-review
description: Use when code, architecture, tests, or a pre-merge change needs an independent read-only Sonnet or Opus review with findings grounded in repository evidence.
---

# Hydra Review

## Principle

Return only findings that survive local verification. A fluent model claim without reproducible repository evidence is not a finding.

## Workflow

1. Call `hydra_preflight` for the repository. Stop if authentication, provider routing, CLI capabilities, or platform checks fail.
2. Call `hydra_budget` with `{"action":"status"}`. Select Sonnet high for normal review. Select Opus xhigh for critical risk, architecture, or adversarial pre-merge review. Do not select Fable for ordinary code review and do not weaken a required review model to conserve allowance.
3. Build the bounded context capsule below. Call `hydra_start` with `accessMode: "analyze"`, `strictModel: true`, `budgetIntent.priority: "quality-floor"`, the capsule plus one reviewer role-specific delta, and a bounded turn count.
4. Require structured output with a `findings` array. Each item must contain:

   - `path`: repository-relative file path;
   - `line`: smallest relevant 1-based line number or `null`;
   - `severity`: `critical`, `high`, `medium`, or `low`;
   - `claim`: falsifiable description of the defect;
   - `evidence`: code path, state transition, command, or test that supports it;
   - `uncertainty`: explicit caveat or `none`;
   - `suggestedCheck`: narrow local verification step.

5. Record the job ID, inspect `hydra_status`, and retrieve `hydra_result` only after a terminal state.
6. For each candidate finding, open the cited code and its callers. Attempt to disprove the claim. Run the suggested focused test or another safe reproduction when practical.
7. Drop any finding that local evidence does not support. Correct its severity when the stated impact or reach is unsupported.
8. Report verified findings first, ordered by severity. Include the exact path and line, impact, evidence, and remaining uncertainty. If none survive, state that no verified findings were found and name the checks performed.
9. Record `taskType: "review"`, scope, accepted claims, rejected claims, false positives, `testsBefore`, `testsAfter`, patch verdict, and user verdict when known with `hydra_record_outcome`.

## Context capsule

Create one capsule containing, in order: review objective; active constraints and risk criteria; canonical Git root and Git SHA; precise evidence references as paths, lines, commands, or digests; and open questions. Do not copy the full host conversation.

Measure the capsule's exact UTF-8 bytes after assembly. Keep it within 32,768 UTF-8 bytes by removing stale discussion and duplicate evidence. The role-specific delta contains only reviewer role, distinct falsifiable question, named scope, and the required findings schema; it contains no repeated capsule or transcript and is capped at 4,096 UTF-8 bytes. A second review session receives the same capsule plus a different role-specific delta only when `hydra_route` names a conditional unresolved question or independent judgment requirement.

## Review boundaries

- Keep Read, Glob, and Grep as the only Claude tools.
- Do not ask Claude to edit, run Bash, use the network, or invoke MCP tools.
- Do not apply a patch from review output.
- Do not accept a finding because Sonnet or Opus repeated it confidently.
- Preserve any unexpected repository change and report it; never reset user files.

## Stop rules

Stop after every unique claim has either local support or a documented rejection. Stop immediately on model substitution, malformed evidence, repository mutation, preflight failure, or cancellation.
