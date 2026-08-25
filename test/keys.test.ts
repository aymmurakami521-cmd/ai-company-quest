/**
 * Identifiers that collide with `Object.prototype` members.
 *
 * `session_id` and `agent_id` accept `__proto__`, `constructor`, `toString` and
 * `valueOf`; `event_type` accepts `constructor` and `valueof`. On an ordinary
 * object literal those keys answer a lookup with an inherited member instead of
 * `undefined`, which is not a curiosity here: it throws inside the reducer,
 * after the tailer has already advanced past the line, so the record and every
 * later record for that identifier are lost with only a sanitized error notice.
 *
 * These tests pin the guarantee: an identifier is only ever an identifier.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { JsonlTailer } from '../src/collector/tailer.ts';
import { NamespaceStore } from '../src/collector/store.ts';
import { resolveActor } from '../src/domain/actor.ts';
import {
  DEFAULT_STATE_LIMITS,
  checkStateLimits,
  createInitialState,
  reduce,
  reduceAll,
} from '../src/domain/reducer.ts';
import { makeEvent, makeIngested, makeLine } from './helpers.ts';

/** Every `Object.prototype` member name the id patterns actually admit. */
const HOSTILE_IDS = ['__proto__', 'constructor', 'toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf'];

test('a session_id that names an Object.prototype member is folded as an ordinary session', () => {
  for (const sessionId of HOSTILE_IDS) {
    const state = createInitialState('live');
    const next = reduce(state, makeIngested(makeEvent({ session_id: sessionId, event_type: 'session_start' }), 1));

    const session = next.sessions[sessionId];
    assert.ok(session !== undefined, `${sessionId}: a session was stored`);
    assert.equal(session?.session_id, sessionId);
    assert.equal(session?.event_count, 1);
    assert.deepEqual(Object.keys(next.sessions), [sessionId], 'exactly one session, no phantom entry');
    assert.equal(next.counters.applied, 1);
    assert.equal(Object.keys(next.actors).length, 1);
  }
});

test('hostile ids do not leak into the prototype chain of anything', () => {
  const state = createInitialState('live');
  const next = reduceAll(state, [
    makeIngested(makeEvent({ session_id: '__proto__', agent_id: '__proto__' }), 1),
    makeIngested(makeEvent({ session_id: 'constructor', agent_id: 'constructor' }), 2),
  ]);

  assert.equal(Object.keys(next.sessions).length, 2);
  assert.equal(Object.keys(next.actors).length, 2);
  // Nothing was written through a `__proto__` setter: plain objects are intact.
  const probe: Record<string, unknown> = {};
  assert.equal(probe['session_id'], undefined);
  assert.equal(Object.getPrototypeOf(probe), Object.prototype);
  assert.equal(Object.getPrototypeOf([]), Array.prototype);
});

test('a repeated hostile session_id accumulates instead of restarting', () => {
  const state = createInitialState('live');
  const next = reduceAll(state, [
    makeIngested(makeEvent({ session_id: '__proto__', event_type: 'session_start' }), 1),
    makeIngested(makeEvent({ session_id: '__proto__', event_type: 'agent_start' }), 2),
    makeIngested(makeEvent({ session_id: '__proto__', event_type: 'session_end' }), 3),
  ]);

  const session = next.sessions['__proto__'];
  assert.equal(session?.event_count, 3, 'the same session, not three phantom ones');
  assert.equal(session?.started_at, '2026-01-01T00:00:00.000Z');
  assert.equal(session?.ended_at, '2026-01-01T00:00:00.000Z');
  assert.equal(next.actors['__proto__:main']?.active, false);
  assert.deepEqual(Object.keys(next.sessions), ['__proto__']);
});

