# Hydra Core Design

**Date:** 2026-08-12

**Status:** Approved
**Scope:** Phases 0 through 3

## Objective

Hydra is a local Codex plugin that lets GPT-5.6 Sol delegate bounded engineering tasks to the user's installed Claude Code CLI. Hydra uses the user's Claude Max login, preserves Sol as the implementation owner and merge authority, and never calls an Anthropic API or gateway directly.

The first release must start explicit Sonnet, Opus, and Fable jobs, return a job ID without waiting for Claude, persist structured results, resume a saved Claude session, cancel the whole process group, and isolate all test and write work from the main checkout.

## Scope boundaries

The first release contains Phases 0 through 3:

1. repository, architecture records, strict TypeScript tooling, and plugin manifest;
2. subscription-only preflight, Claude CLI adapter, persistent background jobs, status, result, cancellation, and continuation;
3. STDIO MCP integration, analyze/test/execute access modes, worktree isolation, packaged Codex skills, marketplace installation, and an opt-in real CLI smoke test.
4. bounded independent panels, anonymized critique, structured evidence, hard model/round caps, and terminal-job outcome logging.

Phase 4 calibration remains outside this implementation cycle. Hydra does not expose a production burn-mode skill, usage report, adaptive routing, or synthetic allowance-spending workflow in the first release.

## Repository and package layout

The current directory is the repository root. It contains one local marketplace and one plugin:

```text
.
├── .agents/plugins/marketplace.json
├── docs/
│   ├── adr/
│   └── superpowers/
├── package.json
├── plugins/hydra/
│   ├── .codex-plugin/plugin.json
│   ├── .mcp.json
│   ├── skills/
│   ├── src/
│   └── tests/
└── tsconfig.json
```

The repository uses npm workspaces only if another package appears. For the first release, the root package builds `plugins/hydra/src` and emits `plugins/hydra/dist`. This keeps one lockfile and one test, lint, and type-check entry point.

## Runtime architecture

### MCP server

`server.ts` starts an MCP server over standard input and output. It validates every tool argument with Zod, delegates work to application services, and returns compact JSON-compatible content. The server never keeps a tool request open while Claude runs.

`hydra_start` validates and persists a queued job, enforces a bounded durable queue, launches a detached Node worker with an argument array, and returns the job ID. The worker claims a filesystem concurrency slot before preflight or any Claude subprocess. This keeps model calls and preflight fan-out bounded across MCP server restarts.

### Job worker

`worker.ts` receives only a job ID and state-root path. It reloads the job record, claims a slot, prepares the access context, invokes Claude through `ClaudeCliAdapter`, updates the heartbeat, streams sanitized events to disk, and writes the terminal result. The worker releases its slot in a `finally` block.

The MCP server starts the worker as a detached process group so the worker survives its parent. The adapter starts Claude in a second process group and persists that group ID before processing output. Cancellation targets Claude's negative process-group ID, which lets the worker observe termination, persist the final state, and release its slot. Hydra sends `SIGTERM`, waits for the configured grace period, then sends `SIGKILL` if any process remains. A timeout uses the same path and records `timed-out`, not `cancelled`.

### Claude CLI adapter

`ClaudeCliAdapter` uses `child_process.spawn(claudePath, args, { shell: false })`. Task text is one argument and never passes through a shell. Standard output, standard error, and process metadata stay separate.

Before constructing an invocation, the adapter consumes a capability snapshot produced from the installed CLI's `--help`. It may use only detected flags. Version `2.1.228` exposes print mode, model, effort, stream-json, verbose, permission mode, tools, settings, structured schema, resume, and explicit session ID. It does not expose `--max-turns` or a sandbox flag. Hydra therefore:

- counts unique top-level assistant message identities for the current invocation and terminates the process group at the configured tool/turn boundary;
- passes sandbox policy through a generated, mode-specific `--settings` JSON file;
- fails closed when a required flag or sandbox setting cannot be verified;
- records the capability snapshot with every job.

