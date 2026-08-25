/**
 * Retention limits.
 *
 * The reduced state is the last structure that could grow without a ceiling: a
 * valid stream that keeps introducing new sessions, actors or event types would
 * otherwise grow the heap (and every SSE snapshot) forever. These tests pin the
 * agreed behaviour: accept everything up to the ceiling, then fail closed with a
 * sanitized reason instead of evicting anything.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { NamespaceStore } from '../src/collector/store.ts';
import { QuestServer } from '../src/server/server.ts';
import {
  DEFAULT_STATE_LIMITS,
  StateLimitExceededError,
  checkStateLimits,
  createInitialState,
  reduce,
} from '../src/domain/reducer.ts';
import { makeEvent, makeIngested, makeLine } from './helpers.ts';

test('the shared reducer refuses to grow past its actor limit instead of evicting', () => {
  const state = createInitialState('live', undefined, { ...DEFAULT_STATE_LIMITS, max_actors: 2 });

  const first = reduce(state, makeIngested(makeEvent({ agent_id: 'a-1' }), 1));
  const second = reduce(first, makeIngested(makeEvent({ agent_id: 'a-2' }), 2));
  assert.equal(Object.keys(second.actors).length, 2, 'the limit itself is usable');

  const third = makeIngested(makeEvent({ agent_id: 'a-3' }), 3);
  assert.equal(checkStateLimits(second, third)?.limit, 'actors');
  assert.throws(
    () => reduce(second, third),
    (error: unknown) => {
      assert.ok(error instanceof StateLimitExceededError);
      assert.equal(error.limit, 'actors');
      assert.equal(error.detail, 'actors:2');
      // Sanitized: the refusal names the limit, never the stream content.
      assert.ok(!error.message.includes('a-3'));
      assert.ok(!error.message.includes('sess-1'));
      return true;
    },
  );

  // The refused event changed nothing, so the previous state is still whole.
  assert.deepEqual(Object.keys(second.actors).map((key) => second.actors[key]?.agent_id).sort(), ['a-1', 'a-2']);
});

test('a store accepts up to the actor ceiling and then halts fail-closed', () => {
  const store = new NamespaceStore({ namespace: 'live', stateLimits: { max_actors: 3 } });

  for (let index = 0; index < 3; index += 1) {
    const outcome = store.ingestLine(makeLine({ agent_id: `agent-${index}` }));
    assert.equal(outcome.status, 'accepted', `actor ${index} is within the ceiling`);
  }
  assert.equal(store.halted, false, 'reaching the ceiling is not itself a failure');
  assert.equal(Object.keys(store.state.actors).length, 3);

  const overflow = store.ingestLine(makeLine({ agent_id: 'agent-3' }));
  assert.equal(overflow.status, 'halt');
  assert.equal(overflow.status === 'halt' ? overflow.reason : null, 'state_limit');
  assert.equal(store.halted, true);
  assert.equal(store.stats.halt_reason, 'state_limit:actors:3');

  // Nothing was evicted, and the refused event was not applied.
  assert.equal(Object.keys(store.state.actors).length, 3);
  assert.equal(store.stats.accepted, 3);
  assert.equal(store.state.counters.applied, 3);
  assert.equal(store.stats.last_ingest_seq, 3, 'the refused event consumed no sequence number');

  // Fail closed stays closed: later lines are rejected, not silently applied.
  const after = store.ingestLine(makeLine({ agent_id: 'agent-0' }));
  assert.equal(after.status, 'rejected');
  assert.equal(after.status === 'rejected' ? after.reason : null, 'halted');
  assert.equal(Object.keys(store.state.actors).length, 3);
});

test('at the ceiling, known actors keep updating and duplicates stay duplicates', () => {
  const store = new NamespaceStore({ namespace: 'live', stateLimits: { max_actors: 2 } });
  assert.equal(store.ingestLine(makeLine({ agent_id: 'agent-0' })).status, 'accepted');
  const second = makeLine({ agent_id: 'agent-1', event_type: 'tool_use', tool_name: 'Read' });
  assert.equal(store.ingestLine(second).status, 'accepted');

  // An existing actor adds nothing to retain, so its events keep flowing.
  const update = store.ingestLine(makeLine({ agent_id: 'agent-0', event_type: 'agent_stop' }));
  assert.equal(update.status, 'accepted');
  assert.equal(store.state.actors[Object.keys(store.state.actors)[0] ?? '']?.event_count, 2);

  // A replayed line for a known actor is a duplicate, never a limit failure.
  assert.equal(store.ingestLine(second).status, 'duplicate');
  assert.equal(store.halted, false);
  assert.equal(store.stats.duplicates, 1);
});

test('sessions, per-session actors and event-type buckets are bounded too', () => {
  const sessions = new NamespaceStore({ namespace: 'live', stateLimits: { max_sessions: 2 } });
  assert.equal(sessions.ingestLine(makeLine({ session_id: 's-1' })).status, 'accepted');
  assert.equal(sessions.ingestLine(makeLine({ session_id: 's-2' })).status, 'accepted');
  assert.equal(sessions.ingestLine(makeLine({ session_id: 's-3' })).status, 'halt');
  assert.equal(sessions.stats.halt_reason, 'state_limit:sessions:2');
  assert.equal(Object.keys(sessions.state.sessions).length, 2);

  const perSession = new NamespaceStore({ namespace: 'live', stateLimits: { max_actors_per_session: 2 } });
  assert.equal(perSession.ingestLine(makeLine({ agent_id: 'a-1' })).status, 'accepted');
  assert.equal(perSession.ingestLine(makeLine({ agent_id: 'a-2' })).status, 'accepted');
  assert.equal(perSession.ingestLine(makeLine({ agent_id: 'a-3' })).status, 'halt');
  assert.equal(perSession.stats.halt_reason, 'state_limit:actors_per_session:2');
  assert.equal(perSession.state.sessions['sess-1']?.actor_keys.length, 2, 'the key list stays bounded');

  const types = new NamespaceStore({ namespace: 'live', stateLimits: { max_event_types: 2 } });
  assert.equal(types.ingestLine(makeLine({ event_type: 'agent_start' })).status, 'accepted');
  assert.equal(types.ingestLine(makeLine({ event_type: 'heartbeat' })).status, 'accepted');
  assert.equal(types.ingestLine(makeLine({ event_type: 'custom_thing' })).status, 'halt');
  assert.equal(types.stats.halt_reason, 'state_limit:event_types:2');
  assert.equal(Object.keys(types.state.counters.by_type).length, 2);
});

test('a state limit reached in one namespace never touches the other', () => {
  const live = new NamespaceStore({ namespace: 'live', stateLimits: { max_actors: 1 } });
  const demo = new NamespaceStore({ namespace: 'demo', stateLimits: { max_actors: 1 } });

  assert.equal(demo.ingestLine(makeLine({ agent_id: 'demo-1' })).status, 'accepted');
  assert.equal(demo.ingestLine(makeLine({ agent_id: 'demo-2' })).status, 'halt');
  assert.equal(demo.halted, true);

  // LIVE has its own state, its own limits and its own halt flag.
  assert.equal(live.halted, false);
  assert.equal(live.ingestLine(makeLine({ agent_id: 'live-1' })).status, 'accepted');
  assert.equal(Object.keys(live.state.actors).length, 1);
  assert.equal(live.stats.halt_reason, null);
});

test('health publishes the limits and a sanitized halt reason', () => {
  const live = new NamespaceStore({ namespace: 'live', stateLimits: { max_actors: 1 } });
  const demo = new NamespaceStore({ namespace: 'demo' });
  const server = new QuestServer({ stores: { live, demo } });

  assert.deepEqual(server.health().namespaces.live.state_limits, { ...DEFAULT_STATE_LIMITS, max_actors: 1 });
  assert.deepEqual(server.health().namespaces.demo.state_limits, DEFAULT_STATE_LIMITS);
  assert.equal(server.health().status, 'ok');

  live.ingestLine(makeLine({ session_id: 'secret-session', agent_id: 'secret-agent' }));
  live.ingestLine(makeLine({ session_id: 'secret-session', agent_id: 'other-agent' }));

  const health = server.health();
  assert.equal(health.status, 'fail_closed');
  assert.equal(health.namespaces.live.halt_reason, 'state_limit:actors:1');
  const serialised = JSON.stringify(health);
  assert.ok(!serialised.includes('secret-agent'), 'health must not echo stream identifiers');
  assert.ok(!serialised.includes('other-agent'));
});
