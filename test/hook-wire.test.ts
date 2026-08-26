/**
 * External LIVE wire contract (Claude Code hook, schema_version 2).
 *
 * These tests pin two things: the producer's own records are accepted, and the
 * boundary stays fail-closed for everything else - including the flat internal
 * model, which carries the same version number and must never be mistaken for
 * this contract.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import type { HookToolCategory } from '../src/domain/hookWire.ts';
import {
  HOOK_FIXED_ACTIVITY,
  HOOK_POST_TOOL_LABELS,
  HOOK_PRE_TOOL_LABELS,
  HOOK_RESEARCH_POST_LABEL,
  HOOK_RESEARCH_PRE_LABEL,
  HOOK_TOOL_CATEGORIES,
  HOOK_TOOL_FACILITY,
  HOOK_TOOL_FAILURE_LABEL,
  HOOK_TOOL_PHASES,
  HOOK_WIRE_KEYS,
  validateHookWireLine,
  validateHookWireObject,
} from '../src/domain/hookWire.ts';
import { HOOK_EVENT_LIFECYCLE } from '../src/domain/hookAdapter.ts';
import { validateEventObject } from '../src/domain/validate.ts';
import { makeEvent } from './helpers.ts';
import {
  CAPACITY_MARKER,
  KNOWN_HOOK_EVENT_SEQUENCE,
  SAMPLE_POST_TOOL_USE,
  SAMPLE_SUBAGENT_START,
  makeHookEvent,
  makeHookLine,
} from './hookFixtures.ts';

test('the producer records published with the contract are accepted', () => {
  for (const sample of [SAMPLE_POST_TOOL_USE, SAMPLE_SUBAGENT_START]) {
    const result = validateHookWireObject(sample);
    assert.equal(result.ok, true, `${sample.hook_event ?? 'null'} must validate`);
    if (!result.ok) continue;
    assert.deepEqual(result.dropped_keys, [], 'the contract models every key the producer emits');
    assert.equal(result.wire.event_id, sample.event_id);
    assert.equal(result.wire.activity.label, sample.activity.label);
  }
});

test('every row of the known hook_event table validates, and so does the capacity marker', () => {
  for (const wire of [...KNOWN_HOOK_EVENT_SEQUENCE, CAPACITY_MARKER]) {
    assert.equal(validateHookWireObject(wire).ok, true, `${wire.hook_event ?? 'capacity marker'} must validate`);
  }
});

// ------------------------------------------------- the two schema_version 2s ---

test('the flat internal model is refused by the external wire validator', () => {
  const result = validateHookWireObject(makeEvent());
  assert.equal(result.ok, false, 'a flat schema_version 2 event is not a hook wire event');
  if (!result.ok) {
    // The first key the flat model does not carry. Nothing about the payload is
    // guessed from its shape: it simply fails the contract it was handed to.
    assert.equal(result.reason, 'missing_key');
    assert.equal(result.detail, 'producer:absent');
  }
});

test('a hook wire event is refused by the internal normalized validator', () => {
  const result = validateEventObject(SAMPLE_POST_TOOL_USE);
  assert.equal(result.ok, false, 'the rich shape is not the internal model');
  if (!result.ok) assert.equal(result.reason, 'missing_key');
});

// --------------------------------------------------------------- fail closed ---

test('an unsupported schema_version is refused before anything is interpreted', () => {
  for (const schemaVersion of [1, 3, 0]) {
    const result = validateHookWireObject({ ...makeHookEvent(), schema_version: schemaVersion });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'unsupported_schema');
  }
});

test('sanitizer_version never gates acceptance', () => {
  for (const sanitizerVersion of [0, 3, 4, 99]) {
    const result = validateHookWireObject(makeHookEvent({ sanitizer_version: sanitizerVersion }));
    assert.equal(result.ok, true, `sanitizer_version ${sanitizerVersion} must be accepted`);
    if (result.ok) assert.equal(result.wire.sanitizer_version, sanitizerVersion);
  }
});

test('a payload that does not identify as a local Claude Code hook is refused', () => {
  const wrongKind = validateHookWireObject(
    makeHookEvent({ producer: { kind: 'something-else', host_id: '0123456789ab', env: 'local' } }),
  );
  assert.equal(wrongKind.ok, false);
  if (!wrongKind.ok) {
    assert.equal(wrongKind.reason, 'unsupported_producer');
    assert.equal(wrongKind.detail, 'producer.kind:not_allowed');
  }

  const wrongEnv = validateHookWireObject(
    makeHookEvent({ producer: { kind: 'claude-code-hook', host_id: '0123456789ab', env: 'cloud' } }),
  );
  assert.equal(wrongEnv.ok, false);
  if (!wrongEnv.ok) assert.equal(wrongEnv.reason, 'unsupported_producer');
});

test('every top-level contract key is mandatory', () => {
  for (const key of HOOK_WIRE_KEYS) {
    if (key === 'schema_version') continue;
    const raw: Record<string, unknown> = { ...makeHookEvent() };
    delete raw[key];
    const result = validateHookWireObject(raw);
    assert.equal(result.ok, false, `${key} must be mandatory`);
    if (!result.ok) {
      assert.equal(result.reason, 'missing_key');
      assert.equal(result.detail, `${key}:absent`);
    }
  }
});

test('a missing nested key is reported by path, and refused', () => {
  const result = validateHookWireObject(
    makeHookEvent({ outcome: { status: 'ok', duration_ms: null, is_interrupt: null, error_kind: null } as never }),
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, 'missing_key');
    assert.equal(result.detail, 'outcome.denial_kind:absent');
  }
});

test('values outside a closed vocabulary are refused', () => {
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ session: { source: 'teleport', end_reason: null } }, 'session.source:not_in_vocabulary'],
    [{ tool: { name: null, category: 'telepathy', mcp_server: null, tool_use_id: null } }, 'tool.category:not_in_vocabulary'],
    [{ activity: { kind: 'daydream', facility: 'desk', label: 'x' } }, 'activity.kind:not_in_vocabulary'],
    [{ activity: { kind: 'exec', facility: 'rooftop', label: 'x' } }, 'activity.facility:not_in_vocabulary'],
    [
      { outcome: { status: 'maybe', duration_ms: null, is_interrupt: null, error_kind: null, denial_kind: null } },
      'outcome.status:not_in_vocabulary',
    ],
  ];
  for (const [override, detail] of cases) {
    const result = validateHookWireObject({ ...makeHookEvent(), ...override });
    assert.equal(result.ok, false, `${detail} must be refused`);
    if (!result.ok) {
      assert.equal(result.reason, 'invalid_format');
      assert.equal(result.detail, detail);
    }
  }
});

test('malformed scalars are refused', () => {
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ event_id: 'not-a-uuid' }, 'invalid_format'],
    // Valid UUID shape but version 1.
    [{ event_id: 'f81d4fae-7dec-11d0-a765-00a0c91e6bf6' }, 'invalid_format'],
    // Uppercase is not the canonical lowercase form the producer emits.
    [{ event_id: '3F2C9D10-8B41-4A7E-9C02-5F1D7A6B2E88' }, 'invalid_format'],
    [{ ts: '2026-08-22T05:40:00Z' }, 'invalid_format'],
    [{ ts: '2026-08-22T05:40:00.123+09:00' }, 'invalid_format'],
    [{ ts: 42 }, 'type_error'],
    [{ session_id: 'sess 1' }, 'invalid_format'],
    [{ hook_event: 'Post_Tool_Use' }, 'invalid_format'],
    [{ truncated: true }, 'invalid_format'],
    [{ producer: { kind: 'claude-code-hook', host_id: 'nothex', env: 'local' } }, 'invalid_format'],
    [{ agent: { id: null, type: null, parent_session_id: 'sess-0' } }, 'invalid_format'],
  ];
  for (const [override, reason] of cases) {
    const result = validateHookWireObject({ ...makeHookEvent(), ...override });
    assert.equal(result.ok, false, `${JSON.stringify(override)} must be refused`);
    if (!result.ok) assert.equal(result.reason, reason, `${JSON.stringify(override)} -> ${result.detail}`);
  }
});

test('duration_ms is bounded by the producer range', () => {
  const overRange = validateHookWireObject(
    makeHookEvent({
      outcome: { status: 'ok', duration_ms: 86_400_001, is_interrupt: null, error_kind: null, denial_kind: null },
    }),
  );
  assert.equal(overRange.ok, false);
  if (!overRange.ok) assert.equal(overRange.detail, 'outcome.duration_ms:out_of_range');

  for (const durationMs of [0, 1234, 86_400_000]) {
    const result = validateHookWireObject(
      makeHookEvent({
        hook_event: 'PostToolUse',
        outcome: { status: 'ok', duration_ms: durationMs, is_interrupt: null, error_kind: null, denial_kind: null },
      }),
    );
    assert.equal(result.ok, true, `${durationMs} ms must be accepted`);
  }
});

test('unsafe content anywhere in a retained field is refused, and never echoed', () => {
  const unsafeLabels = [
    'read /Users/someone/secrets.txt',
    'opened ~/.ssh/id_rsa',
    'key sk-ant-abcdefghijklmnop',
    'ran sudo rm -rf something',
    '-----BEGIN RSA PRIVATE KEY-----',
  ];
  for (const label of unsafeLabels) {
    const result = validateHookWireObject(makeHookEvent({ activity: { kind: 'exec', facility: 'terminal', label } }));
    assert.equal(result.ok, false, `must refuse: ${label.slice(0, 12)}`);
    if (!result.ok) {
      assert.equal(result.reason, 'unsafe_content');
      assert.equal(result.detail.includes(label), false, 'the detail must not echo content');
    }
  }
});

test('a control character in a label is refused', () => {
  const result = validateHookWireObject(
    makeHookEvent({ activity: { kind: 'exec', facility: 'terminal', label: 'line\nbreak' } }),
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.detail, 'activity.label:control_characters');
});

test('unmodelled producer keys are dropped by path, never forwarded', () => {
  const raw: Record<string, unknown> = {
    ...makeHookEvent(),
    future_top_level: 'ignored',
    outcome: {
      status: 'started',
      duration_ms: null,
      is_interrupt: null,
      error_kind: null,
      denial_kind: null,
      future_nested: 'ignored',
    },
  };
  const result = validateHookWireObject(raw);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.dropped_keys.sort(), ['future_top_level', 'outcome.future_nested']);
  assert.equal(Object.prototype.hasOwnProperty.call(result.wire, 'future_top_level'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(result.wire.outcome, 'future_nested'), false);
});

test('a validated wire event carries exactly the modelled keys', () => {
  const result = validateHookWireObject(SAMPLE_POST_TOOL_USE);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(Object.keys(result.wire).sort(), [...HOOK_WIRE_KEYS].sort());
});

// --------------------------------------------------- the fixed activity table ---

/**
 * The pinned producer's non-tool tuples, restated verbatim so that changing the
 * table in `hookWire.ts` cannot silently change what the boundary accepts.
 * `[hook_event, kind, facility, label, outcome.status]`.
 */
