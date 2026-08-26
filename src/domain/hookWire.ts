/**
 * External LIVE wire contract: the Claude Code Hook rich/nested schema.
 *
 * This module is the consumer-side statement of a contract that is *owned by the
 * producer* (`aymmurakami521-cmd/ai-company`, `scripts/quest-hook-emit.py`). It
 * is deliberately separate from `event.ts` / `validate.ts`, which describe the
 * internal normalized model this repository reduces and renders.
 *
 * Both shapes carry `schema_version: 2` and they are NOT compatible. The two are
 * never told apart by inspecting a payload: which contract applies is a
 * construction-time decision of the store (`inputContract`), so a rich event can
 * never be silently reinterpreted as a flat one, or the reverse.
 *
 * Rules that must not be relaxed:
 * - `schema_version` is the only compatibility gate. `sanitizer_version` is
 *   observational and never gates acceptance.
 * - Every modelled key must be present; absent information is an explicit
 *   `null`. Values outside the documented domains are fail-closed.
 * - `producer.kind` / `producer.env` are checked explicitly. A payload that does
 *   not announce itself as a local Claude Code hook is refused outright.
 * - The returned object is built key by key. Producer objects are never spread,
 *   so a field this module does not model cannot reach any consumer.
 * - Rejection details name a field path and a rule. They never contain a value.
 */

import { DEFAULT_MAX_LINE_BYTES, hasControlChars, isUuidV4, scanUnsafe } from './validate.ts';

/** The producer's schema version. Same number as the internal model, different shape. */
export const HOOK_WIRE_SCHEMA_VERSION = 2;

export const HOOK_PRODUCER_KIND = 'claude-code-hook';
export const HOOK_PRODUCER_ENV = 'local';

export type HookSessionSource = 'startup' | 'resume' | 'clear' | 'compact' | 'fork';
export type HookSessionEndReason = 'clear' | 'resume' | 'logout' | 'prompt_input_exit' | 'other';
export type HookToolCategory = 'read' | 'write' | 'exec' | 'search' | 'mcp' | 'delegate' | 'skill' | 'idle';
export type HookActivityKind = HookToolCategory | 'session' | 'permission' | 'task' | 'capacity';
export type HookFacility = 'desk' | 'shelf' | 'terminal' | 'search-terminal' | 'antenna' | 'meeting' | 'portal';
export type HookOutcomeStatus = 'started' | 'ok' | 'error' | 'waiting' | 'auto_denied' | 'limit_reached';
export type HookErrorKind =
  | 'rate_limit'
  | 'overloaded'
  | 'authentication_failed'
  | 'oauth_org_not_allowed'
  | 'billing_error'
  | 'invalid_request'
  | 'model_not_found'
  | 'server_error'
  | 'max_output_tokens'
  | 'unknown';
export type HookDenialKind = 'classifier_blocked' | 'classifier_unavailable' | 'unevaluable' | 'other';

export type HookWireEvent = {
  schema_version: number;
  /** Observational only, exactly like the internal model. */
  sanitizer_version: number;
  event_id: string;
  ts: string;
  producer: { kind: string; host_id: string; env: string };
  /** Nullable at the source: a hook can fire before a session is attributable. */
  session_id: string | null;
  prompt_id: string | null;
  agent: { id: string | null; type: string | null; parent_session_id: null };
  /** Null only for the capacity marker; see `hookAdapter.ts`. */
  hook_event: string | null;
  session: { source: HookSessionSource | null; end_reason: HookSessionEndReason | null };
  tool: { name: string | null; category: HookToolCategory | null; mcp_server: string | null; tool_use_id: string | null };
  skill: { name: string; source: null } | null;
  task: { id: string | null } | null;
  activity: { kind: HookActivityKind; facility: HookFacility; label: string };
  outcome: {
    status: HookOutcomeStatus | null;
    duration_ms: number | null;
    is_interrupt: boolean | null;
    error_kind: HookErrorKind | null;
    denial_kind: HookDenialKind | null;
  };
  workspace: { repo_id: string | null; bucket: string | null };
  truncated: false;
};

/**
 * Why an external wire line was refused. `unsupported_producer` is the only
 * reason that does not also exist for the internal model: it means the payload
 * did not identify itself as a local Claude Code hook event.
 */
export type HookWireRejectReason =
  | 'blank'
  | 'oversized_line'
  | 'not_json'
  | 'not_object'
  | 'unsupported_schema'
  | 'unsupported_producer'
  | 'missing_key'
  | 'type_error'
  | 'invalid_format'
  | 'field_too_long'
  | 'unsafe_content';