test('an event_type that names an Object.prototype member is counted as a number', () => {
  const state = createInitialState('live');
  const next = reduceAll(state, [
    makeIngested(makeEvent({ event_type: 'constructor' }), 1),
    makeIngested(makeEvent({ event_type: 'constructor' }), 2),
    makeIngested(makeEvent({ event_type: 'valueof' }), 3),
  ]);

  assert.equal(next.counters.by_type['constructor'], 2);
  assert.equal(next.counters.by_type['valueof'], 1);
  assert.deepEqual(Object.keys(next.counters.by_type).sort(), ['constructor', 'valueof']);
  // Unknown-but-well-formed types are recorded, never interpreted.
  assert.equal(next.counters.ignored, 3);
});

test('retention limits count a hostile id as a new key, not as an existing one', () => {
  const state = createInitialState('live', undefined, { ...DEFAULT_STATE_LIMITS, max_sessions: 1 });

  const first = makeIngested(makeEvent({ session_id: '__proto__' }), 1);
  assert.equal(checkStateLimits(state, first), null, 'nothing is tracked yet');
  const next = reduce(state, first);

  // The same session again is free; a different one crosses the ceiling.
  assert.equal(checkStateLimits(next, makeIngested(makeEvent({ session_id: '__proto__' }), 2)), null);
  assert.equal(checkStateLimits(next, makeIngested(makeEvent({ session_id: 'sess-1' }), 3))?.limit, 'sessions');
});

test('an agent_id that names an Object.prototype member misses the actor directory', () => {
  const directory = { roles: { 'sess-1:reviewer': 'reviewer' } };

  for (const agentId of HOSTILE_IDS) {
    const actor = resolveActor('sess-1', agentId, null, directory);
    assert.equal(actor.role, null, `${agentId}: no inherited member became a role`);
    assert.equal(actor.resolved, false);
    assert.equal(actor.role_source, 'none');
  }

  // The directory itself still works for a real entry.
  assert.equal(resolveActor('sess-1', 'reviewer', null, directory).role, 'reviewer');
});

test('a hostile session_id is ingested by the store like any other', () => {
  for (const namespace of ['live', 'demo'] as const) {
    const store = new NamespaceStore({ namespace });
    const first = store.ingestLine(makeLine({ session_id: '__proto__' }));
    const second = store.ingestLine(makeLine({ session_id: '__proto__', event_type: 'tool_use', tool_name: 'read' }));

    assert.equal(first.status, 'accepted', `${namespace}: first accepted`);
    assert.equal(second.status, 'accepted', `${namespace}: second accepted`);
    assert.equal(store.stats.accepted, 2);
    assert.equal(store.stats.rejected, 0);
    assert.equal(store.halted, false, 'a valid line must not fail the stream closed');
    assert.equal(store.state.sessions['__proto__']?.event_count, 2);
  }
});

test('a hostile session_id in the LIVE stream loses no record after it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'quest-keys-'));
  const file = join(dir, 'events.jsonl');
  const store = new NamespaceStore({ namespace: 'live' });
  const notices: string[] = [];

  const tailer = new JsonlTailer(
    { path: file },
    {
      onLine: (line) => void store.ingestLine(line),
      onNotice: (notice) => notices.push(notice.type),
    },
  );

  try {
    // A throw inside the reducer would surface here as a tailer error *after*
    // the offset moved, taking the rest of this chunk with it.
    const lines = [
      makeLine({ session_id: 'sess-1' }),
      makeLine({ session_id: '__proto__' }),
      makeLine({ session_id: 'sess-1', event_type: 'agent_status', status: 'busy' }),
      makeLine({ session_id: 'constructor' }),
      makeLine({ session_id: 'sess-1', event_type: 'session_end' }),
    ];
    await writeFile(file, `${lines.join('\n')}\n`);
    await tailer.pollOnce();

    assert.equal(store.stats.lines_seen, 5);
    assert.equal(store.stats.accepted, 5, 'no record was dropped');
    assert.equal(store.stats.rejected, 0);
    assert.equal(tailer.stats.errors, 0);
    assert.equal(notices.includes('error'), false);
    assert.equal(Object.keys(store.state.sessions).length, 3);
    assert.equal(store.state.sessions['sess-1']?.ended_at, '2026-01-01T00:00:00.000Z');
  } finally {
    await tailer.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
