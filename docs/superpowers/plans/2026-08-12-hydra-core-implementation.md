# Hydra Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and locally install a Codex plugin that starts, tracks, resumes, and cancels explicit Claude Sonnet, Opus, and Fable CLI jobs under a subscription-only security boundary.

**Architecture:** A TypeScript STDIO MCP server persists jobs and launches detached Node workers. Each worker creates the required access context, spawns one Claude process with an argument array, streams sanitized JSONL into a filesystem store, and leaves merge authority with Codex/Sol.

**Tech Stack:** Node.js 20.9+, TypeScript 6.0, ESM, MCP TypeScript SDK 1.30, Zod 4.4, Vitest 3.2, ESLint 9.39, esbuild, npm

## Global Constraints

- Support macOS arm64 first and Linux; native Windows is out of scope.
- Require Node.js 20.9 or newer and the locally verified Claude Code 2.1.228 baseline or newer.
- Use TypeScript strict mode and ESM.
- Enforce subscription-only authentication unconditionally; expose no billing selector.
- Never inspect or persist the value of `CLAUDE_CODE_OAUTH_TOKEN`.
- Never pass `--bare`, a fallback model, `bypassPermissions`, or `dangerously-skip-permissions`.
- Never construct a shell command for Claude; use `child_process.spawn` with `shell: false` and an argument array.
- Keep Sol as orchestrator, implementation owner, verifier, and merge authority.
- Default to two concurrent Claude jobs, one Fable job, twelve turns, and a 1,800-second timeout.
- Unit tests must not invoke the real Claude subscription.
- Real Claude tests require `HYDRA_REAL_CLAUDE_SMOKE=1`.
- Do not commit or push unless the user grants separate Git permission.

---

## Planned file map

### Repository root

- `package.json`: scripts, pinned dependencies, Node engine, and package metadata.
- `package-lock.json`: exact dependency graph.
- `tsconfig.json`: strict ESM compiler configuration.
- `eslint.config.js`: typed TypeScript lint configuration.
- `vitest.config.ts`: deterministic test discovery and timeouts.
- `scripts/build.mjs`: bundle server and worker for plugin installation.
- `.gitignore`: generated output, state, and temporary files.
- `.agents/plugins/marketplace.json`: repo-local Hydra marketplace.
- `docs/adr/ADR-001-cli-adapter.md` through `ADR-004-worktree-sandbox.md`: accepted architecture decisions.

### Plugin package

- `plugins/hydra/.codex-plugin/plugin.json`: Codex manifest.
- `plugins/hydra/.mcp.json`: local STDIO server declaration.
- `plugins/hydra/src/domain.ts`: shared schemas, records, states, and errors.
- `plugins/hydra/src/config.ts`: defaults and config loading.
- `plugins/hydra/src/platform/atomic-files.ts`: secure directory, atomic JSON, and append-only JSONL primitives.
- `plugins/hydra/src/platform/process.ts`: subprocess abstraction and process-group signals.
- `plugins/hydra/src/preflight.ts`: CLI, authentication, environment, and settings verification.
- `plugins/hydra/src/stream-json.ts`: incremental parser, sanitizer, and normalized event accumulator.
- `plugins/hydra/src/claude-cli.ts`: capability-aware argument builder and CLI execution.
- `plugins/hydra/src/stores.ts`: job, session, outcome, and configuration stores.
- `plugins/hydra/src/concurrency.ts`: restart-safe filesystem slots.
- `plugins/hydra/src/worktrees.ts`: Git inspection, isolated worktrees, snapshots, and diffs.
- `plugins/hydra/src/policy.ts`: deterministic routing rules.
- `plugins/hydra/src/job-service.ts`: start, status, result, continuation, cancellation, and recovery.
- `plugins/hydra/src/worker.ts`: detached job runner.
- `plugins/hydra/src/server.ts`: MCP transport and eight tool registrations.
- `plugins/hydra/src/index.ts`: public exports used by tests.
- `plugins/hydra/tests/fixtures/`: sanitized Claude and mock CLI event streams.
- `plugins/hydra/tests/helpers/mock-claude.mjs`: controllable fake CLI executable.
- `plugins/hydra/tests/helpers/repo.ts`: temporary Git repository helper.
- `plugins/hydra/tests/*.test.ts`: focused unit and integration suites.
- `plugins/hydra/skills/hydra-orchestrate/SKILL.md`: route and stopping workflow.
- `plugins/hydra/skills/hydra-review/SKILL.md`: evidence-based read-only review workflow.
- `plugins/hydra/skills/hydra-panel/SKILL.md`: bounded independent proposals, anonymized critique, evidence schema, and stopping rules.
- `plugins/hydra/README.md`: installation, security, usage, and troubleshooting.

## Task 1: Repository, plugin scaffold, and architecture records

**Files:**

