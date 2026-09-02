/**
 * The Owner ARK management projection.
 *
 * Nothing here touches the DOM, a socket or the clock: every case is a pure
 * function over data, so the suite is deterministic and cannot flake.
 *
 * The rules being held, all of them about what the console must refuse to
 * claim:
 *
 * 1. **Need You outranks everything.** An explicit approval wait sorts above an
 *    advisory, and neither disappears because the stream went quiet.
 * 2. **Unknown is never work.** While nothing is confirming the office, Now
 *    reports 状態不明 for everybody rather than leaving rows that read as still
 *    executing - and it still says what was last observed, separately. A
 *    reopened socket does not count as confirming it; a recovery frame does.
 * 2b. **Completion is the desk's own claim.** A generic `session_end` never
 *    manufactures one, and never erases one the desk already made.
 * 3. **A gap in the contract is reported, not filled.** Next carries no invented
 *    plan and Outcome carries no invented artifact.
 * 4. **The command surface cannot send.** It builds a payload, says there is
 *    nowhere to send it, and has no way to send it anyway.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { NamespaceStore } from '../src/collector/store.ts';
import type { SanitizedEvent } from '../src/domain/event.ts';
import type { WireEvent } from '../src/domain/wire.ts';
import { makeEvent } from './helpers.ts';

import type { ClientState, Frame } from '../src/ui/public/quest-view.js';
import {
  ACTOR_VISUAL_STATES,
  applyEvent,
  applyFrame,
  createClientState,
  setConnectionPhase,
} from '../src/ui/public/quest-view.js';
import type { ArkRuntimeCode } from '../src/ui/public/quest-ark.js';
import {
  ARK_ATTENTION_LEVELS,
  ARK_ATTENTION_REASONS,
  ARK_COMMAND_MAX,
  ARK_COMMAND_REJECTS,
  ARK_OUTCOME_RESULTS,
  ARK_RECOVERY_FRAMES,
  ARK_RUNTIME_CODES,
  ARK_SETTLING_RECOVERY_FRAMES,
  ARK_SUBMISSION,
  ARK_UNCONFIRMED_BANNER_CODES,
  NOT_IN_CONTRACT,
  arkPhaseOnOpen,
  arkRecovered,
  arkRecoverySettles,
  buildCommandDraft,
  outcomeLabel,
  runtimeLabel,
  selectArk,
  selectAttention,
  selectNext,
  selectNow,
  selectOutcome,
} from '../src/ui/public/quest-ark.js';

/**
 * A client state folded from wire events a real store produced, so the shapes
 * under test are the ones a browser would actually receive.
 */
function stateOf(events: readonly Partial<SanitizedEvent>[]): ClientState {
  const store = new NamespaceStore({ namespace: 'live' });
  const wires: WireEvent[] = [];
  store.subscribe((wire) => wires.push(wire));
  events.forEach((overrides, index) => {
    store.ingestObject(makeEvent({ ts: `2026-01-01T00:00:0${index}.000Z`, ...overrides }));
  });
  let state = setConnectionPhase(createClientState('live'), 'open', 1000);
  for (const wire of wires) state = applyEvent(state, wire, 1000);
  return state;
}

/** The same office, with the stream no longer confirming anything. */
function disconnected(state: ClientState): ClientState {
  return setConnectionPhase(state, 'error', 2000);
}

/**
 * The same office mid-recovery: the socket is open, and frames are known to be
 * missing until the `snapshot` that repairs the gap lands.
 */
function gapped(state: ClientState): ClientState {
  return applyFrame(state, { kind: 'stream_gap', payload: { reason: 'evicted' }, at_ms: 2000 });
}

/** The same office replaying what it missed, which is also not a live office. */
function replaying(state: ClientState): ClientState {
  return applyFrame(state, { kind: 'replay_start', at_ms: 2000 });
}

/** The server re-stating the whole office, which is what ends a recovery. */
function recovery(statuses: Record<string, string>): Frame {
  const store = new NamespaceStore({ namespace: 'live' });
  Object.entries(statuses).forEach(([agent, status], index) => {
    store.ingestObject(
      makeEvent({
        event_type: 'agent_start',
        agent_id: agent,
        status,
        ts: `2026-01-01T00:00:0${index}.000Z`,
      }),
    );
  });
  return {
    kind: 'snapshot',
    payload: {
      namespace: 'live',
      halted: false,
      halt_reason: null,
      last_ingest_seq: store.stats.last_ingest_seq,
      state: JSON.parse(JSON.stringify(store.state)) as unknown,
    },
    at_ms: 3000,
  };
}

/**
 * An office this client watched, a stretch of it the client missed, and the
 * server's snapshot in between - built from one store, so `ingest_seq` runs the
 * way it does on the wire and the missed stretch is a real hole in what this
 * client applied rather than a re-numbered second history.
 */
function afterRecovery(
  seen: readonly Partial<SanitizedEvent>[],
  missed: readonly Partial<SanitizedEvent>[],
  after: readonly Partial<SanitizedEvent>[] = [],
): ClientState {
  const store = new NamespaceStore({ namespace: 'live' });
  const pending: WireEvent[] = [];
  store.subscribe((wire) => pending.push(wire));
  let clock = 0;
  const ingest = (events: readonly Partial<SanitizedEvent>[]): WireEvent[] => {
    for (const overrides of events) {
      const ts = `2026-01-01T00:00:${String(clock++).padStart(2, '0')}.000Z`;
      store.ingestObject(makeEvent({ ts, ...overrides }));
    }
    return pending.splice(0, pending.length);
  };

  let state = setConnectionPhase(createClientState('live'), 'open', 1000);
  for (const wire of ingest(seen)) state = applyEvent(state, wire, 1000);
  // Ingested while this client was not listening: the server folds these, and
  // the client only ever learns of them through the snapshot below.
  ingest(missed);
  state = applyFrame(state, {
    kind: 'snapshot',
    payload: {
      namespace: 'live',
      halted: false,
      halt_reason: null,
      last_ingest_seq: store.stats.last_ingest_seq,
      state: JSON.parse(JSON.stringify(store.state)) as unknown,
    },
    at_ms: 3000,
  });
  for (const wire of ingest(after)) state = applyEvent(state, wire, 3100);
  return state;
}

