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

import { HOOK_WIRE_KEYS, validateHookWireLine, validateHookWireObject } from '../src/domain/hookWire.ts';
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
