# Hydra Core Verification Report

> Historical 0.1 verification evidence. This report records the installed build named below and is not proof for Hydra 1.0. Test counts, installed-cache identity, and live job IDs have not been carried forward. The current 1.0 boundary and release gate are defined in `docs/1.0-boundary.md`.

**Date:** 2026-08-13

**Scope:** Historical core phases 0 through 3 and acceptance criteria 1 through 31 for the recorded 0.1 build.

## Verified environment

| Component | Observed value |
|---|---|
| OS | Darwin arm64 |
| Node.js | 24.13.0 |
| npm | 11.6.2 |
| Git | 2.50.1 (Apple Git-155) |
| Claude Code | 2.1.228 |
| Codex CLI | 0.147.0 |
| Installed Hydra | `0.1.0+codex.20260812215941`, enabled from `hydra-local` |

The final Codex/Sol preflight in fresh task `019ff7fd-d572-7df2-bed8-086b74089880` loaded installed cache `0.1.0+codex.20260812215941` and returned `ok: true`, Claude Code `2.1.228`, `billingMode: "subscription-only"`, subscription type `max`, `usageCreditsState: "unknown"`, `manualCheckRequired: true`, and no error codes. Account identity and raw authentication output were not retained in this report. An earlier test invocation omitted the optional input object and was rejected by MCP input validation with `-32602`; it launched no Claude job.

## Verification commands

| Check | Observed result |
|---|---|
| `npm run check` | Exit 0; 266 tests passed, 5 real-only tests skipped; lint, strict typecheck, build, and portable plugin validation passed |
| Opt-in real Sonnet smoke | Exit 0; 1 structured-output test passed through the production adapter after the final adapter/settings changes |
| Opt-in real isolation smoke | Exit 0; 4 tests separately proved allowed in-root Bash/Read/Write and denied analyze-mode outside Read, test-mode outside read/write/local network, and execute-mode outside Write; every main-checkout fingerprint matched |
| Skill validation | All three packaged skills passed `quick_validate.py` |
| Bundle syntax | Both `dist/server.js` and `dist/worker.js` passed `node --check` |
| Dependency audit | `npm audit` and `npm audit --omit=dev` reported 0 vulnerabilities |
| Installed-cache comparison | Recursive source/cache comparison for `0.1.0+codex.20260812215941` returned no differences |
| State permissions | No non-0700 state directory and no non-0600 state file outside managed Git worktrees |
| Credential-shaped state scan | 0 matching files under the Hydra state root |
| Prohibited source scan | No `--bare`, shell execution, permission bypass, fallback-model, HTTP endpoint, or private Claude.ai pattern in `plugins/hydra/src` |

## Live Codex/Sol acceptance evidence

The following jobs were launched by fresh Codex 0.147.0 processes using `gpt-5.6-sol` and the installed Hydra MCP tools. The model/continuation probe used maximum reasoning effort; the final cancellation probe used high reasoning effort:

| Probe | Job | Terminal evidence |
|---|---|---|
| Sonnet structured analyze | `ede3e0e8-ecbd-46b8-8d1f-c21533d672fe` | `completed`; resolved `claude-sonnet-5`; structured `{ok:true, modelLabel:"sonnet"}`; main checkout unchanged |
| Final installed Sonnet smoke | `706ec7cf-dabe-47d8-bdc9-585afe72903d` | Exact final cache `0.1.0+codex.20260812215941`; `completed`; resolved `claude-sonnet-5`; terminal `reportedModels` contained only `claude-sonnet-5`; output `{ok:true, label:"final-exact-cache-verified"}`; no warnings; main-checkout fingerprints matched. An earlier installed-cache probe exposed Claude 2.1.228's separate internal Haiku quota-check and drove the selector pinning and terminal model-usage audit used by this final run. |
| Opus structured analyze | `a93106fd-0fef-4b30-8a15-d1590171281f` | `completed`; resolved `claude-opus-5`; structured `{ok:true, modelLabel:"opus"}`; main checkout unchanged |
| Fable structured analyze | `bcaa495a-6e7f-42ba-b03b-8002cb056e41` | `completed`; resolved `claude-fable-5`; structured `{ok:true, modelLabel:"fable"}`; main checkout unchanged |
| Sonnet continuation | `e4cfe938-6344-4f5e-865a-ec2a49ff5e4c` | `completed`; session `6fe9f5b7-3051-47c9-aa0d-341433787145` matched the original Sonnet session; structured `{continued:true}` |
| Process-group cancellation | `0b25a706-36ee-48d2-bcfd-2c1f6cd289a0` | Installed build; `cancelled` in meta and result; `CLAUDE_CANCELLED`; resolved `claude-sonnet-5`; main checkout unchanged; worker and Claude process scan empty |