- Create: `package.json`
- Create: `tsconfig.json`
- Create: `eslint.config.js`
- Create: `vitest.config.ts`
- Create: `scripts/build.mjs`
- Create: `.gitignore`
- Create: `.agents/plugins/marketplace.json`
- Create: `plugins/hydra/.codex-plugin/plugin.json`
- Create: `plugins/hydra/.mcp.json`
- Create: `docs/adr/ADR-001-cli-adapter.md`
- Create: `docs/adr/ADR-002-subscription-boundary.md`
- Create: `docs/adr/ADR-003-background-jobs.md`
- Create: `docs/adr/ADR-004-worktree-sandbox.md`
- Test: `plugins/hydra/tests/scaffold.test.ts`

**Interfaces:**

- Produces npm scripts `build`, `test`, `lint`, `typecheck`, `validate:plugin`, and `check`.
- Produces ESM bundles `plugins/hydra/dist/server.js` and `plugins/hydra/dist/worker.js`.
- Produces marketplace identity `hydra-local` and plugin identity `hydra`.

- [x] **Step 1: Generate the canonical repo-local plugin skeleton**

Run the plugin-creator scaffold with these exact destinations:

```bash
python3 "$CODEX_HOME/skills/.system/plugin-creator/scripts/create_basic_plugin.py" hydra \
  --path "$PWD/plugins" \
  --marketplace-path "$PWD/.agents/plugins/marketplace.json" \
  --marketplace-name hydra-local \
  --with-skills --with-mcp --with-marketplace
```

- [x] **Step 2: Add the minimal test runner configuration and install the pinned graph**

Create `package.json`, `tsconfig.json`, and `vitest.config.ts` with the pinned dependencies shown in Step 5, a temporary `test` script equal to `vitest run`, and strict ESM compilation. Run `npm install` to create the lockfile. Configuration files are scaffold prerequisites; production behavior remains test-first.

- [x] **Step 3: Write a failing scaffold test**

Create assertions that require strict ESM settings, the two bundle entry points, a plugin manifest with `mcpServers: "./.mcp.json"`, and an MCP command of `node ./dist/server.js` with `cwd: "."`.

```ts
expect(packageJson.type).toBe('module');
expect(tsconfig.compilerOptions.strict).toBe(true);
expect(pluginJson.name).toBe('hydra');
expect(mcpJson.mcpServers.hydra.args).toEqual(['./dist/server.js']);
```

- [x] **Step 4: Run the test and verify the generated defaults fail the production contract**

Run: `npm test -- plugins/hydra/tests/scaffold.test.ts`

Expected: FAIL because the root toolchain and production manifest do not exist yet.

- [x] **Step 5: Add production scripts, build configuration, and metadata**

Use exact dependency families:

```json
{
  "dependencies": {
    "@modelcontextprotocol/sdk": "1.30.0",
    "zod": "4.4.3"
  },
  "devDependencies": {
    "@types/node": "20.19.43",
    "esbuild": "0.28.2",
    "eslint": "9.39.5",
    "typescript": "6.0.3",
    "typescript-eslint": "8.67.0",
    "vitest": "3.2.7"
  }
}
```

Set the manifest capabilities to `Local`, `Read`, and `Write`; describe subscription allowance consumption; omit unsupported `hooks` and absent app fields. Configure `.mcp.json` with a relative bundled entry point and no credential environment forwarding.

- [x] **Step 6: Write all four ADRs**

Each ADR uses `Context`, `Decision`, `Consequences`, and `Rejected alternatives`. Record one subprocess per turn, the subscription-only boundary, detached durable workers, and one isolated worktree per test or execute job.

- [x] **Step 7: Run scaffold checks**

Run:

```bash
npm test -- plugins/hydra/tests/scaffold.test.ts
npm run typecheck
npm run lint
npm run validate:plugin
```

Expected: all commands exit `0`.

- [x] **Step 8: Inspect the phase diff without committing**

Run: `git status --short && git diff --check && git diff -- docs/adr plugins/hydra/.codex-plugin plugins/hydra/.mcp.json`

## Task 2: Domain records, validation, and configuration

**Files:**

- Create: `plugins/hydra/src/domain.ts`
- Create: `plugins/hydra/src/config.ts`
- Create: `plugins/hydra/src/index.ts`
- Test: `plugins/hydra/tests/domain.test.ts`
- Test: `plugins/hydra/tests/config.test.ts`

**Interfaces:**

- Produces `JobId`, `JobStatus`, `AccessMode`, `StartJobInput`, `ContinueJobInput`, `JobMeta`, `JobResult`, `SessionRecord`, `OutcomeRecord`, `HydraConfig`, and `HydraError`.
- Produces `parseStartJobInput(value: unknown): StartJobInput` and `loadConfig(overrides?: unknown): HydraConfig`.

- [x] **Step 1: Write failing schema tests**

Cover empty tasks, relative `cwd`, path traversal job IDs, unsupported effort, timeout bounds, maximum turn bounds, output-schema size, and valid full model IDs.

