import test from 'node:test';
import assert from 'node:assert/strict';

import { actorKeyOf, resolveActor, resolveActorFromEvent } from '../src/domain/actor.ts';
import { createInitialState, reduce } from '../src/domain/reducer.ts';
import { makeEvent, makeIngested } from './helpers.ts';

test('an unknown agent resolves to a null role, never a guess', () => {
  const actor = resolveActor('sess-1', 'worker-7', null);
  assert.equal(actor.actor_key, 'sess-1:worker-7');
  assert.equal(actor.role, null);
  assert.equal(actor.resolved, false);
  assert.equal(actor.role_source, 'none');
});

test('{session_id}:main is the main orchestrator and nothing more', () => {
  const actor = resolveActor('sess-1', 'main', null);
  assert.equal(actor.is_main_orchestrator, true);
  // Structural marker only: no CEO, no job title, no seniority.
  assert.equal(actor.role, null);
  assert.equal(actor.resolved, false);
});

test('a missing agent_id yields an explicit marker, distinct from a real agent', () => {
  const actor = resolveActor('sess-1', null, null);
  assert.equal(actor.actor_key, 'sess-1:%00');
  assert.equal(actor.agent_id, null);
  assert.equal(actor.is_main_orchestrator, false);

  // A producer may legitimately name an agent "unknown"; it must not be merged
  // with the null case.
  assert.notEqual(actorKeyOf('sess-1', 'unknown'), actorKeyOf('sess-1', null));
});

test('actor keys are collision-free when a component contains the separator', () => {
  // Both identifier patterns accept ':', so plain concatenation is ambiguous.
  const tuples: Array<[string, string | null]> = [
    ['a:b', 'c'],
    ['a', 'b:c'],
    ['a:b:c', null],
    ['a', 'b%3Ac'],
    ['a%', 'b'],
    ['a', '%b'],
    ['sess-1', 'unknown'],
    ['sess-1', null],
  ];
  const keys = tuples.map(([sessionId, agentId]) => actorKeyOf(sessionId, agentId));
  assert.equal(new Set(keys).size, tuples.length, 'every distinct tuple needs a distinct key');

  // The ordinary case stays readable and unchanged.
  assert.equal(actorKeyOf('sess-1', 'worker-7'), 'sess-1:worker-7');
});

test('colliding-looking actors stay separate in the reduced state', () => {
  const first = makeEvent({ session_id: 'a:b', agent_id: 'c', event_type: 'agent_start' });
  const second = makeEvent({ session_id: 'a', agent_id: 'b:c', event_type: 'agent_start' });

  let state = createInitialState('live');
  state = reduce(state, makeIngested(first, 1));
  state = reduce(state, makeIngested(second, 2));

  assert.equal(Object.keys(state.actors).length, 2, 'two different actors, two state entries');
  assert.equal(Object.keys(state.sessions).length, 2);
  for (const actor of Object.values(state.actors)) {
    assert.equal(actor.event_count, 1, 'event counts must not be merged across actors');
  }
});

test('roles come from the allowed directory, session scope first', () => {
  const directory = { roles: { 'worker-1': 'global-role', 'sess-1:worker-1': 'session-role' } };
  const scoped = resolveActor('sess-1', 'worker-1', null, directory);
  assert.equal(scoped.role, 'session-role');
  assert.equal(scoped.role_source, 'directory');
  assert.equal(scoped.resolved, true);

  const unscoped = resolveActor('sess-2', 'worker-1', null, directory);
  assert.equal(unscoped.role, 'global-role');
});

test('the sanitized event role is used only when the directory has nothing', () => {
  const directory = { roles: { 'worker-1': 'directory-role' } };
  assert.equal(resolveActor('sess-1', 'worker-1', 'event-role', directory).role, 'directory-role');
  assert.equal(resolveActor('sess-1', 'worker-2', 'event-role', directory).role, 'event-role');
  assert.equal(resolveActor('sess-1', 'worker-2', 'event-role', directory).role_source, 'event');
});

test('resolveActorFromEvent keeps the same boundary', () => {
  const actor = resolveActorFromEvent(makeEvent({ agent_id: 'main', agent_role: null }));
  assert.equal(actor.actor_key, 'sess-1:main');
  assert.equal(actor.role, null);
  assert.equal(actor.is_main_orchestrator, true);
});