/** One colleague per status label, all in one session. */
function office(statuses: Record<string, string>): ClientState {
  return stateOf(
    Object.entries(statuses).map(([agent, status]) => ({
      event_type: 'agent_start' as const,
      agent_id: agent,
      status,
    })),
  );
}

// ------------------------------------------------------------- Need You ---

test('Need You puts an explicit approval request above every advisory', () => {
  const state = office({ ann: 'awaiting_approval', bob: 'failed', cy: 'running' });
  const attention = selectAttention(state);

  assert.deepEqual(
    attention.items.map((item) => item.reason_code),
    ['AWAITING_APPROVAL', 'RUN_ERROR'],
    'the working colleague is not asking for anything, and is not listed',
  );
  assert.equal(attention.items[0]?.level, 'required');
  assert.equal(attention.items[1]?.level, 'advised');
  assert.equal(attention.count, 2);
  assert.equal(attention.required, true);
});

test('a quiet office asks for nobody', () => {
  const attention = selectAttention(office({ ann: 'running', bob: 'planning' }));
  assert.deepEqual(attention.items, []);
  assert.equal(attention.count, 0);
  assert.equal(attention.required, false);
});

test('every Need You item is a decision packet, not a request to approve', () => {
  const attention = selectAttention(office({ ann: 'awaiting_approval' }));
  const item = attention.items[0];
  assert.ok(item !== undefined);
  // Why a person is needed, what the choice is, and what happens if nobody
  // makes it. A bare 「承認してください」 is exactly what this must not be.
  assert.ok(item.reason.length > 0, 'why a person is needed');
  assert.ok(item.recommended.length > 0, 'what is recommended');
  assert.ok(item.options.length >= 2, 'what the choices are');
  assert.ok(item.inaction.length > 0, 'what doing nothing costs');
  assert.equal(item.last_update, '2026-01-01T00:00:00.000Z', 'and when it was last true');
  assert.ok(ARK_ATTENTION_REASONS.includes(item.reason_code), 'from a closed vocabulary');
});

test('a lost stream raises one item, not one per colleague', () => {
  const state = disconnected(office({ ann: 'awaiting_approval', bob: 'running', cy: 'running' }));
  const items = selectAttention(state).items;

  const connection = items.filter((item) => item.kind === 'connection');
  assert.equal(connection.length, 1, 'the disconnection is one fact about one stream');
  assert.equal(connection[0]?.reason_code, 'STREAM_UNCONFIRMED');
  // The two working colleagues become 状態不明 while stale. That is not three
  // more things to decide, so they raise nothing.
  assert.deepEqual(
    items.map((item) => item.reason_code),
    ['AWAITING_APPROVAL', 'STREAM_UNCONFIRMED'],
  );
});

test('an approval wait survives the disconnection that hid it, marked unconfirmed', () => {
  const live = selectAttention(office({ ann: 'awaiting_approval' })).items[0];
  const frozen = selectAttention(disconnected(office({ ann: 'awaiting_approval' }))).items.find(
    (item) => item.kind === 'actor',
  );

  assert.equal(live?.confirmed, true);
  assert.equal(frozen?.reason_code, 'AWAITING_APPROVAL', 'still the reason it was raised for');
  assert.equal(frozen?.confirmed, false, 'but not presented as a live observation');
  assert.equal(frozen?.visual?.state, 'unknown', 'what may be claimed now');
  assert.equal(frozen?.last_known_visual?.state, 'awaiting_approval', 'what was last observed');
});

test('a fail-closed namespace is an explicit request for a person', () => {
  let state = office({ ann: 'running' });
  state = applyFrame(state, {
    kind: 'fail_closed',
    payload: { namespace: 'live', halted: true, reason: 'state_limit', detail: '' },
    at_ms: 2000,
  });
  const items = selectAttention(state).items;
  assert.equal(items[0]?.reason_code, 'INGEST_HALTED');
  assert.equal(items[0]?.level, 'required');
  assert.equal(items[0]?.confirmed, false);
});

test('nothing in Need You is carried by colour alone', () => {
  const state = disconnected(office({ ann: 'awaiting_approval', bob: 'failed' }));
  for (const item of selectAttention(state).items) {
    assert.ok(ARK_ATTENTION_LEVELS.includes(item.level), 'the level is a word');
    assert.ok(item.title.length > 0, 'the item is named');
    if (item.visual !== null) {
      assert.ok(item.visual.symbol.length > 0, 'the state has a symbol');
      assert.ok(item.visual.label.length > 0, 'and a readable label');
    }
  }
});

// ------------------------------------------------------------------ Now ---

test('Now separates the runtime classes it can actually classify', () => {
  const now = selectNow(office({ ann: 'running', bob: 'awaiting_approval', cy: 'failed', di: 'idle' }));
  const byName = new Map(now.rows.map((row) => [row.display_name, row.runtime]));
  assert.equal(byName.get('ann'), 'EXECUTING');
  assert.equal(byName.get('bob'), 'HUMAN_WAIT');
  assert.equal(byName.get('cy'), 'BLOCKED');
  assert.equal(byName.get('di'), 'IDLE');
  assert.equal(now.confirmed, true);
  // Worst first, so the failure is not below the fold on a busy screen.
  assert.deepEqual(now.rows.map((row) => row.display_name), ['cy', 'bob', 'ann', 'di']);
});

test('Now never reports work while nothing is confirming it', () => {
  const state = disconnected(office({ ann: 'running', bob: 'running', cy: 'failed' }));
  const now = selectNow(state);

  assert.equal(now.confirmed, false);
  assert.equal(now.counts.EXECUTING, 0, 'a disconnection empties 実行中');
  assert.equal(now.counts.UNKNOWN, 3, 'and moves everybody to 状態不明');
  for (const row of now.rows) {
    assert.equal(row.runtime, 'UNKNOWN');
    assert.equal(row.confirmed, false);
  }
  // The observation itself is kept, separately and labelled as the last one.
  assert.deepEqual(
    now.rows.map((row) => row.last_known_runtime).sort(),
    ['BLOCKED', 'EXECUTING', 'EXECUTING'],
  );
});