const FIXED_TUPLES: ReadonlyArray<[string, string, string, string, string]> = [
  ['SessionStart', 'session', 'desk', 'セッションが開始されました', 'started'],
  ['SessionEnd', 'session', 'desk', 'セッションが終了しました', 'ok'],
  ['SubagentStart', 'delegate', 'meeting', '専門Agentが起動しました', 'started'],
  ['SubagentStop', 'delegate', 'meeting', '専門Agentの処理が終了しました', 'ok'],
  ['UserPromptSubmit', 'idle', 'desk', 'イベントを記録しました', 'started'],
  ['Stop', 'session', 'desk', '応答処理が終了しました', 'ok'],
  ['StopFailure', 'session', 'desk', 'APIエラーで応答が終了しました', 'error'],
  ['PermissionRequest', 'permission', 'desk', '権限確認が発生しました', 'waiting'],
  ['PermissionDenied', 'permission', 'desk', '自動モードで実行が許可されませんでした', 'auto_denied'],
  ['Notification', 'session', 'desk', '通知が発生しました', 'waiting'],
  ['PreCompact', 'session', 'desk', 'コンテキスト整理が開始されました', 'started'],
  ['TaskCreated', 'task', 'desk', '内部タスクが作成されました', 'started'],
  ['TaskCompleted', 'task', 'desk', '内部タスクが完了しました', 'ok'],
];

