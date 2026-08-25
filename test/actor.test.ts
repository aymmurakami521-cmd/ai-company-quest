import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveActor, resolveActorFromEvent } from '../src/domain/actor.ts';
import { makeEvent } from './helpers.ts';

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

test('a missing agent_id yields an explicit unknown actor key', () => {
  const actor = resolveActor('sess-1', null, null);
  assert.equal(actor.actor_key, 'sess-1:unknown');
  assert.equal(actor.agent_id, null);
  assert.equal(actor.is_main_orchestrator, false);
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