export type HookWireResult =
  | { ok: true; wire: HookWireEvent; dropped_keys: string[] }
  | { ok: false; reason: HookWireRejectReason; detail: string };

/** Top-level contract keys, in the order their absence is reported. */
export const HOOK_WIRE_KEYS = [
  'schema_version',
  'sanitizer_version',
  'event_id',
  'ts',
  'producer',
  'session_id',
  'prompt_id',
  'agent',
  'hook_event',
  'session',
  'tool',
  'skill',
  'task',
  'activity',
  'outcome',
  'workspace',
  'truncated',
] as const;

const PRODUCER_KEYS = ['kind', 'host_id', 'env'] as const;
const AGENT_KEYS = ['id', 'type', 'parent_session_id'] as const;
const SESSION_KEYS = ['source', 'end_reason'] as const;
const TOOL_KEYS = ['name', 'category', 'mcp_server', 'tool_use_id'] as const;
const SKILL_KEYS = ['name', 'source'] as const;
const TASK_KEYS = ['id'] as const;
const ACTIVITY_KEYS = ['kind', 'facility', 'label'] as const;
const OUTCOME_KEYS = ['status', 'duration_ms', 'is_interrupt', 'error_kind', 'denial_kind'] as const;
const WORKSPACE_KEYS = ['repo_id', 'bucket'] as const;

export const HOOK_SESSION_SOURCES: readonly HookSessionSource[] = ['startup', 'resume', 'clear', 'compact', 'fork'];
export const HOOK_SESSION_END_REASONS: readonly HookSessionEndReason[] = [
  'clear',
  'resume',
  'logout',
  'prompt_input_exit',
  'other',
];
export const HOOK_TOOL_CATEGORIES: readonly HookToolCategory[] = [
  'read',
  'write',
  'exec',
  'search',
  'mcp',
  'delegate',
  'skill',
  'idle',
];
export const HOOK_ACTIVITY_KINDS: readonly HookActivityKind[] = [
  ...HOOK_TOOL_CATEGORIES,
  'session',
  'permission',
  'task',
  'capacity',
];
export const HOOK_FACILITIES: readonly HookFacility[] = [
  'desk',
  'shelf',
  'terminal',
  'search-terminal',
  'antenna',
  'meeting',
  'portal',
];
export const HOOK_OUTCOME_STATUSES: readonly HookOutcomeStatus[] = [
  'started',
  'ok',
  'error',
  'waiting',
  'auto_denied',
  'limit_reached',
];
export const HOOK_ERROR_KINDS: readonly HookErrorKind[] = [
  'rate_limit',
  'overloaded',
  'authentication_failed',
  'oauth_org_not_allowed',
  'billing_error',
  'invalid_request',
  'model_not_found',
  'server_error',
  'max_output_tokens',
  'unknown',
];
export const HOOK_DENIAL_KINDS: readonly HookDenialKind[] = [
  'classifier_blocked',
  'classifier_unavailable',
  'unevaluable',
  'other',
];

/** Producer-side identifier charset (`session_id`, `prompt_id`, `agent.id`, `tool.name`). */
const HOOK_ID = /^[A-Za-z0-9_-]{1,128}$/;
/** Runtime agent type. Wider than `HOOK_ID` because it admits `:`. */
const HOOK_AGENT_TYPE = /^[A-Za-z0-9_:-]{1,64}$/;
const HOOK_EVENT_NAME = /^[A-Za-z][A-Za-z0-9]{0,63}$/;
/** First 12 hex digits of a hostname SHA-256. Not reversible, and dropped anyway. */
const HOOK_HOST_ID = /^[0-9a-f]{12}$/;
/** The producer emits UTC with exactly three fractional digits. */
const HOOK_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** Upper bound on `outcome.duration_ms` (24h), as documented by the producer. */
export const HOOK_MAX_DURATION_MS = 86_400_000;
const MAX_LABEL_CHARS = 256;
/** Ceiling for a modelled-but-dropped opaque string, so a huge value fails closed. */
const MAX_OPAQUE_CHARS = 256;

/**
 * Internal control-flow signal for the first failing rule.
 *
 * Validating seventeen top-level keys with nine nested objects through returned
 * result records would bury the contract under plumbing. The rejection is thrown
 * and caught inside this module only; nothing escapes, and the payload is the
 * same content-free `(reason, detail)` pair the internal validator produces.
 */
class WireRejection extends Error {
  readonly reason: HookWireRejectReason;
  readonly detail: string;

