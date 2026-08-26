/**
 * The allowlist adapter: external hook wire -> internal normalized event.
 *
 * What is pinned here is the mapping itself - every row of the producer's known
 * `hook_event` table, every field that is carried, and every field that is
 * deliberately dropped rather than approximated.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { CONTRACT_KEYS } from '../src/domain/event.ts';
import { HOOK_CAPACITY_DETAIL, INTERNAL_TASK_EVENT_TYPE, adaptHookEvent } from '../src/domain/hookAdapter.ts';
import { validateEventObject } from '../src/domain/validate.ts';
import { CAPACITY_MARKER, SAMPLE_POST_TOOL_USE, SAMPLE_SUBAGENT_START, makeHookEvent } from './hookFixtures.ts';

/** The producer's table, restated here so a mapping change has to be deliberate. */
const LIFECYCLE: ReadonlyArray<[string, string, string]> = [
  ['SessionStart', 'session_start', 'started'],
  ['SessionEnd', 'session_end', 'ok'],
  ['SubagentStart', 'agent_start', 'active'],
  ['SubagentStop', 'agent_stop', 'stopped'],
  ['UserPromptSubmit', 'agent_start', 'active'],
  ['Stop', 'agent_stop', 'stopped'],
  ['StopFailure', 'agent_stop', 'error'],
  ['PreToolUse', 'tool_use', 'started'],
  ['PostToolUse', 'tool_use', 'ok'],
  ['PostToolUseFailure', 'tool_use', 'error'],
  ['PermissionRequest', 'agent_status', 'permission'],
  ['PermissionDenied', 'agent_status', 'denied'],
  ['Notification', 'agent_status', 'waiting'],
  ['PreCompact', 'agent_status', 'started'],
  ['TaskCreated', INTERNAL_TASK_EVENT_TYPE, 'started'],
  ['TaskCompleted', INTERNAL_TASK_EVENT_TYPE, 'ok'],
];

test('every known hook_event maps to its documented event_type and status', () => {
  for (const [hookEvent, eventType, status] of LIFECYCLE) {
    const adapted = adaptHookEvent(makeHookEvent({ hook_event: hookEvent }));
    assert.equal(adapted.kind, 'event', `${hookEvent} must normalize`);
    if (adapted.kind !== 'event') continue;
    assert.equal(adapted.event.event_type, eventType, `${hookEvent} event_type`);
    assert.equal(adapted.event.status, status, `${hookEvent} status`);
  }
});

test('every normalized event still passes the internal validator', () => {
  for (const [hookEvent] of LIFECYCLE) {
    const adapted = adaptHookEvent(makeHookEvent({ hook_event: hookEvent }));
    if (adapted.kind !== 'event') {
      assert.fail(`${hookEvent} must normalize`);
      continue;
    }
    assert.equal(validateEventObject(adapted.event).ok, true, `${hookEvent} must survive the second gate`);
  }
});

test('a normalized event carries exactly the internal contract keys', () => {
  const adapted = adaptHookEvent(SAMPLE_POST_TOOL_USE);
  assert.equal(adapted.kind, 'event');
  if (adapted.kind !== 'event') return;
  assert.deepEqual(Object.keys(adapted.event).sort(), [...CONTRACT_KEYS].sort());
});

test('the published PostToolUse record maps field by field', () => {
  const adapted = adaptHookEvent(SAMPLE_POST_TOOL_USE);
  assert.equal(adapted.kind, 'event');
  if (adapted.kind !== 'event') return;
  assert.deepEqual(adapted.event, {
    schema_version: 2,
    sanitizer_version: 3,
    event_id: '3f2c9d10-8b41-4a7e-9c02-5f1d7a6b2e88',
    session_id: 'sess-1',
    ts: '2026-08-22T05:40:00.123Z',
    event_type: 'tool_use',
    // `agent.id` was null: the producer's identity rule makes that the session's
    // main orchestrator, not an unattributed actor.
    agent_id: 'main',
    agent_role: null,
    runtime_agent_type: null,
    producer_seq: null,
    status: 'ok',
    tool_name: 'Bash',
    duration_ms: 1234,
    token_count: null,
    summary: 'ターミナル処理を確認しました',
  });
});

test('a runtime agent type is kept apart from the org role', () => {
  const adapted = adaptHookEvent(SAMPLE_SUBAGENT_START);
  assert.equal(adapted.kind, 'event');
  if (adapted.kind !== 'event') return;
  assert.equal(adapted.event.runtime_agent_type, 'backend-engineer');
  assert.equal(adapted.event.agent_role, null, 'a runtime agent type is not an org role');
  assert.equal(adapted.event.agent_id, 'agent-1');
});

