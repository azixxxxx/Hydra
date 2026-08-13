# Security policy

Hydra executes a locally authenticated Claude Code CLI and persists sanitized local job state. Treat reports about credential exposure, sandbox escape, process-group cancellation, provider-routing bypass, or unauthorized filesystem writes as security issues.

Do not publish sensitive reproduction details in a public issue. Open a [private GitHub security advisory](https://github.com/azixxxxx/Hydra/security/advisories/new). Include the Hydra version, Claude Code version, macOS version, the smallest sanitized reproduction, and whether any credentials or external systems were affected.

The maintained 1.0 security boundary is macOS arm64. Linux paths are community-owned and unverified; Windows is unsupported.
