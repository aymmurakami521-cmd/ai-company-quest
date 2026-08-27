/**
 * Where the org snapshot lives, and what it is not allowed to disturb.
 *
 * The org slot is held on the same terms as the human player: it comes from
 * configuration, `reduce` carries it by reference, and no event can create,
 * change or remove it. The three things these tests hold in place are:
 *
 * 1. **A refused org disables the org slot and nothing else.** Ingestion, the
 *    reducer, the replay buffer and the SSE subscribers keep running exactly as
 *    they did, and the store does not halt. An organisation Quest cannot read
 *    says nothing about the health of the stream.
 * 2. **LIVE and DEMO keep separate orgs.** DEMO performs no external I/O, so it
 *    never sees the LIVE configured path nor anything read from it.
 * 3. **Adoption / absence / refusal is readable from a closed vocabulary**, and
 *    a refusal carries nothing but a rule name and a structural field path.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { NamespaceStore } from '../src/collector/store.ts';
import { seedDemoStore } from '../src/demo/fixtures.ts';
import { loadConfig } from '../src/config.ts';
import { createInitialState, reduce } from '../src/domain/reducer.ts';
import type { OrgSnapshot, OrgState } from '../src/domain/orgSnapshot.ts';
import { ORG_ABSENT, ORG_STATUSES, orgAccepted, orgRejected, validateOrgSnapshot } from '../src/domain/orgSnapshot.ts';
import { QuestServer } from '../src/server/server.ts';
import { makeEvent, makeIngested, makeLine } from './helpers.ts';

function snapshotFixture(): OrgSnapshot {
  const result = validateOrgSnapshot({
    departments: [{ id: 'dept-alpha', displayName: '第一部', display_order: 10 }],
    roles: [
      {
        id: 'role-lead',
        displayName: 'リード',
        kind: 'department',
        department_id: 'dept-alpha',
        runtime_agent_type: 'lead-agent',
      },
    ],
    facilities: [{ id: 'zone-workshop', displayName: '工房', type: 'shared' }],
  });
  if (!result.ok) throw new Error('fixture must be valid');
  return result.snapshot;
}

const REJECTED: OrgState = orgRejected({ rule: 'unknown_reference', field: 'roles[].department_id' });

// ---------------------------------------------------------- the state slot ---

test('a state with no configured org has one, and it is the absent one', () => {
  const state = createInitialState('live');
  assert.equal(state.org.status, 'absent');
  assert.equal(state.org.snapshot, null);
  assert.equal(state.org.reject, null);
  assert.ok((ORG_STATUSES as readonly string[]).includes(state.org.status));
  // The org slot does not collide with anything the event state already owns.
  assert.deepEqual(Object.keys(state).sort(), [
    'actors',
    'counters',
    'last_ingest_seq',
    'limits',
    'namespace',
    'org',
    'player',
    'sessions',
  ]);
});

test('no event can create, change or remove the org slot', () => {
  const accepted = orgAccepted(snapshotFixture());
  const state = createInitialState('live', undefined, undefined, accepted);

  let next = state;
  for (const [index, type] of ['session_start', 'agent_start', 'tool_use', 'agent_stop', 'session_end'].entries()) {
    next = reduce(next, makeIngested(makeEvent({ event_type: type, tool_name: 'Read' }), index + 1));
    // Carried by reference, exactly like `player`: there is no code path that
    // could fold stream content into it.
    assert.equal(Object.is(next.org, accepted), true, `${type} must not touch the org slot`);
  }
  assert.deepEqual(next.org.snapshot, accepted.snapshot);

  // An event that names an organisation cannot conjure one either.
  const fromAbsent = reduce(
    createInitialState('live'),
    makeIngested(makeEvent({ runtime_agent_type: 'lead-agent', agent_role: 'lead' }), 1),
  );
  assert.equal(fromAbsent.org.status, 'absent');
  assert.equal(fromAbsent.org.snapshot, null);
});

test('a store serves the org it was given, and the default is no org at all', () => {
  const withOrg = new NamespaceStore({ namespace: 'live', org: orgAccepted(snapshotFixture()) });
  assert.equal(withOrg.state.org.status, 'accepted');
  assert.equal(withOrg.state.org.snapshot?.departments.length, 1);

  const without = new NamespaceStore({ namespace: 'live' });
  assert.deepEqual(without.state.org, ORG_ABSENT);
});

// ------------------------------------------------- refusal is org-local only ---

test('a refused org disables the org slot and leaves ingestion running', () => {
  const store = new NamespaceStore({ namespace: 'live', org: REJECTED });
  const streamed: string[] = [];
  store.subscribe((wire) => streamed.push(wire.event_id));
  const halts: unknown[] = [];
  store.subscribeHalt((notice) => halts.push(notice));

  for (const agent of ['main', 'worker-1', 'worker-2']) {
    assert.equal(store.ingestLine(makeLine({ agent_id: agent, event_type: 'agent_start' })).status, 'accepted');
  }

  assert.equal(store.halted, false, 'an unreadable organisation is not a stream failure');
  assert.equal(store.stats.halt_reason, null);
  assert.equal(store.stats.accepted, 3);
  assert.equal(store.stats.rejected, 0);
  assert.equal(Object.keys(store.state.actors).length, 3, 'the reducer kept folding');
  assert.equal(store.state.counters.applied, 3);
  assert.equal(store.replay.size, 3, 'the replay buffer kept filling');
  assert.equal(streamed.length, 3, 'subscribers kept receiving');
  assert.deepEqual(halts, [], 'no halt was announced');

  // …and the refusal is still readable, unchanged, after all of that.
  assert.equal(store.state.org.status, 'rejected');
  assert.deepEqual(store.state.org.reject, { rule: 'unknown_reference', field: 'roles[].department_id' });
});

test('health reports the same status whether or not an org was refused', () => {
  const withRefusal = new QuestServer({
    stores: { live: new NamespaceStore({ namespace: 'live', org: REJECTED }), demo: new NamespaceStore({ namespace: 'demo' }) },
    now: () => 0,
  });
  const without = new QuestServer({
    stores: { live: new NamespaceStore({ namespace: 'live' }), demo: new NamespaceStore({ namespace: 'demo' }) },
    now: () => 0,
  });

  assert.equal(withRefusal.health().status, 'ok', 'org is not a fail-closed condition for the stream');
  assert.deepEqual(withRefusal.health(), without.health(), 'health output is byte-identical');
});

test('the served snapshot frame gains the org slot and changes nothing else', () => {
  const live = new NamespaceStore({ namespace: 'live', org: orgAccepted(snapshotFixture()) });
  const plain = new NamespaceStore({ namespace: 'live' });
  live.ingestLine(makeLine({ event_id: '11111111-1111-4111-8111-111111111111' }));
  plain.ingestLine(makeLine({ event_id: '11111111-1111-4111-8111-111111111111' }));

  const server = new QuestServer({ stores: { live, demo: new NamespaceStore({ namespace: 'demo' }) }, now: () => 0 });
  const frame = server.snapshot('live') as Record<string, unknown>;

  // No new frame key: the org slot rides inside `state`, which has always been
  // "the whole QuestState", and no other key of the frame moves.
  assert.deepEqual(Object.keys(frame).sort(), ['halt_reason', 'halted', 'last_ingest_seq', 'namespace', 'replay', 'state']);
  const served = frame['state'] as Record<string, unknown>;
  assert.equal((served['org'] as OrgState).status, 'accepted');

  const { org: _served, ...restWithOrg } = served;
  const { org: _plain, ...restWithout } = plain.state as unknown as Record<string, unknown>;
  assert.deepEqual(restWithOrg, restWithout, 'every other part of the state is untouched');
});

// ---------------------------------------------------------- LIVE vs DEMO ---

test('LIVE and DEMO never share an org, and DEMO has none', () => {
  const live = new NamespaceStore({ namespace: 'live', org: orgAccepted(snapshotFixture()) });
  const demo = new NamespaceStore({ namespace: 'demo' });

  seedDemoStore(demo);

  assert.equal(demo.state.org.status, 'absent');
  assert.equal(demo.state.org.snapshot, null);
  assert.equal(live.state.org.status, 'accepted');
  assert.equal(Object.is(live.state.org, demo.state.org), false, 'the two namespaces hold separate instances');
  assert.equal(live.stats.lines_seen, 0, 'seeding DEMO touched nothing on the LIVE side');
});

test('the DEMO path reads no file and knows no configured path', () => {
  // DEMO's invariant is "no external I/O" (README). The fixtures module is the
  // whole DEMO input, so it must not reach the filesystem or the environment.
  const fixtures = readFileSync(new URL('../src/demo/fixtures.ts', import.meta.url), 'utf8');
  for (const forbidden of ['node:fs', 'orgLoader', 'loadOrgSnapshotFile', 'QUEST_ORG_SNAPSHOT_PATH', 'process.env']) {
    assert.ok(!fixtures.includes(forbidden), `DEMO fixtures must not reference ${forbidden}`);
  }
});

// ------------------------------------------------------------- the config ---

test('the org snapshot path is configuration only, and unset is normal', () => {
  assert.equal(loadConfig({}).orgSnapshotPath, null);
  assert.equal(loadConfig({ QUEST_ORG_SNAPSHOT_PATH: '   ' }).orgSnapshotPath, null);
  assert.equal(loadConfig({ QUEST_ORG_SNAPSHOT_PATH: ' org.snapshot.json ' }).orgSnapshotPath, 'org.snapshot.json');
  // It is its own variable: the input path never doubles as an org path.
  assert.equal(loadConfig({ QUEST_INPUT_PATH: 'events.jsonl' }).orgSnapshotPath, null);
  assert.equal(loadConfig({ QUEST_ORG_SNAPSHOT_PATH: 'org.snapshot.json' }).inputPath, null);
});

test('no cross-repository location is baked into the source', () => {
  for (const file of ['../src/config.ts', '../src/live.ts', '../src/collector/orgLoader.ts', '../src/domain/orgSnapshot.ts']) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.ok(!/['"][^'"\n]*company\/org\.snapshot\.json['"]/.test(source), `${file} must not hard-code a snapshot path`);
    assert.ok(!/['"]\/(Users|home|root)\//.test(source), `${file} must not hard-code an absolute path`);
  }
});