test('a gap in the stream stops Now reporting work it can no longer see', () => {
  const now = selectNow(gapped(office({ ann: 'running', bob: 'awaiting_approval' })));

  // The socket is still open, so the office's own `stale` rule does not fire -
  // and that is exactly the case this console has to catch for itself. Frames
  // are known to be missing, so nothing on screen is a current observation.
  assert.equal(now.confirmed, false);
  assert.equal(now.counts.EXECUTING, 0, 'a gap empties 実行中 like a disconnection does');
  assert.equal(now.counts.UNKNOWN, 2);
  for (const row of now.rows) {
    assert.equal(row.runtime, 'UNKNOWN');
    assert.equal(row.visual.state, 'unknown', 'and the row itself reads as 状態不明');
    assert.equal(row.confirmed, false);
  }
  // Kept, and kept labelled as the last observation rather than dropped.
  assert.deepEqual(
    now.rows.map((row) => row.last_known_runtime).sort(),
    ['EXECUTING', 'HUMAN_WAIT'],
  );
});

test('a replay in progress is a recovery, never a live office', () => {
  const now = selectNow(replaying(office({ ann: 'running' })));

  assert.equal(now.confirmed, false);
  assert.equal(now.counts.EXECUTING, 0);
  assert.equal(now.rows[0]?.runtime, 'UNKNOWN');
  assert.equal(now.rows[0]?.confirmed, false);
  assert.equal(now.rows[0]?.last_known_runtime, 'EXECUTING', 'what was observed is still there');
});

test('nothing reads as confirmed in the same frame the console reports a recovery', () => {
  for (const recovering of [gapped, replaying]) {
    const state = recovering(office({ ann: 'running', bob: 'awaiting_approval', cy: 'planning' }));
    const ark = selectArk(state);

    assert.ok(
      ARK_UNCONFIRMED_BANNER_CODES.includes(ark.banner.code),
      `${ark.banner.code} is a recovery the banner is already showing`,
    );
    assert.equal(ark.now.confirmed, false);
    // One item, saying why the rest of the screen cannot be trusted - not one
    // per colleague, and not silence.
    const connection = ark.attention.items.filter((item) => item.kind === 'connection');
    assert.equal(connection.length, 1);
    assert.equal(connection[0]?.reason_code, 'STREAM_UNCONFIRMED');
    for (const item of ark.attention.items) {
      assert.equal(item.confirmed, false, `${item.id} is not a live observation`);
      assert.equal(item.visual === null || item.visual.state === 'unknown', true);
    }
    for (const row of ark.now.rows) assert.equal(row.confirmed, false);
    for (const row of ark.next.rows) assert.equal(row.confirmed, false);
    for (const row of ark.outcome.rows) assert.equal(row.confirmed, false);
  }
});

test('the freeze lifts when the recovery snapshot actually lands, and not before', () => {
  const gap = gapped(office({ ann: 'running' }));
  assert.equal(selectNow(gap).confirmed, false, 'while the gap stands');

  const now = selectNow(applyFrame(gap, recovery({ ann: 'running' })));
  assert.equal(now.confirmed, true, 'the server has re-stated the whole office');
  assert.equal(now.counts.EXECUTING, 1);
  assert.equal(now.rows[0]?.runtime, 'EXECUTING');
});

test('a socket that reopens over a populated office has re-established nothing', () => {
  // The reconnect the browser performs by itself: `error` drops the office to
  // 状態不明, then `open` arrives *before* the queued replay/gap/snapshot frames.
  // Taking that `open` at face value is what handed every desk back as confirmed
  // 実行中 for the window in between.
  const dropped = disconnected(office({ ann: 'running', bob: 'planning' }));
  const reopened = setConnectionPhase(dropped, arkPhaseOnOpen(dropped), 3000);

  assert.equal(arkPhaseOnOpen(dropped), 'reconnecting', 'the transport is up; the office is not');
  const now = selectNow(reopened);
  assert.equal(now.confirmed, false);
  assert.equal(now.counts.EXECUTING, 0, 'a bare open does not refill 実行中');
  assert.equal(now.counts.UNKNOWN, 2);
  assert.equal(selectArk(reopened).banner.code, 'RECONNECTING', 'and the banner says so');
});

test('a stream that stalls after opening stays frozen instead of ageing into work', () => {
  // The half of the failure a delayed recovery makes permanent: nothing at all
  // follows the `open`. There is no clock in this projection, so "nothing since"
  // is the same state however long it lasts - which is the point.
  const dropped = disconnected(office({ ann: 'running' }));
  const stalled = setConnectionPhase(dropped, arkPhaseOnOpen(dropped), 3000);

  const ark = selectArk(stalled);
  assert.equal(ark.now.confirmed, false);
  assert.ok(ARK_UNCONFIRMED_BANNER_CODES.includes(ark.banner.code));
  for (const row of ark.now.rows) assert.equal(row.runtime, 'UNKNOWN');
  // And the reason is on screen rather than left to be inferred from a blank panel.
  assert.deepEqual(
    ark.attention.items.map((item) => item.reason_code),
    ['STREAM_UNCONFIRMED'],
  );
});

test('only a frame that re-establishes the office may lift the reconnect freeze', () => {
  const dropped = disconnected(office({ ann: 'running' }));
  const reopened = setConnectionPhase(dropped, arkPhaseOnOpen(dropped), 3000);

  // Both frames a reconnect can actually end with, and nothing else.
  const start = applyFrame(reopened, { kind: 'replay_start', at_ms: 3100 });
  assert.equal(arkRecovered(reopened, start, 'replay_start'), false, 'a replay is not its end');
  const gap = applyFrame(reopened, { kind: 'stream_gap', payload: { reason: 'evicted' }, at_ms: 3100 });
  assert.equal(arkRecovered(reopened, gap, 'stream_gap'), false, 'a gap is the opposite of one');
  const ordinary = applyFrame(reopened, { kind: 'replay_end', payload: { count: 0 }, at_ms: 3100 });
  assert.equal(arkRecovered(reopened, ordinary, 'replay_end'), true, 'a served replay is');

  const snapshot = applyFrame(reopened, recovery({ ann: 'running' }));
  assert.equal(arkRecovered(reopened, snapshot, 'snapshot'), true, 'and so is a snapshot');
  // A frame the fold refused established nothing, whatever it was called.
  const foreign = applyFrame(reopened, {
    kind: 'snapshot',
    payload: { namespace: 'demo', halted: false, last_ingest_seq: 0, state: {} },
    at_ms: 3100,
  });
  assert.equal(arkRecovered(reopened, foreign, 'snapshot'), false);
  // Nothing to lift when the console was never frozen by a reconnect.
  const live = office({ ann: 'running' });
  assert.equal(arkRecovered(live, applyFrame(live, recovery({ ann: 'running' })), 'snapshot'), false);
});

