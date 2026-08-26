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
 * - `activity` is NOT free-form sanitized text. The producer emits a fixed tuple
 *   per event, and this module accepts only that tuple; see
 *   `HOOK_FIXED_ACTIVITY` and `checkActivityContract`.
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
  | 'unsafe_content'
  /**
   * Every field is individually well formed, but the combination is not one the
   * producer emits: an activity tuple that does not belong to this event, or a
   * capacity marker that is not the producer's capacity marker.
   */
  | 'contract_mismatch';

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

// ------------------------------------------------- the fixed activity table ---

/**
 * The producer's fixed activity tuple for one event.
 *
 * `activity.label` is the only external string that becomes user-visible, so it
 * is not treated as sanitized free text: the producer picks it from a closed
 * phrase table, and this consumer accepts nothing else. A label is therefore
 * only ever accepted together with the `kind`, `facility` and `outcome.status`
 * it is emitted with, which also rules out a valid phrase copied onto a
 * different event or a different tool category.
 */
export type HookActivityContract = {
  kind: HookActivityKind;
  facility: HookFacility;
  label: string;
  status: HookOutcomeStatus;
};

/**
 * The fixed tuple of every non-tool `hook_event`, from the pinned producer
 * (`aymmurakami521-cmd/ai-company@3306b2b3c07a17a7d1de2c66e6669f0e6bb02a2f`).
 *
 * `UserPromptSubmit` carries the producer's generic fallback tuple: it reports
 * no tool, so the producer labels it with its default phrase rather than a
 * tool phrase.
 *
 * A `Map`, not an object literal: the key is stream content and a lookup must
 * never answer with an inherited `Object.prototype` member.
 */
export const HOOK_FIXED_ACTIVITY: ReadonlyMap<string, HookActivityContract> = new Map<string, HookActivityContract>([
  ['SessionStart', { kind: 'session', facility: 'desk', label: 'セッションが開始されました', status: 'started' }],
  ['SessionEnd', { kind: 'session', facility: 'desk', label: 'セッションが終了しました', status: 'ok' }],
  ['SubagentStart', { kind: 'delegate', facility: 'meeting', label: '専門Agentが起動しました', status: 'started' }],
  ['SubagentStop', { kind: 'delegate', facility: 'meeting', label: '専門Agentの処理が終了しました', status: 'ok' }],
  ['UserPromptSubmit', { kind: 'idle', facility: 'desk', label: 'イベントを記録しました', status: 'started' }],
  ['Stop', { kind: 'session', facility: 'desk', label: '応答処理が終了しました', status: 'ok' }],
  ['StopFailure', { kind: 'session', facility: 'desk', label: 'APIエラーで応答が終了しました', status: 'error' }],
  ['PermissionRequest', { kind: 'permission', facility: 'desk', label: '権限確認が発生しました', status: 'waiting' }],
  [
    'PermissionDenied',
    { kind: 'permission', facility: 'desk', label: '自動モードで実行が許可されませんでした', status: 'auto_denied' },
  ],
  ['Notification', { kind: 'session', facility: 'desk', label: '通知が発生しました', status: 'waiting' }],
  ['PreCompact', { kind: 'session', facility: 'desk', label: 'コンテキスト整理が開始されました', status: 'started' }],
  ['TaskCreated', { kind: 'task', facility: 'desk', label: '内部タスクが作成されました', status: 'started' }],
  ['TaskCompleted', { kind: 'task', facility: 'desk', label: '内部タスクが完了しました', status: 'ok' }],
]);

/** The three tool phases and the `outcome.status` each one is emitted with. */
export const HOOK_TOOL_PHASES: ReadonlyMap<string, 'pre' | 'post' | 'failure'> = new Map<
  string,
  'pre' | 'post' | 'failure'
>([
  ['PreToolUse', 'pre'],
  ['PostToolUse', 'post'],
  ['PostToolUseFailure', 'failure'],
]);

const TOOL_PHASE_STATUS: Record<'pre' | 'post' | 'failure', HookOutcomeStatus> = {
  pre: 'started',
  post: 'ok',
  failure: 'error',
};

/** Producer label for a tool call that has just started, by tool category. */
export const HOOK_PRE_TOOL_LABELS: ReadonlyMap<HookToolCategory, string> = new Map<HookToolCategory, string>([
  ['read', '資料を確認中'],
  ['write', '作業内容を編集中'],
  ['exec', 'コマンドを実行中'],
  ['search', '情報を検索中'],
  ['mcp', '外部サービスと通信中'],
  ['delegate', '担当者に作業を依頼中'],
  ['skill', '手順書を実行中'],
  ['idle', '作業中'],
]);