/** Builds a row for `hookEvent` with an explicit activity tuple. */
function withActivity(
  hookEvent: string | null,
  kind: string,
  facility: string,
  label: string,
  status: string,
): unknown {
  return {
    ...makeHookEvent({ hook_event: hookEvent }),
    activity: { kind, facility, label },
    outcome: { status, duration_ms: null, is_interrupt: null, error_kind: null, denial_kind: null },
  };
}

test('each pinned producer tuple is accepted for its own event', () => {
  for (const [hookEvent, kind, facility, label, status] of FIXED_TUPLES) {
    const result = validateHookWireObject(withActivity(hookEvent, kind, facility, label, status));
    assert.equal(result.ok, true, `${hookEvent} must be accepted with its own tuple`);
    if (result.ok) assert.equal(result.wire.activity.label, label);
  }
});

test('an arbitrary control-free label is refused for every known hook_event', () => {
  // Nothing unsafe about these strings: they are bounded, control-free and hit
  // no path/credential rule. They are refused because they are not the phrase
  // the producer emits for the event - a raw prompt or command reads like this.
  const arbitrary = ['echo the customer discussion', 'summarize the meeting notes', '顧客との会話を整理して'];
  for (const [hookEvent, kind, facility, , status] of FIXED_TUPLES) {
    for (const label of arbitrary) {
      const result = validateHookWireObject(withActivity(hookEvent, kind, facility, label, status));
      assert.equal(result.ok, false, `${hookEvent} must refuse an arbitrary label`);
      if (result.ok) continue;
      assert.equal(result.reason, 'contract_mismatch');
      assert.equal(result.detail, 'activity.label:not_fixed_for_event');
      assert.equal(result.detail.includes(label), false, 'the detail names the rule, not the value');
    }
  }
});