test('the office comes back the moment the recovery snapshot re-states it', () => {
  const dropped = disconnected(office({ ann: 'running' }));
  const reopened = setConnectionPhase(dropped, arkPhaseOnOpen(dropped), 3000);
  assert.equal(selectNow(reopened).confirmed, false, 'while the reconnect is unconfirmed');

  const applied = applyFrame(reopened, recovery({ ann: 'running' }));
  const recovered = setConnectionPhase(applied, 'open', 3200);
  const now = selectNow(recovered);
  assert.equal(now.confirmed, true, 'the server has re-stated the whole office');
  assert.equal(now.counts.EXECUTING, 1);
  assert.equal(now.rows[0]?.runtime, 'EXECUTING');
});

test('only a recovery frame that carries the halt state may declare the stream healthy', () => {
  // `arkRecovered` says the office has been re-established; this says whether
  // the same frame also settled whether ingestion is still running. A `snapshot`
  // carries `halted` in its own payload, so it settles both. A `replay_end` does
  // not: `server.ts:332-337` writes a queued `fail_closed` *behind* it, because a
  // halt that happened while this client was offline reaches nobody through the
  // replay itself - so declaring the recovery healthy on the `replay_end` alone
  // rendered every retained desk as confirmed 実行中 for the frame in between.
  assert.equal(arkRecoverySettles('snapshot'), true);
  assert.equal(arkRecoverySettles('replay_end'), false);
  // Neither is a recovery at all, and neither settles anything either.
  assert.equal(arkRecoverySettles('replay_start'), false);
  assert.equal(arkRecoverySettles('stream_gap'), false);
  assert.equal(arkRecoverySettles('fail_closed'), false);
  // A subset of the recovery vocabulary, so it can never name a frame that is
  // not one - which would be a second connection rule rather than a reading of
  // this one.
  for (const kind of ARK_SETTLING_RECOVERY_FRAMES) {
    assert.ok(ARK_RECOVERY_FRAMES.includes(kind), `${kind} is a recovery frame`);
  }
});

test('a first connection is not a recovery, and is not frozen as one', () => {
  // `open` over an empty office has no earlier observation to misreport, so it
  // is taken as it comes - the same reason `LOADING` is not a frozen state.
  assert.equal(arkPhaseOnOpen(createClientState('live')), 'open');
});

test('Now reports the bucket the contract cannot fill instead of guessing it', () => {
  const now = selectNow(office({ ann: 'running' }));
  assert.equal(now.external_wait.available, false);
  assert.ok(now.external_wait.note.length > 0, 'and says why in words');
  assert.equal(
    ARK_RUNTIME_CODES.includes('EXTERNAL_WAIT' as ArkRuntimeCode),
    false,
    'so no row can ever land in a class nothing can classify',
  );
});

test('every runtime code has a readable label', () => {
  for (const code of ARK_RUNTIME_CODES) {
    assert.ok(runtimeLabel(code).length > 0, `${code} is a word, not just a colour`);
  }
});

// ----------------------------------------------------------------- Next ---

test('Next reports that the plan is not in the contract, and invents none', () => {
  const next = selectNext(office({ ann: 'planning', bob: 'running' }));

  assert.equal(next.contract_available, false);
  assert.ok(next.note.length > 0);
  assert.deepEqual(next.rows.map((row) => row.display_name), ['ann'], 'only what reported planning');
  assert.equal(next.rows[0]?.next_action, null, 'and no step it did not report');
  for (const field of next.fields) {
    assert.equal(field.value, NOT_IN_CONTRACT, `${field.key} is reported absent, not blank`);
  }
});

// -------------------------------------------------------------- Outcome ---

test('Outcome puts a failure above a success, and leaves the unfinished out', () => {
  const outcome = selectOutcome(
    stateOf([
      { event_type: 'agent_start', agent_id: 'ann', status: 'running' },
      // 完了 needs this: the desk's own stop report, not somebody else's.
      { event_type: 'agent_stop', agent_id: 'ann', status: 'completed' },
      { event_type: 'agent_start', agent_id: 'bob', status: 'failed' },
      { event_type: 'agent_start', agent_id: 'cy', status: 'running' },
    ]),
  );

  assert.deepEqual(
    outcome.rows.map((row) => [row.display_name, row.result]),
    [
      ['bob', 'FAILED'],
      ['ann', 'COMPLETED'],
    ],
    'cy is still working, so it has no outcome yet',
  );
  assert.equal(outcome.counts.FAILED, 1);
  assert.equal(outcome.counts.COMPLETED, 1);
  assert.equal(outcome.counts.STOPPED, 0);
});

test('a session that ended on somebody still waiting is 中断, never 完了', () => {
  const state = stateOf([
    { event_type: 'agent_start', agent_id: 'di', status: 'running' },
    // Stopped while it was still waiting for a person, so the reducer leaves
    // this status alone: `session_end` only rewrites actors that are still
    // active.
    { event_type: 'agent_stop', agent_id: 'di', status: 'approval' },
    { event_type: 'session_end', agent_id: 'zz', status: 'running' },
  ]);
  const rows = selectOutcome(state).rows;

  assert.deepEqual(
    rows.map((row) => [row.display_name, row.result]),
    [
      ['di', 'STOPPED'],
      // zz's own last event is the session ending. That is the run stopping, not
      // zz reporting that it finished anything.
      ['zz', 'STOPPED'],
    ],
    'the run is over; di never got the approval it was waiting for',
  );
  for (const row of rows) {
    assert.ok((row.follow_up ?? '').length > 0, `${row.display_name} names the loop left open`);
  }
});