Hydra never passes `--bare`, a fallback model, `bypassPermissions`, or `dangerously-skip-permissions`. Every process receives `CLAUDE_CODE_NO_MODEL_FALLBACK=1`; inherited model-default overrides are removed; and all recognized Claude 2.1.228 internal selectors (main, small-fast, classifier, context-collapse, auto-mode, and subagent) are overwritten with the same explicit job model. This prevents internal quota/classifier calls from silently using Haiku. Terminal `modelUsage` is audited: any additional model fails the job. A primary resolved-model mismatch produces a warning; `strictModel: true` converts that label mismatch into a failed job while preserving sanitized partial output and model identity.

### Stream parser

The adapter reads standard output incrementally, splits complete JSON Lines, and retains an unfinished tail until EOF. Each valid event passes through a sanitizer before append-only persistence. Each malformed line becomes a synthetic parse-error event that includes a bounded digest and line number, not the raw line. Earlier events and partial final text remain usable.

The parser extracts fields defensively because Claude events may evolve. It records the raw sanitized object and separately derives session ID, requested and resolved model, terminally reported usage models, canonical model ID, final text, structured output, reported usage, duration, invocation turn count, optional terminal `reportedSessionTurns`, and termination reason when present. A terminal cumulative session count never overwrites or limits the current invocation count. Reported token and cost data are estimates from local history, never plan allowance or remaining quota.

## Persistent state

Hydra uses JSON and JSONL under `~/.hydra` by default:

```text
~/.hydra/
├── config.json
├── jobs/<jobId>/meta.json
├── jobs/<jobId>/events.jsonl
├── jobs/<jobId>/stderr.log
├── jobs/<jobId>/result.json
├── sessions/<sessionId>.json
├── outcomes/<jobId>.json
├── worktrees/<repoHash>/<jobId>/
└── locks/
```

Hydra creates directories with mode `0700` and state files with mode `0600`. JSON writes use a same-directory temporary file, `fsync`, rename, and parent-directory `fsync` where supported. The append-only event writer opens files with mode `0600` and handles stream backpressure.

Job IDs and session IDs are validated opaque identifiers. Managed paths derive from validated IDs and verified roots; user paths never join directly into a state path. Worktree paths remain under the configured worktree root after `realpath` validation. Hydra never stores credentials, complete environment maps, unsanitized settings, or OAuth values.

Filesystem locks use exclusive lock-directory creation with an owner record containing PID, process start time, and heartbeat. A claimant may recover a stale lock only after checking that the recorded process no longer exists and the heartbeat exceeds the configured threshold. This supports concurrency enforcement after server restarts without a native database.

## Preflight and billing boundary

`PreflightService` runs these commands with argument arrays:

1. `claude --version`;
2. `claude --help`;
3. `claude auth status`.

Subscription-only mode requires the locally verified Claude Code baseline `>=2.1.228`, `loggedIn: true`, `authMethod: "claude.ai"`, `apiProvider: "firstParty"`, and a subscription type compatible with Claude Pro or Max. Hydra rejects the run when any required property is absent or ambiguous.

The service checks the presence, never the secret value, of prohibited environment variables. It rejects `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_PROFILE`, and known Bedrock, Vertex, and Foundry selectors. It inspects approved Claude settings files through a narrow JSON parser and rejects `apiKeyHelper`, custom provider routing, base URLs, and gateway settings. It may note that `CLAUDE_CODE_OAUTH_TOKEN` is present, but it never reads or persists the value.

Every subscription-only result includes:

```json
{
  "usageCreditsState": "unknown",
  "manualCheckRequired": true
}
```

The README instructs the user to disable usage credits in Claude Settings > Usage when they require a hard no-charge boundary. Hydra exposes no `remainingQuota`, private Claude.ai endpoint, website scraper, browser automation, API key fallback, or cloud gateway.

## Access modes and isolation

### Analyze

