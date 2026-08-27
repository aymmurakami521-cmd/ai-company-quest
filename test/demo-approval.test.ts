/**
 * The DEMO approval gate.
 *
 * The regression this file exists for: the moving demo used to walk out of
 * `awaiting_approval` on its own, because `#schedule` armed the next timer
 * without looking at the beat it had just ingested. `intervalMs` elapsing was
 * therefore enough to ingest the beat that says "承認を受けて作業を再開しました" -
 * a claim that a person approved something, produced by nothing but the clock.
 *
 * So the cases below are about causality, not about the story:
 * - time alone, and stepping alone, leave the wait exactly where it is;
 * - no beat claiming an approval exists in the store before the signal;
 * - one signal resumes, exactly once;
 * - a duplicate, a late, an early or an unrecognized signal changes nothing;
 * - LIVE has no part in any of it, and shutdown leaves nothing behind.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { QuestServer } from '../src/server/server.ts';
import { NamespaceStore } from '../src/collector/store.ts';
import { DEMO_TIMELINE, DemoPlayer } from '../src/demo/timeline.ts';
import {
  APPROVAL_COMMAND,
  ApprovalSignalReader,
  MAX_SIGNAL_CHARS,
  attachApprovalConsole,
} from '../src/demo/approval.ts';
import type { ApprovalDataListener, ApprovalInput } from '../src/demo/approval.ts';
import type { ApprovalOutcome } from '../src/demo/timeline.ts';
import { countFrames, openSse } from './helpers.ts';

/** The one beat that reports a run has stopped for a human. */
const GATE_INDEX = DEMO_TIMELINE.findIndex((beat) => beat.status === 'awaiting_approval');

/** The beat that claims the work was approved and resumed. */
const RESUME_BEAT = DEMO_TIMELINE[GATE_INDEX + 1];

function demoStore(): NamespaceStore {
  return new NamespaceStore({ namespace: 'demo' });
}

function playerFor(store: NamespaceStore, overrides: Record<string, unknown> = {}): DemoPlayer {
  return new DemoPlayer({ store, intervalMs: 1500, firstDelayMs: 1200, ...overrides });
}

/** Steps up to and including the beat that reports the wait. */
function stepToGate(player: DemoPlayer): void {
  for (let i = 0; i <= GATE_INDEX; i += 1) assert.equal(player.step(), true);
  assert.equal(player.awaitingApproval, true, 'the run is waiting for a human');
}

/** True once the beat claiming the resumption is in the store's replay buffer. */
function resumeBeatIngested(store: NamespaceStore): boolean {
  return store.replayFrom(RESUME_BEAT?.event_id ?? '').status !== 'unknown';
}

test('the script really does stop for a human, and really does claim a resumption', () => {
  // The two facts the rest of this file is about. If either changes, the cases
  // below would be asserting nothing.
  assert.ok(GATE_INDEX >= 0, 'a beat reports awaiting_approval');
  assert.equal(RESUME_BEAT?.status, 'working');
  assert.match(String(RESUME_BEAT?.summary), /承認/, 'and the beat after it claims an approval');
});

// ------------------------------------------------- time is not an approval ---

test('elapsed wall-clock time alone never clears the approval wait', async () => {
  // `intervalMs: 0` is the worst case on purpose: before the fix this played the
  // whole 18-beat script - approval, resumption, completion and all - inside
  // this wait, with nobody approving anything.
  const store = demoStore();
  const player = playerFor(store, { intervalMs: 0, firstDelayMs: 0 });
  player.start();
  await new Promise((resolve) => setTimeout(resolve, 300));

  assert.equal(player.awaitingApproval, true, 'the run is still waiting');
  assert.equal(player.progress, GATE_INDEX + 1, 'playback stopped on the beat that reported the wait');
  assert.equal(resumeBeatIngested(store), false, 'and no beat claiming a resumption was ingested');

  // More time is still not approval.
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(player.progress, GATE_INDEX + 1, 'a second wait moved it no further');
  assert.equal(player.approvals, 0, 'nothing was recorded as approved');
  player.stop();
});

test('no event claiming an approval exists in the store before the signal', () => {
  const store = demoStore();
  const player = playerFor(store);
  stepToGate(player);

  // Not just the one beat: nothing anywhere in what was ingested says a person
  // approved anything, and no actor has left the waiting state.
  for (const wire of store.replay.snapshot()) {
    assert.equal(/承認を受けて|再開しました/.test(String(wire.summary ?? '')), false, 'no resumption is claimed');
  }
  const waiting = Object.values(store.state.actors).find((actor) => actor.agent_id === 'dev-1');
  assert.equal(waiting?.status, 'awaiting_approval', 'the implementer is still waiting');
  assert.equal(player.approvals, 0);
});