/** Producer label for a tool call that has completed, by tool category. */
export const HOOK_POST_TOOL_LABELS: ReadonlyMap<HookToolCategory, string> = new Map<HookToolCategory, string>([
  ['read', '資料の参照を確認しました'],
  ['write', '変更処理を確認しました'],
  ['exec', 'ターミナル処理を確認しました'],
  ['search', '検索処理を確認しました'],
  ['mcp', '外部サービスとの通信を確認しました'],
  ['delegate', '委任処理を確認しました'],
  ['skill', '手順書の実行を確認しました'],
  ['idle', 'ツール処理を確認しました'],
]);

/** A failed tool call is labelled by the failure alone, not by its category. */
export const HOOK_TOOL_FAILURE_LABEL = 'ツール処理が失敗しました';

/** The two web research tools, which the producer labels by name, not category. */
export const HOOK_RESEARCH_TOOL_NAMES: readonly string[] = ['WebSearch', 'WebFetch'];
export const HOOK_RESEARCH_PRE_LABEL = '外部資料を調査中';
export const HOOK_RESEARCH_POST_LABEL = '外部調査の完了を確認しました';

/** What the producer classifies one tool name as: its category and its facility. */
export type HookToolClass = { category: HookToolCategory; facility: HookFacility };

/**
 * The producer's `TOOL_CATEGORY` table, keyed by tool name.
 *
 * `activity.facility` is NOT a function of `tool.category`: the producer derives
 * `(kind, facility)` together from the tool name (`_category(tool_name,
 * mcp_server)`), and one category can sit in two facilities - `Grep` is
 * `search / search-terminal` while `WebSearch` and `WebFetch` are
 * `search / antenna`. A category-keyed facility table cannot express that, so
 * the name is the key here.
 *
 * Verbatim from the pinned producer
 * (`aymmurakami521-cmd/ai-company@3306b2b3c07a17a7d1de2c66e6669f0e6bb02a2f`,
 * `scripts/quest-hook-emit.py`). `Skill` is listed there as `skill / workshop`,
 * but `workshop` is outside the emitted facility vocabulary and the producer's
 * own `_safe_facility` rewrites it to `desk` before the record is written, so
 * `skill / desk` is what actually appears on the wire.
 *
 * A `Map`, not an object literal: the key is stream content and a lookup must
 * never answer with an inherited `Object.prototype` member.
 */
export const HOOK_TOOL_CLASS: ReadonlyMap<string, HookToolClass> = new Map<string, HookToolClass>([
  ['Read', { category: 'read', facility: 'shelf' }],
  ['Glob', { category: 'read', facility: 'shelf' }],
  ['Write', { category: 'write', facility: 'desk' }],
  ['Edit', { category: 'write', facility: 'desk' }],
  ['NotebookEdit', { category: 'write', facility: 'desk' }],
  ['Bash', { category: 'exec', facility: 'terminal' }],
  ['PowerShell', { category: 'exec', facility: 'terminal' }],
  ['Grep', { category: 'search', facility: 'search-terminal' }],
  ['WebSearch', { category: 'search', facility: 'antenna' }],
  ['WebFetch', { category: 'search', facility: 'antenna' }],
  ['Agent', { category: 'delegate', facility: 'meeting' }],
  ['Skill', { category: 'skill', facility: 'desk' }],
  ['TaskCreate', { category: 'idle', facility: 'desk' }],
  ['TaskUpdate', { category: 'idle', facility: 'desk' }],
  ['TaskGet', { category: 'idle', facility: 'desk' }],
  ['TaskList', { category: 'idle', facility: 'desk' }],
  ['TaskStop', { category: 'idle', facility: 'desk' }],
  ['TaskOutput', { category: 'idle', facility: 'desk' }],
]);

/**
 * The producer's `RE_MCP_SERVER`, verbatim.
 *
 * An MCP tool is named `mcp__<server>__<tool>`, and the producer derives the
 * server from the *name* alone:
 *
 * ```python
 * RE_MCP_SERVER = re.compile(r"^mcp__([A-Za-z0-9_-]{1,64}?)__")
 * mcp_match = RE_MCP_SERVER.match(tool_name) if tool_name else None
 * mcp_server = mcp_match.group(1) if mcp_match else None
 * ```
 *
 * `tool.name` and `tool.mcp_server` are therefore not independent fields: the
 * second is a function of the first. A name that does not match this pattern -
 * an ordinary tool, an unknown one, or an incomplete `mcp__` prefix - is emitted
 * with a null server and goes through the known-name table like any other.
 *
 * The quantifier is lazy, exactly as upstream: `mcp__a__b__t` reports `a`.
 */
