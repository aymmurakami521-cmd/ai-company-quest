/**
 * Sanitized fixtures for the external Claude Code hook wire (schema_version 2).
 *
 * These are synthetic records built to the producer contract as published at
 * `aymmurakami521-cmd/ai-company@3306b2b3c07a17a7d1de2c66e6669f0e6bb02a2f`
 * (`scripts/quest-hook-emit.py`, `docs/ai-company-quest/01-event-schema.md`).
 * `SAMPLE_POST_TOOL_USE` and `SAMPLE_SUBAGENT_START` are the two records quoted
 * in that contract, verbatim.
 *
 * Nothing here came from a real session. There are no prompts, no commands, no
 * paths, no credentials and no host data: `host_id` is a placeholder, and every
 * `activity.label` is a fixed phrase from the producer's own label table.
 *
 * Not a test file itself.
 */

import type { HookActivityContract, HookWireEvent } from '../src/domain/hookWire.ts';
import { HOOK_CAPACITY_ACTIVITY, HOOK_FIXED_ACTIVITY, HOOK_TOOL_PHASES } from '../src/domain/hookWire.ts';

/** Verbatim from the producer contract: a completed Bash tool call. */
export const SAMPLE_POST_TOOL_USE: HookWireEvent = {
  schema_version: 2,
  sanitizer_version: 3,
  event_id: '3f2c9d10-8b41-4a7e-9c02-5f1d7a6b2e88',
  ts: '2026-08-22T05:40:00.123Z',
  producer: { kind: 'claude-code-hook', host_id: '0123456789ab', env: 'local' },
  session_id: 'sess-1',
  prompt_id: 'prompt-1',
  agent: { id: null, type: null, parent_session_id: null },
  hook_event: 'PostToolUse',
  session: { source: null, end_reason: null },
  tool: { name: 'Bash', category: 'exec', mcp_server: null, tool_use_id: 'tool-1' },
  skill: null,
  task: null,
  activity: { kind: 'exec', facility: 'terminal', label: 'ターミナル処理を確認しました' },
  outcome: { status: 'ok', duration_ms: 1234, is_interrupt: null, error_kind: null, denial_kind: null },
  workspace: { repo_id: '0123abcd', bucket: 'scripts' },
  truncated: false,
};

/** Verbatim from the producer contract: a subagent starting. */
export const SAMPLE_SUBAGENT_START: HookWireEvent = {
  schema_version: 2,
  sanitizer_version: 3,
  event_id: '5b44d2b8-9bc7-4b09-83e8-27a3e1394480',
  ts: '2026-08-22T05:41:00.000Z',
  producer: { kind: 'claude-code-hook', host_id: '0123456789ab', env: 'local' },
  session_id: 'sess-1',
  prompt_id: 'prompt-1',
  agent: { id: 'agent-1', type: 'backend-engineer', parent_session_id: null },
  hook_event: 'SubagentStart',
  session: { source: null, end_reason: null },
  tool: { name: null, category: null, mcp_server: null, tool_use_id: null },
  skill: null,
  task: null,
  activity: { kind: 'delegate', facility: 'meeting', label: '専門Agentが起動しました' },
  outcome: { status: 'started', duration_ms: null, is_interrupt: null, error_kind: null, denial_kind: null },
  workspace: { repo_id: '0123abcd', bucket: null },
  truncated: false,
};

type HookOverrides = {
  [K in keyof HookWireEvent]?: HookWireEvent[K];
};

/**
 * Builds one wire record that is valid for its `hook_event`.
 *
 * The producer emits a fixed `(kind, facility, label, outcome.status)` tuple per
 * event and a fixed identity rule (subagent lifecycle rows carry a subagent id,
 * main-orchestrator rows do not), so a fixture cannot pick those independently
 * of the event any more than a real hook can. The base is therefore derived
 * from the event; every other key is present and explicitly null where the
 * producer has nothing to report.
 *
 * Overrides replace a whole top-level value, never merge into one, so a fixture
 * cannot accidentally inherit half a nested object - and a test that wants an
 * invalid combination still gets exactly the one it asks for.
 */