test('repeated ticks and repeated steps while awaiting leave the store byte-identical', () => {
  const store = demoStore();
  const player = playerFor(store);
  stepToGate(player);

  const before = JSON.stringify(store.state);
  const accepted = store.stats.accepted;
  for (let i = 0; i < 50; i += 1) assert.equal(player.step(), false);

  assert.equal(JSON.stringify(store.state), before, 'the folded state did not move');
  assert.equal(store.stats.accepted, accepted, 'and nothing was ingested');
});

// --------------------------------------------------- exactly one signal ------

test('exactly one valid signal resumes, and it resumes exactly once', () => {
  const store = demoStore();
  const player = playerFor(store);
  stepToGate(player);

  const atGate = player.progress;
  assert.equal(player.approve(), 'resumed');
  assert.equal(player.awaitingApproval, false, 'the wait is over');
  assert.equal(player.progress, atGate + 1, 'the signal ingested exactly one beat');
  assert.equal(resumeBeatIngested(store), true, 'and that beat is the reported resumption');
  assert.equal(player.approvals, 1);

  // The rest of the mission runs on the ordinary step path from here.
  while (player.step());
  assert.equal(player.finished, true);
  assert.equal(store.stats.accepted, DEMO_TIMELINE.length);
  assert.equal(player.approvals, 1, 'one gate, one approval, for the whole script');
});

test('duplicate, late and early signals are harmless no-ops', () => {
  const store = demoStore();
  const player = playerFor(store);

  // Early: nothing is waiting yet.
  assert.equal(player.approve(), 'not_awaiting');
  assert.equal(store.stats.accepted, 0, 'an early signal ingests nothing');

  stepToGate(player);
  assert.equal(player.approve(), 'resumed');
  const afterResume = player.progress;
  const state = JSON.stringify(store.state);

  // Duplicate: the same person pressing it twice, or two signals racing.
  for (let i = 0; i < 5; i += 1) assert.equal(player.approve(), 'not_awaiting');
  assert.equal(player.progress, afterResume, 'no second beat was ingested');
  assert.equal(JSON.stringify(store.state), state, 'and the state is untouched');
  assert.equal(player.approvals, 1, 'a duplicate is not counted as an approval');

  // Late: after the mission has ended.
  while (player.step());
  assert.equal(player.approve(), 'stopped');
  assert.equal(store.stats.accepted, DEMO_TIMELINE.length, 'the timeline did not wrap around');
});

test('a stopped player refuses to be approved, and holds no timer', async () => {
  const store = demoStore();
  const player = playerFor(store, { intervalMs: 0, firstDelayMs: 0 });
  player.start();
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(player.awaitingApproval, true);

  player.stop();
  assert.equal(player.approve(), 'stopped', 'shutdown is not a thing an approval reverses');
  const progress = player.progress;
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(player.progress, progress, 'and no timer survived the shutdown');
  assert.equal(resumeBeatIngested(store), false);
});

test('approval resumes the timer chain, so the mission still finishes on its own', async () => {
  const store = demoStore();
  let finished = 0;
  const player = playerFor(store, { intervalMs: 0, firstDelayMs: 0, onFinished: () => (finished += 1) });
  player.start();
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(player.awaitingApproval, true);

  assert.equal(player.approve(), 'resumed');
  await new Promise((resolve) => setTimeout(resolve, 300));

  assert.equal(player.finished, true, 'playback continued after the approval');
  assert.equal(finished, 1, 'and announced its end exactly once');
  assert.equal(store.stats.accepted, DEMO_TIMELINE.length);
  player.stop();
});

test('the waiting run is announced once, when it starts waiting', () => {
  const store = demoStore();
  let announced = 0;
  const player = playerFor(store, { onAwaitingApproval: () => (announced += 1) });

  stepToGate(player);
  assert.equal(announced, 1, 'announced when the gate closed');
  for (let i = 0; i < 10; i += 1) player.step();
  assert.equal(announced, 1, 'and not again for every refused step');

  player.approve();
  while (player.step());
  assert.equal(announced, 1, 'one gate in the script, one announcement');
});

// ------------------------------------------------------- the signal reader ---

test('only the exact word resumes anything; everything else is unrecognized', () => {
  const reader = new ApprovalSignalReader();
  assert.deepEqual(reader.read('approve\n'), ['approve']);
  assert.deepEqual(reader.read('  APPROVE  \n'), ['approve'], 'case and padding are forgiven');
  assert.deepEqual(reader.read('approve now\n'), ['unrecognized'], 'but nothing else is');
  assert.deepEqual(reader.read('yes\napproved\nok\n'), ['unrecognized', 'unrecognized', 'unrecognized']);
  assert.deepEqual(reader.read('\n'), ['blank'], 'a stray Enter is silent, not a command');
  assert.deepEqual(reader.read('  \r\n'), ['blank']);
});