```ts
expect(() => parseStartJobInput({ ...valid, task: '' })).toThrowError('task');
expect(() => assertJobId('../escape')).toThrowError('jobId');
expect(parseStartJobInput(valid).strictModel).toBe(false);
```

- [x] **Step 2: Verify RED**

Run: `npm test -- plugins/hydra/tests/domain.test.ts plugins/hydra/tests/config.test.ts`

Expected: FAIL because the modules are missing.

- [x] **Step 3: Implement schemas and the checked status machine**

Use the exact terminal states and transitions:

```ts
export const JOB_STATUSES = ['queued', 'running', 'completed', 'failed', 'cancelled', 'timed-out'] as const;
export const TRANSITIONS: Readonly<Record<JobStatus, readonly JobStatus[]>> = {
  queued: ['running', 'cancelled'],
  running: ['completed', 'failed', 'cancelled', 'timed-out'],
  completed: [], failed: [], cancelled: [], 'timed-out': [],
};
```

Reject all unknown object keys at MCP boundaries. Cap tasks at 200,000 UTF-8 bytes, schemas at 100,000 bytes, `maxTurns` at 1–100, and timeout at 1–86,400 seconds.

- [x] **Step 4: Implement immutable validated defaults**

```ts
export const DEFAULT_CONFIG = {
  minClaudeVersion: '2.1.228',
  maxConcurrentClaudeJobs: 2,
  maxConcurrentFableJobs: 1,
  maxPanelMembers: 3,
  maxDebateRounds: 2,
  defaultMaxTurns: 12,
  defaultTimeoutSec: 1800,
  cancellationGraceMs: 5000,
  staleHeartbeatMs: 30000,
  logRetentionDays: 30,
  loggingMode: 'sanitized-events',
} as const;
```

- [x] **Step 5: Verify GREEN and all static checks**

Run: `npm test -- plugins/hydra/tests/domain.test.ts plugins/hydra/tests/config.test.ts && npm run typecheck && npm run lint`

## Task 3: Secure filesystem state primitives

**Files:**

- Create: `plugins/hydra/src/platform/atomic-files.ts`
- Test: `plugins/hydra/tests/atomic-files.test.ts`

**Interfaces:**

- Produces `ensurePrivateDirectory(path): Promise<void>`.
- Produces `atomicWriteJson(path, value): Promise<void>` and `readJsonFile<T>(path, schema): Promise<T>`.
- Produces `appendJsonLine(path, value): Promise<void>` with backpressure.
- Produces `resolveManagedPath(root, ...validatedSegments): string`.

- [x] **Step 1: Write failing permission, atomicity, and traversal tests**

Assert directory mode `0700`, file mode `0600`, replacement without partial JSON, concurrent append integrity, and rejection of `..`, slashes, NUL, symlink escape, and paths outside the canonical root.

- [x] **Step 2: Verify RED**

Run: `npm test -- plugins/hydra/tests/atomic-files.test.ts`

Expected: FAIL because the secure primitives are missing.

- [x] **Step 3: Implement same-directory atomic replacement**

Create the temporary file with `open(..., 'wx', 0o600)`, write the full buffer, call `sync`, close, rename, and sync the parent directory when the platform permits it. Always remove a failed temporary file by its exact validated path.

- [x] **Step 4: Implement serialized JSONL append with backpressure**

Maintain one promise queue per canonical event file. Write one JSON object plus `\n`, wait for the stream callback, and close on terminal job completion.

- [x] **Step 5: Verify GREEN**

Run: `npm test -- plugins/hydra/tests/atomic-files.test.ts && npm run typecheck && npm run lint`

## Task 4: Strict subscription preflight and CLI capabilities

**Files:**

- Create: `plugins/hydra/src/platform/process.ts`
- Create: `plugins/hydra/src/preflight.ts`
- Test: `plugins/hydra/tests/preflight.test.ts`
- Test fixture: `plugins/hydra/tests/fixtures/claude-help-2.1.228.txt`

**Interfaces:**

- Produces `ProcessRunner.run(command, args, options): Promise<CompletedProcess>`.
- Produces `PreflightService.check({ cwd }): Promise<PreflightResult>` and reports the fixed subscription-only boundary.
- Produces `detectClaudeCapabilities(helpText): ClaudeCapabilities`.

- [x] **Step 1: Capture the installed help text as a non-secret fixture**

Run `claude --help`, review it for account data, and store the exact help output. Record that `maxTurns` and a direct sandbox flag are absent in `2.1.228`.

- [x] **Step 2: Write failing preflight tests**

Cover versions below `2.1.228`, malformed versions, logged-out auth, API auth, missing subscription type, every prohibited environment name, `apiKeyHelper`, custom base URL, Bedrock, Vertex, Foundry, unknown provider routing, missing required flags, and the allowed presence of `CLAUDE_CODE_OAUTH_TOKEN` without reading its value.

