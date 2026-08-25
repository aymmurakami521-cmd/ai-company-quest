/**
 * Strict, fail-closed validation for sanitized JSONL lines.
 *
 * Guarantees provided to every downstream consumer (reducer, store, SSE):
 * - The returned object is built key by key from a whitelist. Unknown keys from
 *   the producer are dropped, never forwarded.
 * - Every string field has passed a content scan for absolute paths, shell
 *   commands and credential-shaped substrings.
 * - `schema_version` is the only compatibility gate. `sanitizer_version` is
 *   recorded but never gates acceptance.
 *
 * Rejection details are intentionally content-free: they name the failing field
 * and rule, never the offending text.
 */

import type { SanitizedEvent } from './event.ts';
import { REQUIRED_KEYS, SUPPORTED_SCHEMA_VERSION } from './event.ts';

export type RejectReason =
  | 'blank'
  | 'oversized_line'
  | 'not_json'
  | 'not_object'
  | 'unsupported_schema'
  | 'missing_key'
  | 'type_error'
  | 'invalid_format'
  | 'field_too_long'
  | 'unsafe_content';

export type ValidationResult =
  | { ok: true; event: SanitizedEvent; dropped_keys: string[] }
  | { ok: false; reason: RejectReason; detail: string };

export const DEFAULT_MAX_LINE_BYTES = 64 * 1024;