test('a line is only read once it is complete, and is read in order', () => {
  const reader = new ApprovalSignalReader();
  assert.deepEqual(reader.read('app'), [], 'a partial line is not a signal');
  assert.deepEqual(reader.read('rove'), [], 'still not');
  assert.deepEqual(reader.read('\nnope\n'), ['approve', 'unrecognized'], 'and then both, in order');
  assert.deepEqual(reader.counts, { approve: 1, blank: 0, unrecognized: 1 });
});

test('an over-long line is dropped rather than buffered or truncated', () => {
  const reader = new ApprovalSignalReader();
  // The dangerous shape: a very long line that ends in the command word. If the
  // reader trimmed to a window instead of dropping, this would approve.
  const flood = 'x'.repeat(MAX_SIGNAL_CHARS * 4) + APPROVAL_COMMAND;
  assert.deepEqual(reader.read(flood), [], 'nothing is emitted while it is being discarded');
  assert.deepEqual(reader.read('\n'), ['unrecognized'], 'and the completed line is refused');
  // The reader recovered: the next ordinary line still works.
  assert.deepEqual(reader.read(`${APPROVAL_COMMAND}\n`), ['approve']);
});

// ------------------------------------------------------------ the console ---

/** A stand-in for `process.stdin`: the four calls the console actually makes. */
class FakeInput implements ApprovalInput {
  listeners: ApprovalDataListener[] = [];
  encoding: string | null = null;
  paused = false;
  unreffed = false;

  setEncoding(encoding: 'utf8'): void {
    this.encoding = encoding;
  }
  on(_event: 'data', listener: ApprovalDataListener): void {
    this.listeners.push(listener);
  }
  removeListener(_event: 'data', listener: ApprovalDataListener): void {
    this.listeners = this.listeners.filter((item) => item !== listener);
  }
  pause(): void {
    this.paused = true;
  }
  unref(): void {
    this.unreffed = true;
  }
  emit(chunk: string): void {
    for (const listener of [...this.listeners]) listener(chunk);
  }
}

function consoleFor(player: DemoPlayer): { input: FakeInput; written: string[]; detach: () => void } {
  const input = new FakeInput();
  const written: string[] = [];
  const detach = attachApprovalConsole({
    input,
    approve: () => player.approve(),
    write: (line) => {
      written.push(line);
    },
  });
  return { input, written, detach };
}

test('a typed approval is what resumes the mission, and only that', () => {
  const store = demoStore();
  const player = playerFor(store);
  const { input, written } = consoleFor(player);
  stepToGate(player);

  input.emit('hello\n');
  input.emit('\n');
  assert.equal(player.awaitingApproval, true, 'neither a wrong word nor an empty line approved anything');
  assert.equal(player.progress, GATE_INDEX + 1);

  input.emit(`${APPROVAL_COMMAND}\n`);
  assert.equal(player.awaitingApproval, false);
  assert.equal(player.approvals, 1);
  assert.equal(resumeBeatIngested(store), true);

  // One reply per non-blank line: the refusal and the acceptance, nothing else.
  assert.equal(written.length, 2);
  assert.match(written[0] ?? '', /認識できない/);
  assert.match(written[1] ?? '', /承認を受け付けました/);
});

test('typing it twice does not advance twice', () => {
  const store = demoStore();
  const player = playerFor(store);
  const { input, written } = consoleFor(player);
  stepToGate(player);

  input.emit(`${APPROVAL_COMMAND}\n${APPROVAL_COMMAND}\n${APPROVAL_COMMAND}\n`);
  assert.equal(player.approvals, 1, 'three lines, one approval');
  assert.equal(player.progress, GATE_INDEX + 2, 'and one beat');
  assert.equal(written.filter((line) => /承認を受け付けました/.test(line)).length, 1);
  assert.equal(written.filter((line) => /承認待ちのものはありません/.test(line)).length, 2);
});

test('detaching leaves nothing attached and nothing later can resume the run', () => {
  const store = demoStore();
  const player = playerFor(store);
  const { input, detach } = consoleFor(player);
  stepToGate(player);

  assert.equal(input.encoding, 'utf8');
  assert.equal(input.unreffed, true, 'the console never keeps the process alive on its own');
  assert.equal(input.listeners.length, 1);

  detach();
  assert.equal(input.listeners.length, 0, 'the listener is gone');
  assert.equal(input.paused, true, 'and the stream is not left flowing');

  input.emit(`${APPROVAL_COMMAND}\n`);
  assert.equal(player.awaitingApproval, true, 'a line after shutdown resumes nothing');
  assert.equal(resumeBeatIngested(store), false);

  detach();
  assert.equal(input.listeners.length, 0, 'detaching twice is safe');
});

