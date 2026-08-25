import test from 'node:test';
import assert from 'node:assert/strict';

import { NamespaceStore } from '../src/collector/store.ts';
import { makeEvent, makeLine } from './helpers.ts';

function liveStore(): NamespaceStore {
  return new NamespaceStore({ namespace: 'live', failClosedOnUnsupportedSchema: true });
}

test('ingest_seq is collector assigned, starting at 1 and strictly increasing', () => {
  const store = liveStore();
  const seqs: number[] = [];
  for (let index = 0; index < 5; index += 1) {
    const outcome = store.ingestLine(makeLine({ producer_seq: 999 - index }));
    assert.equal(outcome.status, 'accepted');
    if (outcome.status === 'accepted') seqs.push(outcome.wire.ingest_seq);
  }
  assert.deepEqual(seqs, [1, 2, 3, 4, 5]);
  assert.equal(store.stats.last_ingest_seq, 5);
});

test('producer_seq is recorded but never drives ordering', () => {
  const store = liveStore();
  const first = store.ingestLine(makeLine({ producer_seq: 100 }));
  const second = store.ingestLine(makeLine({ producer_seq: 1 }));
  assert.equal(first.status === 'accepted' && first.wire.ingest_seq, 1);
  assert.equal(second.status === 'accepted' && second.wire.ingest_seq, 2);
});

test('duplicate event_id is ignored and consumes no sequence number', () => {
  const store = liveStore();
  const line = makeLine();

  const first = store.ingestLine(line);
  const duplicate = store.ingestLine(line);
  const third = store.ingestLine(makeLine());

  assert.equal(first.status, 'accepted');
  assert.equal(duplicate.status, 'duplicate');
  assert.equal(third.status === 'accepted' && third.wire.ingest_seq, 2);
  assert.equal(store.stats.accepted, 2);
  assert.equal(store.stats.duplicates, 1);
  assert.equal(store.state.counters.applied, 2);
});

test('rejected lines consume no sequence number and are counted by reason', () => {
  const store = liveStore();
  store.ingestLine('{ broken');
  store.ingestLine(JSON.stringify({ ...makeEvent(), event_id: 'nope' }));
  store.ingestLine(makeLine({ summary: 'wrote /etc/passwd' }));
  store.ingestLine('');
  const accepted = store.ingestLine(makeLine());

  assert.equal(accepted.status === 'accepted' && accepted.wire.ingest_seq, 1);
  assert.equal(store.stats.rejected, 3);
  assert.equal(store.stats.blank, 1);
  assert.equal(store.stats.rejected_by_reason['not_json'], 1);
  assert.equal(store.stats.rejected_by_reason['invalid_format'], 1);
  assert.equal(store.stats.rejected_by_reason['unsafe_content'], 1);
});

test('LIVE halts fail-closed on an unsupported schema version', () => {
  const store = liveStore();
  store.ingestLine(makeLine());
  const halt = store.ingestLine(makeLine({ schema_version: 3 }));

  assert.equal(halt.status, 'halt');
  assert.equal(store.halted, true);
  assert.equal(store.stats.halt_reason, 'unsupported_schema:schema_version:3');

  // Everything after the halt is refused, including valid lines.
  const after = store.ingestLine(makeLine());
  assert.equal(after.status, 'rejected');
  assert.equal(after.status === 'rejected' && after.reason, 'halted');
  assert.equal(store.stats.accepted, 1);
  assert.equal(store.state.counters.applied, 1);
});

test('DEMO rejects an unsupported schema without halting', () => {
  const store = new NamespaceStore({ namespace: 'demo', failClosedOnUnsupportedSchema: false });
  const rejected = store.ingestLine(makeLine({ schema_version: 3 }));
  assert.equal(rejected.status, 'rejected');
  assert.equal(store.halted, false);
  assert.equal(store.ingestLine(makeLine()).status, 'accepted');
});

test('a sanitizer_version bump alone never halts or rejects', () => {
  const store = liveStore();
  assert.equal(store.ingestLine(makeLine({ sanitizer_version: 3 })).status, 'accepted');
  assert.equal(store.ingestLine(makeLine({ sanitizer_version: 4 })).status, 'accepted');
  assert.equal(store.ingestLine(makeLine({ sanitizer_version: 12 })).status, 'accepted');
  assert.equal(store.halted, false);
  assert.equal(store.stats.rejected, 0);
});

test('unknown producer keys are dropped and counted, not streamed', () => {
  const store = liveStore();
  const outcome = store.ingestLine(
    JSON.stringify({ ...makeEvent(), raw_prompt: 'do the thing', cwd: '/home/someone/repo' }),
  );
  assert.equal(outcome.status, 'accepted');
  assert.equal(store.stats.dropped_producer_keys, 2);
  if (outcome.status === 'accepted') {
    assert.equal(Object.prototype.hasOwnProperty.call(outcome.wire, 'raw_prompt'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(outcome.wire, 'cwd'), false);
    assert.equal(JSON.stringify(outcome.wire).includes('/home/someone'), false);
  }
});

test('subscribers only see accepted events', () => {
  const store = liveStore();
  const seen: string[] = [];
  const unsubscribe = store.subscribe((wire) => {
    seen.push(wire.event_id);
  });

  const accepted = store.ingestLine(makeLine());
  store.ingestLine('{ broken');
  const line = makeLine();
  store.ingestLine(line);
  store.ingestLine(line);

  unsubscribe();
  store.ingestLine(makeLine());

  assert.equal(seen.length, 2);
  assert.equal(seen[0], accepted.status === 'accepted' ? accepted.wire.event_id : '');
});

test('the replay buffer is bounded and reports eviction as a gap', () => {
  const store = new NamespaceStore({ namespace: 'live', replayCapacity: 2 });
  const first = store.ingestLine(makeLine());
  store.ingestLine(makeLine());
  store.ingestLine(makeLine());

  const firstId = first.status === 'accepted' ? first.wire.event_id : '';
  const lookup = store.replayFrom(firstId);
  assert.equal(lookup.status, 'gap');
  assert.equal(store.replay.size, 2);

  const unknown = store.replayFrom('00000000-0000-4000-8000-000000000000');
  assert.equal(unknown.status, 'unknown');
});