const MAX_SUMMARY_CHARS = 256;
const MAX_LABEL_CHARS = 128;

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ID_SLUG = /^[A-Za-z0-9._:-]{1,128}$/;
const EVENT_TYPE_SLUG = /^[a-z][a-z0-9_]{0,63}$/;
const LABEL_SLUG = /^[A-Za-z0-9_.:@#| -]{1,128}$/;
const ISO_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;
/** True when the value contains C0/C7F control characters (tab included). */
function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

type UnsafeRule = { id: string; re: RegExp; blobOnly?: boolean };

/**
 * Content rules. A single match rejects the whole event (fail closed): the
 * collector never attempts to repair or redact producer output.
 */
const UNSAFE_RULES: UnsafeRule[] = [
  { id: 'posix_path', re: /(^|[^A-Za-z0-9_])\/(Users|home|root|etc|var|private|tmp|opt|usr|srv|mnt|proc|Volumes|Applications|Library)(\/|$)/ },
  { id: 'home_path', re: /(^|[^A-Za-z0-9_])~\// },
  { id: 'windows_path', re: /(^|[^A-Za-z0-9_])[A-Za-z]:[\\/](Users|Windows|Program)/i },
  { id: 'unc_path', re: /\\\\[A-Za-z0-9_.-]+\\/ },
  { id: 'file_url', re: /file:\/\//i },
  { id: 'private_key_block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { id: 'anthropic_key', re: /sk-ant-[A-Za-z0-9_-]{8,}/ },
  { id: 'openai_key', re: /(^|[^A-Za-z0-9])sk-[A-Za-z0-9]{16,}/ },
  { id: 'github_token', re: /(^|[^A-Za-z0-9])(gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,})/ },
  { id: 'aws_access_key', re: /(^|[^A-Za-z0-9])AKIA[0-9A-Z]{16}([^A-Za-z0-9]|$)/ },
  { id: 'slack_token', re: /(^|[^A-Za-z0-9])xox[abprs]-[A-Za-z0-9-]{8,}/ },
  { id: 'jwt', re: /(^|[^A-Za-z0-9])eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./ },
  { id: 'bearer_token', re: /[Bb]earer\s+[A-Za-z0-9._~+/-]{16,}/ },
  { id: 'secret_assignment', re: /(api[_-]?key|secret|password|passwd|token|credential)\s*[:=]\s*\S{6,}/i },
  { id: 'env_export', re: /(^|[^A-Za-z0-9_])export\s+[A-Z0-9_]{3,}\s*=/ },
  { id: 'shell_command', re: /(^|[^A-Za-z0-9_])(sudo\s|rm\s+-rf|curl\s+-|wget\s+http|ssh\s+[A-Za-z0-9_.-]+@)/ },
  { id: 'long_opaque_blob', re: /[A-Za-z0-9+/]{48,}={0,2}/, blobOnly: true },
];

/** True for a lowercase canonical UUIDv4, the only accepted `event_id` shape. */
export function isUuidV4(value: string): boolean {
  return UUID_V4.test(value);
}

/** Returns the id of the first matching unsafe rule, or null. */
export function scanUnsafe(value: string, options: { includeBlobRule?: boolean } = {}): string | null {
  const includeBlob = options.includeBlobRule === true;
  for (const rule of UNSAFE_RULES) {
    if (rule.blobOnly === true && !includeBlob) continue;
    if (rule.re.test(value)) return rule.id;
  }
  return null;
}

function fail(reason: RejectReason, detail: string): ValidationResult {
  return { ok: false, reason, detail };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function checkNullableLabel(
  raw: Record<string, unknown>,
  key: string,
  pattern: RegExp,
): { ok: true; value: string | null } | { ok: false; result: ValidationResult } {
  const value = raw[key];
  if (value === null) return { ok: true, value: null };
  if (typeof value !== 'string') return { ok: false, result: fail('type_error', `${key}:expected_string_or_null`) };
  if (value.length > MAX_LABEL_CHARS) return { ok: false, result: fail('field_too_long', `${key}:max_${MAX_LABEL_CHARS}`) };
  if (!pattern.test(value)) return { ok: false, result: fail('invalid_format', `${key}:pattern`) };
  const unsafe = scanUnsafe(value);
  if (unsafe !== null) return { ok: false, result: fail('unsafe_content', `${key}:${unsafe}`) };
  return { ok: true, value };
}

function checkNullableCount(
  raw: Record<string, unknown>,
  key: string,
): { ok: true; value: number | null } | { ok: false; result: ValidationResult } {
  const value = raw[key];
  if (value === null) return { ok: true, value: null };
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return { ok: false, result: fail('type_error', `${key}:expected_finite_number_or_null`) };
  }
  if (!Number.isInteger(value) || value < 0) {
    return { ok: false, result: fail('invalid_format', `${key}:expected_non_negative_integer`) };
  }
  return { ok: true, value };
}

/**
 * Validates an already-parsed object against the schema_version 2 contract.
 */
export function validateEventObject(raw: unknown): ValidationResult {
  if (!isPlainObject(raw)) return fail('not_object', 'root:expected_object');

  // Compatibility gate first: an unsupported schema must not be interpreted at all.
  const schemaVersion = raw['schema_version'];
  if (typeof schemaVersion !== 'number' || !Number.isInteger(schemaVersion)) {
    return fail('type_error', 'schema_version:expected_integer');
  }
  if (schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
    return fail('unsupported_schema', `schema_version:${schemaVersion}`);
  }

  for (const key of REQUIRED_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(raw, key)) {
      return fail('missing_key', `${key}:absent`);
    }
  }

  // Observational only. Recorded, never used to accept or reject.
  const sanitizerVersion = raw['sanitizer_version'];
  if (typeof sanitizerVersion !== 'number' || !Number.isInteger(sanitizerVersion) || sanitizerVersion < 0) {
    return fail('type_error', 'sanitizer_version:expected_non_negative_integer');
  }

  const eventId = raw['event_id'];
  if (typeof eventId !== 'string') return fail('type_error', 'event_id:expected_string');
  if (!UUID_V4.test(eventId)) return fail('invalid_format', 'event_id:expected_uuid_v4');

  const sessionId = raw['session_id'];
  if (typeof sessionId !== 'string') return fail('type_error', 'session_id:expected_string');
  if (!ID_SLUG.test(sessionId)) return fail('invalid_format', 'session_id:pattern');
  const unsafeSession = scanUnsafe(sessionId);
  if (unsafeSession !== null) return fail('unsafe_content', `session_id:${unsafeSession}`);

  const ts = raw['ts'];
  if (typeof ts !== 'string') return fail('type_error', 'ts:expected_string');
  if (!ISO_TS.test(ts) || !Number.isFinite(Date.parse(ts))) return fail('invalid_format', 'ts:expected_iso8601');

  const eventType = raw['event_type'];
  if (typeof eventType !== 'string') return fail('type_error', 'event_type:expected_string');
  if (!EVENT_TYPE_SLUG.test(eventType)) return fail('invalid_format', 'event_type:pattern');

  const agentId = checkNullableLabel(raw, 'agent_id', ID_SLUG);
  if (!agentId.ok) return agentId.result;

  const agentRole = checkNullableLabel(raw, 'agent_role', LABEL_SLUG);
  if (!agentRole.ok) return agentRole.result;

  const status = checkNullableLabel(raw, 'status', LABEL_SLUG);
  if (!status.ok) return status.result;

  const toolName = checkNullableLabel(raw, 'tool_name', LABEL_SLUG);
  if (!toolName.ok) return toolName.result;

  const producerSeq = checkNullableCount(raw, 'producer_seq');
  if (!producerSeq.ok) return producerSeq.result;

  const durationMs = checkNullableCount(raw, 'duration_ms');
  if (!durationMs.ok) return durationMs.result;

  const tokenCount = checkNullableCount(raw, 'token_count');
  if (!tokenCount.ok) return tokenCount.result;

  const rawSummary = raw['summary'];
  let summary: string | null = null;
  if (rawSummary !== null) {
    if (typeof rawSummary !== 'string') return fail('type_error', 'summary:expected_string_or_null');
    if (rawSummary.length > MAX_SUMMARY_CHARS) return fail('field_too_long', `summary:max_${MAX_SUMMARY_CHARS}`);
    if (hasControlChars(rawSummary)) return fail('invalid_format', 'summary:control_characters');
    const unsafeSummary = scanUnsafe(rawSummary, { includeBlobRule: true });
    if (unsafeSummary !== null) return fail('unsafe_content', `summary:${unsafeSummary}`);
    summary = rawSummary;
  }

  const known = new Set<string>(REQUIRED_KEYS);
  const droppedKeys = Object.keys(raw).filter((key) => !known.has(key));

  // Explicit whitelist construction: producer keys are never spread in.
  const event: SanitizedEvent = {
    schema_version: schemaVersion,
    sanitizer_version: sanitizerVersion,
    event_id: eventId,
    session_id: sessionId,
    ts,
    event_type: eventType,
    agent_id: agentId.value,
    agent_role: agentRole.value,
    producer_seq: producerSeq.value,
    status: status.value,
    tool_name: toolName.value,
    duration_ms: durationMs.value,
    token_count: tokenCount.value,
    summary,
  };

  return { ok: true, event, dropped_keys: droppedKeys };
}

/**
 * Validates one raw JSONL line. Oversized lines are rejected before parsing.
 */
export function validateLine(line: string, options: { maxLineBytes?: number } = {}): ValidationResult {
  const maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
  if (Buffer.byteLength(line, 'utf8') > maxLineBytes) {
    return fail('oversized_line', `line:max_${maxLineBytes}_bytes`);
  }
  if (line.trim() === '') return fail('blank', 'line:empty');

  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return fail('not_json', 'line:json_parse_error');
  }
  return validateEventObject(parsed);
}