The cancellation probe exposed and drove fixes for two races: a terminal Claude event could previously leave `terminationReason: "completed"` on a cancelled job, and an early cancellation before model discovery could previously surface as `MODEL_MISMATCH`. Both cases now have regression tests.

## Acceptance matrix

| # | Status | Evidence |
|---:|:---:|---|
| 1 | PASS | Fresh live preflight reported Claude 2.1.228 and subscription-compatible authentication metadata. |
| 2 | PASS | Table-driven preflight tests reject the complete maintained credential/routing denylist, including `ANTHROPIC_API_KEY`, by variable presence without reading values. |
| 3 | PASS | Preflight tests reject custom base URLs, profile routing, Bedrock, Vertex, Foundry, AWS/Google/Foundry auth bypasses, and custom gateway selectors. Ancestor settings and relative `CLAUDE_CONFIG_DIR` are covered. |
| 4 | PASS | Fixed-string source scan found no `--bare`. |
| 5 | PASS | Source URL/private-endpoint scan returned no matches. |
| 6 | PASS | Sanitizers and persistence-boundary guards reject or redact recognized credentials; the final state scan found zero credential-shaped files. See the residual limit below. |
| 7 | PASS | Detached-start acceptance tests and live MCP runs returned durable job IDs before model completion. |
| 8 | PASS | Domain, worker, adapter, store, and job-service tests cover queued, running, completed, failed, cancelled, and timed-out states. |
| 9 | PASS | Mock and live results contain final output and process-backed session IDs. |
| 10 | PASS | Live continuation returned the original Sonnet session ID after the first process exited. |
| 11 | PASS | Live Opus resolved to `claude-opus-5`. |
| 12 | PASS | Live Fable resolved to `claude-fable-5`. |
| 13 | PASS | Every invocation sets `CLAUDE_CODE_NO_MODEL_FALLBACK=1`, removes inherited model-default overrides, pins all recognized Claude 2.1.228 selectors to the explicit job model, audits terminal `modelUsage`, and fails on any additional model. Adapter and worker tests also verify exact full-ID comparison, warning mode, and strict `MODEL_MISMATCH` evidence preservation. |
| 14 | PASS | JSONL tests preserve valid events around malformed lines and persist only bounded digests for bad lines. |
| 15 | PASS | Deterministic mock coverage spawns a TERM-resistant child and grandchild in the detached group and confirms all disappear; installed live cancellation also left no job worker or Claude process. |
| 16 | PASS | Timeout tests retain partial output and report `CLAUDE_TIMED_OUT`. |
| 17 | PASS | Analyze uses fail-closed `dontAsk`, scopes Read/Glob/Grep to exact canonical repository paths, denies filesystem reads from `/` except the repository/temp roots, rejects ambiguous permission paths, disables hooks/settings/MCP/web/shell/editing, and compares bounded tracked, untracked, ignored, executable, symlink, and byte-content fingerprints. A real probe read a tracked in-repository file while denying an absolute outside-root Read. |
| 18 | PASS | Test mode uses a unique detached worktree with fail-closed sandbox and strict empty network allowlist. The real probe denied outside read/write and local network and reported the main checkout unchanged. |
| 19 | PASS | Execute scopes Edit/Write explicitly to the worktree/temp roots. The real probe allowed in-worktree Write and denied outside Write; deterministic rules cover Edit identically. Integration tests return changed files, binary-safe patch including untracked content, structured test outcomes with output digests, and worktree path. |
| 20 | PASS | Concurrent test/execute preparation produces different managed worktree paths per job. |
| 21 | PASS | Managed-path tests reject traversal, separators, NUL bytes, symlink escapes, and atomic-write symlink targets. |
| 22 | PASS | Claude and Git invocations use argument arrays with `shell: false`; the task-string test verifies one untouched argument. |
| 23 | PASS | Separate Node-process tests enforce the hard slot, atomically enforce queue admission capacity, and serialize job metadata. Unit tests cover PID identity, live/dead owners, ownerless locks, orphaned recovery guards, and recovery ownership checks. |
| 24 | PASS | Policy tests enforce configured member and debate-round caps; the panel skill caps top-level sessions at three, Fable at one, and rounds at two. |
| 25 | PASS | The panel skill requires the structured claim/evidence/confidence schema, anonymized critique, assumptions, open questions, and stop rules. |
| 26 | PASS | The default suite uses only the mock CLI; all five opt-in real tests are skipped. |
| 27 | PASS | Real adapter and isolation probes run only when their explicit `HYDRA_REAL_*` environment flags are present. |
| 28 | PASS | Final post-documentation run: 266 tests passed, 5 opt-in tests skipped, then lint, strict typecheck, build, portable validation, official plugin validation, and `git diff --check` all exited 0. |
| 29 | PASS | `hydra@hydra-local` is installed and enabled; installed files exactly match the built plugin source. |
| 30 | PASS | Fresh Codex/Sol processes invoked preflight, Sonnet, Opus, Fable, continuation, and cancellation through the installed MCP server. |
| 31 | PASS | README content tests and manual inspection cover installation, Max authentication, usage credits, security, platforms, troubleshooting, routing, and quota visibility. |

