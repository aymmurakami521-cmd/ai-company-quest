/**
 * The actor detail view.
 *
 * The interesting cases here are the ones about *wording*. This screen is the
 * only place a person is told what a colleague is doing, so the difference
 * between "this is the task it was given" and "this is what the last event was
 * called" has to survive in code, not just in a comment.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { NamespaceStore } from '../src/collector/store.ts';
import { DemoPlayer } from '../src/demo/timeline.ts';
import { seedDemoStore } from '../src/demo/fixtures.ts';
import type { QuestState } from '../src/domain/reducer.ts';
import {
  DETAIL_LOG_ENTRIES,
  HUMAN_ACTION,
  NOT_REPORTED,
  NO_EVIDENCE_IN_CONTRACT,
  applyFrame,
  applySnapshot,
  createClientState,
  selectDetail,
  setConnectionPhase,
  setSelectedActor,
} from '../src/ui/public/quest-view.js';
import type { ClientState } from '../src/ui/public/quest-view.js';
import { WIRE_EVENT_KEYS } from '../src/domain/wire.ts';

function snapshotOf(store: NamespaceStore): { namespace: string; state: QuestState } {
  return { namespace: store.namespace, state: store.state };
}

/**
 * A DEMO office fed one wire event at a time, the way the browser gets it - so
 * the client log the detail view reads from is actually populated.
 */
function playedOffice(): { store: NamespaceStore; client: () => ClientState } {
  const store = new NamespaceStore({ namespace: 'demo' });
  const frames: unknown[] = [];
  const unsubscribe = store.subscribe((wire) => frames.push(wire));
  let tick = 0;
  const player = new DemoPlayer({
    store,
    intervalMs: 0,
    firstDelayMs: 0,
    now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)),
  });
  while (player.step());
  unsubscribe();

  return {
    store,
    client: () => {
      let state = setConnectionPhase(createClientState('demo'), 'open', null);
      for (const payload of frames) state = applyFrame(state, { kind: 'event', payload });
      return state;
    },
  };
}

function select(state: ClientState, displayName: string): ClientState {
  const key = Object.keys(state.actors).find(
    (candidate) => state.actors[candidate]?.agent_id === displayName,
  );
  assert.ok(key !== undefined, `${displayName} is seated`);
  return setSelectedActor(state, key);
}

// ------------------------------------------------------------- selection ---

test('nothing is selected until somebody selects something', () => {
  const store = new NamespaceStore({ namespace: 'demo' });
  seedDemoStore(store);
  const state = applySnapshot(createClientState('demo'), snapshotOf(store));
  assert.equal(selectDetail(state), null, 'no selection, no detail');

  const selected = select(state, 'worker-1');
  assert.notEqual(selectDetail(selected), null, 'and one appears when a desk is chosen');
});

test('a selection that no longer matches anybody shows nothing, and does not throw', () => {
  const store = new NamespaceStore({ namespace: 'demo' });
  seedDemoStore(store);
  const state = applySnapshot(createClientState('demo'), snapshotOf(store));
  const ghost = { ...state, selected_actor_key: 'nobody:%00' } as ClientState;
  assert.equal(selectDetail(ghost), null);
});

// --------------------------------------------------- task versus summary ---

test('an event summary is never presented as the task the colleague was given', () => {
  // The whole point of this test. `summary` is a label for one event; the event
  // contract carries no business task at all. Printing one as the other would
  // tell somebody their colleague is assigned to a job nobody assigned.
  const { client } = playedOffice();
  const detail = selectDetail(select(client(), 'dev-1'));
  assert.ok(detail !== null);

  assert.equal(detail.task, null, 'the contract carries no business task reference');
  assert.ok(
    typeof detail.latest_summary === 'string' && detail.latest_summary.length > 0,
    'but the latest event summary is there to show',
  );
  assert.notEqual(detail.task, detail.latest_summary, 'and the two are never the same field');
});

test('a task the contract cannot supply is reported as unreported, not left blank', () => {
  const { client } = playedOffice();
  const detail = selectDetail(select(client(), 'dev-1'));
  assert.equal(detail?.task ?? NOT_REPORTED, NOT_REPORTED);
  assert.equal(NOT_REPORTED, '未報告');
});

test('the screen never predicts what happens next', () => {
  const { client } = playedOffice();
  const detail = selectDetail(select(client(), 'dev-1'));
  assert.equal(detail?.next_action, null, 'no next action is derived from anything');
});

// ------------------------------------------------------- human attention ---

test('only an approval wait is reported as a request for human action', () => {
  const { client } = playedOffice();
  const state = client();

  // dev-1 finished; sync-1 failed; ext-1 reported something unreadable.
  assert.equal(selectDetail(select(state, 'dev-1'))?.human_action, HUMAN_ACTION.none);
  assert.equal(
    selectDetail(select(state, 'sync-1'))?.human_action,
    HUMAN_ACTION.advised,
    'a failure is worth a look, but it is not a request the session made',
  );
  assert.equal(
    selectDetail(select(state, 'ext-1'))?.human_action,
    HUMAN_ACTION.advised,
    'nor is a status nobody can read',
  );
  assert.notEqual(HUMAN_ACTION.advised, HUMAN_ACTION.required, 'the two are worded differently');
});

