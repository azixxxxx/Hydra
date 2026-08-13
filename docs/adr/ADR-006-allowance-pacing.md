# ADR-006: Pace manual allowance evidence with conservative fixed-point math

## Status

Accepted for Hydra 1.0.

## Context

Claude Max does not expose a supported headless remaining-quota API. Run-level tokens and estimated cost do not identify plan allowance. The maintainer wants economical weekly use and aggressive use of valuable backlog in the final day without risking paid overflow or reducing required quality.

## Decision

Hydra accepts append-only manual snapshots in integer basis points and never retrieves account quota itself.

- Record absolute capture, cycle-start, and reset instants for each five-hour or weekly bucket.
- Record the account UI measurement granularity and treat displayed zero deltas as censored at that granularity.
- Keep input, output, cache-read, and cache-creation usage separate.
- Forecast only exact cohorts: resolved model, Claude version, effort, access mode, context-size class, and turn class.
- Use the empirical upper order statistic. Report its sample-size-derived coverage measure separately from the selected 9,500-basis-point quantile.
- Require at least 19 matching usage and allowance observations before final burn can claim a 9,500-basis-point order-statistic coverage measure.
- Attribute the full interval delta to every complete job when multiple Hydra jobs occur between exclusive snapshots. This deliberately overestimates consumption.
- Reserve every applicable bucket at admission, including the UI measurement floor, and serialize admission across processes.
- Let the tightest bucket decide. Five-hour buckets use a hard reserve floor.
- Move the weekly remaining target from 10,000 basis points at cycle start to 2,000 at 24 hours, then to 300 at 2 hours. Preserve the final two-hour reserve.
- Admit final-burn work only with fresh snapshot and credit attestation, calibrated positive surplus, useful work, and distinct information gain for optional fan-out.
- Preserve the requested model and effort as a quality floor in every mode.

## Consequences

Hydra can use a verified surplus more aggressively during the last day while remaining conservative about quantization, in-flight work, and sparse evidence. It can leave allowance unused. The coverage measure assumes comparable future work and is not a universal 95% guarantee.

Corrupt or stale budget evidence defers opportunistic work. Required quality-floor work may continue with an explicit unavailable-state warning because allowance policy cannot override correctness or an explicit user requirement.

## Rejected alternatives

- Scraping Claude.ai or private endpoints: unsupported and outside the subscription boundary.
- Treating cost estimates as quota: they measure a different quantity.
- Synthetic burn tasks: allowance expiry is not useful work.
- Cross-model conversion ratios: no verified local evidence supports them.
- Five-hour interpolation: the available evidence does not define a trustworthy intra-window curve.
