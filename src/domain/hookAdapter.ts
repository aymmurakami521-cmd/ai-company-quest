/**
 * Allowlist adapter: external Claude Code hook wire -> internal normalized event.
 *
 * The adapter is the single place where producer semantics are translated. It
 * only uses fields whose meaning is fixed by the producer contract; it never
 * guesses, never derives a value from an unmodelled field, and never spreads a
 * producer object. Every internal field is assigned from an explicit source or
 * from a documented constant.
 *
 * Three outcomes, all deterministic:
 * - `event`  - a normalized `SanitizedEvent` for the reducer.
 * - `capacity` - the producer's capacity marker. It is NOT a business event: it
 *   states that history is missing from here on, so it becomes a fail-closed
 *   control signal instead of something a desk could be rendered from.
 * - `reject` - fail closed. The detail names a field and a rule, never a value.
 *
 * Deliberately NOT mapped (no receptacle in the internal model that would keep
 * their meaning, so they are dropped rather than approximated):
 * `prompt_id`, `producer.host_id`, `session.source`, `session.end_reason`,
 * `tool.category`, `tool.mcp_server`, `tool.tool_use_id`, `skill`, `task`,
 * `agent.parent_session_id`, `outcome.is_interrupt`, `outcome.error_kind`,
 * `outcome.denial_kind`, `workspace.repo_id`, `workspace.bucket`,
 * `activity.kind`, `activity.facility`, `truncated`.
 */

import type { SanitizedEvent } from './event.ts';
import { SUPPORTED_SCHEMA_VERSION } from './event.ts';
import { MAIN_AGENT_ID } from './actor.ts';
import type { HookWireEvent } from './hookWire.ts';

/**
 * Normalized type for a Claude-internal task event. It is deliberately outside
 * `KNOWN_EVENT_TYPES`: `TaskCreated` / `TaskCompleted` describe Claude Code's
 * own bookkeeping, not company work, so the reducer must count them as ignored
 * rather than move a desk.
 */
export const INTERNAL_TASK_EVENT_TYPE = 'internal_task';

/** Detail published with a capacity halt. Fixed token, never stream content. */
export const HOOK_CAPACITY_DETAIL = 'producer:limit_reached';

export type HookAdapterRejectReason =
  /** `session_id` was null: the row cannot be attributed to a session. */
  | 'unattributable'
  /** `hook_event` is outside the known table, or the capacity shape is mixed. */
  | 'unsupported_hook_event'
  /**
   * The event and the agent identity disagree: a subagent lifecycle row with no
   * subagent, or a main-orchestrator lifecycle row carrying a subagent id.
   */
  | 'identity_conflict';

export type HookAdaptation =
  | { kind: 'event'; event: SanitizedEvent }
  | { kind: 'capacity'; detail: string }
  | { kind: 'reject'; reason: HookAdapterRejectReason; detail: string };

type Lifecycle = {
  /** Internal `event_type`. */
  event_type: string;
  /**
   * Internal `status`. Taken from this table, not copied from `outcome.status`:
   * the producer's status vocabulary describes a hook's outcome, while the
   * internal one describes what a desk is doing. They coincide for some rows
   * and differ for others (`SubagentStart` is `started` upstream, `active`
   * here), so a copy would be wrong in exactly the rows that matter.
   */
  status: string;
};

/**
 * The known `hook_event` table, verbatim from the producer contract.
 *
 * A `Map` rather than an object literal: `hook_event` is stream content, and a
 * lookup must never answer with an inherited `Object.prototype` member.
 */
export const HOOK_EVENT_LIFECYCLE: ReadonlyMap<string, Lifecycle> = new Map<string, Lifecycle>([
  ['SessionStart', { event_type: 'session_start', status: 'started' }],
  ['SessionEnd', { event_type: 'session_end', status: 'ok' }],
  ['SubagentStart', { event_type: 'agent_start', status: 'active' }],
  ['SubagentStop', { event_type: 'agent_stop', status: 'stopped' }],
  // The main agent's response cycle. The producer models it as prompt/stop, and
  // the company view reads it as the orchestrator starting and stopping work.
  ['UserPromptSubmit', { event_type: 'agent_start', status: 'active' }],
  ['Stop', { event_type: 'agent_stop', status: 'stopped' }],
  ['StopFailure', { event_type: 'agent_stop', status: 'error' }],
  ['PreToolUse', { event_type: 'tool_use', status: 'started' }],
  ['PostToolUse', { event_type: 'tool_use', status: 'ok' }],
  ['PostToolUseFailure', { event_type: 'tool_use', status: 'error' }],
  ['PermissionRequest', { event_type: 'agent_status', status: 'permission' }],
  ['PermissionDenied', { event_type: 'agent_status', status: 'denied' }],
  ['Notification', { event_type: 'agent_status', status: 'waiting' }],
  ['PreCompact', { event_type: 'agent_status', status: 'started' }],
  // Claude-internal bookkeeping. Recorded, never interpreted as company work.
  ['TaskCreated', { event_type: INTERNAL_TASK_EVENT_TYPE, status: 'started' }],
  ['TaskCompleted', { event_type: INTERNAL_TASK_EVENT_TYPE, status: 'ok' }],
]);