```ts
expect(result.usageCreditsState).toBe('unknown');
expect(result.manualCheckRequired).toBe(true);
expect(JSON.stringify(result)).not.toContain('oauth-secret');
```

- [x] **Step 3: Verify RED**

Run: `npm test -- plugins/hydra/tests/preflight.test.ts`

- [x] **Step 4: Implement fail-closed environment and settings inspection**

Accept an injected presence lookup `(name: string) => boolean`. Parse only known settings files and walk key names and non-secret routing values. Never serialize the process environment or a token value.

- [x] **Step 5: Implement version, auth, and capability checks**

Require `authMethod === 'claude.ai'`, `apiProvider === 'firstParty'`, and `subscriptionType` in `['pro', 'max']`. Require detected flags for print, model, effort, stream-json output, verbose, permission mode, tools, settings, JSON schema, resume, session ID, MCP config, and strict MCP config. Report `supportsCliMaxTurns: false` rather than inventing support.

- [x] **Step 6: Verify GREEN and run a local preflight diagnostic**

Run: `npm test -- plugins/hydra/tests/preflight.test.ts && npm run typecheck && npm run lint`

Then run a diagnostic entry point against the real CLI. Expected safe facts: version `2.1.228`, first-party Claude Max auth, no prohibited provider routing, and unknown usage-credit state.

## Task 5: Incremental stream-json parser and sanitizer

**Files:**

- Create: `plugins/hydra/src/stream-json.ts`
- Test: `plugins/hydra/tests/stream-json.test.ts`
- Create fixtures: `plugins/hydra/tests/fixtures/mock-valid.jsonl`, `mock-malformed.jsonl`, and `mock-incomplete.jsonl`

**Interfaces:**

- Produces `StreamJsonParser.push(chunk): ParsedStreamItem[]` and `finish(): ParsedStreamItem[]`.
- Produces `sanitizeClaudeEvent(value): JsonValue`.
- Produces `ClaudeEventAccumulator.accept(item): void` and `summary(): ClaudeExecutionSummary`.

- [x] **Step 1: Write failing chunk-boundary and malformed-line tests**

Split JSON across every byte boundary, include CRLF, multiple lines per chunk, invalid UTF-8 replacement, one malformed line between valid lines, and a final incomplete object. Assert that valid earlier events survive.

- [x] **Step 2: Write failing extraction and sanitizer tests**

Cover session IDs, model fields at multiple known paths, result text, structured output, usage, duration, turns, termination reason, token-like keys, authorization headers, email addresses, and absolute home paths.

- [x] **Step 3: Verify RED**

Run: `npm test -- plugins/hydra/tests/stream-json.test.ts`

- [x] **Step 4: Implement the parser and bounded parse-error event**

Malformed output becomes:

```ts
{
  type: 'hydra_parse_error',
  line: lineNumber,
  sha256: createHash('sha256').update(rawLine).digest('hex'),
  byteLength: Buffer.byteLength(rawLine),
}
```

Do not persist the malformed raw line.

- [x] **Step 5: Implement recursive key-based redaction and normalized accumulation**

Replace secret-bearing values with `"[REDACTED]"`, replace the home prefix with `"~"`, and retain unknown non-secret fields for future compatibility. Count only top-level assistant messages as Hydra turns.

- [x] **Step 6: Verify GREEN**

Run: `npm test -- plugins/hydra/tests/stream-json.test.ts && npm run typecheck && npm run lint`

## Task 6: Capability-aware Claude CLI adapter

**Files:**

- Create: `plugins/hydra/src/claude-cli.ts`
- Test: `plugins/hydra/tests/claude-cli.test.ts`
- Create: `plugins/hydra/tests/helpers/mock-claude.mjs`

**Interfaces:**

- Produces `buildClaudeArgs(input, capabilities, settingsPath): readonly string[]`.
- Produces `ClaudeCliAdapter.run(input, callbacks): Promise<ClaudeExecutionSummary>`.
- Callback contract: `onEvent`, `onStderr`, `onHeartbeat`, `onProcessGroup`, and `onTurnLimit`.

- [x] **Step 1: Write failing argument-array tests**

Assert the exact required ordering and one-element task argument:

```ts
expect(args).toEqual([
  '-p', task,
  '--model', 'sonnet',
  '--effort', 'high',
  '--output-format', 'stream-json',
  '--verbose',
  '--permission-mode', 'dontAsk',
  '--tools', 'Read,Glob,Grep',
  '--settings', settingsPath,
  '--strict-mcp-config',
  '--mcp-config', emptyMcpPath,
]);
```

Assert source and built output contain no `--bare`, `--fallback-model`, `bypassPermissions`, `dangerously-skip-permissions`, `shell: true`, or task interpolation.

- [x] **Step 2: Write failing process behavior tests**

