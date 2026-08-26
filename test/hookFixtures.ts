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

import type { HookWireEvent } from '../src/domain/hookWire.ts';

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
 * Builds one wire record. The base is the shape every hook event shares, with
 * every modelled key present and explicitly null where the producer has nothing
 * to report. Overrides replace a whole top-level value, never merge into one, so
 * a fixture cannot accidentally inherit half a nested object.
 */
export function makeHookEvent(overrides: HookOverrides = {}): HookWireEvent {
  const base: HookWireEvent = {
    schema_version: 2,
    sanitizer_version: 3,
    event_id: '3f2c9d10-8b41-4a7e-9c02-5f1d7a6b2e88',
    ts: '2026-08-22T05:40:00.123Z',
    producer: { kind: 'claude-code-hook', host_id: '0123456789ab', env: 'local' },
    session_id: 'sess-1',
    prompt_id: 'prompt-1',
    agent: { id: null, type: null, parent_session_id: null },
    hook_event: 'UserPromptSubmit',
    session: { source: null, end_reason: null },
    tool: { name: null, category: null, mcp_server: null, tool_use_id: null },
    skill: null,
    task: null,
    activity: { kind: 'session', facility: 'desk', label: '応答処理を開始しました' },
    outcome: { status: 'started', duration_ms: null, is_interrupt: null, error_kind: null, denial_kind: null },
    workspace: { repo_id: '0123abcd', bucket: null },
    truncated: false,
  };
  return { ...base, ...overrides };
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
 * The producer's capacity marker: `hook_event: null` with `activity.kind`
 * `capacity` and `outcome.status` `limit_reached`.
 *
 * `facility` and `label` are synthetic here. The adapter's decision depends on
 * the three fields above and on nothing else, so the choice cannot influence
 * what is being tested.
 */
export const CAPACITY_MARKER: HookWireEvent = makeHookEvent({
  event_id: 'c0000000-0000-4000-8000-000000000001',
  hook_event: null,
  activity: { kind: 'capacity', facility: 'portal', label: '記録容量の上限に達しました' },
  outcome: { status: 'limit_reached', duration_ms: null, is_interrupt: null, error_kind: null, denial_kind: null },
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
