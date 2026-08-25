import test from 'node:test';
import assert from 'node:assert/strict';

import { validateEventObject, validateLine } from '../src/domain/validate.ts';
import { makeEvent, makeLine } from './helpers.ts';

test('accepts a well-formed schema_version 2 line', () => {
  const result = validateLine(makeLine({ summary: 'agent started' }));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.event.schema_version, 2);
  assert.equal(result.event.summary, 'agent started');
  assert.deepEqual(result.dropped_keys, []);
});

test('drops unknown producer keys instead of forwarding them', () => {
  const raw = { ...makeEvent(), future_field: 'ignored', nested: { a: 1 } };
  const result = validateEventObject(raw);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.dropped_keys.sort(), ['future_field', 'nested']);
  assert.equal(Object.prototype.hasOwnProperty.call(result.event, 'future_field'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(result.event, 'nested'), false);
});

test('sanitizer_version changes never affect acceptance', () => {
  for (const sanitizerVersion of [0, 3, 4, 99]) {
    const result = validateLine(makeLine({ sanitizer_version: sanitizerVersion }));
    assert.equal(result.ok, true, `sanitizer_version ${sanitizerVersion} must be accepted`);
    if (result.ok) assert.equal(result.event.sanitizer_version, sanitizerVersion);
  }
});

test('unsupported schema_version is rejected fail-closed', () => {
  for (const schemaVersion of [1, 3, 0]) {
    const result = validateLine(makeLine({ schema_version: schemaVersion }));
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'unsupported_schema');
  }
});

test('missing contract keys are rejected even when nullable', () => {
  const raw: Record<string, unknown> = { ...makeEvent() };
  delete raw['summary'];
  const result = validateEventObject(raw);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, 'missing_key');
    assert.equal(result.detail, 'summary:absent');
  }
});

test('explicit nulls are accepted for nullable keys', () => {
  const result = validateEventObject(
    makeEvent({ agent_id: null, agent_role: null, status: null, tool_name: null, summary: null }),
  );
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.event.agent_id, null);
});

test('type errors are rejected', () => {
  const cases: Array<[Partial<Record<string, unknown>>, string]> = [
    [{ session_id: null }, 'type_error'],
    [{ event_id: 42 }, 'type_error'],
    [{ duration_ms: 'fast' }, 'type_error'],
    [{ token_count: -1 }, 'invalid_format'],
    [{ duration_ms: 1.5 }, 'invalid_format'],
    [{ ts: 'yesterday' }, 'invalid_format'],
    [{ event_type: 'Agent Start' }, 'invalid_format'],
  ];
  for (const [override, expected] of cases) {
    const result = validateEventObject({ ...makeEvent(), ...override });
    assert.equal(result.ok, false, `${JSON.stringify(override)} must be rejected`);
    if (!result.ok) assert.equal(result.reason, expected, `${JSON.stringify(override)} -> ${result.reason}`);
  }
});

test('event_id must be a UUIDv4', () => {
  const notUuid = validateEventObject(makeEvent({ event_id: 'abc' }));
  assert.equal(notUuid.ok, false);
  // Valid UUID shape but version 1: still rejected.
  const uuidV1 = validateEventObject(makeEvent({ event_id: 'f81d4fae-7dec-11d0-a765-00a0c91e6bf6' }));
  assert.equal(uuidV1.ok, false);
  if (!uuidV1.ok) assert.equal(uuidV1.reason, 'invalid_format');
});

test('malformed and non-object lines are rejected', () => {
  assert.equal(validateLine('{"schema_version":2').ok, false);
  assert.equal(validateLine('not json at all').ok, false);
  assert.equal(validateLine('[1,2,3]').ok, false);
  assert.equal(validateLine('"a string"').ok, false);
  assert.equal(validateLine('null').ok, false);

  const blank = validateLine('   ');
  assert.equal(blank.ok, false);
  if (!blank.ok) assert.equal(blank.reason, 'blank');
});

test('oversized lines are rejected before parsing', () => {
  const result = validateLine(makeLine({ summary: 'ok' }), { maxLineBytes: 16 });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, 'oversized_line');
});

test('over-long summaries are rejected', () => {
  const result = validateEventObject(makeEvent({ summary: 'x'.repeat(257) }));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, 'field_too_long');
});

test('unsafe content is rejected and never echoed back', () => {
  const unsafeSummaries = [
    'read /Users/someone/secrets.txt',
    'opened ~/.ssh/id_rsa',
    'key sk-ant-abcdefghijklmnop',
    'ghp_abcdefghijklmnopqrstuvwxyz012345',
    'AKIAIOSFODNN7EXAMPLE ',
    'password: hunter2000',
    'ran sudo rm -rf something',
    'file:///tmp/x',
    '-----BEGIN RSA PRIVATE KEY-----',
    'Bearer abcdefghijklmnopqrstuvwxyz',
  ];
  for (const summary of unsafeSummaries) {
    const result = validateEventObject(makeEvent({ summary }));
    assert.equal(result.ok, false, `must reject: ${summary.slice(0, 12)}`);
    if (!result.ok) {
      assert.equal(result.reason, 'unsafe_content');
      assert.equal(result.detail.includes(summary), false, 'detail must not echo content');
    }
  }
});

test('absolute paths hidden in labels are rejected too', () => {
  const result = validateEventObject(makeEvent({ tool_name: null, status: null, session_id: 'ok-1' }));
  assert.equal(result.ok, true);
  const bad = validateEventObject(makeEvent({ session_id: '/home/someone/session' }));
  assert.equal(bad.ok, false);
});

test('rejection details are content free', () => {
  const result = validateLine('{"schema_version":2,"secret":"sk-ant-aaaaaaaaaaaaaaaa"}');
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.detail.includes('sk-ant'), false);
});