Use the mock CLI to verify separate stderr, streamed events, heartbeat updates, process-group ID capture, timeout, Hydra-side turn termination, model mismatch warnings, strict-model failure, structured schema, and `--resume` continuation.

- [x] **Step 3: Verify RED**

Run: `npm test -- plugins/hydra/tests/claude-cli.test.ts`

- [x] **Step 4: Implement access-mode argument profiles**

Use fail-closed `dontAsk` in every mode, with `Read,Glob,Grep` for analyze, plus Bash for test, and plus Edit/Write for execute. Pre-approve only exact absolute repository/worktree paths. Pass an empty strict MCP config in every mode. Reject missing flags before spawn.

- [x] **Step 5: Implement one spawned process per turn**

Spawn with `{ cwd, env: sanitizedEnv, shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'] }`. Consume both streams concurrently, honor backpressure callbacks, and normalize exit, signal, timeout, turn-limit, and abort outcomes.

- [x] **Step 6: Verify GREEN**

Run: `npm test -- plugins/hydra/tests/claude-cli.test.ts && npm run typecheck && npm run lint`

## Task 7: Durable job, session, outcome, and configuration stores

**Files:**

- Create: `plugins/hydra/src/stores.ts`
- Test: `plugins/hydra/tests/stores.test.ts`

**Interfaces:**

- `JobStore.create`, `get`, `list`, `transition`, `heartbeat`, `setWorker`, `setClaudeGroup`, `appendEvent`, `appendStderr`, and `writeResult`.
- `SessionStore.put` and `get` keyed by validated Claude session UUID.
- `OutcomeStore.put` and `get` keyed by Hydra job ID.

- [x] **Step 1: Write failing store tests**

Cover directory layout, modes, immutable creation, legal and illegal transitions, recent-job ordering, partial results, restart reads, stderr size bounds, metadata-only event logging, retention deletion by exact job directory, and credential-shaped data rejection.

- [x] **Step 2: Verify RED**

Run: `npm test -- plugins/hydra/tests/stores.test.ts`

- [x] **Step 3: Implement job persistence and checked transitions**

Store ISO timestamps, requested and resolved model fields, Claude version, PIDs, capability snapshot, access context, and warnings. Make terminal results immutable after the first successful write.

- [x] **Step 4: Implement session and outcome persistence**

Session records retain model, effort, role, access mode, context mode, repository identity, and the latest job ID. Outcome records retain accepted and rejected claims, test verdict, notes, false positives, and patch acceptance without changing policy automatically.

- [x] **Step 5: Verify GREEN**

Run: `npm test -- plugins/hydra/tests/stores.test.ts && npm run typecheck && npm run lint`

## Task 8: Restart-safe concurrency slots

**Files:**

- Create: `plugins/hydra/src/concurrency.ts`
- Test: `plugins/hydra/tests/concurrency.test.ts`
- Create helper: `plugins/hydra/tests/helpers/slot-contender.mjs`

**Interfaces:**

- Produces `ConcurrencyManager.acquire({ jobId, model, signal }): Promise<SlotLease>`.
- `SlotLease.release(): Promise<void>` and `heartbeat(): Promise<void>`.

- [x] **Step 1: Write failing cross-process tests**

Start three contender processes against a two-slot root, assert only two simultaneous leases, assert one Fable lease, recover a stale dead-owner lease, and refuse recovery while the PID remains alive.

- [x] **Step 2: Verify RED**

Run: `npm test -- plugins/hydra/tests/concurrency.test.ts`

- [x] **Step 3: Implement lock-directory slot acquisition**

Use exclusive `mkdir` for `locks/claude-0`, `locks/claude-1`, and `locks/fable-0`. Store PID, job ID, process start marker, and heartbeat in a `0600` owner file. Poll with abort-aware bounded jitter.

- [x] **Step 4: Verify GREEN**

Run: `npm test -- plugins/hydra/tests/concurrency.test.ts && npm run typecheck && npm run lint`

## Task 9: Git worktrees, access settings, and repository evidence

**Files:**

- Create: `plugins/hydra/src/worktrees.ts`
- Test: `plugins/hydra/tests/worktrees.test.ts`
- Create: `plugins/hydra/tests/helpers/repo.ts`

**Interfaces:**

- Produces `WorktreeManager.prepare(job): Promise<PreparedAccessContext>`.
- Produces `snapshotRepository(cwd): Promise<RepositorySnapshot>` and `compareSnapshots(before, after)`.
- Produces `collectWorktreeResult(path): Promise<WorktreeEvidence>`.

- [x] **Step 1: Write failing analyze-mode evidence tests**

Create a repository with tracked, staged, unstaged, untracked, ignored, executable, and symlink files. Assert deterministic before/after fingerprints and detection of every changed category without resetting it.

- [x] **Step 2: Write failing test/execute isolation tests**