export const HOOK_MCP_SERVER_PATTERN = /^mcp__([A-Za-z0-9_-]{1,64}?)__/;
export const HOOK_MCP_TOOL_CLASS: HookToolClass = { category: 'mcp', facility: 'portal' };

/** The producer's own fallback for a tool it does not classify, and for none. */
export const HOOK_TOOL_FALLBACK_CLASS: HookToolClass = { category: 'idle', facility: 'desk' };

/**
 * The `tool.mcp_server` the producer emits for a tool name, or null.
 *
 * This is the only source of the server. The value a row *supplies* is never
 * used to decide anything; it is compared against this result and the row is
 * refused when the two disagree.
 */
export function hookMcpServer(toolName: string | null): string | null {
  if (toolName === null) return null;
  // The capture group is not optional in the pattern, so a match always has it.
  return HOOK_MCP_SERVER_PATTERN.exec(toolName)?.[1] ?? null;
}

/**
 * Classifies a tool row exactly as the pinned producer does:
 *
 * ```python
 * def _category(tool_name, mcp_server):
 *     if mcp_server: return ("mcp", "portal")
 *     if not tool_name: return ("idle", "desk")
 *     return TOOL_CATEGORY.get(tool_name, ("idle", "desk"))
 * ```
 *
 * with `mcp_server` being the producer's own capture, not a supplied field - so
 * the whole classification is a function of the already-validated `tool.name`,
 * which matched the identifier charset and is compared against a closed table.
 *
 * An unknown or absent name is the producer's `idle / desk` fallback rather than
 * a rejection: the producer emits that row, and refusing it would drop real
 * history. It stays safe because the label is still fixed by the class, so an
 * unknown name can only ever carry `作業中` / `ツール処理を確認しました`.
 */
export function hookToolClass(toolName: string | null): HookToolClass {
  if (hookMcpServer(toolName) !== null) return HOOK_MCP_TOOL_CLASS;
  if (toolName === null) return HOOK_TOOL_FALLBACK_CLASS;
  return HOOK_TOOL_CLASS.get(toolName) ?? HOOK_TOOL_FALLBACK_CLASS;
}

/**
 * The activity tuple of the producer's capacity marker. It is a control row,
 * not an event: `hook_event` is null, and so is everything else a real event
 * would report. See `HOOK_CAPACITY_NULL_FIELDS` for the rest of the shape.
 */
export const HOOK_CAPACITY_ACTIVITY: HookActivityContract = {
  kind: 'capacity',
  facility: 'desk',
  label: '本日の記録上限に達しました',
  status: 'limit_reached',
};

/**
 * Every remaining field the producer's `limit_marker_event` fixes to null.
 *
 * The capacity row is not an ordinary record that happens to be about capacity:
 * it is a control signal that *permanently halts LIVE ingestion*, so it is the
 * one shape where a partial match must not be tolerated. The pinned producer
 * (`aymmurakami521-cmd/ai-company@3306b2b3c07a17a7d1de2c66e6669f0e6bb02a2f`,
 * `limit_marker_event`) builds the record from constants: it reports no session,
 * no prompt, no agent, no session transition, no tool, no skill, no task, no
 * timing and no workspace. A row that carries any of them is a row the producer
 * cannot emit, and stopping the stream on it would turn one malformed line into
 * the permanent loss of everything after it.
 *
 * `agent.parent_session_id` (always null) and `truncated` (always false) are not
 * listed: they are fixed for *every* row and already enforced field by field.
 * `schema_version`, `sanitizer_version`, `event_id`, `ts` and `producer` are
 * likewise validated exactly as they are on a business row - the marker carries
 * real ones. `sanitizer_version` in particular stays observational here, as it
 * is everywhere else.
 */
const CAPACITY_FIXED_NULL: readonly (readonly [string, (wire: HookWireEvent) => unknown])[] = [
  ['session_id', (wire) => wire.session_id],
  ['prompt_id', (wire) => wire.prompt_id],
  ['agent.id', (wire) => wire.agent.id],
  ['agent.type', (wire) => wire.agent.type],
  ['session.source', (wire) => wire.session.source],
  ['session.end_reason', (wire) => wire.session.end_reason],
  ['tool.name', (wire) => wire.tool.name],
  ['tool.category', (wire) => wire.tool.category],
  ['tool.mcp_server', (wire) => wire.tool.mcp_server],
  ['tool.tool_use_id', (wire) => wire.tool.tool_use_id],
  ['skill', (wire) => wire.skill],
  ['task', (wire) => wire.task],
  ['outcome.duration_ms', (wire) => wire.outcome.duration_ms],
  ['outcome.is_interrupt', (wire) => wire.outcome.is_interrupt],
  ['outcome.error_kind', (wire) => wire.outcome.error_kind],
  ['outcome.denial_kind', (wire) => wire.outcome.denial_kind],
  ['workspace.repo_id', (wire) => wire.workspace.repo_id],
  ['workspace.bucket', (wire) => wire.workspace.bucket],
];