Analyze mode runs in the requested repository with fail-closed `dontAsk` and `Read`, `Glob`, and `Grep` scoped to the canonical repository. Hydra denies filesystem reads from `/` and re-opens only the repository and job temporary directory, then disables Bash, editing tools, web tools, hooks, external setting sources, and all MCP tools. Permission paths must be representable as literal Claude permission rules; pattern metacharacters fail closed. It captures bounded fingerprints of tracked, untracked, ignored, executable, and symlink state before and after the run. Analyze results retain fingerprints and changed-path metadata, not a pre-existing user patch. Any change fails the isolation check and remains untouched for Sol to inspect.

### Test

Test mode creates a dedicated detached worktree under Hydra state at the caller's current Git commit. Claude receives Bash plus repository-scoped read tools, but no edit tools. A generated settings file enables the Claude sandbox, sets `sandbox.failIfUnavailable` to `true`, uses an empty `network.strictAllowlist`, and restricts filesystem access to the worktree and its job temporary directory. The main checkout is never the worker's current directory.

### Execute

Execute mode creates a separate dedicated worktree. Claude receives read and Bash tools plus Edit/Write rules scoped explicitly to the worktree and job temporary directory, with fail-closed permission mode `dontAsk`. The same sandbox denies network access and writes outside those roots. Hydra returns the worktree path, changed files, binary-safe Git diff metadata, textual patch when representable, and tests reported by Claude. Sol decides whether to apply any change.

Hydra preserves a worktree when it contains changes or useful artifacts. It may remove a clean worktree only after the result is durable. Concurrent test and execute jobs never share a worktree.

## Application services

- `ConfigService` loads defaults, validates overrides, and exposes no secrets.
- `PreflightService` verifies version, subscription authentication, environment, provider settings, flags, and platform.
- `PolicyEngine` maps a task profile and user mode to a deterministic route recommendation. Maximum mode remains explicit and bounded.
- `JobStore` owns job state transitions, heartbeats, atomic result writes, and list queries.
- `SessionStore` maps Claude session IDs to the latest completed Hydra job and immutable invocation context required for resume.
- `OutcomeStore` records terminal-job outcomes with task type, scope, requested/resolved model, effort, duration, observed tests, before/after tests, findings, false positives, patch verdict, and optional user verdict without adapting routing automatically.
- `ConcurrencyManager` owns cross-process Claude and Fable slots.
- `WorktreeManager` validates Git context, creates one worktree per isolated job, captures diffs, and preserves useful work.
- `ClaudeCliAdapter` builds invocations, streams events, and returns a normalized execution summary.
- `JobService` coordinates start, continuation, status, result, and cancellation.

Each service receives filesystem, process, clock, and ID dependencies through narrow interfaces where tests need deterministic control. Production code uses Node implementations.

## MCP tool contracts

The server exposes:

- `hydra_preflight`: validates environment and returns the capability snapshot;
- `hydra_route`: returns a deterministic recommendation and limits;
- `hydra_start`: persists and dispatches a new Claude job;
- `hydra_status`: returns one job or a bounded recent-job list;
- `hydra_result`: returns a durable terminal result and partial data for nonterminal jobs;
- `hydra_continue`: starts a new process with `--resume <sessionId>`, preserved model/access context, and durable turn/time limits; explicit bounded limit overrides become the next session snapshot;
- `hydra_cancel`: requests process-group termination and returns the observed terminal state;
- `hydra_record_outcome`: writes a user or Sol verdict to local history.

Preflight, route, status, and result carry read-only MCP annotations. Start, continue, cancel, and record-outcome carry mutating annotations. Tool descriptions state that Claude invocations consume subscription allowance.

## Routing policy

The initial `PolicyEngine` implements the named FAST, STANDARD, HARD_DEBUG, ARCHITECTURE, LONG_HORIZON_UNKNOWN, PRE_MERGE_HIGH_RISK, and MAXIMUM routes from the product requirements. It returns recommendations only. It never changes the host model, launches a fallback, or starts a panel on its own.

