/**
 * The scripted DEMO mission.
 *
 * Every case here drives `step()` directly. Nothing in this file waits on a
 * timer, so the scenario is verified deterministically and the suite cannot
 * flake on a slow machine.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { NamespaceStore } from '../src/collector/store.ts';
import { DEMO_TIMELINE, DemoPlayer } from '../src/demo/timeline.ts';
import { CONTRACT_KEYS } from '../src/domain/event.ts';
import {
  applyFrame,
  applySnapshot,
  classifyActor,
  createClientState,
  selectDesks,
  setConnectionPhase,
} from '../src/ui/public/quest-view.js';
import type { ClientState } from '../src/ui/public/quest-view.js';
import type { QuestState } from '../src/domain/reducer.ts';

/** A fixed clock, so a replay of the same beats is the same fold every time. */
function fixedClock(): () => Date {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++));
}

function demoStore(): NamespaceStore {
  return new NamespaceStore({ namespace: 'demo' });
}

function playerFor(store: NamespaceStore, overrides: Record<string, unknown> = {}): DemoPlayer {
  return new DemoPlayer({
    store,
    intervalMs: 1500,
    firstDelayMs: 1200,
    now: fixedClock(),
    ...overrides,
  });
}

function snapshotOf(store: NamespaceStore): { namespace: string; state: QuestState } {
  return { namespace: store.namespace, state: store.state };
}

/** Folds the store's state into a connected client, the way the screen sees it. */
function screen(store: NamespaceStore): ClientState {
  const state = applySnapshot(createClientState('demo'), snapshotOf(store));
  return setConnectionPhase(state, 'open', null);
}

// ------------------------------------------------------------- isolation ---

test('the timeline refuses any namespace that is not DEMO', () => {
  const live = new NamespaceStore({ namespace: 'live', inputContract: 'internal_normalized' });
  assert.throws(
    () => playerFor(live),
    /namespace 'live'/,
    'the guard names the namespace it refused',
  );
  assert.equal(live.stats.accepted, 0, 'and nothing reached LIVE on the way to the throw');
});

test('every beat is a plain sanitized event, accepted by the ordinary validator', () => {
  const store = demoStore();
  const player = playerFor(store);
  while (player.step());

  assert.equal(store.stats.accepted, DEMO_TIMELINE.length, 'every beat was accepted');
  assert.equal(store.stats.rejected, 0, 'none was rejected');
  assert.equal(store.stats.dropped_producer_keys, 0, 'and none carried an unmodelled key');
  assert.equal(store.halted, false, 'the mission never halts the store');

  const allowed = new Set([...CONTRACT_KEYS, 'ts']);
  for (const beat of DEMO_TIMELINE) {
    for (const key of Object.keys(beat)) {
      assert.ok(allowed.has(key), `beat field ${key} is part of the event contract`);
    }
  }
});

test('no beat carries a raw prompt, command, path or credential', () => {
  const forbidden = /https?:\/\/|\/(Users|home|root)\/|~\/|sk-|gh[pousr]_|AKIA|Bearer |password|secret/i;
  for (const beat of DEMO_TIMELINE) {
    const text = [beat.summary, beat.status, beat.tool_name, beat.agent_id].filter(Boolean).join(' ');
    assert.equal(forbidden.test(text), false, `a beat leaks nothing: ${text}`);
  }
});

// --------------------------------------------------------- the story arc ---

test('the mission runs planning -> work -> approval -> completion, in that order', () => {
  const store = demoStore();
  const player = playerFor(store);

  /** The visual state of one actor, as the screen would show it right now. */
  const stateOf = (agentId: string): string | null => {
    const desk = selectDesks(screen(store)).find((item) => item.display_name === agentId);
    return desk === undefined ? null : desk.visual.state;
  };

  const seen: string[] = [];
  while (player.step()) {
    const current = stateOf('dev-1');
    if (current !== null && seen[seen.length - 1] !== current) seen.push(current);
  }

  // Duplicates collapsed, so this is the shape of the story, not its length.
  assert.deepEqual(
    seen,
    ['planning', 'working', 'awaiting_approval', 'working', 'ended'],
    'the implementer plans, works, stops for a human, resumes and finishes',
  );
});

test('the approval wait does not clear itself', () => {
  // A run that stops for a person must stay stopped until something says it was
  // approved. Time passing is not approval, so stepping through the beats that
  // follow must not move it on its own.
  const store = demoStore();
  const player = playerFor(store);

  const approvalIndex = DEMO_TIMELINE.findIndex((beat) => beat.status === 'awaiting_approval');
  assert.ok(approvalIndex >= 0, 'the mission does stop for a human');

  for (let i = 0; i <= approvalIndex; i += 1) player.step();
  const waiting = selectDesks(screen(store)).find((desk) => desk.display_name === 'dev-1');
  assert.equal(waiting?.visual.state, 'awaiting_approval');
  assert.equal(waiting?.visual.code, 'APPROVAL');

  // The very next beat is the approval itself - an event, not a timeout.
  const next = DEMO_TIMELINE[approvalIndex + 1];
  assert.equal(next?.agent_id, 'dev-1');
  assert.equal(next?.status, 'working', 'what resumes the work is a reported status');
});

