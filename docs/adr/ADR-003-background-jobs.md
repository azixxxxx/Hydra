# ADR-003: Run durable detached job workers

## Context

Claude jobs can outlive an MCP request or MCP server process. Codex must receive a job ID immediately and recover status after a restart.

## Decision

The MCP server writes a queued job record and starts a detached Node worker. The worker claims a filesystem concurrency slot, starts Claude in a separate process group, streams events, updates its heartbeat, writes a terminal result, and releases the slot. JSON state uses atomic replacement; event logs use append-only JSONL.

## Consequences

Completed jobs survive MCP restarts without a database. Cross-process locking and stale-worker recovery require careful PID and heartbeat checks. Partial output remains available after crashes.

## Rejected alternatives

Holding an MCP tool request open makes client timeouts part of job control. An in-memory queue loses jobs on restart. A native database adds installation and portability risk without enough benefit for the first release.