Defaults are fixed in validated configuration:

- two concurrent Claude jobs;
- one concurrent Fable job;
- three panel members;
- two debate rounds;
- twelve Claude turns;
- 1,800-second timeout.

## Error handling and recovery

State transitions form a checked state machine:

```text
queued -> running -> completed
                  -> failed
                  -> cancelled
                  -> timed-out
queued ----------------> failed
       ----------------> cancelled
```

An invalid transition fails without overwriting the prior record. A server restart does not alter durable jobs. On status inspection, Hydra marks a stale queued or running job failed only when the persisted worker identity is absent, and it terminates only an identity-matching orphan Claude group. Terminal result creation and metadata transition share one interprocess lock; restart reconciliation repairs a crash after immutable result creation. It preserves events, standard error, worktree, and partial normalized output.

Preflight failures contain machine-readable codes and safe remediation text. Error serialization strips environment values, authorization payload extras, command settings, and raw malformed lines. Logs support full sanitized events or metadata-only mode and apply configurable age-based retention.

## Testing strategy

All production behavior follows test-driven development. Tests use a mock executable that emits controlled JSONL, malformed lines, delayed output, model substitutions, child processes, and resumable session IDs. Unit tests never invoke Claude.

The suite covers:

- version and flag detection;
- subscription-only environment and settings rejection;
- argument-array construction and prohibited-flag absence;
- incremental parsing, malformed-line recovery, backpressure, and incomplete tails;
- atomic permissions and path traversal rejection;
- state transitions, crash recovery, and cross-process slots;
- immediate job-ID return, completion, continuation, timeout, and process-group cancellation;
- model alias and strict substitution handling;
- analyze snapshots and isolated worktree behavior;
- MCP schemas, annotations, and tool dispatch;
- plugin and marketplace validation.

Real integration tests run only when `HYDRA_REAL_CLAUDE_SMOKE=1`. The first smoke test uses Sonnet with low effort, disabled write and shell tools, one Hydra-enforced turn, and a harmless structured response. It stores sanitized event shapes in `tests/fixtures`; fixture review rejects email addresses, tokens, absolute home paths, and account identifiers. Separate explicitly enabled probes verify Opus, Fable, resume, and cancellation because each consumes subscription allowance.

Each phase ends with `npm test`, lint, TypeScript type-checking, plugin validation, Git status, and diff inspection. A phase passes only when all applicable commands exit successfully.

## Documentation and architecture records

Phase 0 writes four records:

- ADR-001: one Claude subprocess per turn instead of a PTY pool;
- ADR-002: local subscription-only authentication boundary;
- ADR-003: detached workers and durable filesystem jobs;
- ADR-004: access modes, worktrees, and fail-closed sandboxing.

The README documents installation, Max login, disabling usage credits, supported platforms, security boundaries, routing policy, quota visibility limits, update requirements, and troubleshooting. It labels every unverified capability and real smoke result explicitly.

## Release gates

Phase 0 must pass before CLI behavior is added. Phase 1 must pass with the mock CLI and sanitized real Sonnet fixture before Phase 2 installation work begins. Phase 2 must pass isolation tests and a local marketplace installation check before Phase 3 starts.

Phase 3 is implemented as a packaged orchestration protocol over the eight MCP tools, not as an autonomous panel daemon. `hydra-panel` launches independent top-level sessions, removes model identity from critique packets, permits one critique round, requires structured claim/evidence/uncertainty fields, and records verified terminal outcomes. `PolicyEngine`, runtime concurrency, and the skill jointly cap members at three, Fable sessions at one, and debate rounds at two. Sol remains the only synthesizer and merge authority.

The first practical milestone is complete when Codex/Sol can run preflight, start an explicit Sonnet, Opus, or Fable job, retrieve structured output, continue the same session, cancel a job, and confirm that the main checkout remains unchanged. Claims about real model execution require the corresponding opt-in smoke probe.
