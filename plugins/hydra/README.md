# Hydra

Hydra is a local Codex plugin for bounded engineering delegation to the installed Claude Code CLI. It uses the active Claude.ai Pro or Max login. Codex remains the orchestrator, verifier, implementation owner, and merge authority.

Hydra 1.0 exposes nine STDIO MCP tools:

- `hydra_preflight`: verify the local Claude and subscription boundary;
- `hydra_route`: compute a deterministic staged delegation plan without launching a model;
- `hydra_start`: create a durable background job;
- `hydra_status`: inspect one job or recent jobs and storage health;
- `hydra_result`: read paginated sanitized events and durable output;
- `hydra_continue`: resume one saved Claude session exclusively;
- `hydra_cancel`: cancel a validated process group;
- `hydra_record_outcome`: store a verified verdict for a terminal job;
- `hydra_budget`: record manual allowance evidence and inspect pacing decisions.

Every tool publishes the same strict response envelope. `response.ok` is the required
discriminator; success requires `data` and `warnings`, while failure requires `error`:

```json
{
  "schemaVersion": 1,
  "hydraVersion": "1.0.0",
  "response": {
    "ok": true,
    "data": {},
    "warnings": []
  }
}
```

## 1.0 support boundary

| Area | 1.0 contract |
|---|---|
| Maintained platform | macOS arm64 |
| Community platform | Linux code paths exist but are unverified and have no maintainer SLA |
| Unsupported platform | Windows |
| Runtime | Node.js 20.9 or newer, Git, Claude Code 2.1.228 or newer |
| Authentication | Local Claude.ai Pro or Max login through Claude Code |
| Billing | Subscription-only; API keys, gateways, cloud providers, and automatic model fallback are rejected |
| Models | `sonnet`, `opus`, `fable`, or a full Claude Sonnet/Opus/Fable model ID |
| Publication | Source and reproducible plugin bundle; npm and marketplace publication are outside 1.0 |

Linux contributions are welcome. Promotion to a maintained platform requires a named owner and CI evidence for process identity, cancellation trees, settings discovery, sandboxing, filesystem isolation, and the subscription boundary.

## Quick start

```bash
npm install
npm run check
codex plugin marketplace add "$(pwd)"
codex plugin add hydra@hydra-local
codex plugin list
```

Open a new Codex task after installation so MCP discovery starts from a fresh task boundary. If `hydra-local` is already present in `codex plugin marketplace list`, do not add it again.

Before invoking a model:

```bash
claude --version
claude auth status
```

Hydra requires `authMethod: "claude.ai"`, `apiProvider: "firstParty"`, and a Pro or Max subscription. If authentication has expired, run `claude auth login --claudeai` interactively, then rerun `hydra_preflight`.

If the CLI is older than the maintained baseline, run `claude install latest` and repeat both checks.

## Paid-usage boundary

Claude Code cannot reliably expose the account-level usage-credit switch to a headless local process. Disable usage credits manually in **Claude Settings > Usage** before running Hydra if paid overflow must be impossible.

Every manual budget snapshot includes `usageCreditsDisabledAttestedAt`. Hydra treats that value as a user attestation, not account telemetry. Fable can require credits after plan allowance is exhausted; Hydra fails closed with `USAGE_CREDITS_REQUIRED` and never substitutes another model.

Preflight therefore reports `usageCreditsState: "unknown"` and `manualCheckRequired: true` instead of claiming it inspected the account switch.

Hydra does not:

- read OAuth token values;
- call undocumented usage endpoints;
- scrape Claude.ai or automate a browser;
- infer remaining allowance from token or cost fields;
- switch to API billing;
- manufacture work to consume expiring allowance.

## Normal workflow

1. Call `hydra_preflight` for the target repository.
2. Call `hydra_budget` with `{"action":"status"}` before optional delegation.
3. Build one bounded evidence capsule and call `hydra_route` when delegation is not already explicit.
4. Start only sessions whose activation is `immediate`.
5. Poll `hydra_status`; do not hold one model call open as a monitor.
6. Read `hydra_result` after a terminal state.
7. Verify accepted claims against the repository and tests.
8. Record the verified result with `hydra_record_outcome`.

An external `hydra_start` or `hydra_continue` consumes Claude subscription allowance. Route, status, result, preflight, and budget evaluation do not invoke Claude.

## Access modes

| Mode | Claude capability | Isolation |
|---|---|---|
| `analyze` | Scoped Read, Glob, and Grep | Canonical repository, before/after byte-bounded fingerprint |
| `test` | Bash without edit tools | Dedicated detached Git worktree, strict empty network allowlist |
| `execute` | Bash plus scoped Edit and Write | Dedicated detached Git worktree, strict empty network allowlist |

Test and execute require at least one Git commit. Analyze supports a newly initialized repository without `HEAD`.

Controlled context is unconditional. Every invocation disables external setting sources, hooks, automatic memory, project MCP servers, WebFetch, and WebSearch. Read permissions are scoped to the canonical repository or worktree plus the job temporary directory. Ambiguous permission-pattern paths fail closed.