/** The paths of `CAPACITY_FIXED_NULL`, so a test can pin what the rule covers. */
export const HOOK_CAPACITY_NULL_FIELDS: readonly string[] = CAPACITY_FIXED_NULL.map(([path]) => path);

/**
 * True only for the producer's complete capacity control row.
 *
 * This is the single definition of that shape. `checkActivityContract` refuses a
 * near miss at the wire, and `hookAdapter.ts` asks this same question before it
 * turns a row into a halt, so the two can never disagree about what stops the
 * stream.
 *
 * `droppedKeys` is the second half of the shape, and it is a required argument
 * rather than an optional one on purpose: a modelled record cannot say what the
 * producer *also* sent, and a caller that could forget to pass it would be free
 * to halt on a row this predicate never saw in full. An unknown key anywhere is
 * a row the pinned `limit_marker_event` cannot emit - it is built from a fixed
 * set of constants - so a candidate carrying one is not the control row.
 */
export function isHookCapacityRow(wire: HookWireEvent, droppedKeys: readonly string[]): boolean {
  return (
    droppedKeys.length === 0 &&
    wire.hook_event === null &&
    wire.activity.kind === HOOK_CAPACITY_ACTIVITY.kind &&
    wire.activity.facility === HOOK_CAPACITY_ACTIVITY.facility &&
    wire.activity.label === HOOK_CAPACITY_ACTIVITY.label &&
    wire.outcome.status === HOOK_CAPACITY_ACTIVITY.status &&
    wire.agent.parent_session_id === null &&
    wire.truncated === false &&
    CAPACITY_FIXED_NULL.every(([, read]) => read(wire) === null)
  );
}

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
 * Resolves the one activity tuple the producer emits for a tool row.
 *
 * Everything it reads has already been validated: `tool.name` matched the
 * identifier charset and `tool.category` is a member of the closed category
 * vocabulary. The tuple is derived from the *name* (through `hookToolClass`),
 * and the category the producer emitted must agree with it - so a row cannot
 * pick a category to borrow another tool's facility or label.
 */
function toolActivityContract(
  phase: 'pre' | 'post' | 'failure',
  category: HookToolCategory,
  toolName: string | null,
): HookActivityContract {
  const tool = hookToolClass(toolName);
  if (category !== tool.category) reject('contract_mismatch', 'tool.category:not_fixed_for_tool');

  const isResearch = toolName !== null && HOOK_RESEARCH_TOOL_NAMES.includes(toolName);
  let label: string | undefined;
  if (phase === 'failure') label = HOOK_TOOL_FAILURE_LABEL;
  else if (phase === 'pre') label = isResearch ? HOOK_RESEARCH_PRE_LABEL : HOOK_PRE_TOOL_LABELS.get(tool.category);
  else label = isResearch ? HOOK_RESEARCH_POST_LABEL : HOOK_POST_TOOL_LABELS.get(tool.category);
  // Unreachable: both label maps cover `HOOK_TOOL_CATEGORIES` exactly, and a
  // test pins that. Fail closed anyway rather than assert a value into being.
  if (label === undefined) return reject('contract_mismatch', 'tool.category:no_label');

  return { kind: tool.category, facility: tool.facility, label, status: TOOL_PHASE_STATUS[phase] };
}

/**
 * Rejects any row whose activity is not the tuple the producer emits for it.
 *
 * This is the trust boundary for the one external string that becomes visible
 * (`activity.label` -> internal `summary`). Per-field validation earlier in this
 * module can only say that a string is bounded, control-free and free of unsafe
 * markers - which an arbitrary sentence also is. Comparing the whole tuple
 * against the producer's fixed table is what stops such a sentence, and it also
 * stops a genuine producer phrase pasted onto a different event or category.
 *
 * A `hook_event` outside the producer's known table has no tuple here on
 * purpose: `hookAdapter.ts` owns that table and refuses the row before anything
 * is mapped, so an unknown event can never reach the reducer, the wire or the
 * screen through this gap.
 */