test('a generic session_end is never read as somebody having completed their work', () => {
  // The whole failure in one state: ann did nothing but start, and the session
  // then ended around it. The shared reducer rewrites every still-active actor
  // to `ended`, and `hookAdapter.ts` drops the end reason - so nothing here says
  // ann succeeded, and the console may not say so either.
  const state = stateOf([
    { event_type: 'agent_start', agent_id: 'ann', status: 'active' },
    { event_type: 'agent_start', agent_id: 'bob', status: 'running' },
    { event_type: 'agent_stop', agent_id: 'bob', status: 'completed' },
    { event_type: 'session_end', agent_id: 'zz', status: 'running' },
  ]);
  const byName = new Map(selectOutcome(state).rows.map((row) => [row.display_name, row]));

  assert.equal(byName.get('ann')?.result, 'STOPPED', 'ended by the session, not by itself');
  assert.ok((byName.get('ann')?.follow_up ?? '').length > 0, 'and the open loop is named');
  assert.equal(byName.get('zz')?.result, 'STOPPED', 'and neither did the actor that ended it');
  // The one desk that reported its own stop is the one - and the only one -
  // that reads as 完了.
  assert.equal(byName.get('bob')?.result, 'COMPLETED');
  assert.equal(byName.get('bob')?.follow_up, null, 'a completed one leaves nothing hanging');
  assert.equal(selectOutcome(state).counts.COMPLETED, 1);
  assert.equal(selectOutcome(state).counts.STOPPED, 2);
});

test('a desk that reported its own stop stays 完了 when the session then ends', () => {
  // The ordinary main-agent lifecycle: `Stop`, then `SessionEnd`. Both fold into
  // the same actor, so the generic session frame overwrites the explicit
  // `agent_stop` - and reading only the newest event turned a genuinely finished
  // orchestrator into 中断 with a follow-up line saying it never reported
  // finishing. The stop is still in the log, and that is where it is found.
  const state = stateOf([
    { event_type: 'agent_start', agent_id: 'ann', status: 'running' },
    { event_type: 'agent_stop', agent_id: 'ann', status: 'completed' },
    { event_type: 'session_end', agent_id: 'ann', status: 'running' },
  ]);
  const row = selectOutcome(state).rows[0];

  assert.ok(row !== undefined);
  assert.equal(
    state.actors[row.actor_key ?? '']?.last_event_type,
    'session_end',
    'the newest event on this actor is the generic one',
  );
  assert.equal(row.result, 'COMPLETED', 'and the desk still reported finishing, before it');
  assert.equal(row.follow_up, null, 'so nothing is claimed to be left open');
  assert.equal(selectOutcome(state).counts.STOPPED, 0);
});

test('a session_end after somebody else stopped confers nothing on the rest', () => {
  // bob's stop is bob's. ann only ever started, and the session ending around it
  // is not ann finishing anything - not even with a stop report sitting in the
  // same log, from a different desk.
  const state = stateOf([
    { event_type: 'agent_start', agent_id: 'ann', status: 'running' },
    { event_type: 'agent_start', agent_id: 'bob', status: 'running' },
    { event_type: 'agent_stop', agent_id: 'bob', status: 'completed' },
    { event_type: 'session_end', agent_id: 'bob', status: 'running' },
  ]);
  const byName = new Map(selectOutcome(state).rows.map((row) => [row.display_name, row]));

  assert.equal(byName.get('ann')?.result, 'STOPPED', 'ended by the session, not by itself');
  assert.ok((byName.get('ann')?.follow_up ?? '').length > 0, 'and the open loop is named');
  assert.equal(byName.get('bob')?.result, 'COMPLETED');
  assert.equal(selectOutcome(state).counts.COMPLETED, 1);
});

test('a stop a later start superseded is not evidence about the run after it', () => {
  // The desk finished one run and began another; the session then ended around
  // the second. Its own latest report is the `agent_start`, so the earlier stop
  // decides nothing here - completion evidence has to be about *this* work.
  const state = stateOf([
    { event_type: 'agent_start', agent_id: 'ann', status: 'running' },
    { event_type: 'agent_stop', agent_id: 'ann', status: 'completed' },
    { event_type: 'agent_start', agent_id: 'ann', status: 'running' },
    { event_type: 'session_end', agent_id: 'zz', status: 'running' },
  ]);
  const byName = new Map(selectOutcome(state).rows.map((row) => [row.display_name, row]));

  assert.equal(byName.get('ann')?.result, 'STOPPED');
  assert.ok((byName.get('ann')?.follow_up ?? '').length > 0);
});

test('a stop the reducer refused to act on stopped nothing, and proves nothing', () => {
  // A late `agent_stop`: it arrives after ann's newer `agent_start`, so the fold
  // counts it out-of-order and deliberately leaves ann running - the desk was
  // never stopped by it. The log records what arrived rather than what was
  // accepted, so the refused stop sits there all the same, newest-first ahead of
  // the start, and reading the log as ingested rather than as applied credited
  // ann with a finish the read model itself declined.
  const at = (second: number): string => `2026-01-01T00:00:0${second}.000Z`;
  const state = stateOf([
    { event_type: 'agent_start', agent_id: 'ann', status: 'running', ts: at(5) },
    { event_type: 'agent_stop', agent_id: 'ann', status: 'completed', ts: at(1) },
    { event_type: 'agent_start', agent_id: 'bob', status: 'running', ts: at(6) },
    { event_type: 'agent_stop', agent_id: 'bob', status: 'completed', ts: at(7) },
    { event_type: 'session_end', agent_id: 'ann', status: 'running', ts: at(9) },
  ]);
  const byName = new Map(selectOutcome(state).rows.map((row) => [row.display_name, row]));

  assert.equal(state.counters.out_of_order, 1, 'the fold declined exactly one event');
  assert.equal(
    state.log.filter((entry) => entry.event_type === 'agent_stop' && entry.actor === 'ann').length,
    1,
    'and the declined stop is in the client log regardless',
  );
  assert.equal(byName.get('ann')?.result, 'STOPPED', 'so it may not be read as ann finishing');
  assert.ok((byName.get('ann')?.follow_up ?? '').length > 0, 'and the open loop is named');
  // The same log, the same session end: what separates the two is whether the
  // fold acted on the stop, which is the only thing this rule reads.
  assert.equal(byName.get('bob')?.result, 'COMPLETED', 'a stop the fold applied still counts');
  assert.equal(selectOutcome(state).counts.COMPLETED, 1);
});