Git preparation is hardened against repository hooks, filters, text conversion, and fsmonitor execution. Hydra never resets the main checkout, applies a patch, commits, pushes, or deletes a useful worktree automatically.

## Staged routing and context economics

The default is one strongest justified lead. More sessions are allowed only when the plan names disjoint scopes or an independent judgment requirement.

| Route | Default staged recommendation |
|---|---|
| `FAST` | Codex only |
| `STANDARD` | Sonnet high when delegation is justified |
| `HARD_DEBUG` | Sonnet xhigh lead, conditional Opus escalation |
| `ARCHITECTURE` | Opus xhigh lead, conditional Fable for unresolved long-horizon uncertainty |
| `LONG_HORIZON_UNKNOWN` | Fable exploration followed by Opus verification when required |
| `PRE_MERGE_HIGH_RISK` | Opus adversarial lead with conditional checks |
| `MAXIMUM` | One lead by default; explicit independent panel can start two immediate members |

Hard limits are three fresh Claude sessions per plan, one Fable session, two rounds, two concurrent Claude jobs, and one concurrent Fable job by default. A route-required second immediate panel member is quality-floor work. A conditional or manually added session is opportunistic and must provide distinct expected information gain.

For delegated jobs, budget priority comes from the immutable activation plan. A caller cannot relabel conditional or manual fan-out as quality-floor work. Delegation records written by the pre-1.0 context-accounting schema retain their legacy digest and migrate to the canonical 1.0 digest on the next valid activation.

Every fresh session receives one canonical evidence capsule plus one role-specific delta:

- capsule maximum: 32,768 UTF-8 bytes;
- role delta maximum: 4,096 UTF-8 bytes;
- independent proposal maximum: 8,192 UTF-8 bytes;
- deduplicated critique bundle maximum: 24,576 UTF-8 bytes.

Do not replay the host conversation or another model's raw transcript. Evidence is referenced by path, line, command, or digest. `replicatedContextBytesImmediate`, `replicatedContextBytesAllActivated`, and the durable `replicatedContextBytesActivated` measure capsule bytes only. They are not token, cache, cost, or remaining-allowance estimates.

This rule addresses a common fan-out failure: several cheaper agents can cost more than one stronger call because each rereads the same context. Hydra therefore prefers one strong lead and permits extra sessions only for a named, non-duplicative question.

## Allowance pacing

`hydra_budget` accepts only manual basis-point snapshots. One basis point is 0.01 percentage point of the value shown by the account UI. `measurementGranularityBasisPoints` records the UI's measurement step; a displayed zero delta is censored at that granularity instead of being treated as free work.

Example:

```json
{
  "action": "record",
  "snapshot": {
    "schemaVersion": 1,
    "source": "manual-settings",
    "measurementGranularityBasisPoints": 100,
    "capturedAt": "2026-08-13T09:00:00.000Z",
    "usageCreditsDisabledAttestedAt": "2026-08-13T09:00:00.000Z",
    "exclusiveHydraActivitySincePreviousSnapshot": true,
    "buckets": [
      {
        "bucketId": "weekly-all",
        "displayLabel": "Weekly all models",
        "window": "weekly",
        "appliesTo": ["all"],
        "capturedAt": "2026-08-13T09:00:00.000Z",
        "cycleStartedAt": "2026-08-06T12:00:00.000Z",
        "resetAt": "2026-08-13T12:00:00.000Z",
        "remainingBasisPoints": 1800
      }
    ]
  }
}
```

The weekly target is computed with fixed-point integer arithmetic:

- cycle start: target 10,000 basis points remaining;
- 24 hours before reset: target 2,000 basis points remaining;
- 2 hours before reset: target 300 basis points remaining;
- final 2 hours: preserve the 300-basis-point finish reserve.

Five-hour buckets use a hard reserve floor. Hydra does not claim to know an intra-window pacing curve that the account UI does not expose. The tightest applicable bucket controls admission.

Forecast cohorts are exact across resolved model, Claude version, effort, access mode, context-size class, and turn class. Input, output, cache-read, and cache-creation tokens remain separate. Hydra uses the local empirical upper order statistic; it does not call a token-counting or pricing endpoint.

Final burn requires all of the following:

- reset is within 24 hours but outside the final 2-hour finish buffer;
- snapshot and usage-credit attestation are no more than 60 minutes old;
- at least 19 matching terminal usage observations and matching allowance observations exist for every applicable bucket;
- the resulting order-statistic coverage measure is at least 9,500 basis points;
- forecast, active reservations, UI measurement granularity, and a 100-basis-point rounding margin fit every bucket;
- the task is declared valuable;
- optional fan-out has distinct expected information gain.