  constructor(reason: HookWireRejectReason, detail: string) {
    super(`${reason}:${detail}`);
    this.name = 'WireRejection';
    this.reason = reason;
    this.detail = detail;
  }
}

function reject(reason: HookWireRejectReason, detail: string): never {
  throw new WireRejection(reason, detail);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function own(raw: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(raw, key) ? raw[key] : undefined;
}

/**
 * Reads a nested object, requiring every modelled key to be present and
 * recording any key this module does not model as dropped.
 */
function readObject(
  parent: Record<string, unknown>,
  path: string,
  keys: readonly string[],
  dropped: string[],
  nullable: boolean,
): Record<string, unknown> | null {
  const value = own(parent, path);
  if (value === null) {
    if (nullable) return null;
    return reject('type_error', `${path}:expected_object`);
  }
  if (!isPlainObject(value)) return reject('type_error', `${path}:expected_object`);
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) reject('missing_key', `${path}.${key}:absent`);
  }
  const modelled = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!modelled.has(key)) dropped.push(`${path}.${key}`);
  }
  return value;
}

/** A string constrained by a pattern, or null. */
function checkNullablePattern(value: unknown, path: string, pattern: RegExp): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') return reject('type_error', `${path}:expected_string_or_null`);
  if (!pattern.test(value)) return reject('invalid_format', `${path}:pattern`);
  const unsafe = scanUnsafe(value);
  if (unsafe !== null) return reject('unsafe_content', `${path}:${unsafe}`);
  return value;
}

/** A member of a closed vocabulary, or null. */
function checkNullableEnum<T extends string>(value: unknown, path: string, allowed: readonly T[]): T | null {
  if (value === null) return null;
  if (typeof value !== 'string') return reject('type_error', `${path}:expected_string_or_null`);
  const found = allowed.find((candidate) => candidate === value);
  if (found === undefined) return reject('invalid_format', `${path}:not_in_vocabulary`);
  return found;
}

/**
 * A string this repository models only so it can be refused when malformed, and
 * then drops. Bounded and control-character free; no charset is invented for it.
 */
function checkNullableOpaque(value: unknown, path: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') return reject('type_error', `${path}:expected_string_or_null`);
  if (value.length > MAX_OPAQUE_CHARS) return reject('field_too_long', `${path}:max_${MAX_OPAQUE_CHARS}`);
  if (hasControlChars(value)) return reject('invalid_format', `${path}:control_characters`);
  return value;
}

function checkNullableBoolean(value: unknown, path: string): boolean | null {
  if (value === null) return null;
  if (typeof value !== 'boolean') return reject('type_error', `${path}:expected_boolean_or_null`);
  return value;
}

function checkDurationMs(value: unknown, path: string): number | null {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return reject('type_error', `${path}:expected_finite_number_or_null`);
  }
  if (!Number.isInteger(value) || value < 0 || value > HOOK_MAX_DURATION_MS) {
    return reject('invalid_format', `${path}:out_of_range`);
  }
  return value;
}

/**
 * The display label. It is the one external string that becomes user-visible
 * (as the internal `summary`), so it is scanned with the blob rule enabled, the
 * same way the internal validator scans a summary.
 */
function checkActivityLabel(value: unknown, path: string): string {
  if (typeof value !== 'string') return reject('type_error', `${path}:expected_string`);
  if (value.length === 0) return reject('invalid_format', `${path}:empty`);
  if (value.length > MAX_LABEL_CHARS) return reject('field_too_long', `${path}:max_${MAX_LABEL_CHARS}`);
  if (hasControlChars(value)) return reject('invalid_format', `${path}:control_characters`);
  const unsafe = scanUnsafe(value, { includeBlobRule: true });
  if (unsafe !== null) return reject('unsafe_content', `${path}:${unsafe}`);
  return value;
}

function checkEnum<T extends string>(value: unknown, path: string, allowed: readonly T[]): T {
  if (typeof value !== 'string') return reject('type_error', `${path}:expected_string`);
  const found = allowed.find((candidate) => candidate === value);
  if (found === undefined) return reject('invalid_format', `${path}:not_in_vocabulary`);
  return found;
}

/**
 * Validates an already-parsed object against the external hook contract.
 *
 * On success the caller gets a fully modelled `HookWireEvent` plus the paths of
 * the producer keys that were dropped. Nothing outside `HookWireEvent` survives
 * this function.
 */
export function validateHookWireObject(raw: unknown): HookWireResult {
  try {
    return { ok: true, ...buildWireEvent(raw) };
  } catch (error) {
    if (error instanceof WireRejection) return { ok: false, reason: error.reason, detail: error.detail };
    throw error;
  }
}