test('a stop from before a recovery snapshot is not proof about the run after it', () => {
  // `applySnapshot` replaces the actors with the server's fold and leaves
  // `state.log` alone, so the log outlives the office it described. Here ann
  // finished one run while this client was watching, the client then missed the
  // restart, and the session ended around the second run - and that first stop
  // is still sitting in the log, describing work the snapshot superseded.
  const state = afterRecovery(
    [
      { event_type: 'agent_start', agent_id: 'ann', status: 'running' },
      { event_type: 'agent_stop', agent_id: 'ann', status: 'completed' },
    ],
    [
      { event_type: 'agent_start', agent_id: 'ann', status: 'running' },
      { event_type: 'session_end', agent_id: 'ann', status: 'running' },
    ],
  );
  const row = selectOutcome(state).rows[0];

  assert.ok(row !== undefined);
  assert.equal(
    state.log.some((entry) => entry.event_type === 'agent_stop'),
    true,
    'the superseded stop is still in the client log',
  );
  assert.equal(
    state.actors[row.actor_key ?? '']?.last_event_type,
    'session_end',
    'and the authoritative state the snapshot brought says only that the run ended',
  );
  assert.equal(row.result, 'STOPPED', 'so the stale stop may not be read as this run finishing');
  assert.ok((row.follow_up ?? '').length > 0, 'and the open loop is named');
});

test('a stop reported after the recovery is the office as it now stands', () => {
  // The other half of the same rule: what may not be cited is an observation the
  // snapshot replaced. Everything applied *since* it is the authoritative
  // lifecycle, and a stop reported there is still the desk reporting its own
  // finish - `session_end` overwriting `last_event_type` afterwards included.
  const state = afterRecovery(
    [{ event_type: 'agent_start', agent_id: 'ann', status: 'running' }],
    [{ event_type: 'agent_start', agent_id: 'bob', status: 'running' }],
    [
      { event_type: 'agent_stop', agent_id: 'ann', status: 'completed' },
      { event_type: 'session_end', agent_id: 'ann', status: 'running' },
    ],
  );
  const byName = new Map(selectOutcome(state).rows.map((row) => [row.display_name, row]));

  assert.equal(byName.get('ann')?.result, 'COMPLETED');
  assert.equal(byName.get('ann')?.follow_up, null, 'so nothing is claimed to be left open');
  // bob is in this office because the snapshot named it, and it never reported
  // anything about itself: the session ending around it is not bob finishing.
  assert.equal(byName.get('bob')?.result, 'STOPPED');
  assert.ok((byName.get('bob')?.follow_up ?? '').length > 0);
});

test('a refused stop is not the first thing a recovered window claims the fold heard', () => {
  // The two rules above meet here, and until now the gap between them was open.
  // `trustedLog` refuses observations from before the recovery, and the
  // out-of-order replay refuses events the fold declined - but that replay had
  // nothing to order the window's *first* entry for a desk against, because the
  // entries that would have said where ann's history stood are on the far side
  // of the snapshot. A null mark accepted whatever arrived first, so this late
  // `agent_stop` was read as ann reporting a finish on a run a generic
  // `session_end` had already ended.
  const at = (second: number): string => `2026-01-01T00:00:0${second}.000Z`;
  const state = afterRecovery(
    [],
    [
      { event_type: 'agent_start', agent_id: 'ann', status: 'running', ts: at(1) },
      { event_type: 'session_end', agent_id: 'ann', status: 'running', ts: at(5) },
    ],
    [{ event_type: 'agent_stop', agent_id: 'ann', status: 'completed', ts: at(1) }],
  );
  const row = selectOutcome(state).rows[0];

  assert.ok(row !== undefined);
  // The defect's preconditions, pinned so the case cannot stop reproducing it.
  assert.equal(state.counters.out_of_order, 1, 'the fold declined the late stop');
  assert.equal(
    state.log.filter((entry) => entry.event_type === 'agent_stop').length,
    1,
    'and it is in the client log regardless, alone in the trusted window',
  );
  assert.equal(
    state.actors[row.actor_key ?? '']?.last_event_type,
    'session_end',
    'while the authoritative state says only that the session ended around ann',
  );
  assert.equal(row.result, 'STOPPED', 'so no completion may be built out of the refused stop');
  assert.ok((row.follow_up ?? '').length > 0, 'and the open loop is named');
});

test('a stop the window cannot place in the desk own order proves nothing', () => {
  // The same hole reached from the other side: here the window *does* hold ann's
  // latest applied event, so there is an anchor - but the late stop sits before
  // it, and where ann's history stood when the window opened is still unknowable
  // from this log. Reading the stop as applied would again have turned a generic
  // `session_end` into a success.
  const at = (second: number): string => `2026-01-01T00:00:0${second}.000Z`;
  const state = afterRecovery(
    [],
    [{ event_type: 'agent_start', agent_id: 'ann', status: 'running', ts: at(5) }],
    [
      { event_type: 'agent_stop', agent_id: 'ann', status: 'completed', ts: at(1) },
      { event_type: 'session_end', agent_id: 'ann', status: 'running', ts: at(5) },
    ],
  );
  const row = selectOutcome(state).rows[0];

  assert.ok(row !== undefined);
  assert.equal(state.counters.out_of_order, 1, 'the fold declined the late stop');
  assert.equal(
    state.log.filter((entry) => entry.event_type === 'agent_stop').length,
    1,
    'and the trusted window holds it, ahead of the session end it never preceded',
  );
  assert.equal(row.result, 'STOPPED');
  assert.ok((row.follow_up ?? '').length > 0);
});