Assert unique worktrees under `<state>/worktrees/<repoHash>/<jobId>`, detached current commit, no shared paths, canonical-root enforcement, sandbox settings with `enabled: true` and `failIfUnavailable: true`, denied network, and mode-specific tool permissions.

- [x] **Step 3: Verify RED**

Run: `npm test -- plugins/hydra/tests/worktrees.test.ts`

- [x] **Step 4: Implement Git commands with fixed argument arrays**

Use `git rev-parse`, `git status --porcelain=v1 -z --untracked-files=all`, `git diff --binary`, `git diff --cached --binary`, `git ls-files -z`, and `git worktree add --detach <validatedPath> <sha>`. Do not invoke a shell and do not auto-reset files.

- [x] **Step 5: Generate fail-closed settings files**

Write mode-specific settings inside the job directory with mode `0600`. Test and execute settings must enable sandboxing, set `failIfUnavailable`, deny network, and allow writes only to the job worktree and temporary directory.

- [x] **Step 6: Verify GREEN**

Run: `npm test -- plugins/hydra/tests/worktrees.test.ts && npm run typecheck && npm run lint`

## Task 10: Background worker and job lifecycle service

**Files:**

- Create: `plugins/hydra/src/job-service.ts`
- Create: `plugins/hydra/src/worker.ts`
- Test: `plugins/hydra/tests/job-service.test.ts`
- Test: `plugins/hydra/tests/worker.integration.test.ts`

**Interfaces:**

- `JobService.start(input): Promise<{ jobId: string; status: 'queued' }>`.
- `JobService.status(jobId?): Promise<JobMeta | JobMeta[]>`.
- `JobService.result(jobId): Promise<JobResultView>`.
- `JobService.continue(input): Promise<{ jobId: string; status: 'queued' }>`.
- `JobService.cancel(jobId): Promise<JobMeta>`.
- Exports `runWorker(jobId, dependencies): Promise<void>`.

- [x] **Step 1: Write failing immediate-return and recovery tests**

Use an injected worker launcher that blocks after spawn. Assert `start` returns after durable creation and detached launch, not after Claude. Cover queued, running, completed, failed, cancelled, and timed-out states plus stale-worker recovery.

- [x] **Step 2: Write failing continuation and cancellation tests**

Assert continuation preserves the Claude session ID, model, role, and access context while allowing effort and schema overrides. Spawn a mock CLI child tree and assert cancellation terminates every child, worker writes `cancelled`, and timeout writes `timed-out` with partial output.

- [x] **Step 3: Verify RED**

Run: `npm test -- plugins/hydra/tests/job-service.test.ts plugins/hydra/tests/worker.integration.test.ts`

- [x] **Step 4: Implement detached worker launch**

Use `spawn(process.execPath, [workerBundlePath, '--job-id', jobId, '--state-root', stateRoot], { detached: true, shell: false, stdio: 'ignore' })`, persist the PID, call `unref`, and return the job ID.

- [x] **Step 5: Implement worker orchestration and durable partial output**

Claim a slot, prepare access, transition to running, invoke the adapter, append events and stderr, update heartbeats, validate model identity, save the session, collect repository evidence, write the result, transition to the terminal state, and release the slot in `finally`.

- [x] **Step 6: Implement process-group cancellation**

Persist Claude's group ID before output processing. Send `SIGTERM` to `-pgid`, wait `cancellationGraceMs`, test liveness with signal `0`, then send `SIGKILL`. Never target an unvalidated positive or zero group ID.

- [x] **Step 7: Verify GREEN**

Run: `npm test -- plugins/hydra/tests/job-service.test.ts plugins/hydra/tests/worker.integration.test.ts && npm run typecheck && npm run lint`

## Task 11: Deterministic routing policy

**Files:**

- Create: `plugins/hydra/src/policy.ts`
- Test: `plugins/hydra/tests/policy.test.ts`

**Interfaces:**

- Produces `PolicyEngine.route(input): RouteRecommendation`.
- Route names: `FAST`, `STANDARD`, `HARD_DEBUG`, `ARCHITECTURE`, `LONG_HORIZON_UNKNOWN`, `PRE_MERGE_HIGH_RISK`, and `MAXIMUM`.

- [x] **Step 1: Write a failing decision-table test**

Create one explicit test row for every route, boundary risk level, write requirement, ambiguity level, novelty level, user mode, and host-model invariant. Assert maximum three Claude sessions and one Fable session.

- [x] **Step 2: Verify RED**

Run: `npm test -- plugins/hydra/tests/policy.test.ts`

- [x] **Step 3: Implement ordered pure rules**

Evaluate explicit `maximum` first, then pre-merge critical review, long-horizon novelty, architecture, hard debugging, standard review, and fast local work. Return recommendations only; never launch a job or alter the host model.

- [x] **Step 4: Verify GREEN**

Run: `npm test -- plugins/hydra/tests/policy.test.ts && npm run typecheck && npm run lint`