## Deliberate boundaries and remaining risks

- Headless Claude Code cannot prove whether account-level usage credits are enabled. The user must disable usage credits manually in Claude Settings > Usage to rule out paid overflow.
- Reported tokens and cost are local run history, not remaining Max allowance. Hydra does not expose a synthetic quota value.
- Native Windows remains out of scope. The verified target is macOS arm64. Linux uses `/proc/<pid>/stat` process-start identity and is implemented, but the complete suite was not exercised on Linux in this run.
- Test and execute modes require at least one Git commit. Analyze mode supports an unborn repository.
- Hydra recognizes common credential formats and sensitive field names, and Claude 2.1.228 also scrubs typical credential environment variables before Bash. No finite redactor can prove a value stored under an innocuous name is not secret; callers must not place credentials in tasks, roles, notes, schemas, or repository output.
- Superseded by the 1.0 contract-freeze work: Hydra no longer accepts a context selector and always disables external setting sources, hooks, memory, and project MCP servers.
- Fable may require usage credits after plan allowance. Hydra recognizes that state and fails with `USAGE_CREDITS_REQUIRED`; it never falls back, but only the manual account setting can rule out paid overflow before invocation.
- This report predates the 1.0 manual allowance snapshots, pacing controller, reservations, context-economics routing, and contract-freeze work. Those features require new release evidence and cannot inherit PASS status from this report.
- The project repository itself still has no commit. All delivered files remain untracked because no commit or push permission was granted.

The temporary cancellation repository and its empty Hydra worktrees were removed after verification. The temporary repository was moved to the macOS Trash, so it remains recoverable until the Trash is emptied. The current managed worktree root is empty. Durable job metadata and sanitized results remain in the Hydra state root as local acceptance evidence.