test('a mark the recovery moved past is not the mark the fold was comparing against', () => {
  // The hole the two rules above still left between them. `trustedLog` refuses
  // the entries from before the recovery as *evidence*, but the ordering floor
  // was still being reconstructed from them - and between the newest of them and
  // the window there is exactly the stretch this client missed, which the fold
  // walked through. So the floor was ann's mark as it stood at t1 while the fold
  // had already carried it to t5, and the late stop at t3 - which the reducer
  // refused against the snapshot-era mark - cleared a floor that was never real
  // and was read back as ann reporting its own finish.
  const at = (second: number): string => `2026-01-01T00:00:0${second}.000Z`;
  const state = afterRecovery(
    [{ event_type: 'agent_start', agent_id: 'ann', status: 'running', ts: at(1) }],
    [{ event_type: 'agent_start', agent_id: 'ann', status: 'running', ts: at(5) }],
    [
      { event_type: 'agent_stop', agent_id: 'ann', status: 'completed', ts: at(3) },
      { event_type: 'session_end', agent_id: 'ann', status: 'running', ts: at(6) },
    ],
  );
  const row = selectOutcome(state).rows[0];

  assert.ok(row !== undefined);
  // The defect's preconditions, pinned so the case cannot stop reproducing it:
  // the fold refused the stop, the log kept it anyway, and the log *also* still
  // holds the pre-recovery entry the floor was being built out of.
  assert.equal(state.counters.out_of_order, 1, 'the fold declined the late stop');
  assert.equal(
    state.log.filter((entry) => entry.event_type === 'agent_stop').length,
    1,
    'and it is in the client log regardless',
  );
  assert.equal(
    state.log.filter((entry) => entry.ts === at(1)).length,
    1,
    'while the superseded observation the floor came from is still there too',
  );
  assert.equal(
    state.actors[row.actor_key ?? '']?.last_event_type,
    'session_end',
    'and the authoritative state says only that the session ended around ann',
  );
  assert.equal(row.result, 'STOPPED', 'so no completion may be built out of the refused stop');
  assert.ok((row.follow_up ?? '').length > 0, 'and the open loop is named');
});

test('a desk whose history begins before this client may not be read out of the log', () => {
  // The cost of the rule above, stated rather than left to be discovered. A
  // browser that opens mid-run holds a snapshot and no observation before it, so
  // nothing says where a desk's history stood when its window opened - and a
  // stop watched afterwards cannot be shown to be one the fold acted on. It
  // falls back to the fold's own `last_event_type`, which a later `session_end`
  // has overwritten, so the run reads as 中断.
  const opened = afterRecovery(
    [],
    [{ event_type: 'agent_start', agent_id: 'ann', status: 'running' }],
    [
      { event_type: 'agent_stop', agent_id: 'ann', status: 'completed' },
      { event_type: 'session_end', agent_id: 'ann', status: 'running' },
    ],
  );
  assert.equal(selectOutcome(opened).rows[0]?.result, 'STOPPED');

  // One observation from before the gap is the whole difference: it says where
  // ann's history stood, the stop can then be placed in it, and the identical
  // run reads as 完了. Under-claiming is the half this screen is allowed to get
  // wrong; a generic session end manufacturing a success is not.
  const watched = afterRecovery(
    [{ event_type: 'agent_start', agent_id: 'ann', status: 'running' }],
    [{ event_type: 'agent_start', agent_id: 'bob', status: 'running' }],
    [
      { event_type: 'agent_stop', agent_id: 'ann', status: 'completed' },
      { event_type: 'session_end', agent_id: 'ann', status: 'running' },
    ],
  );
  const byName = new Map(selectOutcome(watched).rows.map((row) => [row.display_name, row]));
  assert.equal(byName.get('ann')?.result, 'COMPLETED');
});

test('no ordering of a run, across any recovery point, makes 完了 out of a session end', () => {
  // The rule as a property rather than as cases, because the ways to reach it
  // outnumber the ones anybody would think to write down: every sequence of
  // four lifecycle-or-session events, every arrival order including late ones,
  // and a recovery snapshot inserted at every point in each - checked against an
  // oracle that recomputes, independently of the console, which of a desk's
  // events the fold actually acted on.
  const CLOCKS = ['2026-01-01T00:00:01.000Z', '2026-01-01T00:00:05.000Z', '2026-01-01T00:00:09.000Z'];
  const TYPES = ['agent_start', 'agent_stop', 'session_end'] as const;
  const alphabet: { event_type: string; ts: string }[] = [];
  for (const event_type of TYPES) for (const ts of CLOCKS) alphabet.push({ event_type, ts });

  /** What the fold acted on, from the sequence alone: `applyEvent`'s own rule. */
  const appliedLifecycle = (steps: readonly { event_type: string; ts: string }[]): string[] => {
    const applied: string[] = [];
    let mark: number | null = null;
    for (const step of steps) {
      const ms = Date.parse(step.ts);
      if (mark !== null && ms < mark) continue;
      mark = ms;
      if (step.event_type === 'agent_start' || step.event_type === 'agent_stop') {
        applied.push(step.event_type);
      }
    }
    return applied;
  };

  let checked = 0;
  // Four, not three. Three is one event short of the shape where a recovery can
  // sit *between* two of a desk's own events and still leave an older one behind
  // it in the log - which is exactly the run the reconstructed ordering floor
  // read the wrong mark out of.
  const LENGTH = 4;
  const walk = (prefix: { event_type: string; ts: string }[]): void => {
    if (prefix.length === LENGTH) {
      const truth = appliedLifecycle(prefix);
      const latest = truth.length === 0 ? null : truth[truth.length - 1];
      const events = prefix.map((step) => ({ ...step, agent_id: 'ann', status: 'running' }));
      for (let cut = 0; cut <= events.length; cut += 1) {
        for (let live = cut; live <= events.length; live += 1) {
          checked += 1;
          const state = afterRecovery(
            events.slice(0, cut),
            events.slice(cut, live),
            events.slice(live),
          );
          for (const row of selectOutcome(state).rows) {
            if (row.result !== 'COMPLETED') continue;
            assert.equal(
              latest,
              'agent_stop',
              `完了 without the desk's own applied stop: ${prefix
                .map((step) => `${step.event_type}@${step.ts.slice(17, 19)}`)
                .join(' ')} (seen ${cut}, live from ${live})`,
            );
          }
        }
      }
      return;
    }
    for (const step of alphabet) walk([...prefix, step]);
  };
  walk([]);

  assert.ok(checked > 90000, `the search actually ran: ${checked} cases`);
});

