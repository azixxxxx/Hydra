import { HydraError } from './domain.js';

const CANONICAL_REDACTION_PATTERN = /^\[REDACTED(?: PRIVATE KEY)?\]$/u;
const BEARER_PATTERN =
  /\bBearer\s+(?!\[REDACTED\](?=$|[^A-Za-z0-9]))[^\s"',}]+/iu;
const COMMON_SECRET_PATTERN = /\b(?:sk-ant-|sk-|oauth[_-]?)[A-Za-z0-9._-]{8,}\b/iu;
const ENV_SECRET_PATTERN =
  /\b[A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|KEY|AUTH|COOKIE|PAT|DSN|CREDENTIAL)[A-Z0-9_]*\s*[=:]\s*(?!\[REDACTED\](?=$|[^A-Za-z0-9]))(?:"[^"\n]*"|'[^'\n]*'|[^\s,;]+)/iu;
const PROVIDER_SECRET_PATTERN =
  /\b(?:AKIA[0-9A-Z]{16}|gh[opusr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/u;
const PRIVATE_KEY_PATTERN =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/u;

const BEARER_REPLACEMENT_PATTERN =
  /\bBearer\s+(?!\[REDACTED\](?=$|[^A-Za-z0-9]))[^\s"',}]+/giu;
const COMMON_SECRET_REPLACEMENT_PATTERN =
  /\b(?:sk-ant-|sk-|oauth[_-]?)[A-Za-z0-9._-]{8,}\b/giu;
const ENV_SECRET_REPLACEMENT_PATTERN =
  /\b([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|KEY|AUTH|COOKIE|PAT|DSN|CREDENTIAL)[A-Z0-9_]*)\s*([=:])\s*(?!\[REDACTED\](?=$|[^A-Za-z0-9]))(?:"[^"\n]*"|'[^'\n]*'|[^\s,;]+)/giu;
const PROVIDER_SECRET_REPLACEMENT_PATTERN =
  /\b(?:AKIA[0-9A-Z]{16}|gh[opusr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/gu;
const PRIVATE_KEY_REPLACEMENT_PATTERN =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/gu;

const SAFE_TOKEN_METRIC_KEYS = new Set([
  'input_tokens',
  'output_tokens',
  'cache_read_tokens',
  'cache_creation_tokens',
  'cache_read_input_tokens',
  'cache_creation_input_tokens',
  'total_tokens',
  'num_tokens',
]);

function normalizedKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/gu, '$1_$2')
    .replace(/[-.\s]+/gu, '_')
    .toLowerCase();
}

export function isSensitiveCredentialKey(key: string): boolean {
  const normalized = normalizedKey(key);
  if (SAFE_TOKEN_METRIC_KEYS.has(normalized)) {
    return false;
  }
  return /(?:^|_)(?:auth|authorization|access_token|refresh_token|oauth(?:_token)?|token|secret|password|cookie|credential(?:s)?|api_key|apikey)(?:_|$)/u.test(
    normalized,
  );
}

export function sanitizeCredentialText(value: string): string {
  return value
    .replace(PRIVATE_KEY_REPLACEMENT_PATTERN, '[REDACTED PRIVATE KEY]')
    .replace(BEARER_REPLACEMENT_PATTERN, 'Bearer [REDACTED]')
    .replace(COMMON_SECRET_REPLACEMENT_PATTERN, '[REDACTED]')
    .replace(PROVIDER_SECRET_REPLACEMENT_PATTERN, '[REDACTED]')
    .replace(ENV_SECRET_REPLACEMENT_PATTERN, '$1$2[REDACTED]');
}

function stringContainsCredentialShape(value: string): boolean {
  if (CANONICAL_REDACTION_PATTERN.test(value)) {
    return false;
  }
  return (
    BEARER_PATTERN.test(value) ||
    COMMON_SECRET_PATTERN.test(value) ||
    ENV_SECRET_PATTERN.test(value) ||
    PROVIDER_SECRET_PATTERN.test(value) ||
    PRIVATE_KEY_PATTERN.test(value)
  );
}

export function containsCredentialShape(value: unknown): boolean {
  const visit = (candidate: unknown, seen: WeakSet<object>): boolean => {
    if (typeof candidate === 'string') {
      return stringContainsCredentialShape(candidate);
    }
    if (candidate === null || typeof candidate !== 'object') {
      return false;
    }
    if (seen.has(candidate)) {
      return true;
    }
    seen.add(candidate);
    if (Array.isArray(candidate)) {
      const found = candidate.some((item) => visit(item, seen));
      seen.delete(candidate);
      return found;
    }
    for (const [key, child] of Object.entries(candidate)) {
      if (
        isSensitiveCredentialKey(key) &&
        (typeof child !== 'string' || !CANONICAL_REDACTION_PATTERN.test(child))
      ) {
        seen.delete(candidate);
        return true;
      }
      if (visit(child, seen)) {
        seen.delete(candidate);
        return true;
      }
    }
    seen.delete(candidate);
    return false;
  };
  return visit(value, new WeakSet<object>());
}

export function assertCredentialFree(value: unknown): void {
  if (containsCredentialShape(value)) {
    throw new HydraError(
      'CREDENTIAL_SHAPED_STATE',
      'Hydra refuses to persist credential-shaped data',
    );
  }
}