test('a genuine producer phrase is refused on another event', () => {
  for (const [hookEvent, kind, facility, , status] of FIXED_TUPLES) {
    for (const [otherEvent, , , otherLabel] of FIXED_TUPLES) {
      if (otherEvent === hookEvent) continue;
      const result = validateHookWireObject(withActivity(hookEvent, kind, facility, otherLabel, status));
      // A tuple is only equal to itself: some pairs differ on the label, and the
      // pairs that share one differ on kind, facility or status.
      if (result.ok) {
        const expected = FIXED_TUPLES.find((row) => row[0] === hookEvent);
        assert.ok(expected !== undefined);
        assert.equal(result.wire.activity.label, expected[3], `${otherEvent} label leaked onto ${hookEvent}`);
        continue;
      }
      assert.equal(result.reason, 'contract_mismatch');
    }
  }
});

test('a mismatched kind, facility or status is refused, not just a mismatched label', () => {
  const cases: Array<[unknown, string]> = [
    [withActivity('SessionStart', 'task', 'desk', 'セッションが開始されました', 'started'), 'activity.kind'],
    [withActivity('SessionStart', 'session', 'meeting', 'セッションが開始されました', 'started'), 'activity.facility'],
    [withActivity('SessionStart', 'session', 'desk', 'セッションが開始されました', 'ok'), 'outcome.status'],
  ];
  for (const [raw, field] of cases) {
    const result = validateHookWireObject(raw);
    assert.equal(result.ok, false, `${field} must be correlated`);
    if (!result.ok) {
      assert.equal(result.reason, 'contract_mismatch');
      assert.equal(result.detail, `${field}:not_fixed_for_event`);
    }
  }
});

// ------------------------------------------------------------- tool activity ---