function checkActivityContract(wire: HookWireEvent, dropped: readonly string[]): void {
  // `tool.mcp_server` is not an independent field: the producer computes it from
  // the sanitized tool name with `RE_MCP_SERVER` and emits null for every name
  // that does not match. Any other pairing - a plain tool carrying a server, an
  // MCP name with a null, different or invented server, or an incomplete
  // `mcp__` prefix presented as MCP - is a row the producer cannot emit, so it
  // is refused here rather than classified. This holds for every row, tool or
  // not: a non-tool event reports no tool, and therefore no server.
  if (wire.tool.mcp_server !== hookMcpServer(wire.tool.name)) {
    reject('contract_mismatch', 'tool.mcp_server:not_derived_from_name');
  }

  // The capacity control row. It is the only shape with a null `hook_event`.
  if (wire.hook_event === null) {
    checkCapacityContract(wire, dropped);
    return;
  }

  const phase = HOOK_TOOL_PHASES.get(wire.hook_event);
  if (phase !== undefined) {
    // The producer always classifies a tool row, even one whose tool it does not
    // know, so the category is required. The *name* is not: an absent name is
    // the producer's own `idle / desk` fallback.
    if (wire.tool.category === null) reject('contract_mismatch', 'tool.category:required_for_tool_event');
    compareActivity(toolActivityContract(phase, wire.tool.category, wire.tool.name), wire, 'tool');
    return;
  }

  const fixed = HOOK_FIXED_ACTIVITY.get(wire.hook_event);
  // Unknown event: no tuple to compare against. The adapter refuses it.
  if (fixed === undefined) return;
  compareActivity(fixed, wire, 'event');
}

/**
 * Refuses anything that is not the producer's complete capacity control row.
 *
 * A null `hook_event` is only ever the capacity marker, and the marker is built
 * from constants, so *every* field it fixes has to match. The consequence of
 * accepting a near miss is not a mis-rendered desk but a permanent halt: the
 * LIVE namespace stops folding and the rest of the session is lost. That is why
 * a one-field difference is a per-line rejection here rather than a control
 * signal - a rejected line costs one row, a wrong halt costs the session.
 *
 * "Every field it fixes" includes the ones it does not have. An unknown key is
 * dropped rather than refused everywhere else in this module, because a business
 * row from a newer producer must still fold - but a dropped key would otherwise
 * let a row become the marker by being rebuilt without the very thing that made
 * it impossible. Strictness is therefore scoped to this control boundary alone:
 * unknown keys stay forward-compatible on every ordinary row.
 */
function checkCapacityContract(wire: HookWireEvent, dropped: readonly string[]): void {
  compareActivity(HOOK_CAPACITY_ACTIVITY, wire, 'capacity');
  // The path is fixed, not the key that was dropped: a producer-chosen key name
  // is content, and a rejection detail never carries content.
  if (dropped.length > 0) reject('contract_mismatch', 'dropped_keys:unknown_key_for_capacity');
  for (const [path, read] of CAPACITY_FIXED_NULL) {
    if (read(wire) !== null) reject('contract_mismatch', `${path}:expected_null_for_capacity`);
  }
}

/** Field-by-field comparison. The detail names the field and the rule only. */
function compareActivity(expected: HookActivityContract, wire: HookWireEvent, scope: string): void {
  if (wire.activity.kind !== expected.kind) reject('contract_mismatch', `activity.kind:not_fixed_for_${scope}`);
  if (wire.activity.facility !== expected.facility) {
    reject('contract_mismatch', `activity.facility:not_fixed_for_${scope}`);
  }
  if (wire.activity.label !== expected.label) reject('contract_mismatch', `activity.label:not_fixed_for_${scope}`);
  if (wire.outcome.status !== expected.status) reject('contract_mismatch', `outcome.status:not_fixed_for_${scope}`);
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

  // Last, and over the assembled record rather than a hand-picked subset, so a
  // combination rule can see every modelled field. It runs after per-field
  // validation on purpose: an unsafe or malformed value is still reported as
  // such, not as a mismatch. The record is discarded when this throws.
  checkActivityContract(wire, dropped);

  // Backstop on the one decision that can stop the stream. A null `hook_event`
  // is only ever the capacity control row, so a row that reaches here with one
  // must satisfy the very predicate `hookAdapter.ts` halts on. Asking it here
  // means the wire cannot accept a candidate the adapter would then read as a
  // marker on evidence the wire never checked.
  if (wire.hook_event === null && !isHookCapacityRow(wire, dropped)) {
    reject('contract_mismatch', 'hook_event:incomplete_capacity_row');
  }

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