test('a finished-sounding status on a non-terminal event is not a completion either', () => {
  // `agent_status: done` is the producer describing a moment, not the desk
  // reporting that it stopped. Conservative on purpose: 完了 is a claim about a
  // finished run, and this is not evidence of one.
  const state = stateOf([
    { event_type: 'agent_start', agent_id: 'ann', status: 'running' },
    { event_type: 'agent_status', agent_id: 'ann', status: 'done' },
  ]);
  const row = selectOutcome(state).rows[0];
  assert.equal(row?.result, 'STOPPED');
  assert.equal(row?.last_known_visual.state, 'ended', 'the office still classifies it the same way');
});

test('Outcome evidence is reachable, and says what it does not have', () => {
  const state = office({ ann: 'completed' });
  const row = selectOutcome(state).rows[0];
  assert.ok(row !== undefined);

  const labels = row.evidence.trace.map((entry) => entry.label);
  assert.ok(labels.includes('session'), 'the run is reachable');
  assert.ok(labels.includes('actor_key'), 'and so is the identity behind the name');
  assert.ok(labels.includes('最終更新'));
  for (const entry of row.evidence.trace) {
    assert.ok(entry.value.length > 0, `${entry.label} is never a blank cell`);
  }
  // Tests, CI, PR and commit refs are not on the wire. Saying so is not the
  // same claim as leaving the row empty.
  assert.equal(row.evidence.artifacts.available, false);
  assert.ok(row.evidence.artifacts.note.length > 0);
  assert.equal(selectOutcome(state).artifacts.available, false);
});

test('every outcome result has a readable label', () => {
  for (const result of ARK_OUTCOME_RESULTS) {
    assert.ok(outcomeLabel(result).length > 0);
  }
});

// ------------------------------------------------------ command surface ---

test('the command surface builds a payload and refuses to claim it was sent', () => {
  const draft = buildCommandDraft('ARKのNeed You画面をスマホで見やすくして', {
    namespace: 'live',
    target_actor_key: null,
    at: '2026-09-02T00:00:00.000Z',
  });

  assert.equal(draft.status, 'ready');
  assert.equal(draft.reject, null);
  assert.deepEqual(draft.payload, {
    schema_version: 1,
    kind: 'owner_task_delegation',
    origin: 'owner_ark_console',
    namespace: 'live',
    intent: 'ARKのNeed You画面をスマホで見やすくして',
    target_actor_key: null,
    drafted_at: '2026-09-02T00:00:00.000Z',
    dispatch: 'none',
  });
  // Not "sending failed" and not "sent": there is nowhere to send it, and the
  // screen says which of those it is.
  assert.equal(draft.submission.available, false);
  assert.equal(draft.submission.code, 'NOT_CONNECTED');
  assert.equal(draft.submission, ARK_SUBMISSION, 'the same constant in every state');
});

test('the command surface refuses what a boundary would refuse, without echoing it', () => {
  const empty = buildCommandDraft('   ', { namespace: 'live' });
  assert.equal(empty.status, 'empty');
  assert.equal(empty.reject, 'empty');
  assert.equal(empty.payload, null);

  const long = buildCommandDraft('あ'.repeat(ARK_COMMAND_MAX + 1), { namespace: 'live' });
  assert.equal(long.reject, 'too_long');
  assert.equal(long.payload, null);
  assert.equal(long.message?.includes('あ'), false, 'the refusal never quotes the input back');

  const control = buildCommandDraft(`ok${String.fromCharCode(7)}`, { namespace: 'live' });
  assert.equal(control.reject, 'control_chars');
  assert.equal(control.payload, null);

  for (const rule of [empty, long, control]) {
    assert.ok(rule.reject !== null && ARK_COMMAND_REJECTS.includes(rule.reject));
    assert.equal(rule.submission.available, false);
  }
});

test('the command surface is a pure builder: no clock, no request, no state', () => {
  const before = buildCommandDraft('同じ依頼', { namespace: 'live', at: null });
  const after = buildCommandDraft('同じ依頼', { namespace: 'live', at: null });
  assert.deepEqual(before, after, 'the same input builds the same draft, always');
  // Counted in code points, so a surrogate pair is one character and not two.
  assert.equal(buildCommandDraft('🙂', {}).length, 1);
  assert.equal(buildCommandDraft(undefined, {}).status, 'empty', 'a missing field is not a crash');
});

// ------------------------------------------------------------ the whole ---

test('the console reads one state, and no second state machine', () => {
  const state = office({ ann: 'awaiting_approval', bob: 'failed', cy: 'planning' });
  const ark = selectArk(state);

  assert.deepEqual(ark.attention, selectAttention(state));
  assert.deepEqual(ark.now, selectNow(state));
  assert.deepEqual(ark.next, selectNext(state));
  assert.deepEqual(ark.outcome, selectOutcome(state));
  assert.equal(ark.banner.code, 'CONNECTED');
});

test('the console ranks attention by the office’s own ordering, not a new one', () => {
  // If these two ever disagree, the same failure is "worse" on one screen and
  // "better" on the other. The rank here is `ACTOR_VISUAL_STATES` itself.
  assert.deepEqual(
    [...ACTOR_VISUAL_STATES],
    ['error', 'awaiting_approval', 'planning', 'working', 'ended', 'idle'],
  );
  const rows = selectNow(office({ ann: 'idle', bob: 'failed', cy: 'planning' })).rows;
  assert.deepEqual(rows.map((row) => row.display_name), ['bob', 'cy', 'ann']);
});

test('every vocabulary the console exposes is closed and frozen', () => {
  for (const vocabulary of [
    ARK_ATTENTION_LEVELS,
    ARK_ATTENTION_REASONS,
    ARK_RUNTIME_CODES,
    ARK_OUTCOME_RESULTS,
    ARK_COMMAND_REJECTS,
  ]) {
    assert.equal(Object.isFrozen(vocabulary), true);
    assert.equal(new Set(vocabulary).size, vocabulary.length, 'no duplicate token');
  }
});