/** A tool row: the tuple is a function of the phase, the category and the name. */
function toolRow(
  hookEvent: string,
  category: HookToolCategory,
  toolName: string,
  label: string,
  status: string,
): unknown {
  const facility = HOOK_TOOL_FACILITY.get(category);
  assert.ok(facility !== undefined, `${category} must have a facility`);
  return {
    ...makeHookEvent({ hook_event: hookEvent }),
    tool: { name: toolName, category, mcp_server: null, tool_use_id: 'tool-1' },
    activity: { kind: category, facility, label },
    outcome: { status, duration_ms: null, is_interrupt: null, error_kind: null, denial_kind: null },
  };
}

test('every tool category is accepted with exactly its own fixed label, per phase', () => {
  for (const category of HOOK_TOOL_CATEGORIES) {
    const pre = HOOK_PRE_TOOL_LABELS.get(category);
    const post = HOOK_POST_TOOL_LABELS.get(category);
    assert.ok(pre !== undefined && post !== undefined, `${category} must have both labels`);

    for (const [hookEvent, label, status] of [
      ['PreToolUse', pre, 'started'],
      ['PostToolUse', post, 'ok'],
      ['PostToolUseFailure', HOOK_TOOL_FAILURE_LABEL, 'error'],
    ] as const) {
      const ok = validateHookWireObject(toolRow(hookEvent, category, 'Bash', label, status));
      assert.equal(ok.ok, true, `${hookEvent} ${category} must accept its own label`);
    }

    // The other phase's label for the same category, and the same phase's label
    // from a different category, are both refused.
    const wrongPhase = validateHookWireObject(toolRow('PreToolUse', category, 'Bash', post, 'started'));
    assert.equal(wrongPhase.ok, false, `${category}: a post label must not pass as a pre label`);
    if (!wrongPhase.ok) assert.equal(wrongPhase.detail, 'activity.label:not_fixed_for_tool');

    for (const other of HOOK_TOOL_CATEGORIES) {
      if (other === category) continue;
      const otherPre = HOOK_PRE_TOOL_LABELS.get(other);
      assert.ok(otherPre !== undefined);
      if (otherPre === pre) continue;
      const crossed = validateHookWireObject(toolRow('PreToolUse', category, 'Bash', otherPre, 'started'));
      assert.equal(crossed.ok, false, `${other}'s label must not pass as ${category}'s`);
    }
  }
});

test('the web research tools are labelled by name, not by category', () => {
  for (const toolName of ['WebSearch', 'WebFetch']) {
    for (const [hookEvent, label, status] of [
      ['PreToolUse', HOOK_RESEARCH_PRE_LABEL, 'started'],
      ['PostToolUse', HOOK_RESEARCH_POST_LABEL, 'ok'],
    ] as const) {
      const ok = validateHookWireObject(toolRow(hookEvent, 'search', toolName, label, status));
      assert.equal(ok.ok, true, `${toolName} ${hookEvent} must accept the research label`);

      // The plain category label is not what the producer emits for these two.
      const categoryLabel =
        hookEvent === 'PreToolUse' ? HOOK_PRE_TOOL_LABELS.get('search') : HOOK_POST_TOOL_LABELS.get('search');
      assert.ok(categoryLabel !== undefined);
      const refused = validateHookWireObject(toolRow(hookEvent, 'search', toolName, categoryLabel, status));
      assert.equal(refused.ok, false, `${toolName} must not carry the category label`);
      if (!refused.ok) assert.equal(refused.detail, 'activity.label:not_fixed_for_tool');

      // And the research label does not travel to an ordinary tool.
      const onBash = validateHookWireObject(toolRow(hookEvent, 'search', 'Grep', label, status));
      assert.equal(onBash.ok, false, 'the research label belongs to WebSearch/WebFetch only');
    }
  }
});