export function makeHookEvent(overrides: HookOverrides = {}): HookWireEvent {
  const hookEvent = overrides.hook_event !== undefined ? overrides.hook_event : 'UserPromptSubmit';
  const base: HookWireEvent = {
    schema_version: 2,
    sanitizer_version: 3,
    event_id: '3f2c9d10-8b41-4a7e-9c02-5f1d7a6b2e88',
    ts: '2026-08-22T05:40:00.123Z',
    producer: { kind: 'claude-code-hook', host_id: '0123456789ab', env: 'local' },
    session_id: hookEvent === null ? null : 'sess-1',
    prompt_id: hookEvent === null ? null : 'prompt-1',
    agent: baseAgent(hookEvent),
    hook_event: hookEvent,
    session: { source: null, end_reason: null },
    tool: baseTool(hookEvent),
    skill: null,
    task: null,
    activity: baseActivity(hookEvent),
    outcome: {
      status: baseStatus(hookEvent),
      duration_ms: null,
      is_interrupt: null,
      error_kind: null,
      denial_kind: null,
    },
    workspace: hookEvent === null ? { repo_id: null, bucket: null } : { repo_id: '0123abcd', bucket: null },
    truncated: false,
  };
  return { ...base, ...overrides };
}

/** Subagent lifecycle rows name their subagent; everything else is the main desk. */
function baseAgent(hookEvent: string | null): HookWireEvent['agent'] {
  if (hookEvent === 'SubagentStart' || hookEvent === 'SubagentStop') {
    return { id: 'agent-1', type: 'backend-engineer', parent_session_id: null };
  }
  return { id: null, type: null, parent_session_id: null };
}

/** Tool rows report the tool; the producer leaves `tool` null on the others. */
function baseTool(hookEvent: string | null): HookWireEvent['tool'] {
  if (hookEvent !== null && HOOK_TOOL_PHASES.has(hookEvent)) {
    return { name: 'Bash', category: 'exec', mcp_server: null, tool_use_id: 'tool-1' };
  }
  return { name: null, category: null, mcp_server: null, tool_use_id: null };
}

/** The producer's fixed tuple for this event, or the capacity control row. */
function baseActivity(hookEvent: string | null): HookWireEvent['activity'] {
  const contract = fixedContract(hookEvent);
  if (contract === null) {
    // An event with no fixed tuple (unknown to the producer's table). The
    // generic fallback keeps such a fixture rejectable for the right reason.
    return { kind: 'idle', facility: 'desk', label: 'イベントを記録しました' };
  }
  return { kind: contract.kind, facility: contract.facility, label: contract.label };
}

function baseStatus(hookEvent: string | null): HookWireEvent['outcome']['status'] {
  const contract = fixedContract(hookEvent);
  return contract === null ? 'started' : contract.status;
}

function fixedContract(hookEvent: string | null): HookActivityContract | null {
  if (hookEvent === null) return HOOK_CAPACITY_ACTIVITY;
  const phase = HOOK_TOOL_PHASES.get(hookEvent);
  if (phase !== undefined) {
    // Matches `baseTool`: the exec/Bash row the producer publishes verbatim.
    if (phase === 'pre') return { kind: 'exec', facility: 'terminal', label: 'コマンドを実行中', status: 'started' };
    if (phase === 'post') {
      return { kind: 'exec', facility: 'terminal', label: 'ターミナル処理を確認しました', status: 'ok' };
    }
    return { kind: 'exec', facility: 'terminal', label: 'ツール処理が失敗しました', status: 'error' };
  }
  return HOOK_FIXED_ACTIVITY.get(hookEvent) ?? null;
}

export function makeHookLine(overrides: HookOverrides = {}): string {
  return JSON.stringify(makeHookEvent(overrides));
}

/** Distinct, deterministic lowercase UUIDv4s, so fixtures never collide on id. */
export function hookEventId(index: number): string {
  const hex = index.toString(16).padStart(12, '0');
  return `00000000-0000-4000-8000-${hex}`;
}

/**
 * The producer's capacity marker, exactly as the pinned producer emits it:
 * `hook_event`, `session_id` and both agent identity fields null, with the fixed
 * `capacity / desk / 本日の記録上限に達しました / limit_reached` control tuple.
 *
 * Nothing here is synthetic. A marker that differs in any of those fields is not
 * this control row, and is refused rather than halting the stream.
 */
export const CAPACITY_MARKER: HookWireEvent = makeHookEvent({
  event_id: 'c0000000-0000-4000-8000-000000000001',
  hook_event: null,
});

/**
 * One record per row of the producer's known `hook_event` table, in the order
 * the contract lists them. Ids are distinct so a whole run can be ingested.
 */
export const KNOWN_HOOK_EVENT_SEQUENCE: readonly HookWireEvent[] = [
  'SessionStart',
  'SessionEnd',
  'SubagentStart',
  'SubagentStop',
  'UserPromptSubmit',
  'Stop',
  'StopFailure',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'PermissionDenied',
  'TaskCreated',
  'TaskCompleted',
  'Notification',
  'PreCompact',
].map((hookEvent, index) =>
  makeHookEvent({
    event_id: hookEventId(index + 1),
    ts: `2026-08-22T05:40:${String(index).padStart(2, '0')}.000Z`,
    hook_event: hookEvent,
  }),
);