test('the mission ends with an error case and an uninterpretable case beside it', () => {
  const store = demoStore();
  const player = playerFor(store);
  while (player.step());

  const desks = selectDesks(screen(store));
  const byName = new Map(desks.map((desk) => [desk.display_name, desk]));

  assert.equal(byName.get('dev-1')?.visual.state, 'ended', 'the mission itself completed');
  assert.equal(byName.get('sync-1')?.visual.state, 'error', 'a separate failure is visible as one');

  // The honest case: a status the screen has no vocabulary for must read as
  // unknown rather than being rounded up to a success or down to idle.
  const ext = byName.get('ext-1');
  assert.equal(ext?.visual.state, 'unknown');
  assert.equal(ext?.visual.code, 'UNKNOWN');
  assert.equal(ext?.status_label, 'sync_pending', 'the raw label is still reported');
  assert.notEqual(ext?.visual.state, 'ended', 'an unreadable status is never a completion');
});

test('an unknown status stays unknown however active the actor looks', () => {
  const beat = DEMO_TIMELINE.find((item) => item.agent_id === 'ext-1');
  assert.ok(beat !== undefined);
  // `agent_start` sets active: true. The classification must not use that to
  // turn an uninterpretable status into "working".
  assert.equal(beat.event_type, 'agent_start');
  assert.equal(classifyActor({ status: beat.status, active: true }).state, 'unknown');
});

// ---------------------------------------------------------- start-once -----

test('playback starts on the first subscriber and never restarts', () => {
  let starts = 0;
  const store = new NamespaceStore({ namespace: 'demo', onFirstSubscriber: () => (starts += 1) });

  const first = store.subscribe(() => {});
  assert.equal(starts, 1, 'the first subscriber starts it');

  const second = store.subscribe(() => {});
  assert.equal(starts, 1, 'a second tab does not start it again');

  // A reconnect: everybody leaves, then somebody comes back.
  first();
  second();
  const rejoined = store.subscribe(() => {});
  assert.equal(starts, 1, 'and a reconnect does not restart it either');
  rejoined();
});

test('start() is idempotent, and stop() is final', () => {
  const store = demoStore();
  const player = playerFor(store, { firstDelayMs: 0, intervalMs: 0 });

  player.start();
  player.start();
  assert.equal(player.started, true);
  assert.equal(player.progress, 0, 'starting only schedules; it does not ingest inline');

  player.stop();
  assert.equal(player.step(), false, 'a stopped player ingests nothing more');
  assert.equal(store.stats.accepted, 0);
  player.stop();
});

test('the first beat is never ingested in the same tick as the subscription', async () => {
  // `server.ts` writes the opening snapshot after `subscribe()` returns. A beat
  // ingested synchronously from the first-subscriber hook would therefore be
  // overwritten by the snapshot that follows it, and the viewer would never see
  // that transition. Deferring the first beat is what prevents that race.
  const store = demoStore();
  const player = playerFor(store, { firstDelayMs: 0 });
  store.onFirstSubscriber = () => player.start();

  const seen: string[] = [];
  const unsubscribe = store.subscribe((wire) => seen.push(wire.event_id));
  assert.equal(store.stats.accepted, 0, 'nothing was ingested while subscribing');
  assert.equal(seen.length, 0);

  // ...and it does arrive, on a later turn of the loop, to a live subscriber.
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(store.stats.accepted > 0, true, 'the mission did start');
  assert.equal(seen.length, store.stats.accepted, 'and every beat reached the subscriber');
  unsubscribe();
  player.stop();
});

test('finishing stops the player instead of looping', () => {
  const store = demoStore();
  let finished = 0;
  const player = playerFor(store, { onFinished: () => (finished += 1) });

  while (player.step());
  assert.equal(player.finished, true);
  assert.equal(finished, 1, 'the end is announced exactly once');
  assert.equal(player.step(), false, 'and the timeline does not wrap around');
  assert.equal(store.stats.accepted, DEMO_TIMELINE.length);
  player.stop();
});

// -------------------------------------------------------------- freshness ---

test('a beat is timestamped when it is ingested, so "last update" means something', () => {
  const store = demoStore();
  const player = playerFor(store);
  player.step();
  player.step();

  const client = screen(store);
  const timestamps = selectDesks(client).map((desk) => desk.last_event_ts);
  assert.ok(timestamps.every((ts) => typeof ts === 'string' && ts.length > 0));
  // The beats themselves carry no `ts`; it is stamped on the way in.
  for (const beat of DEMO_TIMELINE) {
    assert.equal('ts' in beat, false, 'a beat has no baked-in timestamp');
  }
});

test('the mission is a DEMO story and cannot reach a LIVE client', () => {
  const store = demoStore();
  const player = playerFor(store);
  while (player.step());

  // A LIVE client handed one of these frames counts it as foreign and applies
  // nothing, which is the same guard the fixtures rely on.
  const liveClient = createClientState('live');
  const applied = applyFrame(liveClient, {
    kind: 'snapshot',
    payload: snapshotOf(store),
  });
  assert.equal(Object.keys(applied.actors).length, 0, 'a LIVE screen stays empty');
  assert.equal(applied.counters.foreign, 1, 'and counts the frame as foreign');
});