test('a tool row without a tool is refused rather than labelled generically', () => {
  for (const hookEvent of ['PreToolUse', 'PostToolUse', 'PostToolUseFailure']) {
    const noCategory = validateHookWireObject({
      ...makeHookEvent({ hook_event: hookEvent }),
      tool: { name: 'Bash', category: null, mcp_server: null, tool_use_id: null },
    });
    assert.equal(noCategory.ok, false);
    if (!noCategory.ok) assert.equal(noCategory.detail, 'tool.category:required_for_tool_event');

    const noName = validateHookWireObject({
      ...makeHookEvent({ hook_event: hookEvent }),
      tool: { name: null, category: 'exec', mcp_server: null, tool_use_id: null },
    });
    assert.equal(noName.ok, false);
    if (!noName.ok) assert.equal(noName.detail, 'tool.name:required_for_tool_event');
  }
});

test('the activity table and the lifecycle table describe the same known events', () => {
  const activityEvents = [...HOOK_FIXED_ACTIVITY.keys(), ...HOOK_TOOL_PHASES.keys()].sort();
  assert.deepEqual(activityEvents, [...HOOK_EVENT_LIFECYCLE.keys()].sort(), 'no known event may lack a fixed tuple');

  for (const category of HOOK_TOOL_CATEGORIES) {
    assert.ok(HOOK_TOOL_FACILITY.has(category), `${category} needs a facility`);
    assert.ok(HOOK_PRE_TOOL_LABELS.has(category), `${category} needs a pre label`);
    assert.ok(HOOK_POST_TOOL_LABELS.has(category), `${category} needs a post label`);
  }
});

// ---------------------------------------------------------- capacity marker ---

test("the capacity control row is accepted only in the producer's exact shape", () => {
  assert.equal(validateHookWireObject(CAPACITY_MARKER).ok, true, 'the pinned marker must validate');

  const fixedLabel = '本日の記録上限に達しました';
  const variants: Array<[Record<string, unknown>, string]> = [
    [
      { activity: { kind: 'capacity', facility: 'portal', label: fixedLabel } },
      'activity.facility:not_fixed_for_capacity',
    ],
    [
      { activity: { kind: 'capacity', facility: 'desk', label: '記録容量の上限に達しました' } },
      'activity.label:not_fixed_for_capacity',
    ],
    [{ activity: { kind: 'session', facility: 'desk', label: fixedLabel } }, 'activity.kind:not_fixed_for_capacity'],
    [
      { outcome: { status: 'ok', duration_ms: null, is_interrupt: null, error_kind: null, denial_kind: null } },
      'outcome.status:not_fixed_for_capacity',
    ],
    [{ session_id: 'sess-1' }, 'session_id:expected_null_for_capacity'],
    [{ agent: { id: 'agent-1', type: null, parent_session_id: null } }, 'agent.id:expected_null_for_capacity'],
    [
      { agent: { id: null, type: 'backend-engineer', parent_session_id: null } },
      'agent.type:expected_null_for_capacity',
    ],
  ];
  for (const [override, detail] of variants) {
    const result = validateHookWireObject({ ...CAPACITY_MARKER, ...override });
    assert.equal(result.ok, false, `${detail} must be refused`);
    if (!result.ok) {
      assert.equal(result.reason, 'contract_mismatch');
      assert.equal(result.detail, detail);
    }
  }
});

// ------------------------------------------------------------------- lines ---

test('line-level failures are refused before parsing or interpretation', () => {
  assert.equal(validateHookWireLine('{"schema_version":2').ok, false);
  assert.equal(validateHookWireLine('not json at all').ok, false);
  assert.equal(validateHookWireLine('[1,2,3]').ok, false);
  assert.equal(validateHookWireLine('null').ok, false);

  const blank = validateHookWireLine('   ');
  assert.equal(blank.ok, false);
  if (!blank.ok) assert.equal(blank.reason, 'blank');

  const oversized = validateHookWireLine(makeHookLine(), { maxLineBytes: 16 });
  assert.equal(oversized.ok, false);
  if (!oversized.ok) assert.equal(oversized.reason, 'oversized_line');
});

test('a rejection detail never contains a value from the line', () => {
  const result = validateHookWireLine('{"schema_version":2,"secret":"sk-ant-aaaaaaaaaaaaaaaa"}');
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.detail.includes('sk-ant'), false);
});