function buildWireEvent(raw: unknown): { wire: HookWireEvent; dropped_keys: string[] } {
  if (!isPlainObject(raw)) reject('not_object', 'root:expected_object');

  // Compatibility gate first: an unsupported schema is not interpreted at all.
  const schemaVersion = own(raw, 'schema_version');
  if (typeof schemaVersion !== 'number' || !Number.isInteger(schemaVersion)) {
    reject('type_error', 'schema_version:expected_integer');
  }
  if (schemaVersion !== HOOK_WIRE_SCHEMA_VERSION) {
    reject('unsupported_schema', `schema_version:${String(schemaVersion)}`);
  }

  for (const key of HOOK_WIRE_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(raw, key)) reject('missing_key', `${key}:absent`);
  }

  const dropped: string[] = [];
  const modelled = new Set<string>(HOOK_WIRE_KEYS);
  for (const key of Object.keys(raw)) {
    if (!modelled.has(key)) dropped.push(key);
  }

  // Observational only, exactly like the internal model.
  const sanitizerVersion = own(raw, 'sanitizer_version');
  if (typeof sanitizerVersion !== 'number' || !Number.isInteger(sanitizerVersion) || sanitizerVersion < 0) {
    reject('type_error', 'sanitizer_version:expected_non_negative_integer');
  }

  const eventId = own(raw, 'event_id');
  if (typeof eventId !== 'string') reject('type_error', 'event_id:expected_string');
  if (!isUuidV4(eventId)) reject('invalid_format', 'event_id:expected_uuid_v4');

  const ts = own(raw, 'ts');
  if (typeof ts !== 'string') reject('type_error', 'ts:expected_string');
  if (!HOOK_TS.test(ts) || !Number.isFinite(Date.parse(ts))) reject('invalid_format', 'ts:expected_utc_millis');

  // Identity of the emitter, checked before anything else is interpreted: this
  // is what stops a foreign payload that happens to carry `schema_version: 2`.
  const producer = readObject(raw, 'producer', PRODUCER_KEYS, dropped, false);
  if (producer === null) reject('type_error', 'producer:expected_object');
  const producerKind = own(producer, 'kind');
  if (producerKind !== HOOK_PRODUCER_KIND) reject('unsupported_producer', 'producer.kind:not_allowed');
  const producerEnv = own(producer, 'env');
  if (producerEnv !== HOOK_PRODUCER_ENV) reject('unsupported_producer', 'producer.env:not_allowed');
  const hostId = own(producer, 'host_id');
  if (typeof hostId !== 'string') reject('type_error', 'producer.host_id:expected_string');
  if (!HOOK_HOST_ID.test(hostId)) reject('invalid_format', 'producer.host_id:pattern');

  const sessionId = checkNullablePattern(own(raw, 'session_id'), 'session_id', HOOK_ID);
  const promptId = checkNullablePattern(own(raw, 'prompt_id'), 'prompt_id', HOOK_ID);

  const agent = readObject(raw, 'agent', AGENT_KEYS, dropped, false);
  if (agent === null) reject('type_error', 'agent:expected_object');
  const agentId = checkNullablePattern(own(agent, 'id'), 'agent.id', HOOK_ID);
  const agentType = checkNullablePattern(own(agent, 'type'), 'agent.type', HOOK_AGENT_TYPE);
  // The producer documents this as always null. Anything else is a shape this
  // consumer has no rule for, so it fails closed rather than being ignored.
  if (own(agent, 'parent_session_id') !== null) reject('invalid_format', 'agent.parent_session_id:expected_null');

  const hookEvent = checkNullablePattern(own(raw, 'hook_event'), 'hook_event', HOOK_EVENT_NAME);

  const session = readObject(raw, 'session', SESSION_KEYS, dropped, false);
  if (session === null) reject('type_error', 'session:expected_object');
  const sessionSource = checkNullableEnum(own(session, 'source'), 'session.source', HOOK_SESSION_SOURCES);
  const sessionEndReason = checkNullableEnum(
    own(session, 'end_reason'),
    'session.end_reason',
    HOOK_SESSION_END_REASONS,
  );

  const tool = readObject(raw, 'tool', TOOL_KEYS, dropped, false);
  if (tool === null) reject('type_error', 'tool:expected_object');
  const toolName = checkNullablePattern(own(tool, 'name'), 'tool.name', HOOK_ID);
  const toolCategory = checkNullableEnum(own(tool, 'category'), 'tool.category', HOOK_TOOL_CATEGORIES);
  const toolMcpServer = checkNullableOpaque(own(tool, 'mcp_server'), 'tool.mcp_server');
  const toolUseId = checkNullableOpaque(own(tool, 'tool_use_id'), 'tool.tool_use_id');

  const skillRaw = readObject(raw, 'skill', SKILL_KEYS, dropped, true);
  let skill: { name: string; source: null } | null = null;
  if (skillRaw !== null) {
    const skillName = checkNullableOpaque(own(skillRaw, 'name'), 'skill.name');
    if (skillName === null) reject('type_error', 'skill.name:expected_string');
    if (own(skillRaw, 'source') !== null) reject('invalid_format', 'skill.source:expected_null');
    skill = { name: skillName, source: null };
  }

  const taskRaw = readObject(raw, 'task', TASK_KEYS, dropped, true);
  const task = taskRaw === null ? null : { id: checkNullableOpaque(own(taskRaw, 'id'), 'task.id') };

  const activity = readObject(raw, 'activity', ACTIVITY_KEYS, dropped, false);
  if (activity === null) reject('type_error', 'activity:expected_object');
  const activityKind = checkEnum(own(activity, 'kind'), 'activity.kind', HOOK_ACTIVITY_KINDS);
  const activityFacility = checkEnum(own(activity, 'facility'), 'activity.facility', HOOK_FACILITIES);
  const activityLabel = checkActivityLabel(own(activity, 'label'), 'activity.label');

  const outcome = readObject(raw, 'outcome', OUTCOME_KEYS, dropped, false);
  if (outcome === null) reject('type_error', 'outcome:expected_object');
  const outcomeStatus = checkNullableEnum(own(outcome, 'status'), 'outcome.status', HOOK_OUTCOME_STATUSES);
  const durationMs = checkDurationMs(own(outcome, 'duration_ms'), 'outcome.duration_ms');
  const isInterrupt = checkNullableBoolean(own(outcome, 'is_interrupt'), 'outcome.is_interrupt');
  const errorKind = checkNullableEnum(own(outcome, 'error_kind'), 'outcome.error_kind', HOOK_ERROR_KINDS);
  const denialKind = checkNullableEnum(own(outcome, 'denial_kind'), 'outcome.denial_kind', HOOK_DENIAL_KINDS);

  const workspace = readObject(raw, 'workspace', WORKSPACE_KEYS, dropped, false);
  if (workspace === null) reject('type_error', 'workspace:expected_object');
  const repoId = checkNullableOpaque(own(workspace, 'repo_id'), 'workspace.repo_id');
  const bucket = checkNullableOpaque(own(workspace, 'bucket'), 'workspace.bucket');

  // `truncated: true` would mean the producer already lost part of the record.
  // There is no rule for interpreting a partial event, so it fails closed.
  if (own(raw, 'truncated') !== false) reject('invalid_format', 'truncated:expected_false');

  const wire: HookWireEvent = {
    schema_version: schemaVersion,
    sanitizer_version: sanitizerVersion,
    event_id: eventId,
    ts,
    producer: { kind: HOOK_PRODUCER_KIND, host_id: hostId, env: HOOK_PRODUCER_ENV },
    session_id: sessionId,
    prompt_id: promptId,
    agent: { id: agentId, type: agentType, parent_session_id: null },
    hook_event: hookEvent,
    session: { source: sessionSource, end_reason: sessionEndReason },
    tool: { name: toolName, category: toolCategory, mcp_server: toolMcpServer, tool_use_id: toolUseId },
    skill,
    task,
    activity: { kind: activityKind, facility: activityFacility, label: activityLabel },
    outcome: {
      status: outcomeStatus,
      duration_ms: durationMs,
      is_interrupt: isInterrupt,
      error_kind: errorKind,
      denial_kind: denialKind,
    },
    workspace: { repo_id: repoId, bucket },
    truncated: false,
  };

  return { wire, dropped_keys: dropped };
}

/** Validates one raw JSONL line. Oversized lines are rejected before parsing. */
export function validateHookWireLine(line: string, options: { maxLineBytes?: number } = {}): HookWireResult {
  const maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
  if (Buffer.byteLength(line, 'utf8') > maxLineBytes) {
    return { ok: false, reason: 'oversized_line', detail: `line:max_${maxLineBytes}_bytes` };
  }
  if (line.trim() === '') return { ok: false, reason: 'blank', detail: 'line:empty' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { ok: false, reason: 'not_json', detail: 'line:json_parse_error' };
  }
  return validateHookWireObject(parsed);
}