test('an approval wait says so while it is waiting', () => {
  const store = new NamespaceStore({ namespace: 'demo' });
  seedDemoStore(store);
  const state = applySnapshot(createClientState('demo'), snapshotOf(store));
  const detail = selectDetail(select(state, 'worker-2'));
  assert.equal(detail?.visual.code, 'APPROVAL');
  assert.equal(detail?.human_action, HUMAN_ACTION.required);
});

// -------------------------------------------------------------- evidence ---

test('the absence of evidence is stated, never implied by an empty row', () => {
  const { client } = playedOffice();
  const detail = selectDetail(select(client(), 'dev-1'));
  assert.equal(detail?.evidence, null, 'there is no artifact reference on the wire');
  assert.equal(detail?.evidence ?? NO_EVIDENCE_IN_CONTRACT, NO_EVIDENCE_IN_CONTRACT);
  assert.ok(
    NO_EVIDENCE_IN_CONTRACT.includes('event契約'),
    'and the wording blames the contract, not the colleague',
  );

  // Nothing on the wire could have supplied one, which is why this is honest.
  for (const key of WIRE_EVENT_KEYS) {
    assert.equal(/artifact|evidence|commit|pull_request|url/.test(key), false, `${key} is not evidence`);
  }
});

test('recovery is never claimed to be possible', () => {
  const { client } = playedOffice();
  const detail = selectDetail(select(client(), 'sync-1'));
  assert.equal(detail?.visual.state, 'error');
  assert.equal(detail?.recovery, null, 'retry, handoff and checkpoints are not in the contract');
});

// ----------------------------------------------------------- error detail ---

test('a failed colleague still shows what it was doing before it failed', () => {
  const { client } = playedOffice();
  const detail = selectDetail(select(client(), 'sync-1'));
  assert.ok(detail !== null);
  assert.equal(detail.visual.state, 'error');
  assert.ok(detail.last_non_error !== null, 'the last healthy step is recoverable from the log');
  assert.notEqual(detail.last_non_error?.state, 'error');
  assert.equal(detail.last_non_error?.actor_key, detail.actor_key, 'and it belongs to this desk');
});

test('the recent list is this colleague only, newest first and bounded', () => {
  const { client } = playedOffice();
  const detail = selectDetail(select(client(), 'dev-1'));
  assert.ok(detail !== null);
  assert.ok(detail.recent.length > 0);
  assert.ok(detail.recent.length <= DETAIL_LOG_ENTRIES);
  for (const entry of detail.recent) {
    assert.equal(entry.actor_key, detail.actor_key, 'no other desk leaks into this list');
  }
  const seqs = detail.recent.map((entry) => entry.ingest_seq);
  assert.deepEqual([...seqs].sort((a, b) => b - a), seqs, 'newest first');
});

// ------------------------------------------------------------- identity ----

test('the internal identifier is shown beside the display name, not instead of it', () => {
  const { client } = playedOffice();
  const detail = selectDetail(select(client(), 'dev-1'));
  assert.equal(detail?.display_name, 'dev-1');
  assert.ok(typeof detail?.actor_key === 'string' && detail.actor_key.length > 0);
  assert.notEqual(detail?.actor_key, detail?.display_name, 'they are different things');
  assert.ok(detail?.actor_key.includes('demo-mission-01'), 'the key is session-scoped');
});

test('a role is shown only when the collector resolved one', () => {
  const { client } = playedOffice();
  const detail = selectDetail(select(client(), 'dev-1'));
  // Nothing in this repository invents a job title, so an unresolved role is
  // null here and rendered as 未解決 - never guessed from the runtime type.
  assert.equal(detail?.role, null);
  assert.equal(detail?.runtime_agent_type, 'implementer', 'the runtime type is reported as itself');
});

// ---------------------------------------------------------------- stale ----

test('a frozen desk says so in its detail too, keeping the last observation', () => {
  const { client } = playedOffice();
  const live = select(client(), 'dev-1');
  const before = selectDetail(live);
  assert.equal(before?.stale, false);
  assert.equal(before?.visual.state, 'ended');

  const dropped = setConnectionPhase(live, 'error', null);
  const detail = selectDetail(dropped);
  assert.equal(detail?.stale, true);
  assert.equal(detail?.visual.state, 'unknown', 'it no longer claims a current state');
  assert.equal(detail?.last_known_visual.state, 'ended', 'but what it was is still there');
  assert.equal(detail?.human_action, HUMAN_ACTION.advised, 'and an unreadable desk is worth a look');
});

// ------------------------------------------------------------- session -----

test('the detail reports whether the session behind the desk has finished', () => {
  const store = new NamespaceStore({ namespace: 'demo' });
  seedDemoStore(store);
  const state = applySnapshot(createClientState('demo'), snapshotOf(store));

  const running = selectDetail(select(state, 'worker-1'));
  assert.equal(running?.session_ended_at, null, 'this session is still open');

  // demo-session-02 is the one the fixtures close.
  const closedKey = Object.keys(state.actors).find(
    (key) => state.actors[key]?.session_id === 'demo-session-02',
  );
  assert.ok(closedKey !== undefined);
  const finished = selectDetail(setSelectedActor(state, closedKey));
  assert.ok(finished?.session_ended_at !== null, 'and this one is closed');
  assert.equal(finished?.visual.state, 'ended');
});