## Task 12: STDIO MCP server and all tool contracts

**Files:**

- Create: `plugins/hydra/src/server.ts`
- Test: `plugins/hydra/tests/server.test.ts`

**Interfaces:**

- Registers `hydra_preflight`, `hydra_route`, `hydra_start`, `hydra_status`, `hydra_result`, `hydra_continue`, `hydra_cancel`, and `hydra_record_outcome`.
- Starts `StdioServerTransport` only from the executable entry point.

- [x] **Step 1: Write failing in-memory MCP tests**

List tools and assert exact names, input schemas, descriptions, and annotations. Call each tool through an in-memory client with fake services. Assert validation errors contain no secrets and job tools return JSON-compatible structured content.

- [x] **Step 2: Verify RED**

Run: `npm test -- plugins/hydra/tests/server.test.ts`

- [x] **Step 3: Implement service construction and registrations**

Mark preflight, route, status, and result with `readOnlyHint: true`. Mark start, continue, cancel, and record-outcome as mutating. State in start and continue descriptions that external Claude invocation consumes subscription allowance.

- [x] **Step 4: Implement clean STDIO behavior**

Write protocol data only to standard output. Send diagnostics to standard error. Handle `SIGTERM` and `SIGINT` by closing the MCP transport without cancelling detached jobs.

- [x] **Step 5: Verify GREEN and bundled startup**

Run: `npm test -- plugins/hydra/tests/server.test.ts && npm run build && npm run typecheck && npm run lint`

Start `node plugins/hydra/dist/server.js`, send MCP initialize and tools/list messages from a test client, and require a clean response.

## Task 13: Packaged Codex skills and user documentation

**Files:**

- Create: `plugins/hydra/skills/hydra-orchestrate/SKILL.md`
- Create: `plugins/hydra/skills/hydra-review/SKILL.md`
- Create: `plugins/hydra/skills/hydra-panel/SKILL.md`
- Create: `plugins/hydra/README.md`
- Test: `plugins/hydra/tests/plugin-content.test.ts`

**Interfaces:**

- Orchestrate skill classifies, calls `hydra_route`, starts only justified jobs, verifies results, and stops on evidence.
- Review skill uses analyze mode and returns only repository-verified structured findings.
- Panel skill implements the Phase 3 orchestration protocol over the eight core MCP tools and enforces all member and round limits.

- [x] **Step 1: Write failing content tests**

Assert all skill names, MCP tool references, maximum counts, evidence schema, stopping rules, no burn skill, no advisor-based Fable, and README sections required by acceptance criterion 31.

- [x] **Step 2: Verify RED**

Run: `npm test -- plugins/hydra/tests/plugin-content.test.ts`

- [x] **Step 3: Write the three skills**

Use imperative workflows, exact tool names, bounded loops, independent first-round context, anonymous proposal labels, and a mandatory local evidence check before Sol accepts a claim. Implement Phase 3 as orchestration over independent core jobs rather than a separate panel daemon.

- [x] **Step 4: Write installation and security documentation**

Document repo-local marketplace installation, `claude auth status`, minimum CLI version, `claude install latest`, disabling usage credits in Claude Settings > Usage, state paths and permissions, supported platforms, model routing, quota visibility limits, worktree preservation, cancellation, and troubleshooting codes.

- [x] **Step 5: Verify GREEN and plugin validation**

Run:

```bash
npm test -- plugins/hydra/tests/plugin-content.test.ts
npm run validate:plugin
npm run typecheck
npm run lint
```

## Task 14: End-to-end mock CLI acceptance suite

**Files:**

- Create: `plugins/hydra/tests/acceptance.mock.test.ts`
- Extend: `plugins/hydra/tests/helpers/mock-claude.mjs`

**Interfaces:**

- Exercises built server, detached worker, filesystem state, Git worktrees, and mock Claude as one system.

- [x] **Step 1: Write failing acceptance scenarios**

Cover criteria 1–28 that do not require a real subscription: preflight, prohibited auth, source scans, immediate ID, all states, result/session, resume, model recording, strict substitution, malformed JSONL, cancellation, timeout partials, analyze immutability, test/execute worktrees, unique concurrent worktrees, traversal, no shell, restart slots, bounded panel policy/content, default no-real-CLI behavior, and all static commands.

- [x] **Step 2: Verify RED and diagnose only expected gaps**

Run: `npm test -- plugins/hydra/tests/acceptance.mock.test.ts`

- [x] **Step 3: Add only missing integration wiring**

Keep behavior in existing focused services. Add test helpers for executable discovery, detached-worker polling, and temporary state cleanup; do not duplicate production logic in the test.

- [x] **Step 4: Verify GREEN repeatedly**

Run the acceptance file three times, then run the complete suite:

```bash
npm test -- plugins/hydra/tests/acceptance.mock.test.ts
npm test -- plugins/hydra/tests/acceptance.mock.test.ts
npm test -- plugins/hydra/tests/acceptance.mock.test.ts
npm run check
```