// ------------------------------------------------------ the LIVE boundary ---

test('the approval path cannot touch LIVE state or the LIVE stream', () => {
  const live = new NamespaceStore({ namespace: 'live', inputContract: 'internal_normalized' });
  const liveFrames: string[] = [];
  live.subscribe((wire) => liveFrames.push(wire.event_id));

  const store = demoStore();
  const player = playerFor(store);
  const { input } = consoleFor(player);

  stepToGate(player);
  input.emit(`${APPROVAL_COMMAND}\n`);
  while (player.step());

  assert.equal(player.approvals, 1);
  assert.equal(store.stats.accepted, DEMO_TIMELINE.length, 'the DEMO mission ran to the end');
  assert.equal(liveFrames.length, 0, 'and no frame reached a LIVE subscriber');
  assert.equal(live.stats.accepted, 0);
  assert.equal(live.stats.lines_seen, 0);
  assert.equal(live.state.last_ingest_seq, 0);
  assert.deepEqual(Object.keys(live.state.actors), []);
  assert.deepEqual(Object.keys(live.state.sessions), []);
});

// ------------------------------------------------------------ end to end ---

test('over the real server: a browser watching the DEMO sees the run hold, then resume', async () => {
  // The whole path `live.ts` builds, minus the collector: a DEMO store whose
  // first subscriber starts the mission, the SSE server a browser connects to,
  // and the console the operator types into.
  let player: DemoPlayer | null = null;
  const demo = new NamespaceStore({
    namespace: 'demo',
    inputContract: 'internal_normalized',
    onFirstSubscriber: () => player?.start(),
  });
  const live = new NamespaceStore({ namespace: 'live' });
  player = new DemoPlayer({ store: demo, intervalMs: 0, firstDelayMs: 0 });
  const { input, detach } = consoleFor(player);

  const server = new QuestServer({ stores: { live, demo } });
  const address = await server.listen(0);
  const watcher = await openSse(address.port, '/events/demo');
  const liveWatcher = await openSse(address.port, '/events/live');
  try {
    await watcher.waitFor((text) => text.includes('"awaiting_approval"'));
    // Long enough that an ungated player (`intervalMs: 0`) would have run the
    // rest of the script several times over.
    await new Promise((resolve) => setTimeout(resolve, 300));

    const held = countFrames(watcher.text(), 'quest_event');
    assert.equal(held, GATE_INDEX + 1, 'the browser has every beat up to the wait, and no more');
    assert.equal(watcher.text().includes(RESUME_BEAT?.event_id ?? ''), false, 'no resumption was streamed');

    input.emit(`${APPROVAL_COMMAND}\n`);
    await watcher.waitFor((text) => text.includes(RESUME_BEAT?.event_id ?? ''));
    await watcher.waitFor((text) => countFrames(text, 'quest_event') === DEMO_TIMELINE.length);
    assert.equal(player.approvals, 1);

    // Meanwhile the LIVE stream carried its snapshot and nothing else.
    assert.equal(countFrames(liveWatcher.text(), 'quest_event'), 0, 'LIVE streamed no event');
    assert.equal(live.stats.accepted, 0);
    assert.deepEqual(Object.keys(live.state.actors), []);
  } finally {
    detach();
    player.stop();
    watcher.close();
    liveWatcher.close();
    await server.close();
  }
});

test('there is no player to approve in the LIVE namespace at all', () => {
  const live = new NamespaceStore({ namespace: 'live', inputContract: 'internal_normalized' });
  assert.throws(() => playerFor(live), /namespace 'live'/);
  assert.equal(live.stats.accepted, 0);

  // The console approves whatever callback it is handed and has no namespace of
  // its own; in `live.ts` that callback is the DEMO player's, and there is no
  // second player it could be handed instead.
  const outcomes: ApprovalOutcome[] = [];
  const input = new FakeInput();
  attachApprovalConsole({
    input,
    approve: () => {
      outcomes.push('not_awaiting');
      return 'not_awaiting';
    },
    write: () => {},
  });
  input.emit(`${APPROVAL_COMMAND}\n`);
  assert.deepEqual(outcomes, ['not_awaiting']);
  assert.equal(live.stats.accepted, 0, 'and LIVE saw none of it');
});
