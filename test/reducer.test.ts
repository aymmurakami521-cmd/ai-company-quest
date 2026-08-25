import test from 'node:test';
import assert from 'node:assert/strict';

import { createInitialState, reduce, reduceAll } from '../src/domain/reducer.ts';
import type { IngestedEvent } from '../src/domain/reducer.ts';
import { makeEvent, makeIngested } from './helpers.ts';

function seq(events: ReturnType<typeof makeEvent>[], namespace: 'live' | 'demo' = 'live'): IngestedEvent[] {
  return events.map((event, index) => makeIngested(event, index + 1, namespace));
}

test('reduce does not mutate the previous state', () => {
  const state = createInitialState('live');
  // Serialized rather than structuredClone'd: the keyed maps are prototype-less
  // and a clone would compare unequal on the prototype alone.
  const before = JSON.stringify(state);
  const next = reduce(state, makeIngested(makeEvent({ event_type: 'session_start' }), 1));

  assert.equal(JSON.stringify(state), before);
  assert.notEqual(next, state);
  assert.equal(state.counters.applied, 0);
  assert.equal(next.counters.applied, 1);
});

test('the player entity is never an input to or output of event handling', () => {
  const state = createInitialState('live');
  const playerBefore = structuredClone(state.player);

  const events = seq([
    makeEvent({ event_type: 'session_start' }),
    makeEvent({ event_type: 'agent_start', agent_id: 'player' }),
    makeEvent({ event_type: 'agent_status', agent_id: 'player', status: 'busy' }),
    makeEvent({ event_type: 'tool_use', agent_id: 'player', tool_name: 'read' }),
    makeEvent({ event_type: 'session_end' }),
    makeEvent({ event_type: 'totally_new_type' }),
  ]);
  const next = reduceAll(state, events);

  // Same object identity and same value: no event path can reach the player.
  assert.equal(Object.is(next.player, state.player), true);
  assert.deepEqual(next.player, playerBefore);
  // An agent that happens to be called "player" becomes an actor, not the player.
  assert.equal(next.actors['sess-1:player']?.agent_id, 'player');
  assert.equal(next.player.kind, 'player');
  assert.equal(next.player.display_name, 'Player');
});

test('sessions and actors are tracked from events', () => {
  const state = reduceAll(
    createInitialState('live'),
    seq([
      makeEvent({ event_type: 'session_start', ts: '2026-01-01T00:00:00.000Z' }),
      makeEvent({ event_type: 'agent_start', agent_id: 'worker-1', ts: '2026-01-01T00:00:01.000Z', status: 'active' }),
      makeEvent({
        event_type: 'tool_use',
        agent_id: 'worker-1',
        tool_name: 'grep',
        ts: '2026-01-01T00:00:02.000Z',
      }),
    ]),
  );

  const session = state.sessions['sess-1'];
  if (session === undefined) throw new Error('session sess-1 missing');
  assert.equal(session.started_at, '2026-01-01T00:00:00.000Z');
  assert.equal(session.ended_at, null);
  assert.equal(session.event_count, 3);
  assert.deepEqual(session.actor_keys, ['sess-1:main', 'sess-1:worker-1']);

  const worker = state.actors['sess-1:worker-1'];
  if (worker === undefined) throw new Error('actor sess-1:worker-1 missing');
  assert.equal(worker.active, true);
  assert.equal(worker.status, 'active');
  assert.equal(worker.last_tool, 'grep');
  assert.equal(worker.event_count, 2);
  assert.equal(state.last_ingest_seq, 3);
});

test('session_end deactivates every actor of that session', () => {
  const state = reduceAll(
    createInitialState('live'),
    seq([
      makeEvent({ event_type: 'agent_start', agent_id: 'main', ts: '2026-01-01T00:00:00.000Z' }),
      makeEvent({ event_type: 'agent_start', agent_id: 'worker-1', ts: '2026-01-01T00:00:01.000Z' }),
      makeEvent({ event_type: 'session_end', ts: '2026-01-01T00:00:02.000Z' }),
    ]),
  );

  assert.equal(state.actors['sess-1:main']?.active, false);
  assert.equal(state.actors['sess-1:worker-1']?.active, false);
  assert.equal(state.actors['sess-1:worker-1']?.status, 'ended');
  assert.equal(state.sessions['sess-1']?.ended_at, '2026-01-01T00:00:02.000Z');
});

test('out-of-order timestamps are counted and do not overwrite newer status', () => {
  const state = reduceAll(
    createInitialState('live'),
    seq([
      makeEvent({ event_type: 'agent_status', agent_id: 'worker-1', ts: '2026-01-01T00:00:05.000Z', status: 'newer' }),
      makeEvent({ event_type: 'agent_status', agent_id: 'worker-1', ts: '2026-01-01T00:00:01.000Z', status: 'older' }),
    ]),
  );

  const worker = state.actors['sess-1:worker-1'];
  if (worker === undefined) throw new Error('actor sess-1:worker-1 missing');
  assert.equal(worker.status, 'newer');
  assert.equal(worker.last_event_ts, '2026-01-01T00:00:05.000Z');
  // The late event is still accounted for.
  assert.equal(worker.event_count, 2);
  assert.equal(worker.last_ingest_seq, 2);
  assert.equal(state.counters.out_of_order, 1);
});

test('well-formed but unknown event types are recorded and ignored', () => {
  const state = reduce(createInitialState('live'), makeIngested(makeEvent({ event_type: 'quantum_leap' }), 1));
  assert.equal(state.counters.ignored, 1);
  assert.equal(state.counters.by_type['quantum_leap'], 1);
  assert.equal(state.actors['sess-1:main']?.status, null);
});

test('folding a foreign-namespace event throws instead of mixing states', () => {
  const live = createInitialState('live');
  assert.throws(
    () => reduce(live, makeIngested(makeEvent(), 1, 'demo')),
    /namespace mismatch/,
  );
});

test('the same accepted stream always folds to the same state', () => {
  const events = seq([
    makeEvent({ event_type: 'session_start', ts: '2026-01-01T00:00:00.000Z' }),
    makeEvent({ event_type: 'agent_start', agent_id: 'worker-1', ts: '2026-01-01T00:00:01.000Z' }),
    makeEvent({ event_type: 'agent_stop', agent_id: 'worker-1', ts: '2026-01-01T00:00:02.000Z' }),
  ]);
  const a = reduceAll(createInitialState('live'), events);
  const b = reduceAll(createInitialState('live'), events);
  assert.deepEqual(a, b);
});