test('the producer emits no sequence and no token accounting, so neither is invented', () => {
  const adapted = adaptHookEvent(makeHookEvent({ hook_event: 'PostToolUse' }));
  assert.equal(adapted.kind, 'event');
  if (adapted.kind !== 'event') return;
  assert.equal(adapted.event.producer_seq, null);
  assert.equal(adapted.event.token_count, null);
});

// -------------------------------------------------------------- attribution ---

test('a null session_id is refused instead of being given a sentinel', () => {
  const adapted = adaptHookEvent(makeHookEvent({ session_id: null }));
  assert.equal(adapted.kind, 'reject');
  if (adapted.kind !== 'reject') return;
  assert.equal(adapted.reason, 'unattributable');
  assert.equal(adapted.detail, 'session_id:null');
});

test('a null session_id is refused for every known hook_event, deterministically', () => {
  for (const [hookEvent] of LIFECYCLE) {
    for (const attempt of [0, 1]) {
      const adapted = adaptHookEvent(makeHookEvent({ hook_event: hookEvent, session_id: null }));
      assert.equal(adapted.kind, 'reject', `${hookEvent} attempt ${attempt}`);
      if (adapted.kind === 'reject') assert.equal(adapted.reason, 'unattributable');
    }
  }
});

// ------------------------------------------------------------------ capacity ---

test('the capacity marker becomes a control signal, never a business event', () => {
  const adapted = adaptHookEvent(CAPACITY_MARKER);
  assert.equal(adapted.kind, 'capacity');
  if (adapted.kind !== 'capacity') return;
  assert.equal(adapted.detail, HOOK_CAPACITY_DETAIL);
  assert.equal(adapted.detail.includes(CAPACITY_MARKER.activity.label), false, 'no label leaks into the detail');
});

test('a null hook_event that is not the capacity marker is refused', () => {
  const partial = adaptHookEvent(
    makeHookEvent({
      hook_event: null,
      activity: { kind: 'capacity', facility: 'portal', label: '記録容量の上限に達しました' },
      outcome: { status: 'ok', duration_ms: null, is_interrupt: null, error_kind: null, denial_kind: null },
    }),
  );
  assert.equal(partial.kind, 'reject');
  if (partial.kind === 'reject') {
    assert.equal(partial.reason, 'unsupported_hook_event');
    assert.equal(partial.detail, 'hook_event:null_not_capacity_marker');
  }

  const plainNull = adaptHookEvent(makeHookEvent({ hook_event: null }));
  assert.equal(plainNull.kind, 'reject');
  if (plainNull.kind === 'reject') assert.equal(plainNull.detail, 'hook_event:null_not_capacity_marker');
});

test('a known hook_event carrying capacity signals is an undefined shape, so it is refused', () => {
  const mixedStatus = adaptHookEvent(
    makeHookEvent({
      hook_event: 'PostToolUse',
      outcome: { status: 'limit_reached', duration_ms: null, is_interrupt: null, error_kind: null, denial_kind: null },
    }),
  );
  assert.equal(mixedStatus.kind, 'reject');
  if (mixedStatus.kind === 'reject') assert.equal(mixedStatus.detail, 'hook_event:capacity_shape_conflict');

  const mixedKind = adaptHookEvent(
    makeHookEvent({
      hook_event: 'PostToolUse',
      activity: { kind: 'capacity', facility: 'portal', label: '記録容量の上限に達しました' },
    }),
  );
  assert.equal(mixedKind.kind, 'reject');
  if (mixedKind.kind === 'reject') assert.equal(mixedKind.detail, 'hook_event:capacity_shape_conflict');
});

// ------------------------------------------------------------------- unknown ---

test('a hook_event outside the known table is refused, not guessed at', () => {
  for (const hookEvent of ['SessionPaused', 'PostToolUseRetry', 'Stopped', 'sessionstart']) {
    const adapted = adaptHookEvent(makeHookEvent({ hook_event: hookEvent }));
    assert.equal(adapted.kind, 'reject', `${hookEvent} must be refused`);
    if (adapted.kind !== 'reject') continue;
    assert.equal(adapted.reason, 'unsupported_hook_event');
    assert.equal(adapted.detail, 'hook_event:not_in_known_table');
    assert.equal(adapted.detail.includes(hookEvent), false, 'the detail names the rule, not the value');
  }
});

test('a hook_event that names an Object.prototype member is just an unknown value', () => {
  for (const hookEvent of ['constructor', 'toString', 'valueOf']) {
    const adapted = adaptHookEvent(makeHookEvent({ hook_event: hookEvent }));
    assert.equal(adapted.kind, 'reject', `${hookEvent} must not resolve through the prototype chain`);
  }
});