The coverage measure is a local order-statistic policy under an exchangeable-workload assumption, not a universal 95% statistical guarantee. With 5 samples it is 8,333 basis points; with 19 samples it reaches 9,500. If multiple complete Hydra jobs occur between two exclusive snapshots, Hydra conservatively attributes the full observed interval consumption to every job. This can overestimate spend but cannot create a falsely cheap cohort.

Quality floors are lexicographic: Hydra never downgrades a required model or effort to save allowance. Missing, stale, uncalibrated, or corrupt budget evidence defers optional work. Explicit quality-floor work remains available and carries a typed warning. Unused expiring allowance is an acceptable outcome when no valuable backlog item satisfies the safety gates.

## Durable state

The default state root is `~/.hydra`:

```text
~/.hydra/
├── config.json
├── jobs/<jobId>/{meta.json,events.jsonl,stderr.log,result.json}
├── sessions/<sessionId>.json
├── delegations/<groupId>.json
├── outcomes/<jobId>.json
├── budget/
│   ├── active.json
│   ├── snapshots/<snapshotId>.json
│   ├── calibration/<observationId>.json
│   ├── reservations/<jobId>.json
│   └── reservation-releases/<jobId>.json
├── worktrees/<repoHash>/<jobId>/
└── locks/
```

`config.json` is a versioned override envelope. Each queued job snapshots its complete effective runtime and security policy so later configuration changes cannot alter that job.

Directories use mode `0700`; state files use mode `0600`. JSON writes use same-directory temporary files, synchronization, and atomic rename. Terminal results are immutable. Cross-process locks serialize job finalization, session continuation, budget admission, and concurrency slots.

Sanitized event storage is byte-bounded. `hydra_result` returns at most 200 events by default and supports `eventOffset` plus `eventLimit`. Secret-shaped fields, authorization data, email addresses, and home-directory prefixes are redacted. Rejected result fields retain only field name, byte length, and SHA-256 digest. Do not place credentials in tasks, roles, schemas, notes, configuration, or repository output.

If manifest validation, config loading, or retention fails, Hydra starts in degraded read-only mode. All nine tools remain discoverable. Start, continue, cancel, outcome recording, and snapshot recording fail with `HYDRA_DEGRADED_READ_ONLY` until the local state is repaired and the server restarts. Status, result, and budget inspection skip recovery and reservation reconciliation so a diagnostic read cannot mutate suspect durable state.

## Cancellation and recovery

Detached workers survive MCP shutdown. Hydra stores worker and Claude process-start markers, not only numeric PIDs. Cancellation signals only an identity-matching process group, sends `SIGTERM`, waits the configured grace period, then uses `SIGKILL` if necessary. Recovery reconciles immutable terminal results, stale queued workers, stale running workers, orphan Claude groups, and crash-truncated JSONL tails.

Continuation of test or execute jobs reuses the preserved worktree and nested working-directory subpath. One durable per-session claim permits only one active continuation. The session snapshots model, effort, role, access mode, turn limit, timeout, and delegation identity.

## Troubleshooting

| Code or symptom | Action |
|---|---|
| `CLAUDE_VERSION_UNSUPPORTED` | Update Claude Code and rerun preflight. |
| `SUBSCRIPTION_AUTH_REQUIRED` | Run `claude auth login --claudeai`, then rerun preflight. |
| `PROHIBITED_ENVIRONMENT` | Remove the named credential or provider-routing variable from the Hydra environment. |
| `PROHIBITED_SETTING` | Remove the named API-key helper, hook, gateway, or cloud-provider setting. |
| `MODEL_MISMATCH` | Inspect the recorded requested, resolved, canonical, and reported models. |
| `USAGE_CREDITS_REQUIRED` | Disable paid usage credits or wait for subscription allowance; Hydra does not fall back. |
| `JOB_QUEUE_FULL` | Wait for an active job to become terminal. |
| `SESSION_BUSY` | Wait for the active continuation to finish. |
| `BUDGET_ADMISSION_DEFERRED` | Refresh manual evidence or keep the work as quality-floor only if it is genuinely required. |
| `BUDGET_FORECAST_COVERAGE_INSUFFICIENT` | Accumulate at least 19 clean exact-cohort observations; do not force final burn. |
| `HYDRA_DEGRADED_READ_ONLY` | Repair the issue shown by `hydra_status.health`, then restart Hydra. |
| `REPOSITORY_SNAPSHOT_LIMIT` | Reduce ignored build-cache scope or use a smaller repository. |
| `UNSAFE_PERMISSION_PATH` | Move the repository or state root away from permission-pattern metacharacters. |
| `ANALYZE_REPOSITORY_CHANGED` | Preserve and inspect the change; Hydra intentionally does not reset it. |
| `GIT_COMMIT_REQUIRED` | Create the first commit before test or execute mode. |

Normal `npm test` uses a mock Claude CLI and consumes no subscription allowance. Real Claude and isolation smoke tests are opt-in only.

See [SECURITY.md](../../SECURITY.md), [CONTRIBUTING.md](../../CONTRIBUTING.md), the architecture decisions under [docs/adr](../../docs/adr), and [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).
