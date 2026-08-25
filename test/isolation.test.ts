import test from 'node:test';
import assert from 'node:assert/strict';

import { NamespaceStore } from '../src/collector/store.ts';
import { Collector } from '../src/collector/collector.ts';
import { seedDemoStore } from '../src/demo/fixtures.ts';
import { reduce } from '../src/domain/reducer.ts';
import { makeEvent, makeIngested, makeLine } from './helpers.ts';

function pair(): { live: NamespaceStore; demo: NamespaceStore } {
  return {
    live: new NamespaceStore({ namespace: 'live' }),
    demo: new NamespaceStore({ namespace: 'demo' }),
  };
}

test('DEMO ingestion leaves the LIVE store completely untouched', () => {
  const { live, demo } = pair();
  const liveSeen: string[] = [];
  live.subscribe((wire) => {
    liveSeen.push(wire.event_id);
  });

  const seeded = seedDemoStore(demo);

  assert.ok(seeded > 0);
  assert.equal(liveSeen.length, 0);
  assert.equal(live.stats.accepted, 0);
  assert.equal(live.stats.lines_seen, 0);
  assert.equal(live.replay.size, 0);
  // Keyed by stream content, so these maps are prototype-less: compare contents.
  assert.deepEqual(Object.keys(live.state.sessions), []);
  assert.deepEqual(Object.keys(live.state.actors), []);
  assert.equal(live.state.last_ingest_seq, 0);
});

test('the two namespaces keep independent ingest_seq counters', () => {
  const { live, demo } = pair();
  const liveFirst = live.ingestLine(makeLine());
  const demoFirst = demo.ingestLine(makeLine());

  assert.equal(liveFirst.status === 'accepted' && liveFirst.wire.ingest_seq, 1);
  assert.equal(demoFirst.status === 'accepted' && demoFirst.wire.ingest_seq, 1);
  assert.equal(liveFirst.status === 'accepted' && liveFirst.wire.namespace, 'live');
  assert.equal(demoFirst.status === 'accepted' && demoFirst.wire.namespace, 'demo');
});

test('the same event_id in both namespaces is not cross-de-duplicated', () => {
  const { live, demo } = pair();
  const line = makeLine();
  assert.equal(live.ingestLine(line).status, 'accepted');
  assert.equal(demo.ingestLine(line).status, 'accepted');
  assert.equal(live.stats.duplicates, 0);
  assert.equal(demo.stats.duplicates, 0);
});

test('a LIVE Last-Event-ID is unknown to the DEMO stream and vice versa', () => {
  const { live, demo } = pair();
  const accepted = live.ingestLine(makeLine());
  const liveId = accepted.status === 'accepted' ? accepted.wire.event_id : '';
  assert.equal(demo.replayFrom(liveId).status, 'unknown');
});

test('demo fixtures refuse to be seeded into a LIVE store', () => {
  const { live } = pair();
  assert.throws(() => seedDemoStore(live), /refusing to seed demo fixtures/);
  assert.equal(live.stats.lines_seen, 0);
});

test('a collector is bound to exactly one namespace', () => {
  const { demo } = pair();
  const collector = new Collector({ store: demo, input: { path: '/dev/null' } });
  assert.equal(collector.namespace, 'demo');
});

test('the reducer refuses to fold an event from another namespace', () => {
  const { live, demo } = pair();
  assert.throws(() => reduce(live.state, makeIngested(makeEvent(), 1, 'demo')), /namespace mismatch/);
  assert.throws(() => reduce(demo.state, makeIngested(makeEvent(), 1, 'live')), /namespace mismatch/);
});

test('the player is identical and untouched in both namespaces', () => {
  const { live, demo } = pair();
  const livePlayer = live.state.player;
  const demoPlayer = demo.state.player;

  live.ingestLine(makeLine({ event_type: 'agent_start' }));
  seedDemoStore(demo);

  assert.equal(Object.is(live.state.player, livePlayer), true);
  assert.equal(Object.is(demo.state.player, demoPlayer), true);
  assert.deepEqual(live.state.player, demoPlayer);
});