/**
 * Rows the producer only emits for a subagent. They describe that subagent's
 * own lifecycle, so a null `agent.id` is not "the orchestrator" here - it is a
 * row whose subject is missing.
 */
export const SUBAGENT_LIFECYCLE_EVENTS: ReadonlySet<string> = new Set(['SubagentStart', 'SubagentStop']);

/**
 * Rows the producer only emits for the session's main orchestrator. The session
 * lifecycle and the prompt/response cycle belong to the session itself, so a
 * subagent id on one of them is a contradiction rather than an attribution.
 *
 * Everything else (tool use, permission, notification, compaction, internal
 * tasks) is emitted by either, and keeps the canonical `main` fallback.
 */
export const MAIN_ONLY_LIFECYCLE_EVENTS: ReadonlySet<string> = new Set([
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'Stop',
  'StopFailure',
]);

/** True for the producer's capacity marker: a null hook event, kind and status. */
export function isCapacityMarker(wire: HookWireEvent): boolean {
  return wire.hook_event === null && wire.activity.kind === 'capacity' && wire.outcome.status === 'limit_reached';
}

/**
 * Maps one validated external wire event onto the internal model.
 *
 * The input must already have passed `validateHookWireObject`; this function
 * decides meaning, not shape. Its output is validated again by the internal
 * validator before anything is folded, so a mapping bug cannot bypass the
 * content rules that protect the wire and the screen.
 */
export function adaptHookEvent(wire: HookWireEvent): HookAdaptation {
  // Capacity first: it is the only shape in which `hook_event` may be null, and
  // it must never be read as an ordinary event.
  if (isCapacityMarker(wire)) return { kind: 'capacity', detail: HOOK_CAPACITY_DETAIL };

  if (wire.hook_event === null) {
    return { kind: 'reject', reason: 'unsupported_hook_event', detail: 'hook_event:null_not_capacity_marker' };
  }

  const lifecycle = HOOK_EVENT_LIFECYCLE.get(wire.hook_event);
  if (lifecycle === undefined) {
    return { kind: 'reject', reason: 'unsupported_hook_event', detail: 'hook_event:not_in_known_table' };
  }

  // A known hook event carrying capacity signals is a shape the producer
  // contract does not define. There is no rule for it, so it fails closed
  // rather than being partly interpreted.
  if (wire.activity.kind === 'capacity' || wire.outcome.status === 'limit_reached') {
    return { kind: 'reject', reason: 'unsupported_hook_event', detail: 'hook_event:capacity_shape_conflict' };
  }

  // No sentinel is invented for an unattributable row: without a session the
  // event cannot be placed in the company view at all, so it is refused.
  if (wire.session_id === null) {
    return { kind: 'reject', reason: 'unattributable', detail: 'session_id:null' };
  }

  // Identity before mapping. The `main` fallback below is an identity rule of
  // the producer contract, and it only holds where the contract says the row can
  // be the orchestrator's: applying it to a subagent lifecycle row with a
  // missing id would move the orchestrator's desk and lose the subagent
  // entirely, which is worse than not rendering the row at all.
  if (SUBAGENT_LIFECYCLE_EVENTS.has(wire.hook_event) && wire.agent.id === null) {
    return { kind: 'reject', reason: 'identity_conflict', detail: 'agent.id:required_for_subagent_event' };
  }
  if (MAIN_ONLY_LIFECYCLE_EVENTS.has(wire.hook_event) && wire.agent.id !== null) {
    return { kind: 'reject', reason: 'identity_conflict', detail: 'agent.id:not_allowed_for_main_event' };
  }

  const event: SanitizedEvent = {
    schema_version: SUPPORTED_SCHEMA_VERSION,
    sanitizer_version: wire.sanitizer_version,
    event_id: wire.event_id,
    session_id: wire.session_id,
    ts: wire.ts,
    event_type: lifecycle.event_type,
    // The producer identifies the main orchestrator as `{session_id}:main` and
    // leaves `agent.id` null for it. That is an identity rule from the contract,
    // not an inference about what the agent is - and the check above has already
    // established that this row is one the rule may be applied to.
    agent_id: wire.agent.id ?? MAIN_AGENT_ID,
    // Never from `agent.type`. A runtime agent type is not an org role, and this
    // codebase does not invent roles; the actor directory is the only source.
    agent_role: null,
    runtime_agent_type: wire.agent.type,
    // The producer emits no sequence and no token accounting.
    producer_seq: null,
    status: lifecycle.status,
    tool_name: wire.tool.name,
    duration_ms: wire.outcome.duration_ms,
    token_count: null,
    // A fixed phrase from the producer's own label table. It is re-scanned by
    // the internal validator like any other summary.
    summary: wire.activity.label,
  };

  return { kind: 'event', event };
}