## Task 15: Opt-in real Claude event fixture and model probes

**Files:**

- Create: `plugins/hydra/tests/real-claude.smoke.test.ts`
- Create: `plugins/hydra/tests/fixtures/claude-sonnet-2.1.228.sanitized.jsonl`
- Create: `plugins/hydra/tests/fixtures/claude-sonnet-2.1.228.expected.json`
- Create only after successful probes: Opus and Fable sanitized fixtures.

**Interfaces:**

- Runs only when `HYDRA_REAL_CLAUDE_SMOKE=1`.
- Uses the production adapter with analyze tools, low effort, one Hydra-enforced turn, and a small JSON schema.

- [x] **Step 1: Write the skipped-by-default smoke test**

Assert a normal `npm test` reports the suite as skipped and never resolves the real `claude` binary.

- [x] **Step 2: Run production preflight before consuming allowance**

Require version `2.1.228` or newer, first-party Max auth, no prohibited routing, required flags, and explicit environment opt-in.

- [x] **Step 3: Run the minimal Sonnet probe**

Use the prompt `Return JSON with ok=true and label="hydra-smoke". Do not read or modify files.` with model `sonnet`, effort `low`, analyze access, and schema requiring `ok` and `label`.

- [x] **Step 4: Sanitize and review captured events**

Reject fixtures containing the user's email, home path, organization ID, bearer tokens, OAuth strings, or environment values. Retain event types and structural fields needed by parser tests.

- [x] **Step 5: Re-run parser and adapter tests against the real fixture**

Run: `npm test -- plugins/hydra/tests/stream-json.test.ts plugins/hydra/tests/claude-cli.test.ts`

- [x] **Step 6: Run explicit Opus, Fable, resume, and cancellation probes**

Run one low-effort, one-turn structured probe per model, resume the Sonnet session with `Return JSON with continued=true`, and cancel a harmless delayed test job. Record actual resolved models and warnings. Stop immediately on rate limit, unexpected billing/auth, model substitution in strict mode, or sandbox failure.

## Task 16: Local marketplace installation and Codex invocation

**Files:**

- Modify only through helper: `plugins/hydra/.codex-plugin/plugin.json` cachebuster
- Validate: `.agents/plugins/marketplace.json`

**Interfaces:**

- Installs `hydra@hydra-local` from the repo-local marketplace.
- Makes eight MCP tools visible in a new Codex task.

- [x] **Step 1: Build and validate final plugin source**

Run: `npm run check && npm run build && npm run validate:plugin`

- [x] **Step 2: Configure the repo-local marketplace if absent**

Run: `codex plugin marketplace list`. If the repository marketplace root is absent, run `codex plugin marketplace add "$PWD"`.

- [x] **Step 3: Add the validated plugin**

Run: `codex plugin add hydra@hydra-local`.

- [x] **Step 4: Verify installation without editing marketplace files**

Run: `codex plugin list` and require Hydra to appear from the local source. Inspect the installed cache and require `.mcp.json`, both bundles, three skills, and no credential file.

- [x] **Step 5: Verify Codex MCP discovery in a new task boundary**

Start a fresh Codex CLI session with a harmless prompt that calls `hydra_preflight`, then run one Sonnet review, Opus review, Fable analysis, continuation, and cancellation through Hydra. Record exact successful and failed checks without claiming unrun paths.

## Task 17: Final security, regression, and release audit

**Files:**

- Create: `docs/verification/2026-08-12-hydra-core.md`
- Modify: `plugins/hydra/README.md` only if verified behavior differs from documentation.

**Interfaces:**

- Produces a checked acceptance matrix for criteria 1–31.

- [x] **Step 1: Run prohibited-pattern scans**

Scan source, bundles, docs, fixtures, and state samples for `--bare`, private Claude.ai usage endpoints, API key fallbacks, shell execution, dangerous permission modes, credentials, account identifiers, and unsanitized home paths. Distinguish explanatory documentation from executable source.

- [x] **Step 2: Run the full deterministic verification suite**

Run:

```bash
npm test
npm run lint
npm run typecheck
npm run build
npm run validate:plugin
git diff --check
```

- [x] **Step 3: Inspect repository and main-checkout evidence**

Run `git status --short`, inspect the complete diff, list preserved Hydra worktrees, and compare the main checkout snapshot from before and after real jobs.

- [x] **Step 4: Write the verification report from observed output**

For each acceptance criterion, mark `PASS`, `FAIL`, or `NOT RUN`; cite the exact test or command. List CLI `2.1.228`, actual resolved models, smoke fixture paths, installation result, unresolved sandbox risks, and quota visibility limitations.

- [x] **Step 5: Re-run checks affected by documentation corrections**

If the report exposes a discrepancy, fix it with a failing test when behavior changes, then rerun the narrow check and the complete deterministic suite.
